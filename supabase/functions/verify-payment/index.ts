// supabase/functions/verify-payment/index.ts
//
// Deploy: supabase functions deploy verify-payment --no-verify-jwt
// (verify_jwt=false: the app calls this directly with the publishable
// key; security comes from ON-CHAIN verification below, not from auth).
//
// This is the ONLY path that marks a player paid (record_verified_payment
// RPC). It:
//   1. verifies the WLD transfer really happened on-chain (receipt check
//      OR recent-transfer scan — never trusts MiniKit's status),
//   2. enforces anti-stale (transfer must postdate the match),
//   3. checks the player is a participant of the match and the amount
//      matches the match fee,
//   4. records the payment with the service role key (record_verified_payment
//      also dedupes the tx hash so one payment can never pay for two matches).
//
// The old anon-callable force_confirm_payment can no longer grant paid
// status on its own, so forging "paid" without a real on-chain payment
// is impossible end-to-end.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Primary + fallback World Chain RPCs (the public Alchemy endpoint is
// slow and rate-limited; dRPC and Uniblock are fast backups).
const RPC_URLS = [
  "https://worldchain.drpc.org",
  "https://api.uniblock.dev/uni/v1/json-rpc?chainId=480",
  "https://worldchain-mainnet.g.alchemy.com/public",
];
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";

// Pick the first RPC that answers eth_blockNumber. Verification must be
// resilient: if one provider is down/rate-limited, the next takes over
// instead of leaving the player's payment unrecorded.
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

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

async function matchIdToBytes32(uuidStr: string) {
  const enc = new TextEncoder().encode(uuidStr);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return "0x" + hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Scan recent WLD transfers from player -> escrow at exactly feeWei.
// Contiguous 99-block chunks (no gaps) x 3 ~= last ~10 minutes.
async function findPaymentTxHash(provider: ethers.JsonRpcProvider, playerAddress: string, feeWei: string) {
  const latest = await provider.getBlockNumber();
  const iface = new ethers.Interface(ERC20_ABI);
  const transferTopic = iface.getEvent("Transfer")!.topicHash;
  const fromTopic = ethers.zeroPadValue(playerAddress.toLowerCase(), 32);
  const toTopic = ethers.zeroPadValue(CONTRACT_ADDRESS.toLowerCase(), 32);

  const CHUNK = 99;
  const CHUNKS = 3;
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
      if (parsed && parsed.args.value.toString() === feeWei.toString()) {
        return logs[i].transactionHash;
      }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { matchUuid, playerAddress, feeWei, txHash } = body;
  if (!matchUuid || !playerAddress || !feeWei) {
    return json({ error: "matchUuid, playerAddress and feeWei are required" }, 400);
  }

  try {
    const supabase = createClient(SB_URL, SB_SERVICE_KEY);
    const provider = await getProvider();

    // Load the match row first: participant, fee and created_at checks.
    const { data: matchRow, error: matchErr } = await supabase
      .from("matches")
      .select("id, fee, status, created_at, p1_address, p2_address, p1_paid, p2_paid, p1_payment_tx_hash, p2_payment_tx_hash")
      .eq("id", matchUuid)
      .single();
    if (matchErr || !matchRow) {
      return json({ error: "Match not found" }, 400);
    }

    const wallet = String(playerAddress).toLowerCase();
    const p1 = String(matchRow.p1_address || "").toLowerCase();
    const p2 = String(matchRow.p2_address || "").toLowerCase();
    if (wallet !== p1 && wallet !== p2) {
      return json({ error: "Player is not a participant of this match" }, 400);
    }

    const matchFee = String(matchRow.fee);
    const expectedFeeWei = ethers.parseUnits(matchFee, 18).toString();
    if (expectedFeeWei !== String(feeWei)) {
      return json({ error: `Fee mismatch: match fee is ${matchFee} WLD` }, 400);
    }

    // ---- 1. verify on-chain ----
    let receipt: any = null;
    if (txHash) {
      for (let attempt = 1; attempt <= 8 && (!receipt || receipt.status !== 1); attempt++) {
        receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
          if (attempt < 8) await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    if (!receipt || receipt.status !== 1) {
      const foundHash = await findPaymentTxHash(provider, wallet, expectedFeeWei);
      if (foundHash) {
        receipt = await provider.getTransactionReceipt(foundHash);
      }
    }
    if (!receipt || receipt.status !== 1) {
      return json({
        error: "Could not find the WLD payment on-chain. If you completed the payment, it will be refunded automatically.",
      }, 400);
    }

    // ---- 2. exact transfer in the receipt ----
    const iface = new ethers.Interface(ERC20_ABI);
    let verified = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== WLD_TOKEN_CONTRACT.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (
          parsed!.name === "Transfer" &&
          parsed!.args.from.toLowerCase() === wallet &&
          parsed!.args.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
          parsed!.args.value.toString() === expectedFeeWei
        ) {
          verified = true;
          break;
        }
      } catch {
        // not a WLD Transfer log
      }
    }
    if (!verified) {
      return json({ error: "Could not verify matching WLD transfer in this transaction" }, 400);
    }

    // ---- 3. anti-stale: transfer must postdate the match ----
    const createdMs = Date.parse(matchRow.created_at);
    const block = await provider.getBlock(receipt.blockNumber);
    const transferMs = Number(block.timestamp) * 1000;
    if (Number.isNaN(createdMs) || transferMs < createdMs) {
      return json({ error: "Payment does not match this match (transfer predates the match)" }, 400);
    }

    // ---- 4. record the payment (dedupes tx hash server-side) ----
    const { data: rpcRes, error: rpcErr } = await supabase.rpc("record_verified_payment", {
      p_match_id: matchUuid,
      p_wallet: wallet,
      p_tx_hash: receipt.hash,
    });
    if (rpcErr) {
      return json({ error: rpcErr.message || "Failed to record payment" }, 500);
    }
    if (!rpcRes || rpcRes.success !== true) {
      return json({ error: (rpcRes && rpcRes.error) || "Failed to record payment" }, 400);
    }

    return json({
      success: true,
      verified: true,
      txHash: receipt.hash,
      player: rpcRes.player,
    }, 200);
  } catch (error) {
    console.error("verify-payment error:", error);
    return json({ success: false, error: String((error as Error)?.message || error) }, 500);
  }
});

function json(obj: any, status: number) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
