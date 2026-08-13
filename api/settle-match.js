import { ethers } from "ethers";

// Tumhara Escrow Contract Address
const CONTRACT_ADDRESS = "0x529225162b86489fcbD6320b88C4BAEAAE586a67";
const RPC_URL = "https://worldchain-mainnet.g.alchemy.com/public";

// ABI mein hume backend ke liye sirf settleMatch chahiye
const ABI = [
  "function settleMatch(bytes32 matchId, address winner) external"
];

export default async function handler(req, res) {
  // Sirf POST request allow karni hai
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchId, winnerAddress, fee } = req.body;

  if (!matchId || !winnerAddress) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    // 1. Provider setup
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // 2. Vercel Environment Variables se Operator Wallet ka Private Key nikalna
    const privateKey = process.env.OPERATOR_PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error("Operator Private Key is not set in Vercel environment variables");
    }

    const operatorWallet = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, operatorWallet);

    // 3. Supabase UUID (matchId) ko exact ussi bytes32 me convert karna jo frontend ne kiya tha
    const bytes32MatchId = ethers.keccak256(ethers.toUtf8Bytes(matchId));

    console.log(`Settling match ${matchId} for winner ${winnerAddress}...`);
    
    // 4. Contract par settleMatch call karna
    const tx = await contract.settleMatch(bytes32MatchId, winnerAddress);

    // 5. Transaction complete hone ka wait karna
    const receipt = await tx.wait();
    console.log(`Match settled successfully! TX Hash: ${receipt.hash}`);

    return res.status(200).json({ success: true, txHash: receipt.hash });

  } catch (error) {
    console.error("Settlement error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}