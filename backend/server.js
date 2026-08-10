const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

const app = express();
app.use(express.json());

const SUPABASE_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "YOUR_SUPABASE_SERVICE_ROLE_KEY";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const provider = new ethers.JsonRpcProvider(WORLDCHAIN_RPC);
let wallet = null;
let wldContract = null;

if (process.env.WALLET_PRIVATE_KEY) {
  try {
    wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
    const erc20Abi = ["function transfer(address to, uint256 value) public returns (bool)"];
    wldContract = new ethers.Contract(WLD_TOKEN_CONTRACT, erc20Abi, wallet);
    console.log("Wallet loaded successfully for auto-refunds!");
  } catch (err) {
    console.log("Wallet initialization failed, check private key.");
  }
}

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

        // 2. History me log entry add karein
        await supabase.from('match_history').insert({
          wallet_address: match.p1_address.toLowerCase(),
          action_type: 'AUTO_REFUND',
          amount: match.fee,
          description: `Automatic timeout refund for match ${match.id}`,
          created_at: new Date().toISOString()
        });

        // 3. Refund successful hone ke baad active matches table se row delete kar dein
        await supabase
          .from('matches')
          .delete()
          .eq('id', match.id);

        console.log(`Match ${match.id} refunded and cleaned up from matches table.`);

      } catch (err) {
        console.error(`Failed to refund match ${match.id}:`, err);
      }
    }
  } catch (e) {
    console.error("Error in auto refund loop:", e);
  }
}

setInterval(processAutomaticRefunds, 30000);

app.post('/api/proxy-request', async (req, res) => {
  try {
    const { action, to, data } = req.body;

    if (action === 'eth_call') {
      const response = await fetch(WORLDCHAIN_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
          id: 1
        })
      });

      const result = await response.json();
      return res.json(result);
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    return res.status(500).json({ error: 'Proxy server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy & Auto-Refund server running on port ${PORT}`));