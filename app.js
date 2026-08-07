import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";

const supabaseClient = createClient(SB_URL, SB_KEY);

let myAddress = "", myUsername = "";
let currentWldBalance = 0;

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
  showPhoneDebug("Checking environment & providers...", false);
  
  // Initialize MiniKit safely if available globally
  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
    showPhoneDebug("MiniKit detected successfully.", false);
  } else if (window.ethereum) {
    showPhoneDebug("Injected provider detected.", false);
  } else {
    showPhoneDebug("No provider auto-detected. Ready for click auth.");
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

async function performWalletAuth() {
  showPhoneDebug("Starting authentication...", false);

  // Flow A: World App MiniKit Auth
  try {
    if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
      showPhoneDebug("Triggering MiniKit walletAuth...", false);
      const res = await MiniKit.commandsAsync.walletAuth({
        nonce: Math.random().toString(36).substring(2),
        statement: "Connect to Dice Duel TNV Arena",
        expirationTime: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
      });

      if (res && res.finalPayload) {
        await setUserData(res.finalPayload.username || '@WorldUser', res.finalPayload.address);
        return true;
      }
    }
  } catch (err) {
    showPhoneDebug("MiniKit Auth Error: " + err.message);
  }

  // Flow B: Standard Injected Provider (window.ethereum)
  if (window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts.length > 0) {
        let shortAddr = accounts[0].substring(0, 6) + '...' + accounts[0].substring(38);
        await setUserData('@User_' + shortAddr, accounts[0]);
        return true;
      }
    } catch (err) {
      showPhoneDebug("Provider error: " + err.message);
    }
  }

  // Flow C: Manual Wallet Prompt Fallback
  let manualWallet = prompt("Provider not found. Enter your Wallet Address:", "0x");
  if (manualWallet && manualWallet.startsWith("0x") && manualWallet.length > 10) {
    await setUserData('@Player', manualWallet.trim());
    return true;
  }
  
  return false;
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
  
  showPhoneDebug("Connected: " + myAddress + " | WLD: " + wldBal, false);
}

async function handlePlayButtonClick() {
  showPhoneDebug("Play button clicked.", false);
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) return;
  }
  alert("Connected & Ready!\nUser: " + myUsername + "\nAddress: " + myAddress + "\nWLD Balance: " + currentWldBalance);
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);