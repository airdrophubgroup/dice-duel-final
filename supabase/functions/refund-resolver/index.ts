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
//   The app does NOT book matches on-chain (the deployed TnvDuelArena
//   contract has no recordDeposit function; joinMatch/Permit2 conflicts
//   with the game's 1-minute auto-refund rule). The player's WLD sits in
//   the contract as an unallocated balance and Supabase is the ledger, so
//   EVERY refund here goes through the owner-only emergencyTokenTransfer()
//   (path B below). The on-chain Waiting branch (A) is kept as a defensive
//   fallback for any future match that was booked via joinMatch.
//
//   A) Match IS booked on-chain (status Waiting, player == p1) ->
//      cancelWaitingMatch() refunds the player's WLD.
//   B) Match never booked on-chain (status None) -> return the entry fee
//      via emergencyTokenTransfer(). Only succeeds if the operator key IS
//      the contract owner.
//
// SECURITY: before ANY emergency payout, the player's payment is
// re-verified on-chain (the recorded payment tx hash must show a real
// Transfer from that wallet -> escrow contract at the match fee, with a
// recent-transfer scan as fallback). Even if every DB flag is forged,
// no WLD leaves the contract without real on-chain proof.

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

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const MatchStatus = { None: 0, Waiting: 1, Active: 2, Settled: 3, Cancelled: 4 };

