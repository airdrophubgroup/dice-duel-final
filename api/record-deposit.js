import { ethers } from "ethers";

const RPC_URL = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const SB_URL = process.env.SUPABASE_URL || "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// Look up when the match was created so the verified transfer must be
// NEWER than the match. This kills the stale-payment hole: a player who
// paid for an earlier match (within the scan window) must not be able to
// start a new match without paying and have the old transfer verify it.
async function fetchMatchCreatedAt(matchUuid) {
  const url = `${SB_URL}/rest/v1/matches?select=created_at&id=eq.${encodeURIComponent(matchUuid)}`;
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0 ? rows[0].created_at : null;
}

// The deployed escrow contract (TnvDuelArena) does NOT have a recordDeposit
// function — booking on-chain would require the player to call joinMatch via
// Permit2, which this app intentionally does not use (it conflicts with the
// 1-minute auto-refund requirement, since the contract enforces a 5-minute
// wait for p1 cancel). The escrow contract is therefore used purely as the
// WLD holding wallet: Supabase (p1_paid / p2_paid) is the match ledger and
// all payouts/refunds are owner-operated emergency transfers.
//
// This endpoint's ONLY job is to verify the player's WLD payment actually
// arrived on-chain — never trust MiniKit's status alone. It scans recent
// WLD transfers from the player to the escrow contract at the exact fee.

// Scan recent on-chain WLD transfers for a payment of exactly `feeWei`
// from `playerAddress` to the escrow contract. Used as a fallback when
// the client-reported tx hash cannot be resolved on-chain — MiniKit's
// transaction_id is not always the on-chain hash, and the payment must
// never be missed just because the client couldn't report the hash.
async function findPaymentTxHash(provider, playerAddress, feeWei) {
  const latest = await provider.getBlockNumber();
  const iface = new ethers.Interface(ERC20_ABI);
  const transferTopic = iface.getEvent("Transfer").topicHash;
  const fromTopic = ethers.zeroPadValue(playerAddress.toLowerCase(), 32);
  const toTopic = ethers.zeroPadValue(CONTRACT_ADDRESS.toLowerCase(), 32);

  // The public World Chain RPC caps eth_getLogs at ~100 blocks per call,
  // so walk backwards in 100-block chunks (3 chunks ≈ 10 minutes).
  const CHUNK = 90;
  const CHUNKS = 3;
  for (let c = 0; c < CHUNKS; c++) {
    const toBlock = latest - c * 100;
    const fromBlock = Math.max(0, toBlock - CHUNK);
    let logs = [];
    try {
      logs = await provider.getLogs({
        address: WLD_TOKEN_CONTRACT,
        topics: [transferTopic, fromTopic, toTopic],
        fromBlock,
        toBlock,
      });
    } catch (e) {
      // skip a failed chunk and keep looking in older blocks
      continue;
    }

    // Logs come back oldest → newest; iterate backwards to prefer the
    // most recent identical payment (the one the user just made).
    for (let i = logs.length - 1; i >= 0; i--) {
      const parsed = iface.parseLog(logs[i]);
      if (parsed && parsed.args.value.toString() === feeWei.toString()) {
        return logs[i].transactionHash;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { matchIdBytes32, matchUuid, playerAddress, feeWei, txHash } = req.body;

  if (!matchIdBytes32 || !matchUuid || !playerAddress || !feeWei) {
    return res.status(400).json({
      error: "matchIdBytes32, matchUuid, playerAddress and feeWei are required",
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // ------------------------------------------------------------------
    // 1. Verify the payment actually happened on-chain. We never trust
    //    the client (or even MiniKit's finalPayload status alone).
    //
    //    Path A — the reported txHash resolves to a confirmed receipt.
    //    Path B — scan recent Transfer logs for player → contract at
    //             exactly `feeWei` (covers the case where MiniKit's
    //             transaction_id is not the on-chain tx hash).
    // ------------------------------------------------------------------
    let receipt = null;

    if (txHash) {
      const maxAttempts = 8;
      const delayMs = 1500;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) break;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    if (!receipt || receipt.status !== 1) {
      const foundHash = await findPaymentTxHash(provider, playerAddress, feeWei);
      if (foundHash) {
        receipt = await provider.getTransactionReceipt(foundHash);
      }
    }

    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({
        error:
          "Could not find the WLD payment on-chain. If you completed the payment, it will be refunded automatically.",
      });
    }

    // 2. Confirm the receipt contains the exact Transfer (player → escrow
    //    contract, value = feeWei) before declaring the payment verified.
    const iface = new ethers.Interface(ERC20_ABI);
    let verified = false;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== WLD_TOKEN_CONTRACT.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (
          parsed.name === "Transfer" &&
          parsed.args.from.toLowerCase() === playerAddress.toLowerCase() &&
          parsed.args.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
          parsed.args.value.toString() === feeWei.toString()
        ) {
          verified = true;
          break;
        }
      } catch (e) {
        // not a Transfer log from this token, skip
      }
    }

    if (!verified) {
      return res.status(400).json({
        error: "Could not verify matching WLD transfer in this transaction",
      });
    }

    // ------------------------------------------------------------------
    // 3. Anti-stale check: the transfer must have happened AFTER this
    //    match was created. Otherwise a player who paid for an earlier
    //    match could start a new match without paying and have the old
    //    transfer verify it (then claim a refund they never deposited).
    // ------------------------------------------------------------------
    const createdAt = await fetchMatchCreatedAt(matchUuid);
    if (!createdAt) {
      return res.status(400).json({
        error: "Could not load match to validate payment timing",
      });
    }
    const createdMs = Date.parse(createdAt);
    const block = await provider.getBlock(receipt.blockNumber);
    const transferMs = Number(block.timestamp) * 1000;
    if (Number.isNaN(createdMs) || transferMs < createdMs) {
      return res.status(400).json({
        error: "Payment does not match this match (transfer predates the match)",
      });
    }

    // Verified — the app then marks p1_paid / p2_paid in Supabase (the
    // ledger of record). No on-chain booking happens here.
    return res.status(200).json({
      success: true,
      verified: true,
      txHash: receipt.hash,
    });
  } catch (error) {
    console.error("record-deposit error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
}
