import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";

const supabaseClient = createClient(SB_URL, SB_KEY);

let myAddress = "", myUsername = "";
let selectedFee = 0.5;
let currentWldBalance = 0;
let currentTnvBalance = 0;

const $ = (id) => document.getElementById(id);

function showPhoneDebug(msg, isError = true) {
  let dbg = $('phone-debug-box');
  if (!dbg) {
    dbg = document.createElement('div');
    dbg.id = 'phone-debug-box';
    dbg.style.cssText = 'position:fixed; bottom:10px; left:10px; right:10px; z-index:99999; background:rgba(0,0,0,0.95); border:1.5px solid ' + (isError ? '#ff5f6d' : '#29d9c2') + '; color:#fff; padding:10px; border-radius:10px; font-family:monospace; font-size:10.5px; max-height:120px; overflow-y:auto; word-break:break-all;';
    document.body.appendChild(dbg);
  }
  dbg.innerHTML += `<div>[${new Date().toLocaleTimeString()}] ${msg}</div>`;
  dbg.scrollTop = dbg.scrollHeight;
}

window.addEventListener('DOMContentLoaded', async () => {
  showPhoneDebug("App loaded with Direct Provider mode.", false);
  
  // Check if window.ethereum (World App Injected Provider) is available
  if (window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts && accounts.length > 0) {
        await setUserData('@WorldUser', accounts[0]);
      } else {
        if ($('landingHint')) $('landingHint').textContent = 'Tap Play Now to Connect Wallet';
      }
    } catch (e) {
      showPhoneDebug("Auto-detect error: " + e.message);
    }
  } else {
    showPhoneDebug("Injected provider not found yet. Click Play Now to connect.");
  }
});

async function fetchRealWldBalance(walletAddress) {
  if (!walletAddress || walletAddress.trim() === '') return 0;
  try {
    const response = await fetch('https://worldchain-mainnet.g.alchemy.com/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{
          to: '0x2cfc85d892bab34f634e84b5c7774e30b6a1548e',
          data: '0x70a08231000000000000000000000000' + walletAddress.replace('0x', '')
        }, 'latest'],
        id: 1
      })
    });
    const result = await response.json();
    if (result.result) {
      const balanceWei = BigInt(result.result);
      const balanceWld = Number(balanceWei) / 1e18; 
      currentWldBalance = balanceWld;
      return currentWldBalance;
    }
  } catch (error) {
    showPhoneDebug("WLD Balance error: " + error.message);
  }
  return 0;
}

async function setUserData(username, address){
  myUsername = username;
  myAddress = address ? address.toLowerCase() : address;
  if ($('display-username')) $('display-username').innerText = myUsername;
  if ($('landingHint')) $('landingHint').textContent = 'Wallet Connected Successfully';
  
  showPhoneDebug("Fetching real WLD balance...", false);
  let wldBal = await fetchRealWldBalance(myAddress);
  
  const wldDisp = $('wld-balance-num') || $('wld-balance');
  if (wldDisp) {
    wldDisp.innerText = Number(wldBal).toFixed(4) + " WLD";
  }
  showPhoneDebug("Wallet Connected: " + myAddress + " | WLD: " + wldBal, false);
}

async function performWalletAuth(){
  showPhoneDebug("Requesting wallet connection...", false);
  
  if (window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts.length > 0) {
        await setUserData('@WorldUser', accounts[0]);
        return true;
      }
    } catch (err) {
      showPhoneDebug("Request accounts error: " + err.message);
    }
  }

  // Fallback direct prompt if injected provider is restricted in webview
  let manualWallet = prompt("Enter your World App Wallet Address:", "0x");
  if (manualWallet && manualWallet.startsWith("0x") && manualWallet.length > 10) {
    await setUserData('@Player', manualWallet.trim());
    return true;
  }
  
  alert("Please open inside World App or provide a valid wallet address.");
  return false;
}

async function handlePlayButtonClick() {
  showPhoneDebug("Play button clicked.", false);
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) return;
  }
  alert("Connected & Ready! Address: " + myAddress + "\nWLD Balance: " + currentWldBalance);
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);