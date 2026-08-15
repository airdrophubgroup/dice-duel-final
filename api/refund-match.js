import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";

const RPC_URL = process.env.WORLDCHAIN_RPC || "https://worldchain-mainnet.g.alchemy.com/public";
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const PAYMENT_RECV_WALLET = "0x8FB70CDFb545C7D9b842cBE37B9aba84059Bf14b";

// SERVER-SIDE Supabase client - service_role key use karo (frontend wali anon key NAHI)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // Vercel env var mein set karo, kabhi frontend mein mat daalo
);

const ABI = [
  "function cancelWaitingMatch(bytes32 matchId) external",
  "function settleMatch(bytes32 matchId, address winner) external",
  "function withdrawPlatformFees(address to) external"
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { matchIdBytes32, action, winnerAddress, matchDbId } = req.body;
  if (!matchIdBytes32 || !matchDbId) {
    return res.status(400).json({ error: 'matchIdBytes32 and matchDbId are required' });
  }
  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: 'ADMIN_PRIVATE_KEY is not configured in Vercel' });
  }

  try {
    // ================================
    // CRITICAL: DB se verify karo, client ki baat par bharosa mat karo
    // ================================
    const { data: match, error: dbErr } = await supabaseAdmin
      .from('matches')
      .select('*')
      .eq('id', matchDbId)
      .single();

    if (dbErr || !match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (action === 'SETTLE_WINNER') {
      // Match sach me completed hai? Winner sach me isi match ka player hai?
      if (match.status !== 'completed') {
        return res.status(400).json({ error: 'Match is not completed yet' });
      }
      const validWinner = (winnerAddress?.toLowerCase() === match.p1_address?.toLowerCase() ||
                            winnerAddress?.toLowerCase() === match.p2_address?.toLowerCase());
      if (!validWinner) {
        return res.status(400).json({ error: 'winnerAddress is not a player in this match' });
      }
      if (match.settled) {
        return res.status(400).json({ error: 'Match already settled - duplicate request blocked' });
      }

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

      const tx = await contract.settleMatch(matchIdBytes32, winnerAddress);
      await tx.wait();

      // Mark settled taaki dobara request na chal sake
      await supabaseAdmin.from('matches').update({ settled: true }).eq('id', matchDbId);

      try {
        const feeTx = await contract.withdrawPlatformFees(PAYMENT_RECV_WALLET);
        await feeTx.wait();
      } catch (feErr) {
        console.warn("Auto-fee transfer notice:", feErr.message);
      }

      return res.status(200).json({ success: true, action: 'SETTLE_COMPLETED', txHash: tx.hash });

    } else if (action === 'CANCEL_REFUND') {
      if (match.status === 'completed') {
        return res.status(400).json({ error: 'Match already completed, cannot refund' });
      }
      if (match.settled) {
        return res.status(400).json({ error: 'Already refunded - duplicate request blocked' });
      }

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

      const tx = await contract.cancelWaitingMatch(matchIdBytes32);
      await tx.wait();

      await supabaseAdmin.from('matches').update({ settled: true }).eq('id', matchDbId);

      return res.status(200).json({ success: true, action: 'REFUND_COMPLETED', txHash: tx.hash });
    } else {
      return res.status(400).json({ error: 'Invalid action provided' });
    }
  } catch (error) {
    console.error("Smart Contract Execution Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}