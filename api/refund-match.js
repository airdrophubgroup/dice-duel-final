import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
const RPC_URL = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

const PRIVATE_KEY =
  process.env.OPERATOR_PRIVATE_KEY ||
  process.env.ADMIN_PRIVATE_KEY ||
  process.env.RESOLVER_PRIVATE_KEY;

const ABI = [
  "function emergencyTokenTransfer(address token, address user, uint256 amount) external",
];

// The deployed escrow contract (TnvDuelArena) has no operator-side
// "pay the winner" path that works for unbooked matches: settleMatch needs
// an on-chain Active match (only reachable via joinMatch/Permit2, which this
// app deliberately does not use), and cancelWaitingMatch can only be called
// by the p1 player after a 5-minute wait. Every payout/refund therefore goes
// through the owner-only emergencyTokenTransfer — the same path the refund
// resolver cron already uses successfully.

// Winner payout in WLD per entry fee — mirrors app.js calculatePayout()
// exactly, so what the game displays is what the winner receives. The house
// cut (pot minus payout) stays in the contract as operator profit.
const EXACT_PAYOUTS = {
  0.1: 0.17, 0.2: 0.34, 0.5: 0.8, 1: 1.6, 2: 3.2,
  5: 8.8, 10: 17.8, 20: 36.0, 30: 54.0, 40: 72.0, 50: 90.0,
};

function payoutWeiForFee(feeWei) {
  const fee = Number(ethers.formatUnits(feeWei, 18));
  const payout = EXACT_PAYOUTS[fee] ?? Number((fee * 1.6).toFixed(2));
  return ethers.parseUnits(String(payout), 18);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action = "SETTLE_WINNER", matchIdBytes32, playerAddress, winnerAddress, feeWei } = req.body;

  if (!matchIdBytes32) {
    return res.status(400).json({ error: "matchIdBytes32 is required" });
  }
  if (action === "REFUND" && !playerAddress) {
    return res.status(400).json({ error: "playerAddress is required for REFUND" });
  }
  if (action === "SETTLE_WINNER" && !winnerAddress) {
    return res.status(400).json({ error: "winnerAddress is required for SETTLE_WINNER" });
  }
  if (!feeWei) {
    return res.status(400).json({ error: "feeWei is required" });
  }
  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "Operator private key is not configured" });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    if (action === "REFUND") {
      // Player paid WLD into the escrow but the match never started (no
      // opponent, cancelled, or timed out). Send the exact entry fee back
      // via the owner emergency transfer.
      const tx = await contract.emergencyTokenTransfer(WLD_TOKEN_CONTRACT, playerAddress, feeWei);
      const receipt = await tx.wait();
      return res.status(200).json({ success: true, txHash: receipt.hash, refunded: true });
    }

    // SETTLE_WINNER — pay the winner the displayed payout (pot minus house
    // cut). Only the winner's device triggers this (see app.js), and the
    // app's sessionStorage guard prevents a duplicate on the same device.
    const payoutWei = payoutWeiForFee(feeWei);
    const tx = await contract.emergencyTokenTransfer(WLD_TOKEN_CONTRACT, winnerAddress, payoutWei);
    const receipt = await tx.wait();
    return res.status(200).json({
      success: true,
      txHash: receipt.hash,
      action: "SETTLE_WINNER",
      payoutWld: ethers.formatUnits(payoutWei, 18),
    });
  } catch (error) {
    console.error("refund-match error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
