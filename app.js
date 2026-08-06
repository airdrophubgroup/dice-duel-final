const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";

let myAddress = "", myUsername = "", matchId, isP1, myScore = 0, oppScore = 0;
let gameActive = false, matchmakingActive = false, channel, globalChatChannel, mTimer, pollTimer, gameTimerInterval;
let selectedFee = 0.5;
let realWorldIdUser = false;
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
    dbg.style.cssText = 'position:fixed; bottom:10px; left:10px; right:10px; z-index:99999; background:rgba(0,0,0,0.92); border:1.5px solid ' + (isError ? '#ff5f6d' : '#29d9c2') + '; color:#fff; padding:10px; border-radius:10px; font-family:monospace; font-size:10.5px; max-height:120px; overflow-y:auto; word-break:break-all;';
    document.body.appendChild(dbg);
  }
  dbg.innerHTML += `<div>[${new Date().toLocaleTimeString()}] ${msg}</div>`;
  dbg.scrollTop = dbg.scrollHeight;
}

window.addEventListener('DOMContentLoaded', async () => {
  showPhoneDebug("App starting (Standard JS)...", false);
  
  try {
    if (window.MiniKit) {
      window.MiniKit.install(WORLD_APP_ID);
      showPhoneDebug("MiniKit installed successfully.", false);
    } else {
      showPhoneDebug("MiniKit global object not found!");
    }
  } catch (e) {
    showPhoneDebug("Init error: " + e.message);
  }

  if (window.MiniKit && window.MiniKit.isInstalled()) {
    showPhoneDebug("MiniKit isInstalled = TRUE", false);
    if (window.MiniKit.user && window.MiniKit.user.walletAddress) {
      setUserData('@' + (window.MiniKit.user.username || 'User'), window.MiniKit.user.walletAddress);
    } else {
      if ($('landingHint')) $('landingHint').textContent = 'Tap Play Now to Connect Wallet';
    }
  } else {
    showPhoneDebug("Not inside World App environment.");
    if ($('landingHint')) $('landingHint').textContent = '⚠️ Please open inside World App';
  }

  fetchLeaderboard();
});

function randomAlphaNumeric(len){
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function setUserData(username, address){
  myUsername = username;
  myAddress = address ? address.toLowerCase() : address;
  if ($('display-username')) $('display-username').innerText = myUsername;
  if ($('my-name-tag')) $('my-name-tag').innerText = myUsername;
  if ($('landingHint')) $('landingHint').textContent = 'Wallet Connected Successfully';
  showPhoneDebug("User set: " + myAddress, false);
}

async function performWalletAuth(){
  showPhoneDebug("performWalletAuth called", false);
  if (!window.MiniKit || !window.MiniKit.isInstalled()) {
    alert("Please open this app inside World App.");
    return false;
  }

  if (myAddress) return true;

  try {
    const result = await window.MiniKit.walletAuth({
      nonce: randomAlphaNumeric(16),
      statement: 'Sign in to TNV Duel Arena.',
      expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      notBefore: new Date(Date.now() - 60 * 1000),
    });

    showPhoneDebug("Auth result: " + JSON.stringify(result), false);

    if (result && result.data && result.data.address) {
      realWorldIdUser = true;
      const address = result.data.address;
      const username = '@' + (window.MiniKit.user?.username || 'User_' + address.substring(2, 6));
      setUserData(username, address);
      return true;
    }
    return false;
  } catch (err) {
    showPhoneDebug("Auth catch error: " + err.message);
    return false;
  }
}

async function handlePlayButtonClick() {
  showPhoneDebug("Play button clicked", false);
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) {
      showPhoneDebug("Wallet connection failed on click.");
      return;
    }
  }
  alert("Wallet connected successfully! Ready for action.");
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);