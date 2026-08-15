import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
const RPC_URL = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

const PRIVATE_KEY =
  process.env.OPERATOR_PRIVATE_KEY ||
  process.env.ADMIN_PRIVATE_KEY ||
  process.env.RESOLVER_PRIVATE_KEY;

const ABI = [
  "function settleMatch(bytes32 matchId, address winner) external",
  "function cancelWaitingMatch(bytes32 matchId) external",
  "function emergencyTokenTransfer(address token, address user, uint256 amount) external",
  "function matches(bytes32) view returns (address p1, address p2, uint256 fee, uint8 status, uint256 createdAt)",
];

const MatchStatus = { None: 0, Waiting: 1, Active: 2, Settled: 3, Cancelled: 4 };

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
  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "Operator private key is not configured" });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    if (action === "REFUND") {
      const onChainMatch = await contract.matches(matchIdBytes32);
      const status = Number(onChainMatch.status);

      // Normal case: deposit was booked, match is waiting, player is p1.
      // cancelWaitingMatch refunds the player's WLD.
      if (status === MatchStatus.Waiting && onChainMatch.p1.toLowerCase() === playerAddress.toLowerCase()) {
        const tx = await contract.cancelWaitingMatch(matchIdBytes32);
        const receipt = await tx.wait();
        return res.status(200).json({ success: true, txHash: receipt.hash, refunded: true });
      }

      // The deposit was never booked on-chain (e.g. record-deposit failed
      // earlier). The WLD is sitting unallocated in the contract — attempt
      // a best-effort refund via the contract's emergency token transfer.
      // This only succeeds if the operator key is the contract owner.
      if (status === MatchStatus.None && feeWei) {
        try {
          const tx = await contract.emergencyTokenTransfer(WLD_TOKEN_CONTRACT, playerAddress, feeWei);
          const receipt = await tx.wait();
          return res.status(200).json({ success: true, txHash: receipt.hash, refunded: true, emergency: true });
        } catch (e) {
          return res.status(500).json({
            success: false,
            error:
              "Match was never booked on-chain and the automatic emergency refund failed (operator is not the contract owner). Please contact support.",
          });
        }
      }

      return res.status(400).json({
        success: false,
        error: `Match not refundable on-chain (status=${status}). If you paid, contact support — an emergency refund is available.`,
      });
    }

    // Default: SETTLE_WINNER — pay the match pot out to the winner.
    const tx = await contract.settleMatch(matchIdBytes32, winnerAddress);
    const receipt = await tx.wait();
    return res.status(200).json({ success: true, txHash: receipt.hash });
  } catch (error) {
    console.error("refund-match error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
