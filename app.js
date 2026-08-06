import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@2.0.3/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";

const supabaseClient = createClient(SB_URL, SB_KEY);

let myAddress = "", myUsername = "", matchId, isP1, myScore = 0, oppScore = 0;
let gameActive = false, matchmakingActive = false, channel, globalChatChannel, mTimer, pollTimer, gameTimerInterval;
let selectedFee = 0.5;
let realWorldIdUser = false;
let currentTnvBalance = 0;
let currentWldBalance = 0;
let myTurnsLeft = 15;
let isTimingLocked = false;
let activeAdminReqId = "";

const $ = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  try { 
    MiniKit.install(WORLD_APP_ID); 
  } catch(e) {}

  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
    if (MiniKit.user && MiniKit.user.walletAddress) {
      setUserData('@' + (MiniKit.user.username || 'User'), MiniKit.user.walletAddress);
    } else {
      if ($('landingHint')) $('landingHint').textContent = 'Tap Play Now to Connect Wallet';
    }
  } else {
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
  fetchUserBalanceAndLeaderboard(myAddress);
}

async function performWalletAuth(){
  if (!MiniKit.isInstalled()) {
    alert("Please open this app inside World App.");
    return false;
  }

  if (myAddress) return true;

  try {
    const result = await MiniKit.walletAuth({
      nonce: randomAlphaNumeric(16),
      statement: 'Sign in to TNV Duel Arena.',
      expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      notBefore: new Date(Date.now() - 60 * 1000),
    });

    if (result && result.data && result.data.address) {
      realWorldIdUser = true;
      const address = result.data.address;
      const username = '@' + (MiniKit.user?.username || 'User_' + address.substring(2, 6));
      setUserData(username, address);
      return true;
    }
    return false;
  } catch (err) {
    console.error("Wallet auth error:", err);
    alert("Wallet connection failed: " + (err.message || "Unknown error"));
    return false;
  }
}

async function fetchRealWldBalance(walletAddress) {
  if (!walletAddress) return 0;
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
    const resJson = await response.json();
    if (resJson.result) {
      return Number(BigInt(resJson.result)) / 1e18;
    }
  } catch (error) {
    console.error("Balance fetch error:", error);
  }
  return 0;
}

async function fetchUserBalanceAndLeaderboard(wallet) {
  if (!wallet) return;
  try {
    const cleanWallet = wallet.toLowerCase().trim();
    currentWldBalance = await fetchRealWldBalance(cleanWallet);

    const wldDisp = $('wld-balance-num') || $('wld-balance');
    if (wldDisp) {
      wldDisp.innerText = Number(currentWldBalance || 0).toFixed(4) + " WLD";
    }
  } catch (e) {}
}

async function payRealWldFee(feeAmount) {
  if (!MiniKit.isInstalled()) {
    alert("Please open this game inside World App.");
    return false;
  }

  // Ensure wallet is connected first via official MiniKit.walletAuth
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) return false;
  }

  try {
    if ($('start-btn')) $('start-btn').disabled = true;

    const payment = await MiniKit.commandsAsync.pay({
      reference: `dice_${Date.now()}`,
      to: ADMIN_WALLET,
      tokens: [
        {
          symbol: Tokens.WLD,
          amount: tokenToDecimals(feeAmount, Tokens.WLD).toString(),
        }
      ],
      description: "Dice Duel Entry Fee"
    });

    if (!payment || !payment.finalPayload || payment.finalPayload.status !== "success") {
      if ($('start-btn')) $('start-btn').disabled = false;
      alert("Payment cancelled or failed.");
      return false;
    }

    return true;
  } catch (err) {
    console.error("Payment error:", err);
    if ($('start-btn')) $('start-btn').disabled = false;
    alert("Payment failed.");
    return false;
  }
}

async function handlePlayButtonClick() {
  if (!selectedFee || selectedFee <= 0) return;
  
  // Connects wallet on click if not already connected, then proceeds to payment
  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) return;
  }

  const paymentSuccess = await payRealWldFee(selectedFee);
  if (!paymentSuccess) return;
}

if ($('start-btn')) $('start-btn').addEventListener('click', handlePlayButtonClick);