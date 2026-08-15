import { ethers } from "ethers";

const RPC_URL = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

// Use whichever operator key env var is already set in Vercel — recommend
// standardizing on one name (e.g. OPERATOR_PRIVATE_KEY) across all /api
// files eventually, but this fallback chain keeps things working with
// whatever is currently configured.
const PRIVATE_KEY =
  process.env.OPERATOR_PRIVATE_KEY ||
  process.env.ADMIN_PRIVATE_KEY ||
  process.env.RESOLVER_PRIVATE_KEY;

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const ABI = [
  "function recordDeposit(bytes32 matchId, address player, uint256 fee) external",
  "function matches(bytes32) view returns (address p1, address p2, uint256 fee, uint8 status, uint256 createdAt)",
];

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const MatchStatus = { None: 0, Waiting: 1, Active: 2, Settled: 3, Cancelled: 4 };

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

  const { matchIdBytes32, playerAddress, feeWei, txHash } = req.body;

  if (!matchIdBytes32 || !playerAddress || !feeWei) {
    return res.status(400).json({
      error: "matchIdBytes32, playerAddress and feeWei are required",
    });
  }

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "Operator private key is not configured in Vercel" });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // ------------------------------------------------------------------
    // 1. Verify the payment actually happened on-chain before we ever
    //    tell the contract to book a deposit. We never trust the client
    //    (or even MiniKit's finalPayload status alone) for this.
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
    // 2. Book the deposit on-chain. Idempotent: if the match is already
    //    booked (e.g. an earlier request succeeded but its response was
    //    lost), treat it as success instead of reverting.
    // ------------------------------------------------------------------
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    const onChainMatch = await contract.matches(matchIdBytes32);
    const alreadyBooked =
      Number(onChainMatch.status) !== MatchStatus.None &&
      onChainMatch.p1.toLowerCase() === playerAddress.toLowerCase();

    if (!alreadyBooked) {
      const tx = await contract.recordDeposit(matchIdBytes32, playerAddress, feeWei);
      const depositReceipt = await tx.wait();
      return res.status(200).json({
        success: true,
        txHash: depositReceipt.hash,
      });
    }

    return res.status(200).json({
      success: true,
      txHash: null,
      alreadyBooked: true,
    });
  } catch (error) {
    console.error("record-deposit error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
}
