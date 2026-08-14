// refund_resolver_worker.js
//
// Run this as a small always-on process (or a cron job every ~10-15s) on
// your backend — NOT in the browser. It holds the operator private key,
// so it must never be shipped to app.js / the client.
//
// npm i ethers @supabase/supabase-js

import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SB_URL;                 // same Supabase project as app.js
const SB_SERVICE_KEY = process.env.SB_SERVICE_KEY;  // service_role key — server-side only, never expose
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.DICE_DUEL_CONTRACT;
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";

const CONTRACT_ABI = [
  "function cancelWaitingMatch(bytes32 matchId) external",
  "function matches(bytes32) view returns (address p1, address p2, uint256 fee, uint8 status, uint256 createdAt)"
];

const supabase = createClient(SB_URL, SB_SERVICE_KEY);
const provider = new ethers.JsonRpcProvider(WORLDCHAIN_RPC);
const operatorWallet = new ethers.Wallet(OPERATOR_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, operatorWallet);

// Same hashing app.js uses to turn a Supabase match uuid into the
// bytes32 matchId the contract expects. Must stay identical to app.js's
// matchIdToBytes32() — sha256(uuid string) -> 0x-prefixed hex.
async function matchIdToBytes32(uuidStr) {
  const enc = new TextEncoder().encode(uuidStr);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return "0x" + hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MatchStatus = { None: 0, Waiting: 1, Active: 2, Settled: 3, Cancelled: 4 };

async function processOneRefund(row) {
  const { id, match_id, wallet_address } = row;
  // match_id here is refund_queue.match_id, which is a FK to matches.id
  // (the Supabase row's primary key) — NOT the same as matches.match_id
  // (a separate random field app.js generates for the on-chain hash).
  // We must look up that column explicitly, or refunds will always
  // hash the wrong bytes32 ID and revert on-chain.

  // mark as processing so a second worker instance / re-run doesn't double-fire
  const { error: lockErr } = await supabase
    .from("refund_queue")
    .update({ status: "processing" })
    .eq("id", id)
    .eq("status", "pending");
  if (lockErr) return; // someone else grabbed it first

  try {
    const { data: matchRow, error: matchErr } = await supabase
      .from("matches")
      .select("match_id")
      .eq("id", match_id)
      .single();

    if (matchErr || !matchRow) {
      await supabase
        .from("refund_queue")
        .update({ status: "failed", error: "could not load matches.match_id for on-chain hash", processed_at: new Date().toISOString() })
        .eq("id", id);
      return;
    }

    // Fall back to the row id itself only if the app never set a
    // separate match_id (e.g. an older match created before that field existed).
    const onChainIdSource = matchRow.match_id || match_id;
    const matchIdBytes32 = await matchIdToBytes32(onChainIdSource);

    // Re-verify on-chain before spending gas / firing the refund —
    // never trust the queue row alone.
    const onChainMatch = await contract.matches(matchIdBytes32);
    if (Number(onChainMatch.status) !== MatchStatus.Waiting) {
      await supabase
        .from("refund_queue")
        .update({ status: "failed", error: "match not in Waiting state on-chain", processed_at: new Date().toISOString() })
        .eq("id", id);
      return;
    }
    if (onChainMatch.p1.toLowerCase() !== wallet_address.toLowerCase()) {
      await supabase
        .from("refund_queue")
        .update({ status: "failed", error: "wallet mismatch with on-chain p1", processed_at: new Date().toISOString() })
        .eq("id", id);
      return;
    }

    const tx = await contract.cancelWaitingMatch(matchIdBytes32);
    const receipt = await tx.wait();

    await supabase
      .from("refund_queue")
      .update({ status: "done", tx_hash: receipt.hash, processed_at: new Date().toISOString() })
      .eq("id", id);

    console.log(`Refunded match ${match_id} -> tx ${receipt.hash}`);
  } catch (err) {
    await supabase
      .from("refund_queue")
      .update({ status: "failed", error: String(err?.message || err), processed_at: new Date().toISOString() })
      .eq("id", id);
    console.error(`Refund failed for match ${match_id}:`, err);
  }
}

async function pollLoop() {
  const { data: rows, error } = await supabase
    .from("refund_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error("Poll error:", error);
    return;
  }

  for (const row of rows || []) {
    await processOneRefund(row);
  }
}

setInterval(pollLoop, 10_000);
pollLoop();
