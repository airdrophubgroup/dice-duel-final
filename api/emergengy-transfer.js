import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const RPC_URL = "https://worldchain-mainnet.g.alchemy.com/public";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const ABI = [
  "function emergencyTokenTransfer(address token, address user, uint256 amount) external"
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userAddress, amountInWld } = req.body;

  if (!userAddress || !amountInWld) {
    return res.status(400).json({ error: 'Missing parameters: userAddress and amountInWld are required' });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Emergency transfer ke liye owner/admin ki private key chahiye hogi
    const privateKey = process.env.OWNER_PRIVATE_KEY || process.env.RESOLVER_PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error("Private Key is not set in environment variables");
    }

    const adminWallet = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, adminWallet);

    // Convert WLD amount to Wei (18 decimals)
    const amountWei = ethers.parseUnits(amountInWld.toString(), 18);

    console.log(`Executing emergency transfer of ${amountInWld} WLD to ${userAddress}...`);
    
    // Contract ke emergencyTokenTransfer function ko call karna
    const tx = await contract.emergencyTokenTransfer(WLD_TOKEN_CONTRACT, userAddress, amountWei);
    const receipt = await tx.wait();
    
    console.log(`Emergency transfer successful! TX Hash: ${receipt.hash}`);

    return res.status(200).json({ success: true, txHash: receipt.hash });

  } catch (error) {
    console.error("Emergency transfer error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
