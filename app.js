import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";

const supabaseClient = createClient(SB_URL, SB_KEY);

let myAddress = "", myUsername = "", matchId, isP1, myScore = 0, oppScore = 0;
let gameActive = false, matchmakingActive = false, channel, globalChatChannel, mTimer, pollTimer, gameTimerInterval;
let selectedFee = 0.5;
let currentTnvBalance = 0;
let currentWldBalance = 0;
let myTurnsLeft = 15;
let isTimingLocked = false;
let activeAdminReqId = "";

const CHAT_STORAGE_KEY = "tnv_global_chat_history";
const CHAT_EXPIRY_MS = 24 * 60 * 60 * 1000;

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
  showPhoneDebug("App loaded with Native Injected Provider.", false);
  
  // Check if injected ethereum provider exists (World App webview injects it)
  if (window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts && accounts.length > 0) {
        setUserData('@User', accounts[0]);
      } else {
        if ($('landingHint')) $('landingHint').textContent = 'Tap Play Now to Connect Wallet';
      }
    } catch (e) {
      showPhoneDebug("Account check error: " + e.message);
    }
  } else {
    showPhoneDebug("No window.ethereum detected. Please open inside World App.");
    if ($('landingHint')) $('landingHint').textContent = '⚠️ Please open inside World App';
  }

  fetchLeaderboard();
});

function setUserData(username, address){
  myUsername = username;
  myAddress = address ? address.toLowerCase() : address;
  if ($('display-username')) $('display-username').innerText = myUsername;
  if ($('landingHint')) $('landingHint').textContent = 'Wallet Connected Successfully';
  showPhoneDebug("Wallet Connected: " + myAddress, false);
}

// Native Wallet Connection using standard EIP-1193 request
async function performWalletAuth(){
  showPhoneDebug("Connecting wallet natively...", false);
  
  if (!window.ethereum) {
    alert("Please open this app inside World App.");
    return false;
  }

  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts && accounts.length > 0) {
      setUserData('@User', accounts[0]);
      return true;
    }
    return false;
  } catch (err) {
    showPhoneDebug("Wallet connection error: " + err.message);
    alert("Wallet connection failed: " + err.message);
    return false;
  }
}

async function handlePlayButtonClick() {
  showPhoneDebug("Play button clicked", false);
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) return;
  }
  alert("Connected! Address: " + myAddress);
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);