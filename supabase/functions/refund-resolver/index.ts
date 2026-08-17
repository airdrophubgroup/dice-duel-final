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
// Primary + fallback World Chain RPCs — the public Alchemy endpoint is
// slow and rate-limited; dRPC and Uniblock are fast backups.
const RPC_URLS = [
  "https://worldchain.drpc.org",
  "https://api.uniblock.dev/uni/v1/json-rpc?chainId=480",
  "https://worldchain-mainnet.g.alchemy.com/public",
];
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

// Pick the first RPC that answers eth_blockNumber so payouts/refunds
// never stall on one flaky provider.
async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch {
      // try the next provider
    }
  }
  return new ethers.JsonRpcProvider(RPC_URLS[0]);
}

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

// Scan for a transfer of exactly `feeWei` from `wallet` to the escrow
// contract and return the matching tx hash + block time. Used by the
// cancelled-match recovery: the player paid but verification failed
// while the public RPC was down, so paid was never set and no refund
// was queued. The block time is checked against the match creation so
// an old payment can never refund a newer match.
async function findPaymentWithTime(
  provider: ethers.JsonRpcProvider,
  wallet: string,
  feeWei: string
): Promise<{ txHash: string; blockTime: number } | null> {
  const iface = new ethers.Interface(ERC20_ABI);
  const w = String(wallet).toLowerCase();
  try {
    const latest = await provider.getBlockNumber();
    const transferTopic = iface.getEvent("Transfer")!.topicHash;
    const fromTopic = ethers.zeroPadValue(w, 32);
    const toTopic = ethers.zeroPadValue(CONTRACT_ADDRESS.toLowerCase(), 32);
    const CHUNK = 99;
    const CHUNKS = 6;
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
          const block = await provider.getBlock(logs[i].blockNumber);
          const blockTime = Number(block?.timestamp ?? 0);
          return { txHash: logs[i].transactionHash, blockTime };
        }
      }
    }
  } catch {
    // scan failed — retry next tick
  }
  return null;
}

