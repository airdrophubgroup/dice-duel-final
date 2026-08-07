import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { MiniKit } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@1.9.4/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";

const supabaseClient = createClient(SB_URL, SB_KEY);

// MiniKit.isInstalled() ALWAYS returns false until install() has been
// called first — even when running inside World App. Old code relied
// on a <script> tag that loaded a CDN path (dist/minikit.min.js) which
// doesn't reliably exist for this SDK anymore — that's why MiniKit was
// silently undefined. Importing it directly as an ES module fixes that.
MiniKit.install(WORLD_APP_ID);

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

// World App injects MiniKit asynchronously, so poll briefly instead of
// checking once on DOMContentLoaded (that race is why auth used to silently
// fall through to the insecure manual-address prompt on some devices).
function waitForMiniKit(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (MiniKit.isInstalled()) {
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        resolve(false);
      } else {
        setTimeout(check, 100);
      }
    })();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  showPhoneDebug("Checking environment & providers...", false);

  if (await waitForMiniKit()) {
    showPhoneDebug("MiniKit detected successfully.", false);
  } else if (window.ethereum) {
    showPhoneDebug("Injected provider detected (browser test mode).", false);
  } else {
    showPhoneDebug("Open inside World App to connect your wallet.");
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

  // Flow A: World App MiniKit — proper SIWE wallet auth (this is the
  // real "connect like other World mini apps" flow: the user signs a
  // message inside World App, and we get back a signed address.
  const miniKitReady = await waitForMiniKit(1500);
  if (miniKitReady) {
    try {
      showPhoneDebug("Triggering MiniKit walletAuth...", false);
      const nonce = crypto.randomUUID().replace(/-/g, '');
      const { finalPayload } = await MiniKit.commandsAsync.walletAuth({
        nonce,
        statement: "Connect to Dice Duel TNV Arena",
        expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        notBefore: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      if (finalPayload && finalPayload.status === 'success') {
        const uname = MiniKit.user?.username ? '@' + MiniKit.user.username : '@WorldUser';
        await setUserData(uname, finalPayload.address);
        return true;
      }
      showPhoneDebug("MiniKit auth was cancelled or failed.");
      return false;
    } catch (err) {
      showPhoneDebug("MiniKit Auth Error: " + err.message);
      return false;
    }
  }

  // Flow B: Standard injected provider (MetaMask etc.) — useful only
  // when testing in a normal desktop/mobile browser, not inside World App.
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
    return false;
  }

  // No provider available: guide the user instead of trusting a typed-in
  // address. (The old "manual entry" fallback let anyone type ANY address —
  // including the hardcoded ADMIN_WALLET — and be treated as that wallet
  // with zero proof of ownership. Removed for that reason.)
  showPhoneDebug("No wallet found — open this app inside World App.");
  alert("Please open this app inside the World App to connect your wallet.");
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
    const btn = $('start-btn');
    const originalText = btn ? btn.innerText : null;
    if (btn) { btn.disabled = true; btn.innerText = "Connecting..."; }
    const connected = await performWalletAuth();
    if (btn) { btn.disabled = false; if (originalText) btn.innerText = originalText; }
    if (!connected) return;
  }
  alert("Connected & Ready!\nUser: " + myUsername + "\nAddress: " + myAddress + "\nWLD Balance: " + currentWldBalance);
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);