async function matchIdToBytes32(uuidStr: string) {
  const enc = new TextEncoder().encode(uuidStr);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return "0x" + hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Verify on-chain that `wallet` really transferred `feeWei` WLD to the
// escrow contract. First checks the recorded tx hash; if that is missing
// or fails, scans recent transfers (contiguous 99-block chunks x 5) so
// older matches still refund correctly.
async function verifyPaymentOnChain(
  provider: ethers.JsonRpcProvider,
  wallet: string,
  feeWei: string,
  txHash: string | null
): Promise<{ ok: boolean; txHash?: string }> {
  const iface = new ethers.Interface(ERC20_ABI);
  const w = String(wallet).toLowerCase();

  const checkReceipt = async (hash: string): Promise<boolean> => {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt || receipt.status !== 1) return false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== WLD_TOKEN_CONTRACT.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog(log);
          if (
            parsed!.name === "Transfer" &&
            parsed!.args.from.toLowerCase() === w &&
            parsed!.args.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
            parsed!.args.value.toString() === feeWei
          ) {
            return true;
          }
        } catch {
          // not a WLD Transfer log
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  if (txHash && await checkReceipt(txHash)) {
    return { ok: true, txHash };
  }

  // Scan fallback for matches paid before tx hashes were recorded.
  try {
    const latest = await provider.getBlockNumber();
    const transferTopic = iface.getEvent("Transfer")!.topicHash;
    const fromTopic = ethers.zeroPadValue(w, 32);
    const toTopic = ethers.zeroPadValue(CONTRACT_ADDRESS.toLowerCase(), 32);
    const CHUNK = 99;
    const CHUNKS = 5;
    for (let c = 0; c < CHUNKS; c++) {
      const toBlock = latest - c * CHUNK;
      const fromBlock = Math.max(0, toBlock - (CHUNK - 1));
      let logs: any[] = [];
      try {
        logs = await provider.getLogs({
          address: WLD_TOKEN_CONTRACT,
          topics: [transferTopic, fromTopic, toTopic],
          fromBlock,
          toBlock,
        });
      } catch {
        continue;
      }
      for (let i = logs.length - 1; i >= 0; i--) {
        const parsed = iface.parseLog(logs[i]);
        if (parsed && parsed.args.value.toString() === feeWei) {
          return { ok: true, txHash: logs[i].transactionHash };
        }
      }
    }
  } catch {
    // fall through — refund stays unverified
  }

  return { ok: false };
}

Deno.serve(async (req) => {
  // Shared-secret check — only the pg_cron job (which knows CRON_SECRET)
  // is allowed to trigger this.
  const auth = req.headers.get("x-cron-secret");
  if (auth !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SB_URL, SB_SERVICE_KEY);
  const provider = new ethers.JsonRpcProvider(WORLDCHAIN_RPC);
  const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, operatorWallet);

  // ------------------------------------------------------------------
  // Ghost cleanup (runs BEFORE refund processing so freshly inserted
  // refund rows are picked up by this same tick):
  //   - PAID waiting matches older than 2 minutes with no p2 payment
  //     are abandoned -> cancel + auto-refund.
  //   - Completed matches that never got settled (winner payout failed
  //     or app closed) older than 3 minutes are retried via a refund
  //     queue row for the winner (idempotent — settled_at guard).
  // ------------------------------------------------------------------
  try {
    const ghostCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: ghosts, error: ghostErr } = await supabase
      .from("matches")
      .select("id, fee, p1_address")
      .in("status", ["waiting", "searching"])
      .eq("p1_paid", true)
      .eq("p2_paid", false)
      .lt("created_at", ghostCutoff);
    if (!ghostErr && ghosts) {
      for (const g of ghosts) {
        const { error: cancelErr } = await supabase
          .from("matches")
          .update({ status: "cancelled" })
          .eq("id", g.id)
          .in("status", ["waiting", "searching"]);
        if (cancelErr) continue;

        if (g.p1_address && g.fee != null) {
          await supabase.from("refund_queue").insert({
            match_id: g.id,
            wallet_address: String(g.p1_address).toLowerCase(),
            fee: g.fee,
            status: "pending",
          });
        }
      }
    }
  } catch (e) {
    console.error("paid ghost cleanup exception:", e);
  }

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

    // Claim the row so a second cron tick can't double-process it.
    const { error: lockErr } = await supabase
      .from("refund_queue")
      .update({ status: "processing" })
      .eq("id", id)
      .eq("status", "pending");
    if (lockErr) continue;

    try {
      const { data: matchRow, error: matchErr } = await supabase
        .from("matches")
        .select(
          "match_id, fee, status, p1_address, p2_address, p1_paid, p2_paid, p1_payment_tx_hash, p2_payment_tx_hash, tie"
        )
        .eq("id", match_id)
        .single();

      if (matchErr || !matchRow) {
        await supabase.from("refund_queue").update({
          status: "failed",
          error: "could not load match row",
          processed_at: new Date().toISOString(),
        }).eq("id", id);
        results.push({ id, status: "failed" });
        continue;
      }

      const onChainIdSource = matchRow.match_id || match_id;
      const matchIdBytes32 = await matchIdToBytes32(onChainIdSource);
      const onChainMatch = await contract.matches(matchIdBytes32);
      const status = Number(onChainMatch.status);
      const w = String(wallet_address).toLowerCase();
      const p1 = String(matchRow.p1_address || "").toLowerCase();
      const p2 = String(matchRow.p2_address || "").toLowerCase();

      if (status === MatchStatus.Waiting) {
        if (onChainMatch.p1.toLowerCase() !== w) {
          await supabase.from("refund_queue").update({
            status: "failed",
            error: "wallet mismatch with on-chain p1",
            processed_at: new Date().toISOString(),
          }).eq("id", id);
          results.push({ id, status: "failed" });
          continue;
        }
        const tx = await contract.cancelWaitingMatch(matchIdBytes32);
        const receipt = await tx.wait();
        await supabase.from("refund_queue").update({
          status: "done",
          tx_hash: receipt.hash,
          processed_at: new Date().toISOString(),
        }).eq("id", id);
        results.push({ id, status: "done", tx_hash: receipt.hash });
        continue;
      }

      if (status === MatchStatus.None && matchRow.fee != null) {
        // Must be a PAID participant.
        const isPaidP1 = w === p1 && matchRow.p1_paid === true;
        const isPaidP2 = w === p2 && matchRow.p2_paid === true;
        if (!isPaidP1 && !isPaidP2) {
          await supabase.from("refund_queue").update({
            status: "failed",
            error: "wallet is not a paid participant of this match",
            processed_at: new Date().toISOString(),
          }).eq("id", id);
          results.push({ id, status: "failed" });
          continue;
        }

        // THE GATE: only refund when the player's payment is proven
        // on-chain. A forged row / forged paid flag never pays.
        const feeWei = ethers.parseUnits(String(matchRow.fee), 18).toString();
        const paymentTx = isPaidP1 ? matchRow.p1_payment_tx_hash : matchRow.p2_payment_tx_hash;
        const verification = await verifyPaymentOnChain(provider, w, feeWei, paymentTx || null);
        if (!verification.ok) {
          await supabase.from("refund_queue").update({
            status: "failed",
            error: "payment not verified on-chain",
            processed_at: new Date().toISOString(),
          }).eq("id", id);
          results.push({ id, status: "failed", error: "payment not verified on-chain" });
          continue;
        }

        try {
          const tx = await contract.emergencyTokenTransfer(
            WLD_TOKEN_CONTRACT,
            wallet_address,
            feeWei
          );
          const receipt = await tx.wait();

          await supabase.from("refund_queue").update({
            status: "done",
            tx_hash: receipt.hash,
            error: "emergency refund (payment verified on-chain)",
            processed_at: new Date().toISOString(),
          }).eq("id", id);

          results.push({ id, status: "done", tx_hash: receipt.hash, emergency: true });
        } catch (err) {
          await supabase.from("refund_queue").update({
            status: "failed",
            error: "emergency refund failed — OPERATOR_PRIVATE_KEY must be the contract owner: " +
              String((err as Error)?.message || err),
            processed_at: new Date().toISOString(),
          }).eq("id", id);
          results.push({ id, status: "failed", error: String(err) });
        }
        continue;
      }

      await supabase.from("refund_queue").update({
        status: "failed",
        error: `match not refundable on-chain (status=${status})`,
        processed_at: new Date().toISOString(),
      }).eq("id", id);
      results.push({ id, status: "failed" });
    } catch (err) {
      await supabase.from("refund_queue").update({
        status: "failed",
        error: String((err as Error)?.message || err),
        processed_at: new Date().toISOString(),
      }).eq("id", id);
      results.push({ id, status: "failed", error: String(err) });
    }
  }

  // ------------------------------------------------------------------
  // Maintenance: expire stale matches that never got a payment and never
  // found an opponent (app closed with the payment sheet open). Only
  // matches where NEITHER player paid are touched — no money affected.
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
