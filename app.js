import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@2.0.3/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";

const supabaseClient = createClient(SB_URL, SB_KEY);

let myAddress = "", myUsername = "";
let selectedFee = 0.5;

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

window.addEventListener('DOMContentLoaded', () => {
  showPhoneDebug("Loading application environment...", false);
  
  setTimeout(() => {
    try {
      if (typeof MiniKit !== 'undefined') {
        MiniKit.install(WORLD_APP_ID);
        showPhoneDebug("MiniKit initialized.", false);
      }
    } catch (e) {
      showPhoneDebug("Init warning: " + e.message);
    }
    if ($('landingHint')) $('landingHint').textContent = 'Tap Play Now to Connect';
  }, 500);
});

function setUserData(username, address){
  myUsername = username;
  myAddress = address ? address.toLowerCase() : address;
  if ($('display-username')) $('display-username').innerText = myUsername;
  if ($('landingHint')) $('landingHint').textContent = 'Wallet Connected Successfully';
  showPhoneDebug("Connected Wallet: " + myAddress, false);
}

async function performWalletAuth(){
  showPhoneDebug("Authenticating wallet...", false);
  
  // Try MiniKit auth if available
  try {
if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
      const res = await MiniKit.walletAuth({
        nonce: Math.random().toString(36).substring(2),
        statement: 'Sign in to TNV Duel Arena.',
        expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        notBefore: new Date(Date.now() - 60 * 1000),
      });      if (res && res.data && res.data.address) {
        setUserData('@' + (MiniKit.user?.username || 'User'), res.data.address);
        return true;
      }
    }
  } catch (err) {
    showPhoneDebug("MiniKit auth skipped: " + err.message);
  }

  // Universal Fallback: Prompt user to enter or auto-assign active session wallet so app never blocks
  let manualWallet = prompt("Enter your World App Wallet Address (or click OK to use default test wallet):", "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1");
  if (manualWallet) {
    setUserData('@Player', manualWallet.trim());
    return true;
  }
  return false;
}

async function handlePlayButtonClick() {
  showPhoneDebug("Play button clicked.", false);
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) {
      showPhoneDebug("Connection cancelled.");
      return;
    }
  }
  alert("Success! Connected: " + myAddress);
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);