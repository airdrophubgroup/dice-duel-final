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

import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPERATOR_PRIVATE_KEY = Deno.env.get("OPERATOR_PRIVATE_KEY")!;
const CONTRACT_ADDRESS = Deno.env.get("DICE_DUEL_CONTRACT")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";

const CONTRACT_ABI = [
  "function cancelWaitingMatch(bytes32 matchId) external",
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
        .select("match_id")
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
      if (Number(onChainMatch.status) !== MatchStatus.Waiting) {
        await supabase
          .from("refund_queue")
          .update({
            status: "failed",
            error: "match not in Waiting state on-chain",
            processed_at: new Date().toISOString(),
          })
          .eq("id", id);
        results.push({ id, status: "failed" });
        continue;
      }
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

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});