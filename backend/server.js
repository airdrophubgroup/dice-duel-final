import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://efmkazyrxllcyvcwmewd.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "YOUR_SUPABASE_SERVICE_ROLE_KEY";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Worldchain RPC & Wallet Setup
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || "YOUR_WALLET_PRIVATE_KEY";

let provider, wallet, wldContract;

try {
  provider = new ethers.JsonRpcProvider(WORLDCHAIN_RPC);
  wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  
  const ERC20_ABI = [
    "function transfer(address to, uint256 value) public returns (bool)",
    "function balanceOf(address account) view returns (uint256)"
  ];

  wldContract = new ethers.Contract(WLD_TOKEN_CONTRACT, ERC20_ABI, wallet);
} catch (e) {
  console.error("Blockchain/Wallet initialization error:", e.message);
}

// AUTOMATIC REFUND BACKGROUND LOOP (Runs every 30 seconds)
async function processAutomaticRefunds() {
  if (!wldContract) return;
  try {
    const { data: expiredMatches, error } = await supabase.rpc('get_expired_waiting_matches');
    
    if (error || !expiredMatches || expiredMatches.length === 0) return;

    for (let match of expiredMatches) {
      console.log(`Processing auto refund for match: ${match.id} to user: ${match.p1_address}`);

      try {
        const feeAmountWei = ethers.parseUnits(match.fee.toString(), 18);

        // 1. Blockchain par automatic WLD transfer (Refund)
        const tx = await wldContract.transfer(match.p1_address, feeAmountWei);
        await tx.wait();

        console.log(`Refund success! Tx Hash: ${tx.hash}`);

        // 2. History table mein log entry add karein
        await supabase.from('match_history').insert({
          wallet_address: match.p1_address.toLowerCase(),
          action_type: 'AUTO_REFUND',
          amount: match.fee,
          description: `Automatic refund for match ${match.id}`,
          created_at: new Date().toISOString()
        });

        // 3. Refund successful hone ke baad matches table se row delete kar dein
        await supabase
          .from('matches')
          .delete()
          .eq('id', match.id);

        console.log(`Match ${match.id} refunded and cleaned up from matches table.`);

      } catch (err) {
        console.error(`Failed to refund match ${match.id}:`, err.message);
      }
    }
  } catch (e) {
    console.error("Error in auto refund loop:", e.message);
  }
}

// Run check every 30 seconds
setInterval(processAutomaticRefunds, 30000);

app.get('/', (req, res) => {
  res.send('TNV Duel Arena Backend & Auto-Refund Server is Running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is successfully running on port ${PORT}`);
});