Deno.serve(async (req) => {
  // Shared-secret check — only the pg_cron job (which knows CRON_SECRET)
  // is allowed to trigger this.
  const auth = req.headers.get("x-cron-secret");
  if (auth !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SB_URL, SB_SERVICE_KEY);
  const provider = await getProvider();
  const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, operatorWallet);

  // ------------------------------------------------------------------
  // Ghost / stuck-match cleanup (runs BEFORE refund processing so
  // freshly inserted refund rows are picked up this same tick):
  //   - PAID waiting matches older than 2 min with no opponent payment
  //     -> cancel + auto-refund p1.
  //   - 'matched' matches older than 2 min (opponent joined but the
  //     match never started — e.g. one device died) -> cancel + refund
  //     EVERY paid participant.
  //   - 'playing' matches older than 10 min (both devices died mid-game;
  //     no legit game runs longer than ~2 min) -> cancel + refund EVERY
  //     paid participant.
  //   - Completed matches never settled (the winner's device closed
  //     before the payout, or the settle call failed) older than 3 min
  //     -> queue a refund row for the WINNER carrying the payout amount
  //     (idempotent via settled_at + pending/processing/done guards).
  //   - Completed matches whose TNV was never credited (a device closed
  //     before secure_credit_tnv ran) -> credited server-side via the
  //     same secure_credit_tnv function the app uses.
  // ------------------------------------------------------------------
  try {
    const twoMin = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const tenMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const threeMin = new Date(Date.now() - 3 * 60 * 1000).toISOString();

    const queueRefund = async (matchId, wallet, fee) => {
      if (!wallet || fee == null) return;
      await supabase.from("refund_queue").insert({
        match_id: matchId,
        wallet_address: String(wallet).toLowerCase(),
        fee,
        status: "pending",
      });
    };

    // PAID waiting matches with no opponent payment -> refund p1.
    const { data: ghosts } = await supabase
      .from("matches")
      .select("id, fee, p1_address")
      .in("status", ["waiting", "searching"])
      .eq("p1_paid", true)
      .eq("p2_paid", false)
      .lt("created_at", twoMin);
    for (const g of ghosts ?? []) {
      await supabase.from("matches").update({ status: "cancelled" })
        .eq("id", g.id)
        .in("status", ["waiting", "searching"]);
      await queueRefund(g.id, g.p1_address, g.fee);
    }

    // 'matched' matches that never started -> refund every paid participant.
    const { data: matchedGhosts } = await supabase
      .from("matches")
      .select("id, fee, p1_address, p2_address, p1_paid, p2_paid")
      .eq("status", "matched")
      .lt("created_at", twoMin);
    for (const g of matchedGhosts ?? []) {
      const { error: cancelErr } = await supabase.from("matches")
        .update({ status: "cancelled" })
        .eq("id", g.id)
        .eq("status", "matched");
      if (cancelErr) continue;
      if (g.p1_paid && g.p1_address) await queueRefund(g.id, g.p1_address, g.fee);
      if (g.p2_paid && g.p2_address) await queueRefund(g.id, g.p2_address, g.fee);
    }

    // 'playing' matches that never completed -> refund every paid participant.
    const { data: playingGhosts } = await supabase
      .from("matches")
      .select("id, fee, p1_address, p2_address, p1_paid, p2_paid")
      .eq("status", "playing")
      .lt("created_at", tenMin);
    for (const g of playingGhosts ?? []) {
      const { error: cancelErr } = await supabase.from("matches")
        .update({ status: "cancelled" })
        .eq("id", g.id)
        .eq("status", "playing");
      if (cancelErr) continue;
      if (g.p1_paid && g.p1_address) await queueRefund(g.id, g.p1_address, g.fee);
      if (g.p2_paid && g.p2_address) await queueRefund(g.id, g.p2_address, g.fee);
    }

    // Completed but never settled -> queue the WINNER's payout.
    const { data: unsettled } = await supabase
      .from("matches")
      .select("id, fee, payout_amount, winner_address, tie")
      .eq("status", "completed")
      .is("settled_at", null)
      .lt("created_at", threeMin);
    for (const m of unsettled ?? []) {
      if (!m.winner_address || m.winner_address === "tie" || m.tie) continue;
      const w = String(m.winner_address).toLowerCase();
      const { data: existing } = await supabase
        .from("refund_queue")
        .select("id")
        .eq("match_id", m.id)
        .eq("wallet_address", w)
        .in("status", ["pending", "processing", "done"]);
      if (existing && existing.length > 0) continue;
      const payout = m.payout_amount ?? (m.fee != null ? Number((Number(m.fee) * 1.6).toFixed(2)) : null);
      if (payout == null || Number(payout) <= 0) continue;
      await supabase.from("refund_queue").insert({
        match_id: m.id,
        wallet_address: w,
        fee: payout,
        status: "pending",
        error: "winner payout (resolver retry)",
      });
    }

    // Completed matches whose TNV was never credited -> credit via the
    // same secure_credit_tnv function (participant/paid/completed and
    // one-time checks all apply server-side).
    const TNV_BASE: Record<number, number> = {
      0.1: 5, 0.2: 10, 0.5: 15, 1: 25, 2: 50, 5: 125, 10: 250, 20: 500,
      30: 750, 40: 1000, 50: 1250,
    };
    const { data: tnvPending } = await supabase
      .from("matches")
      .select("id, fee, p1_address, p2_address, p1_paid, p2_paid, p1_score, p2_score, tie, p1_tnv_credited, p2_tnv_credited")
      .eq("status", "completed")
      .eq("tie", false)
      .or("p1_tnv_credited.is.false,p2_tnv_credited.is.false");
    for (const m of tnvPending ?? []) {
      const base = TNV_BASE[Number(m.fee)] ?? 15;
      const participants = [
        { addr: m.p1_address, paid: m.p1_paid, credited: m.p1_tnv_credited, score: m.p1_score, opp: m.p2_score },
        { addr: m.p2_address, paid: m.p2_paid, credited: m.p2_tnv_credited, score: m.p2_score, opp: m.p1_score },
      ];
      for (const p of participants) {
        if (!p.addr || !p.paid || p.credited) continue;
        try {
          await supabase.rpc("secure_credit_tnv", { p_match_id: m.id, p_wallet: p.addr });
        } catch (e) {
          console.error("resolver TNV credit failed:", e);
        }
      }
    }
  } catch (e) {
    console.error("ghost/stuck cleanup exception:", e);
  }

  // ------------------------------------------------------------------
  // CANCELLED-MATCH PAYMENT RECOVERY (safety net)
  //
  // If the public RPC was down while a player paid, the app's verify-
  // payment call failed, paid was never set and NO refund row exists —
  // the player's WLD would sit in the escrow forever. For every recent
  // cancelled match where a participant is unpaid, scan on-chain for
  // the exact fee transfer (must postdate the match, deduped by
  // record_verified_payment). If found -> record + queue the refund.
  // ------------------------------------------------------------------
  try {
    const twentyMin = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { data: cancelled } = await supabase
      .from("matches")
      .select("id, fee, created_at, p1_address, p2_address, p1_paid, p2_paid, p1_payment_tx_hash, p2_payment_tx_hash")
      .eq("status", "cancelled")
      .gt("created_at", twentyMin)
      .limit(20);
    for (const m of cancelled ?? []) {
      const feeWei = m.fee != null ? ethers.parseUnits(String(m.fee), 18).toString() : null;
      if (!feeWei) continue;
      const createdMs = Date.parse(m.created_at);
      const candidates = [
        { addr: m.p1_address, paid: m.p1_paid, tx: m.p1_payment_tx_hash },
        { addr: m.p2_address, paid: m.p2_paid, tx: m.p2_payment_tx_hash },
      ];
      for (const c of candidates) {
        if (!c.addr || c.paid || c.tx) continue; // only unpaid, never-recorded players
        const w = String(c.addr).toLowerCase();
        const { data: already } = await supabase
          .from("refund_queue")
          .select("id")
          .eq("match_id", m.id)
          .eq("wallet_address", w)
          .in("status", ["pending", "processing", "done"]);
        if (already && already.length > 0) continue;
        const found = await findPaymentWithTime(provider, w, feeWei);
        if (!found) continue;
        if (Number.isFinite(createdMs) && found.blockTime * 1000 < createdMs) continue; // stale payment
        const { data: rec, error: recErr } = await supabase.rpc("record_verified_payment", {
          p_match_id: m.id,
          p_wallet: w,
          p_tx_hash: found.txHash,
        });
        if (recErr || !rec || rec.success !== true) continue; // tx already used elsewhere -> skip
        await supabase.rpc("queue_refund_request", { p_match_id: m.id, p_wallet: w });
        console.log("resolver recovered unrecorded payment:", m.id, w, found.txHash);
      }
    }
  } catch (e) {
    console.error("cancelled-match recovery exception:", e);
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

        // THE GATE: only refund/pay when the player's payment is proven
        // on-chain. Verification is ALWAYS against the match ENTRY fee —
        // the amount the player actually transferred — so a forged row /
        // forged paid flag never pays.
        const paidFeeWei = ethers.parseUnits(String(matchRow.fee), 18).toString();
        const paymentTx = isPaidP1 ? matchRow.p1_payment_tx_hash : matchRow.p2_payment_tx_hash;
        const verification = await verifyPaymentOnChain(provider, w, paidFeeWei, paymentTx || null);
        if (!verification.ok) {
          await supabase.from("refund_queue").update({
            status: "failed",
            error: "payment not verified on-chain",
            processed_at: new Date().toISOString(),
          }).eq("id", id);
          results.push({ id, status: "failed", error: "payment not verified on-chain" });
          continue;
        }

        // Amount to send: the queue row's fee when set (winner payouts
        // carry the payout amount), otherwise the entry fee (refunds).
        const transferWei =
          row.fee != null && Number(row.fee) > 0
            ? ethers.parseUnits(String(row.fee), 18)
            : ethers.parseUnits(String(matchRow.fee), 18);

        try {
          const tx = await contract.emergencyTokenTransfer(
            WLD_TOKEN_CONTRACT,
            wallet_address,
            transferWei
          );
          const receipt = await tx.wait();

          await supabase.from("refund_queue").update({
            status: "done",
            tx_hash: receipt.hash,
            error: "emergency refund (payment verified on-chain)",
            processed_at: new Date().toISOString(),
          }).eq("id", id);

          // Mark the match settled when a completed match is paid out
          // (winner payout or tie refund) so the winner sweep never
          // queues a second payout for the same match.
          if (matchRow.status === "completed") {
            await supabase.from("matches")
              .update({ settled_at: new Date().toISOString() })
              .eq("id", match_id)
              .is("settled_at", null);
          }

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
