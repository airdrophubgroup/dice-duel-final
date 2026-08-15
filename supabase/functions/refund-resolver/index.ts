// supabase/functions/refund-resolver/index.ts
//
// Deploy: supabase functions deploy refund-resolver --no-verify-jwt
// (--no-verify-jwt because this is called by pg_cron, not a logged-in
// user — we protect it with our own shared-secret header instead, see
// the CRON_SECRET check below.)
//
// Secrets to set before deploying:
//   supabase secrets set OPERATOR_PRIVATE_KEY=... DICE_DUEL_CONTRACT=0x... CRON_SECRET=some-long-random-string
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// by the platform — you don't need to set those yourself.
//
// Refund flow handled here:
//   A) Match is booked on-chain (status Waiting, player == p1) ->
//      cancelWaitingMatch() refunds the player's WLD. This is the normal
//      case after app.js successfully books the deposit.
//   B) Match was NEVER booked on-chain (status None) -> the player paid
//      but record-deposit failed, so the WLD sits unallocated in the
//      contract. We return the entry fee via the contract's owner-only
//      emergencyTokenTransfer(). This only succeeds if the operator key
//      IS the contract owner — if it isn't, the row is marked failed and
//      the admin must use api/emergengy-transfer.js manually.
//      IMPORTANT: an emergency refund is only attempted while the match
//      is in status None. It is never attempted for Active/Settled/Cancelled.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPERATOR_PRIVATE_KEY = Deno.env.get("OPERATOR_PRIVATE_KEY")!;
const CONTRACT_ADDRESS = Deno.env.get("DICE_DUEL_CONTRACT")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const CONTRACT_ABI = [
  "function cancelWaitingMatch(bytes32 matchId) external",
  "function emergencyTokenTransfer(address token, address user, uint256 amount) external",
  "function matches(bytes32) view returns (address p1, address p2, uint256 fee, uint8 status, uint256 createdAt)",
];

const MatchStatus = { None: 0, Waiting: 1, Active: 2, Settled: 3, Cancelled: 4 };

async function matchIdToBytes32(uuidStr: string) {
  const enc = new TextEncoder().encode(uuidStr);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return "0x" + hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  // Shared-secret check — only the pg_cron job (which knows CRON_SECRET)
  // is allowed to trigger this. Without this, anyone who found the
  // function's public URL could spam-trigger refund processing.
  const auth = req.headers.get("x-cron-secret");
  if (auth !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SB_URL, SB_SERVICE_KEY);
  const provider = new ethers.JsonRpcProvider(WORLDCHAIN_RPC);
  const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, operatorWallet);

  const { data: rows, error } = await supabase
    .from("refund_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results = [];

  for (const row of rows ?? []) {
    const { id, match_id, wallet_address } = row;

    // Claim the row so a second cron tick (if the previous run is still
    // in flight) doesn't double-process it.
    const { error: lockErr } = await supabase
      .from("refund_queue")
      .update({ status: "processing" })
      .eq("id", id)
      .eq("status", "pending");
    if (lockErr) continue;

    try {
      // refund_queue.match_id is a FK to matches.id — but the on-chain
      // hash is derived from matches.match_id (a separate column app.js
      // sets). We must look that up explicitly rather than hashing the
      // FK value directly, or the on-chain lookup will always miss.
      const { data: matchRow, error: matchErr } = await supabase
        .from("matches")
        .select("match_id, fee")
        .eq("id", match_id)
        .single();

      if (matchErr || !matchRow) {
        await supabase
          .from("refund_queue")
          .update({
            status: "failed",
            error: "could not load matches.match_id for on-chain hash",
            processed_at: new Date().toISOString(),
          })
          .eq("id", id);
        results.push({ id, status: "failed" });
        continue;
      }

      const onChainIdSource = matchRow.match_id || match_id;
      const matchIdBytes32 = await matchIdToBytes32(onChainIdSource);

      // Re-verify on-chain before spending gas — never trust the queue
      // row alone.
      const onChainMatch = await contract.matches(matchIdBytes32);
      const status = Number(onChainMatch.status);

      if (status === MatchStatus.Waiting) {
        if (onChainMatch.p1.toLowerCase() !== wallet_address.toLowerCase()) {
          await supabase
            .from("refund_queue")
            .update({
              status: "failed",
              error: "wallet mismatch with on-chain p1",
              processed_at: new Date().toISOString(),
            })
            .eq("id", id);
          results.push({ id, status: "failed" });
          continue;
        }

        // Normal case: deposit was booked, refund via cancelWaitingMatch.
        const tx = await contract.cancelWaitingMatch(matchIdBytes32);
        const receipt = await tx.wait();

        await supabase
          .from("refund_queue")
          .update({
            status: "done",
            tx_hash: receipt.hash,
            processed_at: new Date().toISOString(),
          })
          .eq("id", id);

        results.push({ id, status: "done", tx_hash: receipt.hash });
        continue;
      }

      if (status === MatchStatus.None && matchRow.fee != null) {
        // The deposit was never booked on-chain (record-deposit failed),
        // so the WLD is sitting unallocated in the contract. Return the
        // entry fee with the owner-only emergency transfer. Only
        // attempted while the match is None — never for an already
        // settled/cancelled match.
        const feeWei = ethers.parseUnits(String(matchRow.fee), 18);
        try {
          const tx = await contract.emergencyTokenTransfer(
            WLD_TOKEN_CONTRACT,
            wallet_address,
            feeWei
          );
          const receipt = await tx.wait();

          await supabase
            .from("refund_queue")
            .update({
              status: "done",
              tx_hash: receipt.hash,
              error: "emergency refund (deposit was never booked)",
              processed_at: new Date().toISOString(),
            })
            .eq("id", id);

          results.push({ id, status: "done", tx_hash: receipt.hash, emergency: true });
        } catch (err) {
          await supabase
            .from("refund_queue")
            .update({
              status: "failed",
              error:
                "emergency refund failed — OPERATOR_PRIVATE_KEY must be the contract owner: " +
                String((err as Error)?.message || err),
              processed_at: new Date().toISOString(),
            })
            .eq("id", id);
          results.push({ id, status: "failed", error: String(err) });
        }
        continue;
      }

      await supabase
        .from("refund_queue")
        .update({
          status: "failed",
          error: `match not refundable on-chain (status=${status})`,
          processed_at: new Date().toISOString(),
        })
        .eq("id", id);
      results.push({ id, status: "failed" });
    } catch (err) {
      await supabase
        .from("refund_queue")
        .update({
          status: "failed",
          error: String((err as Error)?.message || err),
          processed_at: new Date().toISOString(),
        })
        .eq("id", id);
      results.push({ id, status: "failed", error: String(err) });
    }
  }

  // ------------------------------------------------------------------
  // Maintenance: expire stale matches that never got a payment and never
  // found an opponent (e.g. the app was closed while the payment sheet
  // was open, so cancelMatchmaking never ran). Only matches where
  // NEITHER player paid are touched, so no money can ever be affected.
  // ------------------------------------------------------------------
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { error: staleErr } = await supabase
      .from("matches")
      .update({ status: "cancelled" })
      .in("status", ["waiting", "searching"])
      .eq("p1_paid", false)
      .eq("p2_paid", false)
      .lt("created_at", cutoff);
    if (staleErr) {
      console.error("stale match cleanup error:", staleErr);
    }
  } catch (e) {
    console.error("stale match cleanup exception:", e);
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
