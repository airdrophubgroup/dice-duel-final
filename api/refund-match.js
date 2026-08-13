import { ethers } from "ethers";

// Tumhara Escrow Contract Address
const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const RPC_URL = "https://worldchain-mainnet.g.alchemy.com/public";

// Contract ke actual cancelWaitingMatch function ke hisab se ABI
const ABI = [
  "function cancelWaitingMatch(bytes32 matchId) external"
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchId } = req.body;

  if (!matchId) {
    return res.status(400).json({ error: 'Missing parameters: matchId is required' });
  }

  try {
    // 1. Provider setup
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // 2. Environment Variable se Private Key nikalna
    const privateKey = process.env.RESOLVER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error("Private Key is not set in environment variables");
    }

    const operatorWallet = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, operatorWallet);

    // 3. Frontend ke matching SHA-256 logic se matchId ko bytes32 mein convert karna
    const encoder = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(matchId));
    const bytes32MatchId = '0x' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    console.log(`Cancelling waiting match ${matchId}...`);
    
    // 4. Contract par cancelWaitingMatch function call karna
    const tx = await contract.cancelWaitingMatch(bytes32MatchId);

    // 5. Transaction complete hone ka wait karna
    const receipt = await tx.wait();
    console.log(`Match cancelled successfully! TX Hash: ${receipt.hash}`);

    return res.status(200).json({ success: true, txHash: receipt.hash });

  }catch (error) {
    console.error("Refund error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
