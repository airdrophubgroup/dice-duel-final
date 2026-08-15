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
];

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { matchIdBytes32, playerAddress, feeWei, txHash } = req.body;

  if (!matchIdBytes32 || !playerAddress || !feeWei || !txHash) {
    return res.status(400).json({
      error: "matchIdBytes32, playerAddress, feeWei, and txHash are all required",
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
    //    (or even MiniKit's finalPayload status alone) for this — we
    //    re-check the transaction receipt ourselves.
    // ------------------------------------------------------------------
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({
        error: "Transaction not found or not confirmed on-chain",
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
    // 2. Payment confirmed — now book the deposit on-chain (moves the
    //    match into Waiting/Active state). This does NOT move any more
    //    tokens; the WLD already arrived in step 1's transaction.
    // ------------------------------------------------------------------
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    const tx = await contract.recordDeposit(matchIdBytes32, playerAddress, feeWei);
    const depositReceipt = await tx.wait();

    return res.status(200).json({
      success: true,
      txHash: depositReceipt.hash,
    });
  } catch (error) {
    console.error("record-deposit error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
}