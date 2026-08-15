import { ethers } from "ethers";

const RPC_URL = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const ABI = [
  "function recordDeposit(bytes32 matchId, address player, uint256 fee) external"
];

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchIdBytes32, playerAddress, feeWei, txHash } = req.body;
  if (!matchIdBytes32 || !playerAddress || !feeWei || !txHash) {
    return res.status(400).json({ error: 'matchIdBytes32, playerAddress, feeWei, txHash required' });
  }
  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: 'ADMIN_PRIVATE_KEY is not configured' });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // 1. Verify the payment transaction actually happened on-chain
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction not found or failed on-chain' });
    }

    // 2. Verify it's a real WLD transfer: from=player, to=contract, amount=feeWei
    const iface = new ethers.Interface(ERC20_ABI);
    let verified = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== WLD_TOKEN_CONTRACT.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (
          parsed.name === 'Transfer' &&
          parsed.args.from.toLowerCase() === playerAddress.toLowerCase() &&
          parsed.args.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
          parsed.args.value.toString() === feeWei.toString()
        ) {
          verified = true;
          break;
        }
      } catch (e) {}
    }

    if (!verified) {
      return res.status(400).json({ error: 'Could not verify matching WLD transfer in this transaction' });
    }

    // 3. Now book the deposit on-chain (moves match into Waiting/Active state)
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
    const tx = await contract.recordDeposit(matchIdBytes32, playerAddress, feeWei);
    await tx.wait();

    return res.status(200).json({ success: true, txHash: tx.hash });
  } catch (error) {
    console.error("recordDeposit error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}