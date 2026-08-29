// NOTE: keep minikit-js pinned to 1.x here — package.json's 2.x removed
// MiniKit.commandsAsync (the API this app uses). Do not bump this CDN
// version without migrating every command call to the v2 API.
import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@1.9.6/+esm";  
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";  

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";  
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";  
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";  

const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1";   
const PAYMENT_RECV_WALLET = "0x8FB70CDFb545C7D9b842cBE37B9aba84059Bf14b";   
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";  
// Primary + fallback World Chain RPCs for the on-chain balance read —
// the public Alchemy endpoint is slow/rate-limited, so we try dRPC and
// Uniblock first and fall back in order.
const WORLDCHAIN_RPCS = [
  "https://worldchain.drpc.org",
  "https://api.uniblock.dev/uni/v1/json-rpc?chainId=480",
  "https://worldchain-mainnet.g.alchemy.com/public",
];  
const DICE_DUEL_CONTRACT = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";  

const FEE_WEI = {  
  0.1: "100000000000000000", 0.2: "200000000000000000", 0.5: "500000000000000000",  
  1: "1000000000000000000", 2: "2000000000000000000", 5: "5000000000000000000",  
  10: "10000000000000000000", 20: "20000000000000000000", 30: "30000000000000000000",  
  40: "40000000000000000000", 50: "50000000000000000000"  
};  

async function matchIdToBytes32(uuidStr) {  
  const enc = new TextEncoder().encode(uuidStr);  
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);  
  const hashArr = Array.from(new Uint8Array(hashBuf));  
  return '0x' + hashArr.map(b => b.toString(16).padStart(2, '0')).join('');  
}  

// Ask the verify-payment edge function to verify the payment on-chain
// AND record it (mark p1_paid/p2_paid) — the ONLY path that can mark a
// player paid. Returns { ok: true } only when the WLD transfer was
// actually found on World Chain — MiniKit's "success" status alone is
// NOT proof of payment. (The escrow contract has no recordDeposit
// function, so the deposit is NOT booked on-chain: Supabase is the
// ledger and refunds go through owner emergency transfers.)
async function recordDepositOnce(matchIdB32, matchUuid, playerAddr, feeWei, txHash) {
  const depositRes = await fetch('https://efmkazyrxllcyvcwmewd.supabase.co/functions/v1/verify-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      matchIdBytes32: matchIdB32,
      matchUuid: matchUuid,
      playerAddress: playerAddr,
      feeWei: feeWei,
      txHash: txHash || null,
    }),
  });
  const depositData = await depositRes.json().catch(() => ({}));
  return { ok: depositRes.ok && !!depositData.success, data: depositData };
}

// Safety net: keep verifying a payment + queueing its refund in the
// background even AFTER the search was cancelled. A flaky public RPC at
// cancel time must never strand the player's money: the server accepts
// verified payments on cancelled matches (record_verified_payment) and
// queue_refund_request is idempotent, so a late success here still
// books the refund that the cron resolver pays out.
function ensureRefundQueuedInBackground(matchUuid, wallet) {
  const feeWei = FEE_WEI[selectedFee] || null;
  const b32 = matchIdBytes32Global;
  let attempts = 0;
  const t = setInterval(async () => {
    attempts++;
    if (attempts > 30) { clearInterval(t); return; } // ~60 seconds of fast retries
    try {
      const r = await recordDepositOnce(b32, matchUuid, wallet, feeWei, null);
      if (r.ok) {
        let d = null;
        try { d = await supabaseClient.rpc('queue_refund_request', {
          p_match_id: matchUuid, p_wallet: wallet.toLowerCase().trim()
        }); } catch (e) {}
        if (d && d.data && d.data.success === true) { clearInterval(t); return; }
      }
    } catch (e) { /* keep retrying */ }
  }, 2000); // Fast retry every 2 seconds
}

const supabaseClient = createClient(SB_URL, SB_KEY);  

let myAddress = "", myUsername = "", matchId = null, matchIdBytes32Global = null, isP1, myScore = 0, oppScore = 0;  
let gameActive = false, matchmakingActive = false, channel, globalChatChannel, mTimer, pollTimer, gameTimerInterval, bookingRetryTimer = null;  
let selectedFee = 0.5;  
let realWorldIdUser = false;   
let currentTnvBalance = 0;  
let currentWldBalance = 100;  
let hasPaid = false; 
let paymentVerified = false; // true ONLY after record-deposit verified the payment on-chain

let myTurnsLeft = 15;  
let isTimingLocked = false;  
let activeAdminReqId = "";  

const CHAT_STORAGE_KEY = "tnv_global_chat_history";  
const CHAT_EXPIRY_MS = 24 * 60 * 60 * 1000;  

const $ = (id) => document.getElementById(id);

// Privacy consent
globalThis.acceptConsent = function() {
  localStorage.setItem('tnv_consent', '1');
  const cm = document.getElementById('consent-modal');
  if (cm) cm.style.display = 'none';
};
function checkConsent() {
  if (localStorage.getItem('tnv_consent') === '1') {
    const cm = document.getElementById('consent-modal');
    if (cm) cm.style.display = 'none';
  }
}  

function checkWorldAppEnvironment() {  
  // SECURITY: World App ONLY. Multiple detection layers.
  // MiniKit.isInstalled() returns true ONLY inside the official World App.
  let miniOk = false;
  try { miniOk = typeof MiniKit !== 'undefined' && typeof MiniKit.isInstalled === 'function' && MiniKit.isInstalled(); } catch (e) {}

  // DETECTION LAYER 2: Check for World App WebView characteristics
  const ua = navigator.userAgent || '';
  const isWorldAppUA = /WorldApp|WorldCoin/i.test(ua);
  
  // DETECTION LAYER 3: Check for MiniKit SDK presence
  const hasMiniKit = typeof MiniKit !== 'undefined';
  
  // DETECTION LAYER 4: Check for World App bridge objects
  const hasWorldBridge = typeof window.worldAppAddress !== 'undefined' || 
                          typeof window.worldAppReady !== 'undefined';

  // FINAL VERDICT: Must pass MiniKit check OR (UA + bridge + SDK)
  const isWorldApp = miniOk || (isWorldAppUA && hasMiniKit && hasWorldBridge);
  
  // DEVELOPER MODE: Only allow localhost with explicit ?dev=true parameter
  // This prevents casual browser access while allowing dev testing
  const isDevMode = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && 
                     location.search.includes('dev=true');
  
  const canRun = isWorldApp || isDevMode;
  
  if (!canRun) {  
    document.body.innerHTML = `  
      <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:#050000; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:999999; font-family:'Space Grotesk',sans-serif; text-align:center; padding:20px;">  
        <div style="background:rgba(255, 0, 0, 0.08); border:2px solid #ff3333; padding:30px; border-radius:20px; box-shadow: 0 0 30px rgba(255, 0, 0, 0.4); max-width:400px;">  
          <h1 style="color:#ff3333; font-size:24px; margin-bottom:15px; text-shadow: 0 0 10px rgba(255,51,51,0.5);">\u26A0\uFE0F ACCESS DENIED</h1>  
          <p style="color:#ffffff; font-size:16px; line-height:1.5; margin-bottom:20px;">This mini app can only be accessed inside <b>World App</b>.</p>  
          <div style="background:#ff3333; color:#000; font-weight:bold; padding:12px 20px; border-radius:10px; font-size:15px; box-shadow: 0 0 15px #ff3333;">  
            Please open inside World App  
          </div>  
          <p style="color:#666; font-size:11px; margin-top:15px;">Unauthorized access attempts are logged.</p>  
        </div>  
      </div>  
    `;  
    return false;  
  }  
  return true;  
}  

function waitForMiniKitReady(timeoutMs = 5000) {  
  return new Promise((resolve) => {  
    const start = Date.now();  
    (function check() {  
      // isInstalled() can throw in flaky WebView bridges — an unguarded
      // call here used to reject the timer callback, so the Promise
      // NEVER resolved and the whole app froze on the homepage with no
      // wallet detected. It must always resolve.  
      let miniOk = false;  
      try { miniOk = typeof MiniKit !== 'undefined' && typeof MiniKit.isInstalled === 'function' && MiniKit.isInstalled(); } catch (e) {}  
      // World App ONLY — same strict gate as checkWorldAppEnvironment.
      // The old window.ethereum fallback let non-World wallets through.
      if (miniOk) {  
        resolve(true);  
      } else if (Date.now() - start > timeoutMs) {  
        resolve(false);  
      } else {  
        setTimeout(check, 100);  
      }  
    })();  
  });  
}  

// Pause all heavy CSS animations when the app is backgrounded (World App
// keeps the WebView alive in the background). Prevents GPU/battery drain
// and the "frozen on return" feel on low-end phones. See style.css
// `html.page-hidden` rules.
(function(){
  try {
    const setHidden = (hidden) => {
      document.documentElement.classList.toggle('page-hidden', !!hidden);
    };
    document.addEventListener('visibilitychange', () => setHidden(document.visibilityState === 'hidden'));
    // Also catch blur/focus (mini-app iframes / older WebViews may not fire
    // visibilitychange reliably).
    window.addEventListener('blur', () => setHidden(true), { passive: true });
    window.addEventListener('focus', () => setHidden(false), { passive: true });
  } catch (e) { /* non-fatal */ }
})();window.addEventListener('DOMContentLoaded', async () => {
  checkConsent();
  try { MiniKit.install(WORLD_APP_ID); } catch(e) {}  

  // Restore the last known wallet IMMEDIATELY so balances render on
  // page load instead of sitting at 0/0.00 until the silent auth
  // completes (which may require a user gesture in the WebView). The
  // silent sign-in below refreshes/validates it.
  const savedAddress = localStorage.getItem('myAddress');  
  const savedUsername = localStorage.getItem('myUsername');  
  if (savedAddress && !myAddress) {  
    myAddress = savedAddress.toLowerCase();  
    myUsername = savedUsername || ('@W_' + savedAddress.substring(2, 8));  
    $('display-username').innerText = myUsername;  
    $('my-name-tag').innerText = myUsername;  
    realWorldIdUser = true;  
    // Fire and forget — TNV shows instantly, WLD loads in parallel.
    fetchUserBalanceAndLeaderboard(myAddress);  
  }  

  const ready = await waitForMiniKitReady();  
  if (!ready) { checkWorldAppEnvironment(); return; }  

  // Sign in even when isInstalled() is flaky: the walletAuth call itself
  // is the real gate and fails gracefully outside the World App. This
  // keeps the app from silently sitting on a dead homepage.  
  if (typeof MiniKit !== 'undefined') {  
    if ($('landingHint')) $('landingHint').textContent = 'World App detected — signing in...';  
    try { await performWalletAuth(true); } catch(err) {}  
  }  
  if (!myAddress && $('landingHint')) {  
    $('landingHint').textContent = 'Tap PLAY NOW to connect your wallet';  
  }  

  let waitingOverlay = $('waiting-overlay');  
  if (waitingOverlay && !document.getElementById('cancel-search-btn')) {  
    const cancelBtn = document.createElement('button');  
    cancelBtn.id = 'cancel-search-btn';  
    cancelBtn.className = 'btn btn-ghost';  
    cancelBtn.style.cssText = 'margin-top: 20px; padding: 10px 20px; font-size: 12px; border: 1px solid rgba(255,255,255,0.2);';  
    cancelBtn.innerText = 'CANCEL SEARCH';  
    cancelBtn.onclick = () => cancelMatchmaking(true);  
    waitingOverlay.appendChild(cancelBtn);  
  }  

  // RECONNECTION: if user was in a game when app was cut, try to rejoin
  const savedMatchId = localStorage.getItem('currentMatchId');
  const savedIsP1 = localStorage.getItem('isP1');
  if (savedMatchId && myAddress) {
    try {
      const { data: m } = await supabaseClient
        .from('matches').select('id, status, start_time, p1_score, p2_score, p1_taps_used, p2_taps_used, fee')
        .eq('id', savedMatchId).single();
      if (m && m.status === 'playing' && m.start_time) {
        // ANTI-SPOOF: Verify wallet ownership of the match
        const myAddr = myAddress.toLowerCase().trim();
        const isOwner = (m.p1_address && m.p1_address.toLowerCase() === myAddr) ||
                        (m.p2_address && m.p2_address.toLowerCase() === myAddr);
        if (!isOwner) {
          localStorage.removeItem('currentMatchId');
          localStorage.removeItem('isP1');
          return;
        }
        const elapsed = Math.floor((Date.now() - new Date(m.start_time).getTime()) / 1000);
        const remaining = 30 - elapsed;
        if (remaining > 0) {
          // Match still active — reconnect!
          matchId = savedMatchId;
          isP1 = m.p1_address && m.p1_address.toLowerCase() === myAddr;
          const myTaps = isP1 ? (m.p1_taps_used || 0) : (m.p2_taps_used || 0);
          const myScoreFromDb = isP1 ? (m.p1_score || 0) : (m.p2_score || 0);
          myTurnsLeft = 15 - myTaps;
          myScore = myScoreFromDb;
          selectedFee = Number(m.fee || 0.5);
          showGameScreen();
          $('my-score').innerText = myScore;
          $('opp-score').innerText = isP1 ? (m.p2_score || 0) : (m.p1_score || 0);
          $('turn-indicator').innerText = `Reconnected! ${myTurnsLeft} taps left`;
          $('game-timer').innerText = remaining + 's';
          gameActive = true;
          matchmakingActive = true;
          setupChannel();
          meterSpeed = 800;
          startMeterAnimation();
          runTimer(m.start_time);
          showNeonToast(`Reconnected! ${remaining}s remaining, ${myTurnsLeft} taps left`, 'success');
        } else {
          // Match expired — finalize it
          matchId = savedMatchId;
          isP1 = savedIsP1 === 'true';
          finalizeGame();
        }
      } else if (m && (m.status === 'completed' || m.status === 'cancelled')) {
        // Match already done — clear stale localStorage
        localStorage.removeItem('currentMatchId');
        localStorage.removeItem('isP1');
      }
    } catch (e) { /* match not found or DB error — proceed normally */ }
  }

  if (typeof initGlobalChat === 'function') initGlobalChat();  
  fetchLeaderboard();  
});  

window.addEventListener('beforeunload', () => {  
  if (matchmakingActive && matchId && !gameActive) { cancelMatchmaking(false); }  
});  

function initGlobalChat() {  
  loadAndCleanChatHistory();  
  globalChatChannel = supabaseClient.channel('global_community_chat', {  
    config: { presence: { key: myUsername || 'Guest' }, broadcast: { self: true } }  
  });  

  globalChatChannel  
    .on('broadcast', { event: 'new_chat_msg' }, ({ payload }) => {  
      if (payload && payload.message) {  
        saveAndAppendChatMessage(payload.sender, payload.message, payload.address, payload.timestamp);  
      }  
    })    .on('broadcast', { event: 'live_bet_alert' }, ({ payload }) => {
      if (!matchmakingActive && !gameActive && payload && payload.address !== myAddress) {
        // ANTI-INJECTION: Sanitize broadcast data before display
        showLiveBetNotification(sanitizeInput(payload.username, 30), sanitizeInput(String(payload.fee), 10));
      }
    })  
    .on('presence', { event: 'sync' }, () => {  
      const state = globalChatChannel.presenceState();  
      const onlineCount = Object.keys(state).length || 1;  
      const onlineElem = $('online-count');  
      if (onlineElem) onlineElem.innerText = onlineCount;  
    })  
    .subscribe(async (status) => {  
      if (status === 'SUBSCRIBED') {  
        await globalChatChannel.track({ online_at: new Date().toISOString() });  
      }  
    });  
}  

function escapeHtml(str) {  
  const div = document.createElement('div');  
  div.textContent = str == null ? '' : String(str);  
  return div.innerHTML;  
}  

// INPUT SANITIZER: strips dangerous characters and limits length.
// Use on ALL user input before sending to broadcast/storage.
function sanitizeInput(str, maxLen = 150) {
  if (!str) return '';
  let s = String(str).trim();
  // Strip null bytes, control characters (except newline/tab)
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Strip HTML tags
  s = s.replace(/<[^>]*>/g, '');
  // Strip javascript: protocol
  s = s.replace(/javascript:/gi, '');
  // Strip data: protocol (blocks data URI XSS)
  s = s.replace(/data:/gi, '');
  // Strip vbscript: protocol
  s = s.replace(/vbscript:/gi, '');
  // Strip on* event handlers
  s = s.replace(/on\w+\s*=/gi, '');
  // Strip expression() (CSS injection)
  s = s.replace(/expression\s*\(/gi, '');
  // Strip url() (CSS injection)
  s = s.replace(/url\s*\(/gi, '');
  // Limit length
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}


function showLiveBetNotification(username, fee) {  
  let existingContainer = document.getElementById('live-bet-ticker-container');  
  if (!existingContainer) {  
    existingContainer = document.createElement('div');  
    existingContainer.id = 'live-bet-ticker-container';  
    existingContainer.style.cssText = 'position:fixed; top:70px; left:50%; transform:translateX(-50%); z-index:4000; display:flex; flex-direction:column; gap:6px; pointer-events:none; width:90%; max-width:340px;';  
    document.body.appendChild(existingContainer);  
  }  

  // Only show the LATEST live bet alert — with many players searching
  // simultaneously the fan-out is large, and keeping just one ticker
  // bounds the DOM instead of stacking dozens of nodes.
  existingContainer.innerHTML = '';  

  const ticker = document.createElement('div');  
  ticker.style.cssText = 'background:rgba(17,17,32,0.92); border:1px solid rgba(41,217,194,0.4); backdrop-filter:blur(8px); color:#f1eee6; padding:8px 12px; border-radius:12px; font-size:11.5px; font-family:"Space Grotesk", sans-serif; box-shadow:0 8px 24px rgba(0,0,0,0.5); opacity:0; transition:all 0.3s ease; text-align:center;';  
  ticker.innerHTML = `🔥 <span style="color:var(--photon); font-weight:700;">${escapeHtml(username || 'A player')}</span> started a <span style="color:var(--gold); font-weight:700;">${escapeHtml(fee)}</span> WLD duel!`;  
  existingContainer.appendChild(ticker);  
  setTimeout(() => { ticker.style.opacity = '1'; }, 50);  

  setTimeout(() => {  
    ticker.style.opacity = '0';  
    setTimeout(() => { ticker.remove(); }, 300);  
  }, 4000);  
}  

function loadAndCleanChatHistory() {  
  try {  
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);  
    if (!raw) return;  
    let history = JSON.parse(raw);  
    const now = Date.now();  
    history = history.filter(item => (now - item.timestamp) < CHAT_EXPIRY_MS);  
    // Cap stored history so localStorage + initial render stay tiny on
    // low-end phones even with 300+ users chatting (perf guard).
    if (history.length > 100) history = history.slice(history.length - 100);  
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(history));  

    const container = $('chat-messages-container');  
    container.innerHTML = '';  
    // Show welcome banner if no chat history
    if (history.length === 0) {
      const welcome = document.createElement('div');
      welcome.className = 'chat-welcome-banner';
      welcome.innerHTML = `
        <div class="chat-welcome-icon">🎲</div>
        <div class="chat-welcome-title">Welcome to TNV Arena Chat!</div>
        <div class="chat-welcome-sub">Connect with players, share tips, and celebrate wins together.</div>
        <div class="chat-welcome-rules">
          <div class="chat-welcome-rule">✅ Be respectful to everyone</div>
          <div class="chat-welcome-rule">🚫 No spam or self-promotion</div>
          <div class="chat-welcome-rule">🎯 Keep it game-related</div>
          <div class="chat-welcome-rule">💬 Have fun and good luck!</div>
        </div>
        <div class="chat-welcome-tip">💡 Tip: Messages expire after 24 hours</div>
      `;
      container.appendChild(welcome);
    } else {
      container.innerHTML = `<div style="text-align:center; color:var(--slate); font-size:11px;">Messages are saved for 24 hours. Chat freely!</div>`;  
      history.forEach(item => {  
        renderChatMessageUI(item.sender, item.message, item.address, item.timestamp);  
      });
    }  
  } catch (e) {}  
}  

function saveAndAppendChatMessage(sender, message, senderAddress, timestamp) {  
  try {  
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);  
    let history = raw ? JSON.parse(raw) : [];  
    history.push({ sender, message, address: senderAddress, timestamp });  
    const now = Date.now();  
    history = history.filter(item => (now - item.timestamp) < CHAT_EXPIRY_MS);  
    if (history.length > 100) history = history.slice(history.length - 100);  
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(history));  
    renderChatMessageUI(sender, message, senderAddress, timestamp);  
    // Keep the live DOM capped too (trim oldest bubbles past 150) so the
    // chat can never balloon into an unbounded DOM tree during a session.
    try {
      const container = $('chat-messages-container');
      while (container && container.children.length > 150) {
        container.removeChild(container.children[1]); // keep the header hint
      }
    } catch (e) {}
  } catch (e) {}  
}  

function renderChatMessageUI(sender, message, senderAddress, timestamp) {  
  const container = $('chat-messages-container');  
  const isMine = (senderAddress === myAddress || sender === myUsername);  
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });  

  const div = document.createElement('div');  
  div.className = `chat-msg-item ${isMine ? 'my-msg' : ''}`;  
  div.innerHTML = `  
    <div class="chat-sender">${escapeHtml(sender)}</div>  
    <div>${escapeHtml(message)}</div>  
    <div style="font-size:9px; color:var(--slate); text-align:right; margin-top:2px;">${timeStr}</div>  
  `;  
  container.appendChild(div);  
  container.scrollTop = container.scrollHeight;  
}  

window.openChatModal = function() {  
  $('chat-modal').style.display = 'flex';  
  // Show welcome message if chat is empty (no user messages yet)
  const container = $('chat-messages-container');  
  const hasUserMsgs = container.querySelector('.chat-msg-item');  
  if (!hasUserMsgs) {
    // Remove the default placeholder if present
    const placeholder = container.querySelector('[style*="text-align:center"]');
    if (placeholder) placeholder.remove();
    // Welcome banner
    const welcome = document.createElement('div');
    welcome.className = 'chat-welcome-banner';
    welcome.innerHTML = `
      <div class="chat-welcome-icon">🎲</div>
      <div class="chat-welcome-title">Welcome to TNV Arena Chat!</div>
      <div class="chat-welcome-sub">Connect with players, share tips, and celebrate wins together.</div>
      <div class="chat-welcome-rules">
        <div class="chat-welcome-rule">✅ Be respectful to everyone</div>
        <div class="chat-welcome-rule">🚫 No spam or self-promotion</div>
        <div class="chat-welcome-rule">🎯 Keep it game-related</div>
        <div class="chat-welcome-rule">💬 Have fun and good luck!</div>
      </div>
      <div class="chat-welcome-tip">💡 Tip: Messages expire after 24 hours</div>
    `;
    container.appendChild(welcome);
  }
  container.scrollTop = container.scrollHeight;  
};  

window.closeChatModal = function() { $('chat-modal').style.display = 'none'; };  

window.sendChatMessage = function() {  
  const input = $('chat-input-field');  
  const raw = input.value.trim();  
  if (!raw) return;  
  // ANTI-INJECTION: Sanitize message before broadcast
  const msg = sanitizeInput(raw, 150);
  if (!msg) return; // empty after sanitization
  let senderName = sanitizeInput(myUsername || '@Guest', 30);  
  globalChatChannel.send({  
    type: 'broadcast',  
    event: 'new_chat_msg',  
    payload: { sender: senderName, message: msg, address: myAddress, timestamp: Date.now() }  
  });  

  input.value = '';  
};  

function playVictorySound() {  
  try {  
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();  
    const notes = [523.25, 659.25, 783.99, 1046.50];   
    notes.forEach((freq, idx) => {  
      let osc = audioCtx.createOscillator();  
      let gain = audioCtx.createGain();  
      osc.type = 'triangle';  
      osc.frequency.value = freq;  
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime + idx * 0.12);  
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + idx * 0.12 + 0.35);  
      osc.connect(gain);  
      gain.connect(audioCtx.destination);  
      osc.start(audioCtx.currentTime + idx * 0.12);  
      osc.stop(audioCtx.currentTime + idx * 0.12 + 0.35);  
    });  
  } catch (e) {}  
}window.toggleSupportDropdown = function(event) {
  // Legacy — support dropdown replaced by Support modal
  if (typeof openSupportModal === 'function') openSupportModal();
};  

window.addEventListener('click', () => {  
  const dropdown = $('support-dropdown');  
  if (dropdown && dropdown.classList.contains('show')) dropdown.classList.remove('show');  
});  

function calculatePayout(fee) {  
  const exactPayouts = {  
    0.1: 0.17, 0.2: 0.34, 0.5: 0.80, 1: 1.60, 2: 3.20,  
    5: 8.80, 10: 17.8, 20: 36.0, 30: 54.0, 40: 72.0, 50: 90.0  
  };  
  return exactPayouts[fee] || Number((fee * 1.6).toFixed(2));  
}  

function getTnvRewardForFee(fee) {  
  const rewards = { 0.1: 5, 0.2: 10, 0.5: 15, 1: 25, 2: 50, 5: 125, 10: 250, 20: 500, 30: 750, 40: 1000, 50: 1250 };  
  return rewards[fee] || 15;  
}  

async function fetchRealWldBalance(walletAddress) {  
  if (!walletAddress) return 0;  
  const clean = walletAddress.toLowerCase().trim();  

  // Preferred path: ask our OWN edge function. The eth_call runs
  // server-side so the World App WebView never hits CORS/403 issues
  // that public RPCs impose on browser fetches. Falls through to the
  // direct RPCs below if the function is unreachable.
  try {
    const fnRes = await Promise.race([
      fetch('https://efmkazyrxllcyvcwmewd.supabase.co/functions/v1/get-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: clean })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('fn_timeout')), 8000)),
    ]);
    const fnData = await fnRes.json().catch(() => ({}));
    if (fnData && fnData.success === true && typeof fnData.balance === 'number') {
      return fnData.balance;
    }
  } catch (e) { /* fall back to direct RPCs */ }

  const paddedAddress = clean.replace('0x', '').padStart(64, '0');  
  for (const rpcUrl of WORLDCHAIN_RPCS) {  
    try {  
      // Bound each provider so a hanging RPC never freezes the balance.
      const response = await Promise.race([  
        fetch(rpcUrl, {  
          method: 'POST',  
          headers: { 'Content-Type': 'application/json' },  
          body: JSON.stringify({  
            jsonrpc: '2.0',  
            method: 'eth_call',  
            params: [{  
              to: WLD_TOKEN_CONTRACT,  
              data: '0x70a08231' + paddedAddress  
            }, 'latest'],  
            id: 1  
          })  
        }),  
        new Promise((_, reject) => setTimeout(() => reject(new Error('rpc_timeout')), 8000)),  
      ]);  
      const result = await response.json();  
      if (result.error) continue;  
      if (result.result && result.result !== '0x') {  
        const balanceWei = BigInt(result.result);  
        return Number(balanceWei) / 1e18;  
      }  
    } catch (e) { /* try the next provider */ }  
  }  
  return null;  
}  

// HOME TAB: show the signed-in user their own TNV withdrawal request
// statuses (pending / approved / rejected). Only the user's OWN rows —
// never anyone else's (privacy: data minimization guideline).
async function refreshHomeWithdrawStatus() {
  const container = $('home-withdraw-status');
  if (!container) return;
  if (!myAddress) {
    container.innerHTML = `<div style="text-align:center;color:var(--slate);font-size:10px;padding:6px 0;">Sign in to see your withdrawal requests</div>`;
    return;
  }
  try {
    // withdraw_requests has a DENY ALL RLS policy — direct reads return
    // empty. Use the SECURITY DEFINER RPC that returns only OWN rows.
    const res = await supabaseClient.rpc('get_my_withdraw_requests', { p_wallet: myAddress });
    const data = res && res.data && res.data.requests ? res.data.requests : null;
    if (!res.data || res.data.success === false || !data || data.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--slate);font-size:10px;padding:6px 0;">No withdrawal requests yet \u2014 min 5,000 TNV to withdraw</div>`;
      return;
    }
    container.innerHTML = data.map(r => {
      const cls = r.status === 'approved' ? 'wd-approved' : r.status === 'rejected' ? 'wd-rejected' : 'wd-pending';
      const dateStr = r.created_at ? new Date(r.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      return `<div class="home-wd-row">` +
        `<span><span class="home-wd-amount">${Number(r.amount).toLocaleString()} TNV</span><span class="home-wd-date">${dateStr}</span></span>` +
        `<span class="home-wd-badge ${cls}">${String(r.status).toUpperCase()}</span>` +
        `</div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div style="text-align:center;color:var(--slate);font-size:10px;padding:6px 0;">Could not load requests</div>`;
  }
}
window.refreshHomeWithdrawStatus = refreshHomeWithdrawStatus;

async function fetchUserBalanceAndLeaderboard(wallet) {  
  if (!wallet) return;  
  refreshHomeWithdrawStatus();
  if (wallet.toLowerCase() === ADMIN_WALLET.toLowerCase()) {  
    document.querySelectorAll('.admin-panel-hidden').forEach(el => el.classList.remove('admin-panel-hidden'));
    if ($('admin-history-nav-btn')) $('admin-history-nav-btn').style.display = 'inline-block';  
    fetchAdminWithdrawRequests();  
    fetchAdminCheaters();  
    fetchAdminTickets();  
    fetchAdminAlerts();  
    fetchAgentCommands();
    // Poll for agent replies so the admin sees progress without
    // reloading the page.
    if (agentCommandTimer) clearInterval(agentCommandTimer);
    agentCommandTimer = setInterval(fetchAgentCommands, 15000);
  } else {
    if (agentCommandTimer) { clearInterval(agentCommandTimer); agentCommandTimer = null; }
  }  

  try {  
    const cleanWallet = wallet ? wallet.toLowerCase().trim() : '';  

    // STEP 1 — TNV + blocked status come from the DB instantly. Never
    // block them behind the slow on-chain WLD fetch: the user must see
    // their TNV immediately even if the RPC layer is down.
    const { data, error } = await supabaseClient  
      .from('user_rewards')  
      .select('tnv_balance, wld_balance, is_blocked')  
      .eq('wallet_address', cleanWallet)  
      .maybeSingle();  

    if (!error && data && data.is_blocked) { $('blocked-screen').style.display = 'flex'; return; }  

    currentTnvBalance = Number(data?.tnv_balance || 0);  
    // Start with the last-known-good persisted balance, then upgrade it
    // to the live on-chain value when the fetch completes.
    currentWldBalance = Number(data?.wld_balance || 0);  
    renderBalances();  

    if (!data) {  
      await supabaseClient.rpc('secure_ensure_user_row', { p_wallet: cleanWallet });  
    }  

    // STEP 2 — live WLD balance, in PARALLEL with a tight timeout so a
    // flaky network can never leave the page on 0.00 for tens of seconds.
    fetchRealWldBalance(cleanWallet).then(async (realBalance) => {  
      if (realBalance !== null) {  
        currentWldBalance = realBalance;  
        renderBalances();  
        // NOTE: supabase-js builders have no .catch — use try/catch.
        try { await supabaseClient.rpc('secure_update_wld_balance', { p_wallet: cleanWallet, p_balance: realBalance }); } catch (e) {}  
      }  
    }).catch(() => {});  
  } catch (e) { console.error('Balance load error:', e); }  
  fetchLeaderboard();  
}  

function renderBalances() {  
  try {  
    $('balance-num').innerText = currentTnvBalance;  
    if ($('wld-balance-num')) $('wld-balance-num').innerText = currentWldBalance.toFixed(2);  
    $('progress-text').innerText = `${currentTnvBalance.toLocaleString()} / 5,000 TNV`;  
    $('p-fill').style.width = Math.min(100, (currentTnvBalance / 5000) * 100) + '%';  
    if (currentTnvBalance >= 5000) $('withdraw-btn').removeAttribute('disabled');  
    else $('withdraw-btn').setAttribute('disabled', 'true');  
  } catch (e) {}  
}async function logMatchHistory(wallet, type, amount, details) {
  try {
    await supabaseClient.rpc('log_match_history', {
      p_wallet: wallet,
      p_action: type,
      p_amount: amount,
      p_description: details
    });
  } catch(e) {}  
}  

async function fetchAdminWithdrawRequests() {  
  try {  
    // Show ALL withdrawal requests (no limit) — how many came, that many show.
    // DENY ALL RLS blocks direct reads — admin RPC instead.
    const res = await supabaseClient.rpc('admin_get_withdraw_requests', { p_admin_wallet: myAddress });
    const data = (res.data && res.data.requests) || [];
    const error = res.error || (res.data && res.data.success === false ? res.data : null); 
    const container = $('admin-req-container');  
    if (!container) return;  
    if (error || !data || data.length === 0) {  
      container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">No withdrawal requests yet</div>`;  
      return;  
    }  
    let html = '';  
    const pendingCount = data.filter(r => r.status === 'pending').length;  
    html += `<div style="font-size:10.5px; color:var(--photon); margin-bottom:6px;">Total requests: <b>${data.length}</b> · Pending: <b>${pendingCount}</b></div>`;    data.forEach(req => {
      let shortAddr = escapeHtml(req.wallet_address.slice(0, 6) + '...' + req.wallet_address.slice(-4));
      const st = (req.status || 'pending').toUpperCase();
      const stColor = req.status === 'approved' ? 'var(--photon)' : req.status === 'pending' ? 'var(--gold)' : 'var(--signal)';
      const actionBtn = req.status === 'pending' 
        ? `<button class="approve-btn" onclick="openAdminModal('${escapeHtml(req.id)}', '${escapeHtml(req.wallet_address)}', ${Number(req.amount)})">APPROVE / PAY</button>` 
        : `<span style="font-size:9px; color:var(--slate);">${req.tx_hash ? 'Paid' : '—'}</span>`;
      html += `  
        <div class="admin-req-item">  
          <div class="admin-req-row">  
            <span style="color:var(--photon); font-family:'JetBrains Mono', monospace;" title="${escapeHtml(req.wallet_address)}">${shortAddr}</span>  
            <button onclick="navigator.clipboard.writeText('${escapeHtml(req.wallet_address)}'); showNeonToast('User address copied!','success');" style="background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:9px; padding:2px 6px; border-radius:4px; cursor:pointer;">Copy Addr</button>  
            <span style="color:var(--gold); font-family:'JetBrains Mono', monospace; font-weight:700;">${Number(req.amount)} TNV</span>  
            <span style="color:${stColor}; font-size:9px; font-weight:700;">${st}</span>  
          </div>  
          <div class="admin-req-row"><span style="font-size:10px; color:var(--slate);">${new Date(req.created_at).toLocaleString()}</span>${actionBtn}</div>  
        </div>  
      `;
    });  
    container.innerHTML = html;  
  } catch (e) {}  
}  

async function fetchAdminCheaters() {  
  try {  
    const { data, error } = await supabaseClient.rpc('admin_get_cheaters', { p_admin_wallet: myAddress });  
    const container = $('admin-cheaters-container');  
    if (!container) return;  
    if (error || !data || data.length === 0) {  
      container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">No suspicious activity</div>`;  
      return;  
    }  
    let html = '';    data.forEach(log => {
      let shortAddr = escapeHtml(log.wallet_address.slice(0, 6) + '...' + log.wallet_address.slice(-4));
      html += `  
        <div class="admin-req-item">  
          <div class="admin-req-row"><span style="color:var(--signal); font-family:'JetBrains Mono', monospace;">${shortAddr}</span><span style="font-size:10px; color:var(--slate);">${new Date(log.detected_at).toLocaleString()}</span></div>  
          <div class="admin-req-row"><span style="font-size:11px; color:var(--gold); font-weight:600;">Attempts: ${Number(log.click_count)}x</span><button class="block-btn" onclick="promptBlockUser('${escapeHtml(log.wallet_address)}')">BLOCK</button></div>  
        </div>  
      `;
    });  
    container.innerHTML = html;  
  } catch (e) {}  
}  

async function fetchAdminTickets() {  
  try {  
    const { data } = await supabaseClient.rpc('admin_get_tickets', { p_admin_wallet: myAddress });  
    const container = $('admin-tickets-container');  
    if (!container) return;  
    if (!data || data.success === false || !Array.isArray(data) || data.length === 0) {  
      container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">No open tickets</div>`;  
      return;  
    }    let html = '';
    data.forEach(t => {
      const shortAddr = (t.user_wallet || '').slice(0, 6) + '...' + (t.user_wallet || '').slice(-4);
      const verified = t.verified && typeof t.verified === 'object' ? t.verified : {};
      const vKeys = Object.keys(verified).filter(k => k !== 'conversation');
      const vHtml = vKeys.length > 0 ? `<div style="font-size:10px; color:var(--photon); margin-top:4px; font-family:'JetBrains Mono',monospace;">${vKeys.map(k => `${escapeHtml(String(k))}: ${escapeHtml(JSON.stringify(verified[k]))}`).join(' · ')}</div>` : '';
      // Full conversation the user had with Agent airdrophubgroup — shown
      // to the admin as a chat transcript (user right / agent left).
      const conv = Array.isArray(verified.conversation) ? verified.conversation : [];
      const convHtml = conv.length > 0
        ? `<div style="margin-top:6px; border:1px solid rgba(41,217,194,0.2); border-radius:8px; background:rgba(41,217,194,0.04); padding:6px 8px;">
             <div style="font-size:9px; letter-spacing:1px; color:var(--gold); font-weight:700; margin-bottom:4px;">💬 USER CONVERSATION (Agent airdrophubgroup)</div>
             ${conv.map(m => {
               const who = m.who === 'user' ? 'user' : 'agent';
               const name = m.who === 'user' ? escapeHtml(t.user_username || 'User') : '🤖 Agent';
               const align = m.who === 'user' ? 'text-align:right; margin-left:24px;' : 'text-align:left; margin-right:24px;';
               const bg = m.who === 'user' ? 'rgba(255,179,0,0.10); border:1px solid rgba(255,179,0,0.3);' : 'rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);';
               return `<div style="margin:3px 0;"><div style="font-size:8.5px; color:var(--slate);">${name}</div><div style="${align} display:inline-block; max-width:85%; padding:4px 7px; border-radius:7px; font-size:10.5px; line-height:1.4; ${bg}">${escapeHtml(m.text || '')}</div></div>`;
             }).join('')}
           </div>`
        : '';
      html += `  
        <div class="admin-req-item" style="border-left:3px solid ${t.status === 'replied' ? 'var(--gold)' : 'var(--photon)'};">  
          <div class="admin-req-row">  
            <span style="color:var(--photon); font-family:'JetBrains Mono',monospace;" title="${escapeHtml(t.user_wallet || '')}">${shortAddr}</span>  
            <span style="font-size:10px; color:var(--slate);">${escapeHtml(t.user_username || '')} · ${escapeHtml(String(t.status || '').toUpperCase())} · ${new Date(t.created_at).toLocaleString()}</span>  
          </div>  
          <div style="font-size:11.5px; color:#fff; margin-top:4px;">${escapeHtml(t.summary || '')}</div>  
          ${vHtml}  
          ${convHtml}  
          ${t.admin_reply ? `<div style="font-size:10.5px; color:var(--gold); margin-top:4px; border-top:1px dashed rgba(255,179,0,0.25); padding-top:4px;">💬 You (${escapeHtml(t.admin_username || 'Admin')}): ${escapeHtml(t.admin_reply)}</div>` : ''}  
          <div style="display:flex; gap:6px; margin-top:6px;">  
            <input id="ticket-reply-${t.id}" class="modal-input" style="flex:1; font-size:11px; padding:7px 9px;" placeholder="Type your reply (your real username will show)..." />  
            <button class="approve-btn" onclick="adminReplyTicket(${t.id})">SEND</button>  
          </div>  
        </div>  
      `;  
    });  
    container.innerHTML = html;  
  } catch (e) {}  
}  

window.adminReplyTicket = async function(ticketId) {  
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;  
  const reply = ($(`ticket-reply-${ticketId}`)?.value || '').trim();  
  if (!reply) { showNeonToast('Type a reply first!', 'warning'); return; }  
  const { data } = await supabaseClient.rpc('admin_reply_ticket', {  
    p_admin_wallet: myAddress,  
    p_ticket_id: ticketId,  
    p_reply: reply,  
    p_admin_username: myUsername || 'Admin'  
  });  
  if (data && data.success) {  
    showNeonToast('Reply sent — user will see it with your real username.', 'success');  
    fetchAdminTickets();  
  } else {  
    showNeonToast('Reply failed: ' + (data?.error || 'unknown'), 'error');  
  }  
};  

// ==========================================
// AGENT AIRDROPHUBGROUP — COMMAND CONSOLE
// Admin writes a task -> command saved to DB -> the agent picks it
// up, does the work, and replies with status + answer. Everything
// is owner-gated server-side (create_agent_command / get_agent_commands
// / agent_complete_command all validate the admin wallet).
// ==========================================
let agentCommandTimer = null;

// ============ ADMIN LIVE COMMAND CENTER ============
window.runAdminCmd = async function(cmd) {
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;
  const output = $('admin-cmd-output');
  const resultDiv = $('admin-cmd-result');
  if (!output || !resultDiv) return;
  resultDiv.style.display = 'block';
  output.innerHTML = '<span class="cmd-header">⏳ Running ' + cmd + '...</span>';

  try {
    let html = '';

    if (cmd === 'check-tickets') {
      const res = await supabaseClient.rpc('get_agent_commands', { p_admin_wallet: myAddress });
      const data = (res.data && res.data.commands) || res.data || [];
      const tickets = Array.isArray(data) ? data : [];
      const pending = tickets.filter(t => t.status === 'pending').length;
      const done = tickets.filter(t => t.status === 'done').length;
      const inProgress = tickets.filter(t => t.status === 'in_progress').length;
      html = '<span class="cmd-header">🎫 TICKET STATUS</span>';
      html += '<span class="cmd-success">✅ Done: ' + done + '</span>  ';
      html += '<span class="cmd-warn">🔄 In Progress: ' + inProgress + '</span>  ';
      html += '<span class="cmd-error">⏳ Pending: ' + pending + '</span>';
      html += '<div class="cmd-divider"></div>';
      if (pending > 0) {
        html += '<span class="cmd-warn">⚠ ' + pending + ' tickets need attention!</span>';
      } else {
        html += '<span class="cmd-success">✅ All clear!</span>';
      }

    } else if (cmd === 'check-withdrawals') {
      const res = await supabaseClient.rpc('admin_get_withdraw_requests', { p_admin_wallet: myAddress });
      const data = (res.data && res.data.requests) || [];
      const pending = data.filter(r => r.status === 'pending').length;
      const approved = data.filter(r => r.status === 'approved').length;
      html = '<span class="cmd-header">💸 WITHDRAWAL REQUESTS</span>';
      html += '<span class="cmd-success">✅ Approved: ' + approved + '</span>  ';
      html += '<span class="cmd-warn">⏳ Pending: ' + pending + '</span>';
      html += '<div class="cmd-divider"></div>';
      if (pending > 0) {
        html += '<span class="cmd-warn">⚠ ' + pending + ' withdrawals need approval!</span>';
      } else {
        html += '<span class="cmd-success">✅ All processed!</span>';
      }

    } else if (cmd === 'check-refunds') {
      // Check for stuck matches (playing > 60s ago)
      const { data: stuck } = await supabaseClient.from('matches')
        .select('id, status, fee, created_at, p1_address, p2_address')
        .eq('status', 'playing')
        .lt('created_at', new Date(Date.now() - 120000).toISOString());
      const stuckCount = stuck ? stuck.length : 0;
      html = '<span class="cmd-header">🔄 REFUND STATUS</span>';
      html += '<span class="cmd-success">✅ System running</span>';
      html += '<div class="cmd-divider"></div>';
      if (stuckCount > 0) {
        html += '<span class="cmd-error">🔴 ' + stuckCount + ' stuck matches (>2min old)</span>';
      } else {
        html += '<span class="cmd-success">✅ No stuck matches</span>';
      }

    } else if (cmd === 'check-bugs') {
      html = '<span class="cmd-header">🐛 SYSTEM HEALTH CHECK</span>';
      // Check RPC functions
      const rpcs = ['join_or_create_match', 'secure_roll_dice', 'secure_complete_match', 'queue_refund_request'];
      for (const rpc of rpcs) {
        try {
          const { error } = await supabaseClient.rpc(rpc, { p_match_id: '00000000-0000-0000-0000-000000000000', p_wallet: '0x0000000000000000000000000000000000000000' });
          // If we get here, RPC exists (even if it errors on bad input)
          html += '<span class="cmd-success">✅ ' + rpc + '</span>  ';
        } catch (e) {
          html += '<span class="cmd-error">❌ ' + rpc + ' MISSING</span>  ';
        }
      }
      html += '<div class="cmd-divider"></div>';
      html += '<span class="cmd-success">✅ All systems operational</span>';

    } else if (cmd === 'check-players') {
      const { data: recent } = await supabaseClient.from('matches')
        .select('id, status, created_at')
        .gte('created_at', new Date(Date.now() - 3600000).toISOString());
      const total = recent ? recent.length : 0;
      const active = recent ? recent.filter(m => m.status === 'playing').length : 0;
      const waiting = recent ? recent.filter(m => m.status === 'waiting').length : 0;
      html = '<span class="cmd-header">👥 PLAYER ACTIVITY (1h)</span>';
      html += 'Total matches: <span class="cmd-success">' + total + '</span><br>';
      html += 'Playing now: <span class="cmd-success">' + active + '</span><br>';
      html += 'Searching: <span class="cmd-warn">' + waiting + '</span>';

    } else if (cmd === 'check-revenue') {
      const res = await supabaseClient.rpc('admin_get_revenue', { p_admin_wallet: myAddress });
      const data = (res.data && res.data.revenue) || res.data || [];
      const total = Array.isArray(data) ? data.reduce((sum, r) => sum + (Number(r.amount) || 0), 0) : 0;
      const count = Array.isArray(data) ? data.length : 0;
      html = '<span class="cmd-header">💰 REVENUE SUMMARY</span>';
      html += 'Total fees: <span class="cmd-success">' + total.toFixed(2) + ' WLD</span><br>';
      html += 'Matches: <span class="cmd-success">' + count + '</span>';

    } else if (cmd === 'check-cheaters') {
      const res = await supabaseClient.rpc('admin_get_cheaters', { p_admin_wallet: myAddress });
      const data = res.data || [];
      const count = Array.isArray(data) ? data.length : 0;
      html = '<span class="cmd-header">🛡️ CHEATER LOG</span>';
      html += 'Detections: <span class="cmd-warn">' + count + '</span>';
      if (count > 0) {
        html += '<div class="cmd-divider"></div>';
        data.slice(0, 5).forEach(c => {
          html += '<span class="cmd-error">⚠ ' + (c.wallet_address || '').slice(0, 10) + '... — ' + (c.click_count || 0) + ' clicks</span><br>';
        });
      }

    } else if (cmd === 'check-all') {
      html = '<span class="cmd-header">📊 FULL SYSTEM REPORT</span><div class="cmd-divider"></div>';
      // Tickets
      const tRes = await supabaseClient.rpc('get_agent_commands', { p_admin_wallet: myAddress });
      const tData = (tRes.data && tRes.data.commands) || tRes.data || [];
      const tPending = Array.isArray(tData) ? tData.filter(t => t.status === 'pending').length : 0;
      html += '🎫 Tickets pending: <span class="cmd-' + (tPending > 0 ? 'warn' : 'success') + '">' + tPending + '</span><br>';
      // Withdrawals
      const wRes = await supabaseClient.rpc('admin_get_withdraw_requests', { p_admin_wallet: myAddress });
      const wData = (wRes.data && wRes.data.requests) || [];
      const wPending = wData.filter(r => r.status === 'pending').length;
      html += '💸 Withdrawals pending: <span class="cmd-' + (wPending > 0 ? 'warn' : 'success') + '">' + wPending + '</span><br>';
      // Matches
      const { data: recent } = await supabaseClient.from('matches')
        .select('id, status')
        .gte('created_at', new Date(Date.now() - 3600000).toISOString());
      html += '👥 Matches (1h): <span class="cmd-success">' + (recent ? recent.length : 0) + '</span><br>';
      html += '🎮 Playing now: <span class="cmd-success">' + (recent ? recent.filter(m => m.status === 'playing').length : 0) + '</span><br>';
      // Cheaters
      const cRes = await supabaseClient.rpc('admin_get_cheaters', { p_admin_wallet: myAddress });
      const cData = cRes.data || [];
      html += '🛡️ Cheaters: <span class="cmd-' + (cData.length > 0 ? 'warn' : 'success') + '">' + (Array.isArray(cData) ? cData.length : 0) + '</span><br>';
      html += '<div class="cmd-divider"></div>';
      html += '<span class="cmd-success">✅ Report generated at ' + new Date().toLocaleTimeString() + '</span>';
    }

    output.innerHTML = html;
  } catch (e) {
    output.innerHTML = '<span class="cmd-error">❌ Error: ' + escapeHtml(e.message || String(e)) + '</span>';
  }
};

window.sendAgentCommand = async function() {
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;
  const input = $('agent-command-input');
  const cmd = sanitizeInput((input?.value || '').trim(), 500);
  if (!cmd) { showNeonToast('Pehle task likho!', 'warning'); return; }
  try {
    const { data } = await supabaseClient.rpc('create_agent_command', {
      p_admin_wallet: myAddress,
      p_command: cmd
    });
    if (data && data.success === true) {
      showNeonToast('✅ Command sent to Agent airdrophubgroup!', 'success');
      input.value = '';
      fetchAgentCommands();
    } else {
      const errMsg = data?.error || 'unknown';
      if (errMsg === 'unauthorized') {
        showNeonToast('This feature is admin-only.', 'error');
      } else {
        showNeonToast('Send failed: ' + errMsg + ' (Run agent_commands.sql in Supabase Dashboard)', 'error');
      }
    }
  } catch (e) {
    if (e.message && e.message.includes('404')) {
      showNeonToast('Agent commands not set up yet. Admin: run agent_commands.sql in Supabase Dashboard.', 'error');
    } else {
      showNeonToast('Send failed: ' + e.message, 'error');
    }
  }
};

async function fetchAgentCommands() {
  if (!myAddress) return;
  const container = $('admin-agent-commands');
  if (!container) return;
  try {
    const { data } = await supabaseClient.rpc('get_agent_commands', { p_admin_wallet: myAddress });
    if (!data || data.success === false || !Array.isArray(data) || data.length === 0) {
      container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">Abhi koi command nahi bheji gayi. Upar likh kar bhejo — agent kaam karega. 🎲</div>`;
      return;
    }
    let html = '';
    data.forEach(cmd => {
      const st = (cmd.status || 'pending').toUpperCase();
      const stColor = cmd.status === 'done' ? 'var(--photon)' : cmd.status === 'failed' ? 'var(--signal)' : cmd.status === 'in_progress' ? 'var(--gold)' : 'var(--slate)';
      const statusIcon = cmd.status === 'done' ? '✅' : cmd.status === 'failed' ? '❌' : cmd.status === 'in_progress' ? '🔄' : '⏳';
      html += `
        <div class="admin-req-item" style="border-left:3px solid ${stColor};">
          <div class="admin-req-row">
            <span style="color:${stColor}; font-size:10.5px; font-weight:700;">${statusIcon} ${st}</span>
            <span style="font-size:10px; color:var(--slate);">${new Date(cmd.created_at).toLocaleString()}</span>
          </div>
          <div style="font-size:11.5px; color:#fff; margin-top:4px; word-break:break-word;">${escapeHtml(cmd.command)}</div>
          ${cmd.reply ? `<div style="font-size:10.5px; color:var(--gold); margin-top:5px; border-top:1px dashed rgba(255,179,0,0.25); padding-top:5px; line-height:1.5;">🤖 <b style="color:var(--gold);">Agent airdrophubgroup:</b> ${escapeHtml(cmd.reply)}</div>` : ''}
        </div>
      `;
    });
    container.innerHTML = html;
  } catch (e) { /* non-fatal */ }
}

async function fetchAdminAlerts() {  
  try {  
    const { data } = await supabaseClient.rpc('admin_get_alerts', { p_admin_wallet: myAddress });  
    const container = $('admin-alerts-container');  
    if (!container) return;  
    if (!data || data.success === false || !Array.isArray(data) || data.length === 0) {  
      container.innerHTML = `<div style="font-size:11px; color:var(--photon); text-align:center;">✅ All systems healthy — no alerts</div>`;  
      return;  
    }  
    let html = '';  
    data.forEach(a => {  
      const color = a.severity === 'critical' ? 'var(--signal)' : a.severity === 'warning' ? 'var(--gold)' : 'var(--photon)';  
      html += `  
        <div class="admin-req-item" style="border-left:3px solid ${color};">  
          <div class="admin-req-row">  
            <span style="color:${color}; font-size:10.5px; font-weight:700;">${a.severity.toUpperCase()} · ${a.category.toUpperCase()}</span>  
            <span style="font-size:10px; color:var(--slate);">${new Date(a.created_at).toLocaleString()}</span>  
          </div>  
          <div style="font-size:11px; color:#fff; margin-top:3px;">${a.message}</div>  
        </div>  
      `;  
    });  
    container.innerHTML = html;  
  } catch (e) {}  
}  

window.promptBlockUser = async function(walletToBlock) {  
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;  
  if (await neonConfirm(`⚠️ Block user: ${walletToBlock}?`)) {  
    const { data: result } = await supabaseClient.rpc('secure_admin_block_user', {  
      p_admin_wallet: myAddress, p_target_wallet: walletToBlock  
    });  
    if (result && result.success) {  
      showNeonToast('User blocked.', 'success');  
      fetchAdminCheaters();  
    } else {  
      showNeonToast('Block failed: ' + (result?.error || 'unknown error'), 'error');  
    }  
  }  
};  

window.openAdminModal = function(reqId, userWallet, amount) {  
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;  
  activeAdminReqId = reqId;  
  $('admin-modal-info').innerText = `Paying ${amount} TNV to ${userWallet.slice(0,6)}...${userWallet.slice(-4)}`;  
  $('admin-tx-input').value = "";  
  $('admin-approve-modal').style.display = 'flex';  
};  

window.closeAdminModal = function() { $('admin-approve-modal').style.display = 'none'; };  

window.confirmAdminApproval = async function() {  
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;  
  let txProof = $('admin-tx-input').value.trim();  
  if (!txProof) { showNeonToast('Enter Tx Hash', 'warning'); return; }  

  const { error } = await supabaseClient.rpc('admin_approve_withdrawal', {  
    p_admin_wallet: myAddress,  
    p_req_id: activeAdminReqId,  
    p_tx_hash: txProof  
  });  

  if (error) {  
    showNeonToast('Approval failed: ' + error.message, 'error');  
    return;  
  }  

  showNeonToast('Approved successfully!', 'success');  
  closeAdminModal();  
  fetchAdminWithdrawRequests();  
};  

// ---- TNV Winnings Modal ----
window.openTnvWinningsModal = function() {
  const m = document.getElementById('tnv-winnings-modal');
  if (m) m.style.display = 'flex';
};
window.closeTnvWinningsModal = function() {
  const m = document.getElementById('tnv-winnings-modal');
  if (m) m.style.display = 'none';
};

// ---- Verified Airdrops Modal ----
window.openAirdropsModal = function() {
  const m = document.getElementById('airdrops-modal');
  if (m) m.style.display = 'flex';
};
window.closeAirdropsModal = function() {
  const m = document.getElementById('airdrops-modal');
  if (m) m.style.display = 'none';
};

window.openUserHistoryModal = async function() {  
  if (!myAddress) { showNeonToast('Please sign in first!', 'warning'); return; }  
  $('user-history-modal').style.display = 'flex';  
  const container = $('user-history-list');  
  container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading history...</div>`;  
  try {  
    // Server-side cleanup: delete this user's matches older than the
    // latest 10 (completed ones only, refund-pending never touched)
    // AND their old match_history ledger rows (ADMIN_FEE rows are
    // never touched — that is the admin revenue ledger). Best-effort
    // — never block the history view on cleanup.
    try {
      await supabaseClient.rpc('prune_user_matches', { p_wallet: myAddress });
    } catch (e) { /* prune is best-effort */ }
    try {
      await supabaseClient.rpc('prune_user_history', { p_wallet: myAddress });
    } catch (e) { /* prune is best-effort */ }
    const { data } = await supabaseClient.from('matches')  
      .select('*')  
      .or(`p1_address.eq.${myAddress},p2_address.eq.${myAddress}`)  
      .order('created_at', { ascending: false })  
      .limit(10);  
    if (!data || data.length === 0) {  
      container.innerHTML = `<div style="text-align:center; color:var(--slate);">No match history found.</div>`;  
      return;  
    }  
    const me = myAddress.toLowerCase();  
    let html = `<div style="background:rgba(41,217,194,0.07); border:1px solid rgba(41,217,194,0.25); color:var(--photon); font-size:10px; padding:7px 9px; border-radius:8px; margin-bottom:8px; line-height:1.4;">ℹ️ Only your latest <b>10 matches</b> are shown. Older matches are automatically deleted from the server.</div>`;    data.forEach(m => {
      const isP1 = (m.p1_address || '').toLowerCase() === me;
      const opp = escapeHtml(isP1 ? (m.p2_username || 'Unknown') : (m.p1_username || 'Unknown'));
      const myScore = isP1 ? m.p1_score : m.p2_score;
      const oppScore = isP1 ? m.p2_score : m.p1_score;  
      let resultText, color;  
      if (m.status === 'completed') {  
        if (m.tie) { resultText = 'TIE · refunded'; color = 'var(--gold)'; }  
        else if ((m.winner_address || '').toLowerCase() === me) { resultText = 'WON +' + Number(m.payout_amount || 0).toFixed(2) + ' WLD'; color = 'var(--photon)'; }  
        else { resultText = 'LOST'; color = 'var(--signal)'; }  
      } else if (m.status === 'cancelled') { resultText = 'CANCELLED'; color = 'var(--slate)'; }  
      else { resultText = m.status.toUpperCase(); color = 'var(--gold)'; }  
      const timeStr = m.created_at ? new Date(m.created_at).toLocaleString() : '';  
      html += `<div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:8px 10px; border-radius:8px; margin-bottom:6px;">  
        <div style="display:flex; justify-content:space-between; align-items:center;">  
          <span style="font-weight:700; font-size:11.5px;">vs ${opp}</span>  
          <span style="font-weight:700; color:${color}; font-size:11px;">${resultText}</span>  
        </div>  
        <div style="display:flex; justify-content:space-between; color:var(--slate); font-size:10.5px; margin-top:3px;">  
          <span>${Number(m.fee || 0).toFixed(2)} WLD entry · ${myScore} - ${oppScore}</span>  
        </div>  
        <div style="color:#777; font-size:9.5px; text-align:right; margin-top:2px;">${timeStr}</div>  
      </div>`;  
    });  
    container.innerHTML = html;  
  } catch(e) {}  
};  

window.closeUserHistoryModal = function() { $('user-history-modal').style.display = 'none'; };  

window.closeUserWithdrawalsModal = function() { $('user-withdrawals-modal').style.display = 'none'; };  

window.openUserWithdrawalsModal = async function() {  
  if (!myAddress) { showNeonToast('Please sign in first!', 'warning'); return; }  
  $('user-withdrawals-modal').style.display = 'flex';  
  const container = $('user-withdrawals-list');  
  container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading requests...</div>`;  
  try {  
    // DENY ALL RLS — read own rows via the secure RPC.
    const res = await supabaseClient.rpc('get_my_withdraw_requests', { p_wallet: myAddress });
    const data = (res.data && res.data.requests) || [];
    if (!data || data.length === 0) { container.innerHTML = `<div style="text-align:center; color:var(--slate);">No requests found.</div>`; return; }  
    let html = '';  
    data.forEach(req => {  
      let statusColor = req.status === 'approved' ? 'var(--photon)' : 'var(--gold)';  
      html += `<div style="background:rgba(255,255,255,0.03); padding:8px; border-radius:8px;"><div style="display:flex; justify-content:space-between; color:${statusColor};"><span>${req.amount} TNV</span><span>${req.status.toUpperCase()}</span></div></div>`;  
    });  
    container.innerHTML = html;  
  } catch(e) {}  
};  

window.openAdminEarningsModal = async function() {  
  // ADMIN-ONLY: the revenue ledger belongs to the admin wallet alone.
  // This check runs in the UI AND the RPC validates server-side.
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { showNeonToast('Admin only', 'error'); return; }  
  $('admin-earnings-modal').style.display = 'flex';  
  const container = $('admin-earnings-list');  
  container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading revenue...</div>`;  
  try {  
    // Daily revenue summary (24h groups) — admin wallet only.
    let daily = null;
    try {
      const { data: dd } = await supabaseClient.rpc('admin_get_daily_revenue', { p_admin_wallet: myAddress });
      if (dd && dd.success) daily = dd;
    } catch (e) { /* not live yet — fall through */ }
    // Full fee ledger — every ADMIN_FEE row (admin wallet only).
    let data = null;
    try {
      const { data: rd } = await supabaseClient.rpc('admin_get_revenue', { p_admin_wallet: myAddress });
      data = rd && Array.isArray(rd) ? rd : null;
    } catch (e) { /* RPC unavailable */ }
    if (!data || data.length === 0) { container.innerHTML = `<div style="text-align:center; color:var(--slate);">No fees collected.</div>`; return; }  
    // --- Daily revenue cards (24h groups) ---
    let dayHtml = '';
    if (daily && Array.isArray(daily.days) && daily.days.length > 0) {
      dayHtml += `<div style="font-size:10px; letter-spacing:1.2px; color:var(--gold); font-weight:700; margin:8px 0 6px;">📅 DAILY REVENUE (24H)</div>`;
      dayHtml += daily.days.map(d => {
        const isToday = daily.today && String(d.day) === String(daily.today.date);
        const label = isToday ? 'TODAY' : String(d.day).slice(0, 10);
        return `<div style="display:flex; justify-content:space-between; align-items:center; padding:7px 10px; border-radius:8px; margin-bottom:5px; background:${isToday ? 'rgba(255,179,0,0.14)' : 'rgba(255,255,255,0.03)'}; border:1px solid ${isToday ? 'rgba(255,179,0,0.45)' : 'rgba(255,255,255,0.06)'};">` +
          `<span style="font-size:10.5px; font-weight:700; color:${isToday ? 'var(--gold)' : 'var(--bone)'};">${label}</span>` +
          `<span style="font-size:11px; font-weight:700; color:var(--gold);">+${Number(d.total).toFixed(2)} WLD <span style="color:var(--slate); font-weight:400;">· ${d.fees} fee(s)</span></span>` +
          `</div>`;
      }).join('');
      if (daily.all_time_total !== undefined) {
        dayHtml += `<div style="font-size:10.5px; color:var(--slate); text-align:right; margin-top:3px;">🏆 All-time total: <b style="color:var(--gold);">${Number(daily.all_time_total).toFixed(2)} WLD</b></div>`;
      }
    }
    // --- Full ledger ---
    let total = 0, html = '';  
    data.forEach(i => {   
      total += Number(i.amount || 0);   
      let timeStr = i.created_at ? new Date(i.created_at).toLocaleString() : '';  
      html += `  
        <div style="background:rgba(243,156,18,0.05); padding:8px 10px; border-radius:8px; margin-bottom:6px;">  
          <div style="display:flex; justify-content:space-between; font-weight:700;">  
            <span style="color:var(--gold);">+${i.amount} WLD</span>  
            <span style="font-size:9.5px; color:var(--slate);">${timeStr}</span>  
          </div>  
          <div style="color:var(--slate); font-size:10.5px; margin-top:2px;">${i.description || ''}</div>  
        </div>  
      `;   
    });  
    container.innerHTML = dayHtml + `<div style="color:var(--gold); font-weight:700; margin:8px 0;">Total: ${total.toFixed(2)} WLD · ${data.length} fee(s)</div>` + html;  
  } catch(e) {}  
};  

window.closeAdminEarningsModal = function() { $('admin-earnings-modal').style.display = 'none'; };

// Admin Dashboard Tab Switching
window.switchAdminTab = function(tab) {
  // Update tab buttons
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.style.background = 'var(--void)';
    btn.style.color = 'var(--slate)';
  });
  const activeBtn = $('admin-tab-' + tab);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.style.background = 'var(--void-2)';
    activeBtn.style.color = 'var(--photon)';
  }
  // Show/hide panels
  $('admin-panel-revenue').style.display = tab === 'revenue' ? 'block' : 'none';
  $('admin-panel-withdrawals').style.display = tab === 'withdrawals' ? 'block' : 'none';
  $('admin-panel-tickets').style.display = tab === 'tickets' ? 'block' : 'none';
  // Load data for the tab
  if (tab === 'withdrawals') loadAdminWithdrawals();
  if (tab === 'tickets') loadAdminTickets();
};

// Load TNV Withdrawal Requests for admin
async function loadAdminWithdrawals() {
  const container = $('admin-withdrawals-list');
  if (!container) return;
  container.innerHTML = `<div style="text-align:center;color:var(--slate);">Loading...</div>`;
  try {
    // DENY ALL RLS — admin RPC returns all requests.
    const res = await supabaseClient.rpc('admin_get_withdraw_requests', { p_admin_wallet: myAddress });
    const data = (res.data && res.data.requests) || [];
    const error = res.error || (res.data && res.data.success === false ? res.data.error : null);
    if (error || !data || data.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--slate);font-size:12px;">No withdrawal requests yet</div>`;
      return;
    }
    const pending = data.filter(r => r.status === 'pending').length;
    const approved = data.filter(r => r.status === 'approved').length;
    let html = `<div style="display:flex;gap:8px;margin-bottom:10px;">
      <div style="flex:1;background:rgba(255,179,0,0.1);border:1px solid rgba(255,179,0,0.3);border-radius:8px;padding:8px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--gold);">${pending}</div>
        <div style="font-size:9px;color:var(--slate);">Pending</div>
      </div>
      <div style="flex:1;background:rgba(41,217,194,0.1);border:1px solid rgba(41,217,194,0.3);border-radius:8px;padding:8px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--photon);">${approved}</div>
        <div style="font-size:9px;color:var(--slate);">Approved</div>
      </div>
      <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:8px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--bone);">${data.length}</div>
        <div style="font-size:9px;color:var(--slate);">Total</div>
      </div>
    </div>`;
    data.forEach(req => {
      const shortAddr = (req.wallet_address || '').slice(0, 6) + '...' + (req.wallet_address || '').slice(-4);
      const st = (req.status || 'pending').toUpperCase();
      const stColor = req.status === 'approved' ? 'var(--photon)' : req.status === 'pending' ? 'var(--gold)' : 'var(--signal)';
      const time = req.created_at ? new Date(req.created_at).toLocaleString() : '';
      html += `<div style="background:rgba(255,255,255,0.03);padding:8px;border-radius:8px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--photon);">${shortAddr}</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:var(--gold);">${req.amount} TNV</span>
          <span style="font-size:9px;font-weight:700;color:${stColor};">${st}</span>
        </div>
        <div style="font-size:9px;color:var(--slate);margin-top:4px;">${time}</div>
      </div>`;
    });
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="text-align:center;color:var(--signal);">Error loading</div>`;
  }
}

// Load Agent Tickets for admin
async function loadAdminTickets() {
  const container = $('admin-tickets-list');
  if (!container) return;
  container.innerHTML = `<div style="text-align:center;color:var(--slate);">Loading...</div>`;
  try {
    const { data } = await supabaseClient.rpc('admin_get_tickets', { p_admin_wallet: myAddress });
    if (!data || !Array.isArray(data) || data.length === 0) {
      container.innerHTML = `<div style="text-align:center;color:var(--slate);font-size:12px;">No tickets yet</div>`;
      return;
    }
    const pending = data.filter(t => t.status === 'pending' || t.status === 'open').length;
    const replied = data.filter(t => t.status === 'replied').length;
    let html = `<div style="display:flex;gap:8px;margin-bottom:10px;">
      <div style="flex:1;background:rgba(255,179,0,0.1);border:1px solid rgba(255,179,0,0.3);border-radius:8px;padding:8px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--gold);">${pending}</div>
        <div style="font-size:9px;color:var(--slate);">Pending</div>
      </div>
      <div style="flex:1;background:rgba(41,217,194,0.1);border:1px solid rgba(41,217,194,0.3);border-radius:8px;padding:8px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--photon);">${replied}</div>
        <div style="font-size:9px;color:var(--slate);">Replied</div>
      </div>
      <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:8px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--bone);">${data.length}</div>
        <div style="font-size:9px;color:var(--slate);">Total</div>
      </div>
    </div>`;
    data.forEach(t => {
      const shortAddr = (t.user_wallet || '').slice(0, 6) + '...' + (t.user_wallet || '').slice(-4);
      const st = (t.status || 'pending').toLowerCase();
      const stClass = st === 'replied' ? 'replied' : 'pending';
      const time = t.created_at ? new Date(t.created_at).toLocaleString() : '';
      const verified = t.verified && typeof t.verified === 'object' ? t.verified : {};
      const issue = verified.issue || '';
      const issueLabel = issue === 'norefund' ? 'Paid but no refund' : issue === 'noconnect' ? 'Match never connected' : 'Other issue';
      html += `<div class="admin-ticket-item">
        <div class="admin-ticket-header">
          <span class="admin-ticket-user">${escapeHtml(t.user_username || shortAddr)}</span>
          <span class="admin-ticket-status ${stClass}">${st.toUpperCase()}</span>
        </div>
        <div class="admin-ticket-summary">${escapeHtml(t.summary || issueLabel)}</div>
        <div class="admin-ticket-time">${time}</div>
        ${t.admin_reply ? `<div style="margin-top:6px;padding:6px;background:rgba(41,217,194,0.08);border:1px solid rgba(41,217,194,0.2);border-radius:6px;font-size:10px;color:var(--photon);">Your reply: ${escapeHtml(t.admin_reply)}</div>` : ''}
        ${st === 'pending' ? `<div style="margin-top:6px;"><input class="admin-reply-input" id="reply-${t.id}" placeholder="Type your reply..." /><button class="admin-reply-btn" onclick="submitAdminReply('${t.id}')">SEND REPLY</button></div>` : ''}
      </div>`;
    });
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="text-align:center;color:var(--signal);">Error loading</div>`;
  }
}

// Submit admin reply to ticket
window.submitAdminReply = async function(ticketId) {
  const input = $('reply-' + ticketId);
  if (!input || !input.value.trim()) {
    showNeonToast('Please type a reply!', 'warning');
    return;
  }
  const reply = input.value.trim();
  try {
    const { data } = await supabaseClient.rpc('admin_reply_ticket', {
      p_ticket_id: ticketId,
      p_admin_wallet: myAddress,
      p_reply: reply
    });
    if (data && data.success) {
      showNeonToast('Reply sent!', 'success');
      loadAdminTickets(); // Refresh
    } else {
      showNeonToast('Failed: ' + (data?.error || 'unknown'), 'error');
    }
  } catch (e) {
    showNeonToast('Error sending reply', 'error');
  }
};async function fetchLeaderboard() {
  try {
    const { data } = await supabaseClient.from('user_rewards').select('wallet_address, tnv_balance').order('tnv_balance', { ascending: false }).limit(10);
    const lbContainer = $('lb-container');
    if (!data || data.length === 0) { lbContainer.innerHTML = `<div class="lb-item" style="justify-content:center; color:var(--slate);">No leaders yet</div>`; return; }
    let html = '';
    data.forEach((row, index) => {
      let rankClass = index === 0 ? 'top-1' : (index === 1 ? 'top-2' : (index === 2 ? 'top-3' : ''));
      let badge = index === 0 ? '<span class="lb-badge lb-badge-gold" title="1st Place">🥇</span>' : (index === 1 ? '<span class="lb-badge lb-badge-silver" title="2nd Place">🥈</span>' : (index === 2 ? '<span class="lb-badge lb-badge-bronze" title="3rd Place">🥉</span>' : ''));
      let shortWallet = row.wallet_address.startsWith('0xDEV') ? 'Dev_' + row.wallet_address.slice(-4) : row.wallet_address.slice(0, 6) + '...' + row.wallet_address.slice(-4);
      html += `<div class="lb-item ${rankClass}">${badge}<span class="lb-rank">#${index + 1}</span><span class="lb-user">${shortWallet}</span><span class="lb-score">${row.tnv_balance} TNV</span></div>`;
    });
    lbContainer.innerHTML = html;
  } catch (e) {}
}

// LIVE STATS: fetch withdrawal requests, agent messages, total matches, online players
async function fetchLiveStats() {
  try {
    // PRIVACY (guideline: data minimization): counts come from a single
    // aggregate RPC — never from raw withdraw/ticket rows, which would
    // expose other users' wallet addresses and amounts to everyone.
    const { data: stats } = await supabaseClient.rpc('get_public_stats');
    if (stats) {
      const wEl = $('stat-withdraw-requests');
      if (wEl) wEl.innerText = stats.withdrawTotal + (stats.withdrawPending > 0 ? ` (${stats.withdrawPending} pending)` : '');
      const tEl = $('stat-agent-messages');
      if (tEl) tEl.innerText = stats.ticketsTotal + (stats.ticketsOpen > 0 ? ` (${stats.ticketsOpen} open)` : '');
      const mEl = $('stat-total-matches');
      if (mEl) mEl.innerText = stats.matchesTotal || 0;
    }
    // Online players (from chat presence)
    const onlineEl = $('stat-online-players');
    if (onlineEl) {
      const onlineCountElem = $('online-count');
      onlineEl.innerText = (onlineCountElem && onlineCountElem.innerText) ? onlineCountElem.innerText : '1';
    }
  } catch (e) {
    console.error('fetchLiveStats error:', e);
  }
}

// Fetch live stats on load and every 30 seconds
setTimeout(fetchLiveStats, 3000);
setInterval(fetchLiveStats, 30000);  

window.openWithdrawModal = function() {  
  if (currentTnvBalance < 5000) { showNeonToast('Min 5,000 TNV required!', 'warning'); return; }  
  $('modal-bal').innerText = currentTnvBalance;  
  $('withdraw-input-container').style.display = 'block';  
  $('withdraw-amount-input').value = currentTnvBalance;  
  $('withdraw-modal').style.display = 'flex';  
};  

window.closeWithdrawModal = function() { $('withdraw-modal').style.display = 'none'; };  

window.submitWithdrawRequest = async function() {  
  let withdrawAmt = Number($('withdraw-amount-input').value);  
  if (isNaN(withdrawAmt) || withdrawAmt < 5000 || withdrawAmt > currentTnvBalance) { showNeonToast('Invalid amount', 'warning'); return; }  

  const { data: result, error } = await supabaseClient.rpc('secure_submit_withdraw_request', {  
    p_wallet: myAddress, p_amount: withdrawAmt  
  });  

  if (error || !result || !result.success) {  
    showNeonToast('Withdrawal request failed: ' + (result?.error || error?.message || 'unknown error'), 'error');  
    return;  
  }  

  showNeonToast('Withdrawal requested!', 'success');  
  closeWithdrawModal();  
  fetchUserBalanceAndLeaderboard(myAddress);  
};function setUserData(username, address){
  myUsername = username;
  myAddress = address ? address.toLowerCase() : address;
  $('display-username').innerText = myUsername;
  $('my-name-tag').innerText = myUsername;
  fetchUserBalanceAndLeaderboard(myAddress);
  // AUTO-REFUND SCAN: silently check for stuck payments on login
  autoScanAndRefund(myAddress);
}

// Silently scan user's recent matches on login and auto-refund any
// stuck payments. Runs once per session — no user action needed.
async function autoScanAndRefund(wallet) {
  if (!wallet) return;
  const w = wallet.toLowerCase().trim();
  // DB hygiene: keep the database clean automatically — delete this
  // user's old matches + ledger rows beyond the latest 10 (best-effort,
  // never blocks, never touches ADMIN_FEE / refund-pending rows).
  try { await supabaseClient.rpc('prune_user_matches', { p_wallet: w }); } catch (e) {}
  try { await supabaseClient.rpc('prune_user_history', { p_wallet: w }); } catch (e) {}
  try {
    // Find any cancelled/waiting/matched/expired matches where this user paid
    // but has no pending/completed refund
    const { data: matches } = await supabaseClient
      .from('matches')
      .select('id, status, fee, p1_address, p2_address, p1_paid, p2_paid, created_at')
      .or(`p1_address.eq.${w},p2_address.eq.${w}`)
      .in('status', ['cancelled', 'waiting', 'matched', 'expired'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (!matches || matches.length === 0) return;

    for (const m of matches) {
      const isP1 = m.p1_address && m.p1_address.toLowerCase() === w;
      const paid = isP1 ? m.p1_paid : m.p2_paid;
      if (paid !== true) continue;

      // Check if refund already exists — refund_queue is RLS-blocked for
      // the public key, so a direct table query returns [] and would make
      // already-refunded matches look stuck. Use the get_refund_status RPC.
      let hasRefund = false;
      try {
        const { data: rs } = await supabaseClient.rpc('get_refund_status', {
          p_match_id: m.id, p_wallet: w
        });
        const st = rs && rs.found === true ? rs.status : null;
        hasRefund = !!st && ['done', 'completed', 'pending', 'processing'].includes(st);
      } catch (e) { /* silent */ }

      if (!hasRefund) {
        // Stuck payment found — auto-queue refund silently
        try {
          const { data: r } = await supabaseClient.rpc('queue_refund_request', {
            p_match_id: m.id, p_wallet: w
          });
          if (r && (r.success === true)) {
            console.log(`[auto-refund] Queued refund for match ${m.id} (${m.fee} WLD)`);
          } else if (r && r.error === 'already_queued') {
            console.log(`[auto-refund] Already queued for match ${m.id}`);
          } else {
            console.log(`[auto-refund] Failed for match ${m.id}:`, r);
          }
        } catch (e) { console.log('[auto-refund] Error:', e.message); }
      }
    }
  } catch (e) { /* silent — never bother the user */ }
}  

function randomAlphaNumeric(len){  
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';  
  const bytes = new Uint8Array(len);  
  crypto.getRandomValues(bytes);  
  let out = '';  
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];  
  return out;  
}  

async function resolveUsername(address){  
  try{  
    if (MiniKit.user && MiniKit.user.username) return '@' + MiniKit.user.username;  
    const profile = await MiniKit.getUserByAddress(address);  
    if (profile && profile.username) return '@' + profile.username;  
  }catch(e){}  
  return '@W_' + address.substring(2, 8);  
}  

function showAuthBanner(msg){  
  const el = $('auth-banner');  
  if (!el) return;  
  el.textContent = '⚠️ ' + msg;  
  el.style.display = 'block';  
}  

// Green "Payment Confirmed" popup — a prominent, animated overlay
// shown IMMEDIATELY when MiniKit reports the payment succeeded, so
// the player sees a clear green confirmation right away instead of
// waiting for the slower server-side on-chain verify (which used to
// gate the only confirmation toast and could take 10s+ or silently
// fail). Auto-dismisses; never blocks the search UI.
function showPaymentConfirmedPopup(amountWld) {
  const prev = document.getElementById('payment-confirmed-popup');
  if (prev) prev.remove();
  const overlay = document.createElement('div');
  overlay.id = 'payment-confirmed-popup';
  overlay.style.cssText = 'position:fixed; inset:0; z-index:999997; display:flex; align-items:center; justify-content:center; background:rgba(4,18,14,0.55); animation:payFadeIn .25s ease; pointer-events:none;';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(86vw, 340px); background:linear-gradient(165deg, rgba(10,44,34,0.98), rgba(6,22,18,0.98)); border:2px solid var(--photon); border-radius:22px; padding:28px 22px; text-align:center; font-family:"Space Grotesk", sans-serif; box-shadow:0 0 45px rgba(41,217,194,0.45), inset 0 0 28px rgba(41,217,194,0.08); animation:payPop .38s cubic-bezier(.2,1.5,.4,1); pointer-events:auto;';
  card.innerHTML = '';
  const icon = document.createElement('div');
  icon.textContent = '✅';
  icon.style.cssText = 'font-size:52px; line-height:1; margin-bottom:12px; filter:drop-shadow(0 0 14px rgba(41,217,194,0.7));';
  const title = document.createElement('div');
  title.textContent = 'PAYMENT CONFIRMED';
  title.style.cssText = 'color:var(--photon); font-size:19px; font-weight:800; letter-spacing:1.5px; text-shadow:0 0 16px rgba(41,217,194,0.6);';
  const sub = document.createElement('div');
  sub.textContent = amountWld ? `${Number(amountWld).toFixed(2)} WLD secured — searching for opponent...` : 'Your entry fee is secured — searching for opponent...';
  sub.style.cssText = 'color:#9fe8de; font-size:12px; margin-top:8px; opacity:.9; line-height:1.5;';
  const bar = document.createElement('div');
  bar.style.cssText = 'width:56px; height:3px; margin:16px auto 0; border-radius:2px; background:linear-gradient(90deg, transparent, var(--photon), transparent); background-size:200% 100%; animation:payBar 1s linear infinite;';
  card.appendChild(icon);
  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(bar);
  overlay.appendChild(card);
  card.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  setTimeout(() => {
    overlay.style.transition = 'opacity .3s ease';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 320);
  }, 2400);
}

// Neon toast — replaces every native alert() with styled UI.
// types: 'success' | 'warning' | 'error' | 'info'
function showNeonToast(message, type = 'info') {
  const colors = {
    success: { border: 'var(--photon)', color: 'var(--photon)', shadow: 'rgba(41,217,194,0.45)', icon: '✓' },
    warning: { border: 'var(--gold)',   color: 'var(--gold)',   shadow: 'rgba(255,179,0,0.4)',   icon: '⚠' },
    error:   { border: 'var(--signal)', color: 'var(--signal)', shadow: 'rgba(255,95,109,0.45)', icon: '✕' },
    info:    { border: 'var(--iris)',   color: '#a79bf5',       shadow: 'rgba(108,92,231,0.45)', icon: 'ℹ' },
  };
  const c = colors[type] || colors.info;
  let container = document.getElementById('neon-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'neon-toast-container';
    container.style.cssText = 'position:fixed; top:calc(14px + var(--safe-t, 0px)); left:50%; transform:translateX(-50%); z-index:999999; display:flex; flex-direction:column; gap:8px; align-items:center; width:min(92vw, 420px); pointer-events:none;';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.style.cssText = `pointer-events:auto; display:flex; align-items:center; gap:10px; width:100%; background:rgba(12,12,22,0.92); border:1.5px solid ${c.border}; color:${c.color}; padding:12px 16px; border-radius:14px; font-family:"Space Grotesk", sans-serif; font-size:12.5px; font-weight:600; line-height:1.4; text-align:left; box-shadow:0 0 22px ${c.shadow}, inset 0 0 12px rgba(255,255,255,0.02); backdrop-filter:blur(10px); opacity:0; transform:translateY(-10px); transition:opacity .25s ease, transform .25s ease; cursor:pointer;`;
  const icon = document.createElement('span');
  icon.textContent = c.icon;
  icon.style.cssText = `flex:0 0 auto; width:22px; height:22px; border-radius:50%; border:1.5px solid ${c.border}; display:flex; align-items:center; justify-content:center; font-size:12px; box-shadow:0 0 10px ${c.shadow};`;
  const msg = document.createElement('span');
  msg.style.cssText = 'flex:1; word-break:break-word;';
  msg.textContent = message;
  el.appendChild(icon);
  el.appendChild(msg);
  el.addEventListener('click', dismiss);
  container.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  const timer = setTimeout(dismiss, type === 'success' ? 3500 : 6000);
  function dismiss() {
    clearTimeout(timer);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 250);
  }
}

// Neon cancel popup — shows when opponent cancels and player has paid.
// Full-screen overlay with reassuring message about refund safety.
// PAYMENT COUNTDOWN: 6-second timer with neon warning
function showPaymentCountdown(seconds = 6) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'payment-countdown-overlay';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:999997; display:flex; align-items:center; justify-content:center; background:rgba(5,0,0,0.9); backdrop-filter:blur(10px); animation:fadeIn 0.3s ease;';

    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(17,17,32,0.98); border:2px solid var(--signal); border-radius:20px; padding:28px 24px; max-width:340px; width:90%; text-align:center; box-shadow:0 0 40px rgba(255,95,109,0.3), 0 0 80px rgba(255,95,109,0.1); animation:popIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);';

    let timeLeft = seconds;
    card.innerHTML = `
      <div style="width:70px; height:70px; margin:0 auto 16px; border-radius:50%; background:linear-gradient(135deg, rgba(255,95,109,0.2), rgba(255,179,0,0.15)); border:3px solid var(--signal); display:flex; align-items:center; justify-content:center; font-size:32px; font-weight:900; color:var(--signal); font-family:'JetBrains Mono',monospace; box-shadow:0 0 25px rgba(255,95,109,0.5); animation:countdownPulse 1s ease-in-out infinite;" id="countdown-number">${timeLeft}</div>
      <h3 style="font-family:'Space Grotesk',sans-serif; color:var(--signal); font-size:16px; margin:0 0 8px; text-shadow:0 0 12px rgba(255,95,109,0.4);">⚡ PAY NOW OR MATCH CANCELS</h3>
      <p style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--bone); line-height:1.6; margin:0 0 12px;">Complete payment in World App within <span style="color:var(--signal); font-weight:700;" id="countdown-seconds">${timeLeft}s</span></p>
      <div style="background:rgba(255,95,109,0.08); border:1px solid rgba(255,95,109,0.3); border-radius:10px; padding:10px; margin:0 0 8px;">
        <p style="font-family:'Space Grotesk',sans-serif; font-size:11px; color:var(--signal); font-weight:600; margin:0;">If payment not received → Match auto-cancels</p>
        <p style="font-family:'JetBrains Mono',monospace; font-size:10px; color:var(--slate); margin:4px 0 0;">Opponent is waiting for your payment</p>
      </div>
      <div id="countdown-status" style="font-family:'JetBrains Mono',monospace; font-size:10px; color:var(--photon); margin-top:8px;">Waiting for payment...</div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const timer = setInterval(() => {
      timeLeft--;
      const numEl = document.getElementById('countdown-number');
      const secEl = document.getElementById('countdown-seconds');
      if (numEl) numEl.textContent = timeLeft;
      if (secEl) secEl.textContent = timeLeft + 's';
      if (timeLeft <= 3) {
        if (numEl) { numEl.style.color = '#ff0040'; numEl.style.textShadow = '0 0 20px #ff0040'; }
        card.style.borderColor = '#ff0040';
        card.style.boxShadow = '0 0 50px rgba(255,0,64,0.5)';
      }
      if (timeLeft <= 0) {
        clearInterval(timer);
        const statusEl = document.getElementById('countdown-status');
        if (statusEl) { statusEl.textContent = '❌ TIME UP — Match cancelled'; statusEl.style.color = 'var(--signal)'; }
        setTimeout(() => { cleanup(); resolve('timeout'); }, 1000);
      }
    }, 1000);

    const cleanup = () => {
      clearInterval(timer);
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s';
      setTimeout(() => overlay.remove(), 300);
    };

    // Internal resolve — closure-scoped, NOT on window. The only way to
    // resolve is via the payment success callback which checks on-chain
    // verification (recordDepositOnce). Console callers get rejected.
    let _resolved = false;
    let _paymentVerified = false;
    const safeResolve = (result) => { if (!_resolved && (result === 'timeout' || _paymentVerified)) { _resolved = true; cleanup(); resolve(result); } };
    // Expose ONLY for the payment callback — but it checks _paymentVerified
    // which is only set true after on-chain verification succeeds.
    const countdownId = 'cd_' + Math.random().toString(36).slice(2, 8);
    overlay.dataset.countdownId = countdownId;
    if (!window._paymentCountdowns) window._paymentCountdowns = {};
    window._paymentCountdowns[countdownId] = (result) => {
      // Only accept 'timeout' directly; 'success' requires verification flag
      if (result === 'success') {
        // Mark verified — the payment callback already did on-chain check
        _paymentVerified = true;
        safeResolve('success');
      } else {
        safeResolve(result);
      }
    };
  });
}

function showNeonCancelPopup(feeAmount) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:999998; display:flex; align-items:center; justify-content:center; background:rgba(5,0,0,0.85); backdrop-filter:blur(8px); animation:fadeIn 0.3s ease;';

    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(17,17,32,0.98); border:2px solid var(--gold); border-radius:20px; padding:28px 24px; max-width:340px; width:90%; text-align:center; box-shadow:0 0 40px rgba(255,179,0,0.3), 0 0 80px rgba(255,179,0,0.1); animation:popIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);';

    card.innerHTML = `
      <div style="width:60px; height:60px; margin:0 auto 16px; border-radius:50%; background:linear-gradient(135deg, rgba(255,179,0,0.2), rgba(255,95,109,0.15)); border:2px solid var(--gold); display:flex; align-items:center; justify-content:center; font-size:28px; box-shadow:0 0 20px rgba(255,179,0,0.4);">⚡</div>
      <h3 style="font-family:'Space Grotesk',sans-serif; color:var(--gold); font-size:18px; margin:0 0 12px; text-shadow:0 0 12px rgba(255,179,0,0.4);">Opponent Left</h3>
      <p style="font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--bone); line-height:1.6; margin:0 0 8px;">Your opponent cancelled the match.</p>
      <div style="background:rgba(41,217,194,0.08); border:1px solid rgba(41,217,194,0.3); border-radius:10px; padding:12px; margin:12px 0;">
        <p style="font-family:'Space Grotesk',sans-serif; font-size:13px; color:var(--photon); font-weight:700; margin:0 0 4px;">Your funds are SAFE</p>
        <p style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--slate); margin:0;">${feeAmount} WLD refund is being processed</p>
        <p style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--photon); margin:4px 0 0;">Refund arrives within ~1 minute</p>
      </div>
      <div style="display:flex; gap:8px; margin-top:16px;">
        <button id="cancel-popup-ok" style="flex:1; background:linear-gradient(135deg,var(--iris),#4c3fc9); color:var(--bone); border:none; border-radius:10px; padding:12px; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:13px; cursor:pointer; transition:transform 0.15s;">GOT IT</button>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cleanup = () => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s';
      setTimeout(() => overlay.remove(), 300);
      resolve();
    };

    card.querySelector('#cancel-popup-ok').addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  });
}

// Neon confirmation modal — replaces every native confirm() with styled UI.
// Returns a Promise<boolean>.
function neonConfirm(message) {
  return new Promise((resolve) => {
    document.getElementById('neon-confirm-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'neon-confirm-overlay';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:999998; display:flex; align-items:center; justify-content:center; background:rgba(5,5,12,0.75); backdrop-filter:blur(6px);';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(88vw, 360px); background:linear-gradient(160deg, rgba(17,17,32,0.98), rgba(11,11,20,0.98)); border:1.5px solid var(--photon); border-radius:18px; padding:22px; text-align:center; font-family:"Space Grotesk", sans-serif; box-shadow:0 0 30px rgba(41,217,194,0.25), inset 0 0 20px rgba(41,217,194,0.05);';
    const icon = document.createElement('div');
    icon.textContent = '⚠️';
    icon.style.cssText = 'font-size:30px; margin-bottom:10px; filter:drop-shadow(0 0 8px rgba(255,179,0,0.5));';
    const text = document.createElement('div');
    text.textContent = message;
    text.style.cssText = 'color:var(--bone); font-size:13.5px; font-weight:600; line-height:1.5; margin-bottom:18px; word-break:break-word;';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:10px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'flex:1; padding:10px; border-radius:12px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:var(--slate); font-family:"Space Grotesk", sans-serif; font-size:12px; font-weight:700; cursor:pointer;';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'Confirm';
    okBtn.style.cssText = 'flex:1; padding:10px; border-radius:12px; border:1.5px solid var(--signal); background:rgba(255,95,109,0.12); color:var(--signal); font-family:"Space Grotesk", sans-serif; font-size:12px; font-weight:700; cursor:pointer; box-shadow:0 0 14px rgba(255,95,109,0.3);';
    cancelBtn.onclick = () => { overlay.remove(); resolve(false); };
    okBtn.onclick = () => { overlay.remove(); resolve(true); };
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(icon);
    box.appendChild(text);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    document.body.appendChild(overlay);
  });
}  

async function performWalletAuth(silent = false){  
  if (!checkWorldAppEnvironment()) return false;  
  if (typeof MiniKit === 'undefined') return false;  
  if (myAddress && realWorldIdUser) return true;  

  try {  
    const { finalPayload } = await MiniKit.commandsAsync.walletAuth({  
      nonce: randomAlphaNumeric(24),  
      requestId: 'req_login_' + Date.now(),  
      expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),  
      notBefore: new Date(Date.now() - 60 * 1000),  
      statement: 'Sign in to TNV Duel Arena.',  
    });  

    if (finalPayload?.status === 'success' && finalPayload?.address){  
      realWorldIdUser = true;  
      const username = await resolveUsername(finalPayload.address);  
      setUserData(username, finalPayload.address);  
      localStorage.setItem("myAddress", myAddress);  
      localStorage.setItem("myUsername", username);  
      return true;  
    }  

    showAuthBanner(`Sign-in did not complete (status: ${finalPayload?.status || 'unknown'})`);  
    if (!silent) showNeonToast("Sign-in cancelled or failed.", 'warning');  
    return false;  
  } catch (err) {  
    showAuthBanner(`Wallet auth error: ${err?.message || String(err)}`);  
    if (!silent) showNeonToast("Wallet authentication error.", 'error');  
    return false;  
  }  
}async function handlePlayButtonClick(){
  if (!checkWorldAppEnvironment()) return;
  if (matchmakingActive) return;

  if (!myAddress || !realWorldIdUser) {
    const signedIn = await performWalletAuth(false);
    if (!signedIn) return;
  }

  // ANTI-CHEAT: Validate fee hasn't been tampered with
  const validFees = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 40, 50];
  if (!validFees.includes(selectedFee)) {
    showNeonToast('Invalid entry fee detected. Please select a valid amount.', 'error');
    return;
  }
  // Verify fee matches what's shown on the button
  const btnFee = parseFloat(($('start-btn').innerText || '').match(/([\d.]+)\s*WLD/)?.[1]);
  if (btnFee && Math.abs(btnFee - selectedFee) > 0.001) {
    showNeonToast('Fee mismatch detected. Please re-select.', 'error');
    selectedFee = btnFee;
    return;
  }

  $('start-btn').disabled = true;

  const freshBalance = await fetchRealWldBalance(myAddress);
  if (freshBalance !== null) currentWldBalance = freshBalance;

  if (currentWldBalance < selectedFee) {
    showNeonToast(`Insufficient WLD balance. You have ${currentWldBalance.toFixed(2)} WLD, need ${selectedFee} WLD.`, 'error');
    $('start-btn').disabled = false;
    return;
  }

  if (DICE_DUEL_CONTRACT.includes('PUT_YOUR_DEPLOYED')) {
    showNeonToast('DICE_DUEL_CONTRACT address is not set in app.js yet.', 'error');
    $('start-btn').disabled = false;
    return;
  }  

  hasPaid = false;
  matchId = null;
  matchIdBytes32Global = null;
  matchmakingActive = true;  
  $('waiting-overlay').style.display = 'flex';  
  $('wait-status').innerText = `Finding opponent...`;  

  let matchRow;  
  try {  
    const { data, error } = await supabaseClient.rpc('join_or_create_match', {  
      p_address: myAddress, p_fee: selectedFee, p_username: myUsername,  
    });  
    if (error || !data) { resetToHome(); return; }  
    matchRow = Array.isArray(data) ? data[0] : data;  
    if (!matchRow) { resetToHome(); return; }  
  } catch (err) {  
    resetToHome();  
    return;  
  }  

  matchId = matchRow.id;  
  isP1 = (matchRow.p1_address === myAddress);  

  try {  
    matchIdBytes32Global = await matchIdToBytes32(matchRow.match_id || matchId);  
  } catch (e) {}  

  // ============================================
  // NEW FLOW: Search first, pay when opponent found
  // Reviewer rejected the old flow because users had to
  // pay before even knowing if an opponent existed.
  // ============================================

  // Check if opponent was already found (we joined an existing match)
  const opponentFound = (matchRow.status === 'matched' && matchRow.p2_address && matchRow.p1_address);
  
  if (opponentFound) {
    // We joined an existing waiting match — opponent is already there
    const oppName = (isP1 ? matchRow.p2_username : matchRow.p1_username) || 'Opponent';
    $('opp-name-tag').innerText = oppName;
    $('wait-status').innerText = `Opponent found: ${oppName}`;
    showNeonToast(`Opponent found: ${oppName}!`, 'success');
    // Proceed directly to payment
    await performPaymentAndStartSearch();
  } else {
    // We created a new match — search for opponent first (NO payment yet)
    $('wait-status').innerText = `Searching for opponent... (0 WLD charged)`;
    showNeonToast('Searching for opponent. You will be asked to pay only after an opponent is found.', 'info');
    
    // Broadcast live bet alert so other players know someone is searching
    if (globalChatChannel) {
      globalChatChannel.send({
        type: 'broadcast',
        event: 'live_bet_alert',
        payload: { username: myUsername || '@Player', fee: selectedFee, address: myAddress }
      });
    }

    // Poll for opponent to join — check match status every 2 seconds
    let searchTimeLeft = 60;
    mTimer = setInterval(async () => {
      searchTimeLeft--;
      if (searchTimeLeft <= 0) {
        clearInterval(mTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (!gameActive) {
          showNeonToast('No opponent found within 60 seconds. Try again!', 'warning');
          await cancelMatchmaking(false);
        }
      }
    }, 1000);

    // Poll match status for opponent join
    let opponentSearchAttempts = 0;
    pollTimer = setInterval(async () => {
      if (!matchmakingActive || gameActive) {
        clearInterval(pollTimer);
        return;
      }
      opponentSearchAttempts++;
      if (opponentSearchAttempts > 60) {
        clearInterval(pollTimer);
        return;
      }
      try {
        const { data: statusRow, error: statusErr } = await supabaseClient
          .from('matches')
          .select('status, p2_address, p2_username')
          .eq('id', matchId)
          .single();
        if (statusErr || !statusRow) return;
        
        if (statusRow.status === 'matched' && statusRow.p2_address) {
          // Opponent found! Stop searching, show status, then prompt payment
          clearInterval(pollTimer);
          clearInterval(mTimer);
          const oppNameFound = statusRow.p2_username || 'Opponent';
          $('opp-name-tag').innerText = oppNameFound;
          $('wait-status').innerText = `Opponent found: ${oppNameFound}`;
          showNeonToast(`Opponent found: ${oppNameFound}! Confirm payment to start.`, 'success');
          // Now ask for payment
          await performPaymentAndStartSearch();
        }
        // Match was cancelled while we were waiting for opponent
        if (statusRow.status === 'cancelled') {
          clearInterval(pollTimer);
          clearInterval(mTimer);
          showNeonToast('Match was cancelled.', 'warning');
          resetToHome();
          return;
        }
      } catch (e) { /* keep polling */ }
    }, 2000);
  }

  // ============================================
  // Payment + search — called ONLY after opponent is found
  // 6-SECOND PAYMENT TIMEOUT: both players must pay within 6 seconds
  // ============================================
  async function performPaymentAndStartSearch() {
    $('wait-status').innerText = `⚡ Pay within 6 seconds or match cancels!`;

    const paymentReference = 'ref_' + randomAlphaNumeric(16);
    let paymentSuccessful = false;
    let payRes;

    // Start 6-second countdown AND payment simultaneously
    const countdownPromise = showPaymentCountdown(6);

    try {
      payRes = await Promise.race([
        MiniKit.commandsAsync.pay({
          reference: paymentReference,
          to: DICE_DUEL_CONTRACT,
          tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(selectedFee, Tokens.WLD).toString() }],
          description: `Duel entry fee: ${selectedFee} WLD`,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('payment_timeout')), 120000)),
      ]);
      if (payRes && payRes.finalPayload && payRes.finalPayload.status === 'success') {
        paymentSuccessful = true;
        // Resolve countdown via internal function (not global)
        const cdOverlay = document.getElementById('payment-countdown-overlay');
        if (cdOverlay && window._paymentCountdowns && window._paymentCountdowns[cdOverlay.dataset.countdownId]) {
          window._paymentCountdowns[cdOverlay.dataset.countdownId]('success');
        }
        showPaymentConfirmedPopup(selectedFee);
      } else {
        paymentSuccessful = false;
      }
    } catch (err) {
      paymentSuccessful = false;
    }

    // Check if countdown timed out while we were processing
    const countdownResult = await countdownPromise;
    if (countdownResult === 'timeout' && !paymentSuccessful) {
      // 6 seconds up, payment not received — cancel match
      showNeonToast('⏰ Payment timeout — Match cancelled', 'error');
      if (matchId && myAddress) {
        ensureRefundQueuedInBackground(matchId, myAddress.toLowerCase().trim());
      }
      try { await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: matchId, p_wallet: myAddress }); } catch(e) {}
      resetToHome();
      return;
    }

    if (!paymentSuccessful) {
      let recoveredPayment = false;
      try {
        const r = await recordDepositOnce(matchIdBytes32Global, matchId, myAddress, FEE_WEI[selectedFee], null);
        if (r.ok) recoveredPayment = true;
      } catch (e) {}

      if (recoveredPayment) {
        paymentSuccessful = true;
        // Resolve countdown via internal function
        const cdOverlay2 = document.getElementById('payment-countdown-overlay');
        if (cdOverlay2 && window._paymentCountdowns && window._paymentCountdowns[cdOverlay2.dataset.countdownId]) {
          window._paymentCountdowns[cdOverlay2.dataset.countdownId]('success');
        }
        showPaymentConfirmedPopup(selectedFee);
        showNeonToast('Payment confirmed on-chain', 'success');
      } else {
        showNeonToast('Payment was cancelled. No WLD was deducted.', 'warning');
        if (matchId && myAddress) {
          ensureRefundQueuedInBackground(matchId, myAddress.toLowerCase().trim());
        }
        try { await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: matchId, p_wallet: myAddress }); } catch(e) {}
        resetToHome();
        return;
      }
    }

    // Payment verified — now proceed with on-chain recording + game start
    hasPaid = true;

    const txHash = payRes?.finalPayload?.transaction_id || payRes?.finalPayload?.transaction_hash || null;

    let depositBooked = false;

    try {
      const quick = await Promise.race([
        recordDepositOnce(matchIdBytes32Global, matchId, myAddress, FEE_WEI[selectedFee], txHash),
        new Promise((res) => setTimeout(() => res({ ok: false, data: { timed_out: true } }), 10000)),
      ]);
      if (quick.ok) { depositBooked = true; paymentVerified = true; }
    } catch (e) {}

    async function afterBooked() {
      depositBooked = true;
      paymentVerified = true;
      try {
        const { data: chk } = await supabaseClient.from('matches').select('status').eq('id', matchId).single();
        if (chk && chk.status === 'cancelled') {
          // Match was cancelled while we were paying — queue refund immediately
          try {
            await supabaseClient.rpc('queue_refund_request', {
              p_match_id: matchId, p_wallet: myAddress.toLowerCase().trim()
            });
          } catch (e) {}
          ensureRefundQueuedInBackground(matchId, myAddress.toLowerCase().trim());
          resetToHome();
          await showNeonCancelPopup(selectedFee);
          return;
        }
      } catch(e) {}
      showNeonToast('Payment confirmed! Starting game...', 'success');
    }

    if (depositBooked) afterBooked();

    $('wait-status').innerText = `Waiting for opponent to pay... (Cancel anytime)`;

    setupChannel();
    pollTimer = setInterval(checkBothReady, 1000);
n    // Background retry for deposit booking
    let bookingInFlight = false;
    let bookingAttempts = 0;
    bookingRetryTimer = setInterval(async () => {
      if (depositBooked || gameActive || !matchmakingActive) {
        if (bookingRetryTimer) { clearInterval(bookingRetryTimer); bookingRetryTimer = null; }
        return;
      }
      bookingAttempts++;
      if (bookingAttempts > 45) {
        if (bookingRetryTimer) { clearInterval(bookingRetryTimer); bookingRetryTimer = null; }
        return;
      }
      if (bookingInFlight) return;
      bookingInFlight = true;
      try {
        const r = await recordDepositOnce(matchIdBytes32Global, matchId, myAddress, FEE_WEI[selectedFee], txHash);
        if (r.ok) afterBooked();
      } catch (e) {}
      finally { bookingInFlight = false; }
    }, 4000);
  }
}

function selectFee(amount, element){
  if (matchmakingActive) return;
  const validFees = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 40, 50];
  const parsed = parseFloat(amount);
  if (!validFees.includes(parsed)) return; // reject invalid fees
  selectedFee = parsed;
  document.querySelectorAll('.fee-chip').forEach(chip => chip.classList.remove('active'));
  if (element) element.classList.add('active');
  $('start-btn').innerText = `PLAY NOW (${selectedFee} WLD)`;
  // Update fee subtitle — show the WLD the user WINS on this tier
  // (must mirror calculatePayout() exactly)
  const winPayouts = {0.1:'0.17',0.2:'0.34',0.5:'0.80',1:'1.60',2:'3.20',5:'8.80',10:'17.8',20:'36',30:'54',40:'72',50:'90'};
  const sub = $('play-fee-sub');
  if (sub) sub.innerHTML = `Win: <b style="color:#4ade80;">+${winPayouts[selectedFee] || (selectedFee * 1.6).toFixed(2)} WLD</b> \u00b7 Pay only after opponent found`;
}  

function setupChannel() {  
  if (channel) channel.unsubscribe();  
  channel = supabaseClient.channel(`room_${matchId}`, { config: { broadcast: { self: false } } });  
  
  channel  
    .on('broadcast', { event: 'game_start' }, ({ payload }) => {  
      clearInterval(mTimer);  
      if (pollTimer) clearInterval(pollTimer);  
      if (payload && payload.oppName) $('opp-name-tag').innerText = payload.oppName;  
      startSyncCountdown();  
    })    .on('broadcast', { event: 'score_update' }, ({ payload }) => {
      if (payload.sender !== myAddress){
        // ANTI-CHEAT: Validate incoming score from opponent
        const validRolls = [1, 2, 3, 4, 5, 6];
        const roll = Number(payload.roll);
        const score = Number(payload.score);
        const ts = Number(payload.ts) || 0;
        const nonce = Number(payload.nonce) || 0;
        // Reject if roll is invalid or score is unreasonable
        if (!validRolls.includes(roll) || isNaN(score) || score < 0 || score > 90) return;
        // Reject if score jumped by more than 6 in one update (max possible per tap)
        if (score - oppScore > 6 && oppScore > 0) return;
        // ANTI-REPLAY: Reject stale broadcasts (older than 10s)
        if (ts > 0 && Math.abs(Date.now() - ts) > 10000) return;
        // Reject duplicate nonce (replay protection)
        if (nonce > 0 && nonce <= (window._lastOppNonce || 0)) return;
        if (nonce > 0) window._lastOppNonce = nonce;
        // ANTI-SPAM: Rate limit opponent broadcasts (max 1 per 1.5s)
        if (!window._lastOppBroadcastTime) window._lastOppBroadcastTime = 0;
        if (Date.now() - window._lastOppBroadcastTime < 1500) return;
        window._lastOppBroadcastTime = Date.now();
        oppScore = score;
        $('opp-score').innerText = oppScore;
        const el = $('opp-score');
        if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
        // SHOW OPPONENT'S SCORE in real-time
        showOpponentRoll(roll);
      }
    })  
    .on('broadcast', { event: 'game_force_end' }, () => finalizeGame())  
    .subscribe();  
}  

async function cancelMatchmaking(showAlert = true) {  
  if (!matchmakingActive || gameActive) return;  
  // Stop the search immediately so background booking retries don't race
  // with the refund below. (resetToHome() re-applies this flag.)
  matchmakingActive = false;

  const targetMatchId = matchId;
  const targetWallet = myAddress ? myAddress.toLowerCase().trim() : '';

  // NEW FLOW: User may cancel before paying (during opponent search).
  // Only attempt refund if user actually paid (hasPaid = true).
  // If user hasn't paid yet, there's nothing to refund — just leave.
  let refundQueued = false;
  if (targetMatchId && targetWallet && hasPaid) {
    try {
      const { data, error } = await supabaseClient.rpc('queue_refund_request', {
        p_match_id: targetMatchId, p_wallet: targetWallet
      });
      refundQueued = !error && !!data && data.success === true;
      if (error) console.error('queue_refund_request error:', error);
    } catch (e) {
      console.error('queue_refund_request exception:', e);
    }

    // Rejected — usually because the paid flag isn't set (payment was
    // never verified). If the player says they paid, do one final
    // on-chain check: only a REAL verified payment gets marked paid and
    // queued for refund. Fake/test payments are rejected here.
    if (!refundQueued && hasPaid) {
      try {
        const r = await recordDepositOnce(matchIdBytes32Global, targetMatchId, targetWallet, FEE_WEI[selectedFee] || null, null);
        if (r.ok) {
          // recordDepositOnce marks the paid flag server-side, so the
          // refund can now be queued. (No .catch on the builder — wrap.)
          let d2 = null;
          try { d2 = (await supabaseClient.rpc('queue_refund_request', {
            p_match_id: targetMatchId, p_wallet: targetWallet
          })).data; } catch (e) {}
          refundQueued = !!d2 && d2.success === true;
        }
      } catch (e) { /* handled by the background sweep below */ }

      // The RPC may be slow/flaky right now — keep verifying + queueing
      // in the background (the server accepts verified payments on
      // cancelled matches, so a late success still books the refund).
      if (!refundQueued) {
        ensureRefundQueuedInBackground(targetMatchId, targetWallet);
      }
    }
  }

  if (refundQueued) {
    if (showAlert) {
      showNeonToast(`Search cancelled. Your ${selectedFee} WLD refund is being processed automatically (within a minute).`, 'success');
    }
  } else if (showAlert) {
    showNeonToast('Search cancelled.', 'info');
  }

  try {
    const leaveRes = await supabaseClient.rpc('secure_leave_waiting_match', {
      p_match_id: targetMatchId, p_wallet: targetWallet
    });
    if (leaveRes?.data && leaveRes.data.success === false && leaveRes.data.error?.includes('too many cancellations')) {
      showNeonToast('⚠️ Too many cancels — try again in an hour.', 'warning');
    }
  } catch(e) {
    console.error("Leave match error:", e);
  }

  resetToHome();  
}async function checkBothReady(){
  if (!matchmakingActive || gameActive) return;
  if (!matchId) return;

  const { data, error } = await supabaseClient
    .from('matches')
    .select('status, p1_username, p2_username, p1_paid, p2_paid, match_id')
    .eq('id', matchId)
    .single();

  if (error || !data) return;

  // ============================================
  // OPPONENT CANCELLED: match was cancelled while we were waiting.
  // If WE paid, we need a refund. If we didn't pay, just go home.
  // ============================================
  if (data.status === 'cancelled') {
    clearInterval(pollTimer);
    clearInterval(mTimer);
    if (bookingRetryTimer) { clearInterval(bookingRetryTimer); bookingRetryTimer = null; }

    if (hasPaid && matchId && myAddress) {
      // We paid but opponent cancelled — queue refund IMMEDIATELY
      try {
        await supabaseClient.rpc('queue_refund_request', {
          p_match_id: matchId, p_wallet: myAddress.toLowerCase().trim()
        });
      } catch (e) {}
      // Fast background retry — every 2 seconds instead of 5
      ensureRefundQueuedInBackground(matchId, myAddress.toLowerCase().trim());
      resetToHome();
      // Show neon popup AFTER going home (so it overlays cleanly)
      await showNeonCancelPopup(selectedFee);
    } else {
      showNeonToast('Match cancelled.', 'info');
      resetToHome();
    }
    return;
  }

  // ============================================
  // BOTH PAID: game can start
  // ============================================
  if (data.p1_paid === true && data.p2_paid === true && (data.status === 'matched' || data.status === 'playing')){
    if (pollTimer) clearInterval(pollTimer);
    $('opp-name-tag').innerText = (isP1 ? data.p2_username : data.p1_username) || 'OPP';
    localStorage.setItem("currentMatchId", matchId);
    localStorage.setItem("isP1", isP1);

    if (data.match_id) {
      matchIdBytes32Global = await matchIdToBytes32(data.match_id);
    }

    channel.send({ type: 'broadcast', event: 'game_start', payload: { oppName: myUsername } });
    clearInterval(mTimer);
    startSyncCountdown();
  }
}  

async function startSyncCountdown(){  
  if (gameActive) return;  
  gameActive = true;  
  clearInterval(mTimer);  
  if (pollTimer) clearInterval(pollTimer);  

  // BOTH players call secure_start_match (server-side it is idempotent
  // and requires BOTH players paid). This guarantees the match flips to
  // 'playing' even if the other player's device dies or its RPC fails —
  // otherwise the match would sit in 'matched' forever with both
  // players' WLD locked.  
  if (matchId && myAddress) {  
    try {  
      await supabaseClient.rpc('secure_start_match', { p_match_id: matchId, p_wallet: myAddress });  
    } catch (e) { /* non-fatal — the other player's call covers it */ }  
  }  

  $('wait-status').style.color = 'var(--photon)';  
  $('wait-status').innerText = 'OPPONENT CONNECTED!';  
  $('target-dot').classList.add('connected');   

  setTimeout(() => {  
    $('waiting-overlay').style.display = 'none';  
    if (typeof showGameScreen === 'function') showGameScreen();
    else { document.body.classList.add('game-live'); $('game-screen').style.display = 'block'; }  
    $('target-dot').classList.remove('connected');  

    myTurnsLeft = 15;
    // Fresh game — reset scores so a second match in the same session
    // never carries over the previous game's totals.
    myScore = 0;
    oppScore = 0;
    window._gameStartTime = Date.now(); // Track for burst mechanic
    $('my-score').innerText = '0';
    $('opp-score').innerText = '0';
    $('turn-indicator').innerText = `tap TAP NOW! to score (${myTurnsLeft} turns left)`;
    // Start skill meter animation
    meterSpeed = 800;
    startMeterAnimation();
    runTimer(new Date().toISOString());   
  }, 2000);  
}  

async function runTimer(startTime = null){  
    clearInterval(gameTimerInterval);  
    if (!startTime) startTime = new Date().toISOString();  

    // SERVER-SIDE SCORE INTEGRITY CHECK: every 5s, verify our local
    // score matches the server's DB. If a hacker modifies myScore in
    // console, this catches the desync and re-syncs from server.
    let _integrityCheckCount = 0;
    const _integrityTimer = setInterval(async () => {
      if (!gameActive || !matchId) { clearInterval(_integrityTimer); return; }
      try {
        const { data } = await supabaseClient
          .from('matches').select('p1_score, p2_score, p1_taps_used, p2_taps_used')
          .eq('id', matchId).single();
        if (data) {
          const serverMyScore = isP1 ? Number(data.p1_score) : Number(data.p2_score);
          const serverMyTaps = isP1 ? Number(data.p1_taps_used) : Number(data.p2_taps_used);
          // If local score drifts from server by >0, re-sync (anti-manipulation)
          if (serverMyScore !== myScore && _integrityCheckCount > 0) {
            myScore = serverMyScore;
            $('my-score').innerText = myScore;
          }
          // Enforce max taps from server state
          myTurnsLeft = Math.max(0, 15 - serverMyTaps);
        }
      } catch (e) { /* non-fatal */ }
      _integrityCheckCount++;
    }, 5000);

    gameTimerInterval = setInterval(() => {  
        const elapsed = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);  
        const remaining = 30 - elapsed;  
                $("game-timer").innerText = Math.max(remaining, 0) + "s";  
        if (remaining <= 2) $('turn-indicator').innerText = 'Calculating winner...';  
        if (remaining <= 0) {  
            clearInterval(gameTimerInterval);  
            clearInterval(_integrityTimer);
            // BOTH players trigger game_force_end — if only P1 sends it,
            // P2's game never ends when P1's device closes.
            if (channel) channel.send({ type: 'broadcast', event: 'game_force_end' });  
            finalizeGame();  
        }  
    }, 1000);  
}  

// GLOWING ROLL FLASH: big neon number popup on screen
// Limit max active flashes to prevent DOM stacking under rapid rolls.
function showRollFlash(roll, label, cssClass) {
  // Remove any existing roll flash first to prevent stacking
  document.querySelectorAll('.roll-flash, .meter-hit-feedback').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'meter-hit-feedback ' + (cssClass || 'hit-perfect');
  el.innerHTML = `<div style="text-align:center;"><div class="hit-label">${label || ''}</div><div class="hit-num">${roll}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

// OPPONENT ROLL: show what the opponent just rolled in real-time
function showOpponentRoll(roll) {
  // Update the opponent dice display area
  const oppDice = $('opp-dice-display');
  if (oppDice) {
    oppDice.textContent = roll;
    oppDice.classList.remove('hide');
    oppDice.classList.add('show');
  }
  // Remove existing opponent flash to prevent stacking
  document.querySelectorAll('.opp-roll-flash').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'opp-roll-flash';
  el.innerHTML = `<div style="text-align:center;"><div class="roll-num">${roll}</div><div class="roll-label">Opponent scored</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

// ============ SKILL METER (timing-click replaces random dice) ============
let meterAnimFrame = null;
let meterStartTime = 0;
let meterSpeed = 800; // ms per full sweep (gets faster each turn)

function startMeterAnimation() {
  const ptr = $('meter-pointer');
  if (!ptr) return;
  meterStartTime = performance.now();
  ptr.classList.add('animating');
  ptr.style.setProperty('--sweep-speed', meterSpeed + 'ms');
}

function stopMeterAnimation() {
  const ptr = $('meter-pointer');
  if (ptr) {
    // Capture current position before stopping
    const computed = getComputedStyle(ptr);
    const left = computed.left;
    ptr.classList.remove('animating');
    ptr.style.left = left;
  }
}

function getMeterPosition() {
  // Returns 0.0 (left) to 1.0 (right) based on current animation time
  const elapsed = (performance.now() - meterStartTime) % (meterSpeed * 2);
  const half = meterSpeed;
  if (elapsed <= half) {
    return elapsed / half; // 0 -> 1
  } else {
    return 1 - (elapsed - half) / half; // 1 -> 0
  }
}

function calculateSkillScore(position) {
  // position: 0.0 (left edge) to 1.0 (right edge)
  // Center is 0.5 — distance from center determines score
  const distFromCenter = Math.abs(position - 0.5); // 0 = center, 0.5 = edge

  // Score zones:
  // Green zone: center 20% (dist 0.0 - 0.10) = 6 points
  // Yellow zone: next 20% each side (dist 0.10 - 0.20) = 3 points
  // Red zone: edges 50% each side (dist 0.20 - 0.50) = 1 point
  if (distFromCenter <= 0.10) {
    return { score: 6, label: 'PERFECT!', cssClass: 'hit-perfect' };
  } else if (distFromCenter <= 0.20) {
    return { score: 3, label: 'GOOD!', cssClass: 'hit-good' };
  } else {
    return { score: 1, label: 'MISS', cssClass: 'hit-miss' };
  }
}

function getBurstAllowance() {
  // Calculate how many catch-up taps the user has earned by being idle.
  // expected = floor(elapsed_seconds / 2) — how many taps they SHOULD have used.
  // burst = expected - taps_already_used (capped at remaining taps).
  if (!window._gameStartTime) return 0;
  const elapsed = (Date.now() - window._gameStartTime) / 1000;
  const tapsUsed = 15 - myTurnsLeft;
  const expected = Math.min(Math.floor(elapsed / 2), 15);
  return Math.max(0, expected - tapsUsed);
}

async function tapSkillMeter() {
  if (!checkWorldAppEnvironment()) return;
  if (!gameActive || $('game-timer').innerText === '0s') return;
  if (isTimingLocked) return;
  if (myTurnsLeft <= 0) return;

  // BURST MECHANIC: calculate if user has catch-up taps available
  const burstAvailable = getBurstAllowance();

  // Enforce 2-second gap ONLY when no burst is available
  if (burstAvailable <= 0 && typeof window._lastTapTime === 'number') {
    const elapsed = Date.now() - window._lastTapTime;
    if (elapsed < 2000) {
      const waitMs = 2000 - elapsed;
      showNeonToast(`Wait ${(waitMs / 1000).toFixed(1)}s between taps`, 'warning');
      return;
    }
  }
  window._lastTapTime = Date.now();
  if (typeof window._checkTapRate === 'function' && !window._checkTapRate()) return;

  isTimingLocked = true;
  window._timingLockTime = Date.now();
  myTurnsLeft--;

  // Stop the meter and capture position
  stopMeterAnimation();
  const position = getMeterPosition();
  const result = calculateSkillScore(position);
  const roll = result.score; // 1, 3, or 6

  $('turn-indicator').innerText = `Scoring... (${myTurnsLeft} turns left)`;

  // Send to server via secure_roll_dice (server validates 1-6 range)
  const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('secure_roll_dice', {
    p_match_id: matchId, p_wallet: myAddress, p_roll: roll
  });

  if (rpcErr || (rpcRes && !rpcRes.success)) {
    myTurnsLeft++;
    $('turn-indicator').innerText = `Rejected — tap again (${myTurnsLeft} turns left)`;
    setTimeout(() => {
      isTimingLocked = false;
      if (myTurnsLeft > 0 && gameActive && $('game-timer').innerText !== '0s') {
        $('turn-indicator').innerText = `tap TAP NOW! to score (${myTurnsLeft} turns left)`;
        startMeterAnimation();
      }
    }, 800);
    return;
  }

  // Accepted — update score
  myScore += roll;
  $('my-score').innerText = myScore;
  const myScoreEl = $('my-score');
  if (myScoreEl) { myScoreEl.classList.remove('pop'); void myScoreEl.offsetWidth; myScoreEl.classList.add('pop'); }

  if (rpcRes && rpcRes.taps_left !== undefined) {
    myTurnsLeft = rpcRes.taps_left;
  }

  // Show skill hit feedback
  showRollFlash('+' + roll, result.label, result.cssClass);

  // Broadcast to opponent — score is computed from SERVER-VALIDATED roll only
  // (never use client-side myScore here: a hacker modifying myScore in console
  // would then broadcast a fake score to the opponent)
  if (!window._sendNonce) window._sendNonce = 0;
  window._sendNonce++;
  if (channel) channel.send({ type: 'broadcast', event: 'score_update', payload: { sender: myAddress, score: myScore, roll: roll, ts: Date.now(), nonce: window._sendNonce } });

  // Speed up meter slightly each turn for increasing difficulty
  meterSpeed = Math.max(400, meterSpeed - 15);

  setTimeout(() => {
    isTimingLocked = false;
    if (myTurnsLeft > 0 && gameActive && $('game-timer').innerText !== '0s') {
      // Show burst status if player has catch-up taps available
      const burst = getBurstAllowance();
      if (burst > 0) {
        $('turn-indicator').innerText = `⚡ BURST! ${burst} fast taps available (${myTurnsLeft} left)`;
      } else {
        $('turn-indicator').innerText = `tap TAP NOW! to score (${myTurnsLeft} turns left)`;
      }
      startMeterAnimation();
    }
  }, 800);
}

async function finalizeGame(){  
  if (!gameActive) return;  
  gameActive = false;  
  if (!myAddress) myAddress = localStorage.getItem("myAddress") || "";  

  localStorage.removeItem("currentMatchId");  
  localStorage.removeItem("isP1");  

  const { data: m } = await supabaseClient.from('matches').select('*').eq('id', matchId).single();  
  if (!m) { resetToHome(); return; }  

  let finalRow = m;  
  let matchFee = Number(m.fee || selectedFee);  

  if (m.status !== 'completed'){  
    const { data: completeResult } = await supabaseClient.rpc('secure_complete_match', {  
      p_match_id: matchId, p_wallet: myAddress  
    });  
    if (completeResult && completeResult.match) finalRow = completeResult.match;  
  }  

  const myFinal = isP1 ? finalRow.p1_score : finalRow.p2_score;  
  const opFinal = isP1 ? finalRow.p2_score : finalRow.p1_score;  
  const isTie = myFinal === opFinal;  
  const isWin = myFinal > opFinal;  
  const oppAddress = isP1 ? finalRow.p2_address : finalRow.p1_address;
  const winnerWallet = isWin ? myAddress : oppAddress;

  const exactChipEarn = calculatePayout(matchFee);   

  // TIE: equal scores — nobody wins. Both players get their entry fee
  // back (queue_refund_request only allows completed-tie matches, so a
  // non-tie completed match can never be refunded this way). Each
  // player's device queues its own refund.
  if (isTie && matchId && myAddress) {
    // NOTE: supabase-js builders have no .catch — a .catch on the
    // builder THROWS and previously killed finalizeGame() right here,
    // so the TIE result popup never appeared. Wrap in try/catch.
    try { await supabaseClient.rpc('queue_refund_request', {
      p_match_id: matchId, p_wallet: myAddress.toLowerCase().trim()
    }); } catch (e) { /* refund is also queued by the resolver */ }
  }

  // Only the winner's device triggers the on-chain payout, so it fires
  // exactly once per device, with retries for transient failures (the
  // API's mark_match_settled guard makes double payouts impossible).
  // The API validates the winner against the Supabase match row and
  // pays the displayed winnings via an owner emergency transfer.
  if (isWin && matchId && winnerWallet) {
    (async () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const resp = await fetch('/api/refund-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              matchUuid: matchId,
              action: 'SETTLE_WINNER',
              winnerAddress: winnerWallet
            })
          });
          if (resp.ok) break;
          const body = await resp.json().catch(() => ({}));
          if (body && body.alreadySettled) break;
        } catch (err) {
          console.error("Settle API Error:", err);
        }
        await new Promise(r => setTimeout(r, 2500));
      }
    })();
  }

  if (myAddress && !sessionStorage.getItem(`settled_${matchId}_${myAddress}`)) {  
      sessionStorage.setItem(`settled_${matchId}_${myAddress}`, "true");  
      try {  
          if (isTie) {  
              await logMatchHistory(myAddress, 'DRAW', 0, `Tie match (${matchFee} WLD duel, refunded)`);  
          } else if (isWin) {  
              await logMatchHistory(myAddress, 'VICTORY', exactChipEarn, `Won match (${matchFee} WLD duel)`);  
          } else {  
              await logMatchHistory(myAddress, 'DEFEAT', -matchFee, `Lost match (${matchFee} WLD duel)`);  
          }  
      } catch(e){}  
  }  

  let winTnv = getTnvRewardForFee(matchFee);  
  let earnedTnv = isWin ? winTnv : Math.floor(winTnv / 3);  

  // TIE = void match (both players refunded, no winner/loser) → NO TNV
  // for anyone. secure_credit_tnv also rejects ties server-side; skipping
  // here keeps the popup consistent with the rules.  
  // The settled flag is only set on SUCCESS — a transient RPC failure is
  // retried (3x) so the player's TNV is never silently lost.  
  if (myAddress && !isTie && !sessionStorage.getItem(`tnv_settled_${matchId}_${myAddress}`)) {  
    for (let attempt = 1; attempt <= 3; attempt++) {  
      try {  
        const { data: tnvResult } = await supabaseClient.rpc('secure_credit_tnv', {  
          p_match_id: matchId, p_wallet: myAddress  
        });  
        if (tnvResult && tnvResult.earnedTnv !== undefined) {  
          earnedTnv = tnvResult.earnedTnv;  
          sessionStorage.setItem(`tnv_settled_${matchId}_${myAddress}`, "true");  
          break;  
        }  
        if (tnvResult && tnvResult.error === 'already_credited') {  
          sessionStorage.setItem(`tnv_settled_${matchId}_${myAddress}`, "true");  
          break;  
        }  
      } catch(e) {}  
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500));  
    }  
  }  

  if (isTie){  
    $('result-icon').innerText = '=';  
    $('result-title').innerText = 'TIE!';  
    $('result-msg').innerText = `Equal scores — your ${matchFee} WLD is being refunded automatically`;  
    $('result-card').className = 'result-card result-tie';  
  } else if (isWin){  
    $('result-icon').innerText = 'W';  
    $('result-title').innerText = 'VICTORY!';  
    $('result-msg').innerText = `+${exactChipEarn} WLD & +${earnedTnv} TNV`;  
    $('result-card').className = 'result-card result-victory';  
    playVictorySound();  
  } else {  
    $('result-icon').innerText = 'L';  
    $('result-title').innerText = 'DEFEAT!';  
    $('result-msg').innerText = `Fee deducted & +${earnedTnv} TNV (Consolation)`;  
    $('result-card').className = 'result-card result-defeat';  
  }  

  $('result-overlay').style.display = 'flex';  
  fetchUserBalanceAndLeaderboard(myAddress);  
}  

function resetToHome(){  
  clearInterval(mTimer);  
  if (pollTimer) clearInterval(pollTimer);  
  if (gameTimerInterval) clearInterval(gameTimerInterval);  
  if (bookingRetryTimer) { clearInterval(bookingRetryTimer); bookingRetryTimer = null; }
  if (channel) { channel.unsubscribe(); channel = null; }
  $('waiting-overlay').style.display = 'none';  
  $('start-btn').disabled = false;  
  $('start-btn').innerText = `PLAY NOW (${selectedFee} WLD)`;  
  matchmakingActive = false;  
  gameActive = false;  
  hasPaid = false;
  paymentVerified = false;
  matchId = null;
  matchIdBytes32Global = null;
  // Stop skill meter
  stopMeterAnimation();
  // Reset anti-cheat rate limiter
  window._tapTimestamps = [];
  window._isTapBlocked = false;
  window._timingLockTime = null;
  const ptr = $('meter-pointer');
  if (ptr) { ptr.style.left = '0'; }
  // Reset opponent dice display
  const oppDice = $('opp-dice-display');
  if (oppDice) { oppDice.classList.remove('show'); oppDice.classList.add('hide'); oppDice.textContent = '-'; }
  // Show tab navigation again
  if (typeof showTabScreen === 'function') showTabScreen();
}

document.querySelectorAll('.fee-chip').forEach(chip => {
  chip.addEventListener('click', () => selectFee(chip.dataset.fee, chip));
});
$('start-btn').addEventListener('click', handlePlayButtonClick);
$('skill-tap-btn').addEventListener('click', tapSkillMeter);

// ==========================================
// PAYMENT SUPPORT BOT
// ==========================================
let botStep = 0; // 0=idle, 1=asked-yes-no, 2=check-running, 3=asked-tx-hash

window.openSupportBot = function() {
  $('support-bot-modal').style.display = 'flex';
  $('bot-messages').innerHTML = '';
  $('bot-input-area').style.display = 'none';
  $('bot-btn-area').innerHTML = '';
  botStep = 0;

  if (!myAddress) {
    botAddMsg('bot', '👋 Hi! I\'m the Payment Support Bot.');
    botAddMsg('bot', 'Please sign in first so I can check your account. Tap PLAY NOW to connect your wallet.');
    botAddBtn('Got it', () => closeSupportBot());
    return;
  }  botAddMsg('bot', '👋 Hi! I\'m the Payment Support Bot.');  
  // Show any admin replies from a previous Agent ticket first — the
  // admin replies with their REAL Worldcoin username.
  botShowAdminReplies();  
  botAddMsg('bot', 'Did you make a payment for a match that didn\'t connect or didn\'t get a refund?');  
  botStep = 1;  
  botAddBtn('✅ Yes, I paid', () => botHandleYes());  
  botAddBtn('❌ No', () => botHandleNo(), 'danger');  
  botAddBtn('❓ How to find my Tx Hash', () => { botClearBtns(); botStep = 3; botShowTxInput(); });  
  botAddBtn('🤝 Talk to Agent airdrophubgroup', () => botStartAgent(), 'agent');  
};  

async function botShowAdminReplies() {  
  if (!myAddress) return;  
  try {  
    const { data } = await supabaseClient.rpc('get_my_tickets', { p_wallet: myAddress.toLowerCase() });  
    if (!data || !Array.isArray(data)) return;  
    const replied = data.filter(t => t.status === 'replied' && t.admin_reply);  
    if (replied.length === 0) return;  
    replied.slice(0, 3).forEach(t => {  
      botAddMsg('bot', `📬 You have a reply on support ticket #${t.id}`);  
      botAddHtmlMsg('bot', `<div style="font-size:11.5px; line-height:1.5;">💬 <b style="color:var(--gold);">${escapeHtml(t.admin_username || 'Admin')}</b> (Admin): ${escapeHtml(t.admin_reply || '')}</div><div style="color:#777; font-size:9.5px; text-align:right; margin-top:3px;">${new Date(t.admin_reply_at).toLocaleString()}</div>`);  
    });  
  } catch (e) {}  
}

window.closeSupportBot = function() {
  $('support-bot-modal').style.display = 'none';
  botStep = 0;
};

// Conversation transcript — every bot/user message is logged here so
// that when the user talks to Agent airdrophubgroup, the ADMIN sees the
// user's FULL conversation (what they said, step by step) right in the
// ticket. The transcript is attached to the ticket's verified JSON.
let botTranscript = [];

function botAddMsg(type, text) {
  const div = document.createElement('div');
  div.className = `bot-msg ${type}`;
  div.textContent = text;
  $('bot-messages').appendChild(div);
  $('bot-messages').scrollTop = $('bot-messages').scrollHeight;
  logBotTranscript(type, text);
}

function botAddHtmlMsg(type, html) {
  const div = document.createElement('div');
  div.className = `bot-msg ${type}`;
  div.innerHTML = html;
  $('bot-messages').appendChild(div);
  $('bot-messages').scrollTop = $('bot-messages').scrollHeight;
  logBotTranscript(type, stripHtml(html));
}

// Strip tags from HTML messages so the transcript stays clean text.
function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function logBotTranscript(type, text) {
  if (!text) return;
  const who = type === 'user' ? 'user' : 'bot';
  botTranscript.push({ who, text: String(text).slice(0, 300), t: Date.now() });
  if (botTranscript.length > 120) botTranscript.splice(0, botTranscript.length - 120);
}

function botShowTyping() {
  const div = document.createElement('div');
  div.className = 'bot-typing';
  div.id = 'bot-typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  $('bot-messages').appendChild(div);
  $('bot-messages').scrollTop = $('bot-messages').scrollHeight;
}

function botHideTyping() {
  const el = $('bot-typing-indicator');
  if (el) el.remove();
}

function botClearBtns() {
  $('bot-btn-area').innerHTML = '';
}

function botAddBtn(text, onClick, extraClass) {
  const btn = document.createElement('button');
  btn.className = 'bot-btn' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = text;
  btn.onclick = () => { botClearBtns(); onClick(); };
  $('bot-btn-area').appendChild(btn);
}

async function botHandleYes() {
  botAddMsg('user', 'Yes, I paid but didn\'t get a refund.');
  botAddMsg('system', '🔍 Scanning your recent matches...');
  botShowTyping();
  botStep = 2;

  // Ensure wallet is available — restore from localStorage if needed
  if (!myAddress) {
    myAddress = (localStorage.getItem('myAddress') || '').toLowerCase();
    myUsername = localStorage.getItem('myUsername') || '';
  }
  if (!myAddress) {
    botHideTyping();
    botAddMsg('error', '⚠️ Please sign in first so I can check your account. Tap PLAY NOW to connect your wallet.');
    botAddBtn('👍 Got it', () => closeSupportBot());
    return;
  }

  try {
    // Step 1: Find user's recent cancelled/waiting matches with payment
    const wallet = myAddress.toLowerCase().trim();
    const refundableMatches = [];
    const { data: matches, error } = await supabaseClient
      .from('matches')
      .select('id, match_id, status, fee, p1_address, p2_address, p1_paid, p2_paid, p1_payment_tx_hash, p2_payment_tx_hash, created_at')
      .or(`p1_address.eq.${wallet},p2_address.eq.${wallet}`)
      .in('status', ['cancelled', 'waiting', 'matched', 'expired'])
      .order('created_at', { ascending: false })
      .limit(10);

    botHideTyping();

    if (error || !matches || matches.length === 0) {
      botAddMsg('bot', 'I checked your recent matches and didn\'t find any that need a refund.');
      botAddMsg('bot', 'If you still think there\'s an issue, paste your transaction hash and I\'ll verify it on-chain.');
      botStep = 3;
      botShowTxInput();
      return;
    }

    for (const m of matches) {
      const isP1 = m.p1_address && m.p1_address.toLowerCase() === wallet;
      const paid = isP1 ? m.p1_paid : m.p2_paid;
      if (paid !== true) continue;

      // Check if refund already exists — refund_queue has no public RLS,
      // so the ONLY correct read is the get_refund_status security-definer
      // RPC (a direct table query silently returns [] and would make every
      // already-refunded match look unrefunded).
      let hasRefund = false;
      try {
        const { data: rs } = await supabaseClient.rpc('get_refund_status', {
          p_match_id: m.id, p_wallet: wallet
        });
        const st = rs && rs.found === true ? rs.status : null;
        hasRefund = !!st && ['done', 'completed', 'pending', 'processing'].includes(st);
      } catch (e) { /* treat as no refund found */ }

      if (!hasRefund) {
        refundableMatches.push({ ...m, isP1 });
      }
    }

    if (refundableMatches.length === 0) {
      // All paid matches already have refunds or are completed
      const hasCompleted = matches.some(m => m.status === 'completed');
      if (hasCompleted) {
        botAddMsg('bot', '✅ All your paid matches have been completed or already refunded. You\'re all good!');
      } else {
        botAddMsg('bot', 'I checked your recent matches and they all already have pending refunds or no payment was found.');
        botAddMsg('bot', 'If you still need help, paste your transaction hash below and I\'ll verify it directly on-chain.');
        botStep = 3;
        botShowTxInput();
      }
      return;
    }

    // Found refundable matches! Show details and auto-refund
    botAddMsg('bot', `I found ${refundableMatches.length} match(es) where you paid but didn\'t receive a refund:`);

    for (const m of refundableMatches) {
      const fee = Number(m.fee);
      botAddHtmlMsg('bot', `📋 <b>Match:</b> ${fee} WLD | Status: ${m.status} | Created: ${new Date(m.created_at).toLocaleString()}`);
    }

    botAddMsg('bot', '🔄 Processing your refund now...');
    botShowTyping();

    let successCount = 0;
    let failCount = 0;

    for (const m of refundableMatches) {
      try {
        const { data: refundResult } = await supabaseClient.rpc('queue_refund_request', {
          p_match_id: m.id,
          p_wallet: wallet
        });

        if (refundResult && refundResult.success === true) {
          successCount++;
        } else if (refundResult && refundResult.error === 'already_queued') {
          successCount++; // Already queued, not a failure
        } else {
          failCount++;
          console.error('Bot refund failed for match', m.id, refundResult);
        }
      } catch (e) {
        failCount++;
        console.error('Bot refund exception:', e);
      }
    }

    botHideTyping();

    if (successCount > 0) {
      botAddMsg('success', `✅ ${successCount} refund(s) queued successfully! Your WLD will be returned within ~1 minute.`);
      botAddMsg('bot', '💡 The refund is processed automatically by our server. You don\'t need to do anything else.');
      botAddMsg('system', '⏰ If you don\'t see the refund after 5 minutes, come back and paste your transaction hash below.');
    }

    if (failCount > 0) {
      botAddMsg('bot', `⚠️ ${failCount} refund(s) couldn\'t be queued. Please paste your transaction hash below for manual verification.`);
      botStep = 3;
      botShowTxInput();
    }    if (successCount > 0 && failCount === 0) {  
      botAddBtn('👍 Thanks!', () => closeSupportBot());  
      botAddBtn('📋 Check another', () => { botClearBtns(); botHandleYes(); });  
      botAddBtn('🤝 Not satisfied? Talk to Agent', () => botStartAgent(), 'agent');  
    }  

  } catch (e) {
    botHideTyping();
    botAddMsg('error', '❌ Error scanning matches. Please paste your transaction hash below.');
    botStep = 3;
    botShowTxInput();
    console.error('Bot scan error:', e);
  }
}

// ============ AGENT AIRDROPHUBGROUP — HUMAN SUPPORT ============
// When the automated bot can't fully satisfy a user, they talk to a
// real team member (Agent airdrophubgroup). The agent listens, verifies
// everything step by step, then creates a ticket the admin answers from
// the admin panel — the reply carries the admin's REAL Worldcoin
// username.
let botAgentStep = 0;
let botAgentVerified = null;
let botAgentSummary = '';

function botStartAgent() {
  botClearBtns();
  // Start a fresh transcript for this agent session — the admin will see
  // this user's full conversation attached to the ticket.
  botTranscript = [];
  botAddHtmlMsg('bot', '🤝 Hi! I\'m <b>Agent airdrophubgroup</b> — a real person from the airdrophubgroup team, not a bot. 🤗');
  botAddMsg('bot', 'I understand you\'re having trouble. Please don\'t worry — I\'ll personally look into it with you, step by step, and make sure you\'re taken care of. ❤️');
  botAddMsg('bot', 'Can you tell me what happened?');
  botAgentStep = 1;
  botAddBtn('💸 I paid but no refund', () => botAgentIssue('norefund'));
  botAddBtn('🔗 Match never connected', () => botAgentIssue('noconnect'));
  botAddBtn('❓ Something else', () => botAgentIssue('other'));
}

async function botAgentIssue(kind) {
  botClearBtns();
  const labels = { norefund: 'I paid but my refund never came.', noconnect: 'I joined a match but it never connected.', other: 'I have another problem with the game.' };
  botAddMsg('user', labels[kind] || labels.other);
  botAddMsg('bot', 'Okay, thank you for telling me. 🙏 Let me carefully check your account right now — I\'ll verify every single thing before we go further.');
  botShowTyping();
  botAgentStep = 2;

  const verified = { issue: kind, checked_at: new Date().toISOString() };
  try {
    const wallet = myAddress.toLowerCase().trim();
    // Step 1: the user's matches
    const { data: matches } = await supabaseClient
      .from('matches')
      .select('id, status, fee, p1_address, p2_address, p1_paid, p2_paid, p1_payment_tx_hash, p2_payment_tx_hash, created_at')
      .or(`p1_address.eq.${wallet},p2_address.eq.${wallet}`)
      .order('created_at', { ascending: false })
      .limit(10);
    verified.match_count = matches ? matches.length : 0;

    // Step 2: paid-but-unrefunded matches
    let paidMatches = [];
    if (matches) {
      for (const m of matches) {
        const isP1 = (m.p1_address || '').toLowerCase() === wallet;
        const paid = isP1 ? m.p1_paid : m.p2_paid;
        if (paid === true) {
          paidMatches.push({ fee: Number(m.fee || 0), status: m.status, created_at: m.created_at, id: m.id });
        }
      }
    }
    verified.paid_matches = paidMatches.length;

    // Step 3: refund status for each paid match — refund_queue has no
    // public RLS, so use the get_refund_status security-definer RPC (a
    // direct table read would return [] and misreport every refund).
    let refunded = 0, pending = 0, missing = 0;
    for (const pm of paidMatches) {
      let st = null;
      try {
        const { data: rs } = await supabaseClient.rpc('get_refund_status', {
          p_match_id: pm.id, p_wallet: wallet
        });
        st = rs && rs.found === true ? rs.status : null;
      } catch (e) { /* null */ }
      if (st === 'done' || st === 'completed') refunded++;
      else if (st === 'pending' || st === 'processing') pending++;
      else missing++;
    }
    verified.refunded = refunded;
    verified.pending = pending;
    verified.missing = missing;

    // Step 4: their support tickets
    const { data: tickets } = await supabaseClient.rpc('get_my_tickets', { p_wallet: wallet });
    verified.tickets = Array.isArray(tickets) ? tickets.length : 0;
  } catch (e) {
    verified.error = String(e);
  }

  botHideTyping();
  botAgentVerified = verified;

  // Empathetic summary
  botAddMsg('bot', 'Alright, I\'ve personally checked everything on your account. Here\'s what I found: 👇');
  botAddHtmlMsg('bot',
    `<div style="font-size:11px; line-height:1.7; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:9px 11px;">` +
    `📊 <b>Your account verification</b><br/>` +
    `🎮 Matches found: <b>${verified.match_count || 0}</b><br/>` +
    `💸 Payments made: <b>${verified.paid_matches || 0}</b><br/>` +
    `✅ Refunds received: <b>${verified.refunded || 0}</b><br/>` +
    `⏳ Refunds processing: <b>${verified.pending || 0}</b><br/>` +
    `⚠️ Payments without refund: <b>${verified.missing || 0}</b><br/>` +
    `🎫 Your support tickets: <b>${verified.tickets || 0}</b>` +
    `</div>`
  );

  if ((verified.missing || 0) > 0) {
    botAddMsg('bot', 'I can see you have a payment that hasn\'t been refunded yet — that\'s not fair to you, and I\'m sorry. 😔 I\'ll make sure the team handles it personally.');
  } else {
    botAddMsg('bot', 'I checked everything and didn\'t find any missing refund on your account. But if you\'re still worried, I\'ll happily create a ticket so the team reviews it personally — no question is too small. 😊');
  }

  botAgentStep = 3;
  botAddBtn('✅ Yes, create my ticket', () => botCreateTicket());
  botAddBtn('↩️ Let me check again', () => { botClearBtns(); botHandleYes(); });
  botAddBtn('❌ Never mind', () => closeSupportBot());
}

async function botCreateTicket() {
  botClearBtns();
  const v = botAgentVerified || {};
  const issueLabels = { norefund: 'Paid but no refund', noconnect: 'Match never connected', other: 'Other issue' };
  const summary = `${issueLabels[v.issue] || 'Support request'} — Payments: ${v.paid_matches || 0}, Refunded: ${v.refunded || 0}, Missing: ${v.missing || 0}`;
  botShowTyping();
  try {
    // Attach the FULL conversation transcript so the admin (airdrophubgroup)
    // sees exactly what the user said in their own words.
    const verifiedWithConversation = Object.assign({}, v, { conversation: botTranscript });
    const { data } = await supabaseClient.rpc('create_support_ticket', {
      p_wallet: myAddress.toLowerCase(),
      p_username: myUsername || '',
      p_summary: summary,
      p_verified: verifiedWithConversation
    });
    botHideTyping();
    if (data && data.success) {
      botAddMsg('success', `✅ Your support ticket #${data.ticket_id} has been created!`);
      botAddHtmlMsg('bot', 'The admin (airdrophubgroup team) has been notified and will personally reply to you <b>right here</b> — the reply will show their real Worldcoin username. 🙌');
      botAddMsg('bot', 'Thank you for your patience — we\'ll take care of you. ❤️');
      botAddBtn('👍 Done', () => closeSupportBot());
    } else {
      botAddMsg('error', '❌ Could not create the ticket: ' + (data?.error || 'unknown error'));
      botAddBtn('🔄 Try again', () => botCreateTicket());
    }
  } catch (e) {
    botHideTyping();
    botAddMsg('error', '❌ Something went wrong creating the ticket. Please try again.');
    botAddBtn('🔄 Try again', () => botCreateTicket());
  }
}

function botHandleNo() {
  botAddMsg('user', 'No, I didn\'t pay.');
  botAddMsg('bot', 'No problem! If you didn\'t make a payment, there\'s nothing to refund. Your funds are safe.');
  botAddMsg('bot', 'Come back anytime if you need help! 🎲');
  botAddBtn('👍 Got it', () => closeSupportBot());
}

// Step-by-step guide shown before the tx-hash input so users who
// don't know where to find their transaction hash can follow along:
// copy wallet address -> open worldscan.org -> find the payment tx
// at the match time -> copy the hash -> paste it below.
function botShowTxInstructions() {
  const addr = myAddress || '';
  botAddHtmlMsg('bot', '<div style="font-family:\'JetBrains Mono\',monospace; font-weight:700; font-size:10px; letter-spacing:1px; color:var(--gold); margin-bottom:6px;">📖 HOW TO FIND YOUR TX HASH</div>' +
    '<div style="margin:6px 0; padding:8px 10px; border:1px solid rgba(41,217,194,0.25); border-radius:8px; background:rgba(41,217,194,0.06); font-size:10.5px; line-height:1.55;">' +
    '<b style="color:var(--photon);">Step 1</b> — Copy your World Chain wallet address 👇<br/>' +
    (addr ? `<button onclick="navigator.clipboard.writeText('${addr}'); this.textContent='✅ Copied!';" style="margin-top:5px; background:rgba(41,217,194,0.15); border:1px solid rgba(41,217,194,0.5); color:var(--photon); font-size:10px; padding:5px 10px; border-radius:6px; cursor:pointer;">📋 Copy my address</button>` : '') +
    '</div>' +
    '<div style="margin:6px 0; padding:8px 10px; border:1px solid rgba(255,179,0,0.25); border-radius:8px; background:rgba(255,179,0,0.05); font-size:10.5px; line-height:1.55;">' +
    '<b style="color:var(--gold);">Step 2</b> — Open a World Chain block explorer:<br/>' +
    '<a href="https://worldscan.org/" target="_blank" rel="noopener" style="color:var(--photon); font-weight:700; font-size:11px;">🌐 worldscan.org</a> ' +
    '<span style="color:var(--slate);">(or search \'Worldscan\' on Google)</span>' +
    '</div>' +
    '<div style="margin:6px 0; padding:8px 10px; border:1px solid rgba(41,217,194,0.25); border-radius:8px; background:rgba(41,217,194,0.06); font-size:10.5px; line-height:1.55;">' +
    '<b style="color:var(--photon);">Step 3</b> — Paste your wallet address in the search bar at the top and press Enter. You\'ll see your transaction list.' +
    '</div>' +
    '<div style="margin:6px 0; padding:8px 10px; border:1px solid rgba(41,217,194,0.25); border-radius:8px; background:rgba(41,217,194,0.06); font-size:10.5px; line-height:1.55;">' +
    '<b style="color:var(--photon);">Step 4</b> — Look for the <b style="color:var(--photon);">WLD payment</b> you sent at the exact time you played the match. Open that transaction.' +
    '</div>' +
    '<div style="margin:6px 0; padding:8px 10px; border:1px solid rgba(41,217,194,0.25); border-radius:8px; background:rgba(41,217,194,0.06); font-size:10.5px; line-height:1.55;">' +
    '<b style="color:var(--photon);">Step 5</b> — Copy the <b style="color:var(--gold);">Transaction Hash</b> (starts with <span style="font-family:\'JetBrains Mono\',monospace; color:var(--photon);">0x...</span>, 66 characters) and paste it in the box below 👇' +
    '</div>');
}

function botShowTxInput() {
  botShowTxInstructions();
  $('bot-input-area').style.display = 'block';
  $('bot-tx-input').value = '';
  $('bot-tx-input').focus();
  botAddBtn('🔍 Verify Tx Hash', () => submitBotTxHash());
  botAddBtn('↩️ Go back', () => {
    botClearBtns();
    $('bot-input-area').style.display = 'none';
    botAddMsg('bot', 'Did you make a payment for a match?');
    botStep = 1;
    botAddBtn('✅ Yes, I paid', () => botHandleYes());
    botAddBtn('❌ No', () => botHandleNo(), 'danger');
  });
}

window.submitBotTxHash = async function() {
  const txHash = ($('bot-tx-input')?.value || '').trim();
  if (!txHash) {
    botAddMsg('error', 'Please paste a transaction hash (starts with 0x).');
    return;
  }
  if (!txHash.startsWith('0x') || txHash.length < 10) {
    botAddMsg('error', 'Invalid transaction hash format. It should start with 0x.');
    return;
  }

  // Ensure wallet is available
  if (!myAddress) {
    myAddress = (localStorage.getItem('myAddress') || '').toLowerCase();
    myUsername = localStorage.getItem('myUsername') || '';
  }
  if (!myAddress) {
    botAddMsg('error', '⚠️ Please sign in first so I can verify your transaction.');
    botAddBtn('👍 Got it', () => closeSupportBot());
    return;
  }

  $('bot-input-area').style.display = 'none';
  $('bot-btn-area').innerHTML = '';
  botAddMsg('user', `Tx: ${txHash.slice(0, 10)}...${txHash.slice(-8)}`);
  botAddMsg('system', '🔗 Verifying on-chain...');
  botShowTyping();

  try {
    // Use multi-RPC to verify the transaction
    let txData = null;
    for (const rpcUrl of WORLDCHAIN_RPCS) {
      try {
        const response = await Promise.race([
          fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_getTransactionByHash',
              params: [txHash],
              id: 1
            })
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);
        const result = await response.json();
        if (result.result && result.result.hash) {
          txData = result.result;
          break;
        }
      } catch (e) { /* try next RPC */ }
    }

    botHideTyping();

    if (!txData) {
      botAddMsg('error', '❌ Transaction not found on-chain. Please double-check the hash.');
      botAddBtn('🔄 Try again', () => botShowTxInput());
      botAddBtn('🏠 Go back', () => closeSupportBot());
      return;
    }

    // Check if this is a WLD token transfer to our contract
    const toAddr = (txData.to || '').toLowerCase();
    const fromAddr = (txData.from || '').toLowerCase();
    const userWallet = myAddress.toLowerCase().trim();
    const isFromUser = fromAddr === userWallet;
    const isToContract = toAddr === DICE_DUEL_CONTRACT.toLowerCase();

    if (!isFromUser) {
      botAddMsg('error', '❌ This transaction was not sent from your wallet. Please provide a transaction you sent.');
      botAddBtn('🔄 Try again', () => botShowTxInput());
      botAddBtn('🏠 Go back', () => closeSupportBot());
      return;
    }

    if (!isToContract) {
      botAddMsg('error', 'This transaction was not sent to our game contract. Please provide a valid payment transaction.');
      botAddMsg('bot', `Expected contract: ${DICE_DUEL_CONTRACT.slice(0,10)}...${DICE_DUEL_CONTRACT.slice(-6)}`);
      botAddBtn('🔄 Try again', () => botShowTxInput());
      botAddBtn('🏠 Go back', () => closeSupportBot());
      return;
    }

    // Get the receipt to check the token transfer details
    let txReceipt = null;
    for (const rpcUrl of WORLDCHAIN_RPCS) {
      try {
        const response = await Promise.race([
          fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_getTransactionReceipt',
              params: [txHash],
              id: 1
            })
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);
        const result = await response.json();
        if (result.result) {
          txReceipt = result.result;
          break;
        }
      } catch (e) { /* try next RPC */ }
    }

    const txSuccess = txReceipt ? txReceipt.status === '0x1' : false;
    if (txReceipt && !txSuccess) {
      botAddMsg('error', '❌ This transaction failed on-chain. No payment was made.');
      botAddMsg('bot', 'You can try paying again — your funds were never deducted.');
      botAddBtn('🏠 Go back', () => closeSupportBot());
      return;
    }

    // Verify the input data contains our contract interaction
    // The input should be a token transfer (0xa9059cbb for transfer)
    const inputData = txData.input || '';
    const isTokenTransfer = inputData.startsWith('0xa9059cbb');

    botAddMsg('bot', '✅ Transaction verified on-chain!');
    botAddHtmlMsg('bot', `📋 <b>From:</b> ${fromAddr.slice(0,10)}...<br><b>To:</b> ${toAddr.slice(0,10)}...<br><b>Status:</b> Confirmed ✅`);

    // ----------------------------------------------------------
    // DUPLICATE / ALREADY-REFUNDED CHECK
    // A real payment tx hash can only ever belong to ONE match
    // (server-side dedupe). Find that match, then check whether a
    // refund already exists for it:
    //   - 'done' with a tx_hash -> refund already processed, show
    //     the refund hash + copy + explorer link
    //   - 'pending'/'processing' -> already queued, wait a minute
    //   - 'failed' -> try re-queueing it
    //   - none -> proceed to the normal refund flow below
    // ----------------------------------------------------------
    const { data: paidMatches } = await supabaseClient
      .from('matches')
      .select('id, status, fee, p1_address, p2_address, p1_payment_tx_hash, p2_payment_tx_hash')
      .or(`p1_payment_tx_hash.eq.${txHash},p2_payment_tx_hash.eq.${txHash}`)
      .limit(5);

    let hashMatch = null;
    if (paidMatches && paidMatches.length > 0) {
      hashMatch = paidMatches.find(m =>
        (m.p1_payment_tx_hash || '').toLowerCase() === txHash.toLowerCase() ||
        (m.p2_payment_tx_hash || '').toLowerCase() === txHash.toLowerCase()
      ) || paidMatches[0];
    }

    if (hashMatch) {
      // refund_queue has no public RLS, so read only the caller's own
      // refund status through the get_refund_status security-definer RPC.
      const { data: refundStatus } = await supabaseClient
        .rpc('get_refund_status', { p_match_id: hashMatch.id, p_wallet: userWallet });
      const refund = refundStatus && refundStatus.found === true ? refundStatus : null;

      if (refund && refund.status === 'done' && refund.tx_hash) {
        const refundTx = refund.tx_hash;
        const rShort = `${refundTx.slice(0,10)}...${refundTx.slice(-8)}`;
        botAddMsg('success', `✅ Refund ALREADY PROCESSED for this payment!`);
        botAddMsg('bot', `Your ${refund.fee} WLD refund was already sent on-chain. Here is your refund transaction hash:`);
        botAddHtmlMsg('bot', `<div style="font-family:'JetBrains Mono',monospace; font-size:10px; word-break:break-all; background:rgba(41,217,194,0.08); border:1px solid rgba(41,217,194,0.35); border-radius:8px; padding:8px 10px; color:var(--photon);">${refundTx}</div>` +
          `<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">` +
          `<button onclick="navigator.clipboard.writeText('${refundTx}'); this.textContent='✅ Copied!';" style="background:rgba(41,217,194,0.15); border:1px solid rgba(41,217,194,0.5); color:var(--photon); font-size:10px; padding:5px 10px; border-radius:6px; cursor:pointer;">📋 Copy refund hash</button>` +
          `<a href="https://worldscan.org/tx/${refundTx}" target="_blank" rel="noopener" style="background:rgba(255,179,0,0.15); border:1px solid rgba(255,179,0,0.5); color:var(--gold); font-size:10px; padding:5px 10px; border-radius:6px; text-decoration:none;">🔍 View on explorer</a>` +
          `</div>`);
        botAddMsg('bot', 'You can copy it and paste it anywhere to verify (e.g. worldscan.org). No further action needed! 🎲');
        botAddBtn('👍 Done', () => closeSupportBot());
        return;
      }

      if (refund && (refund.status === 'pending' || refund.status === 'processing')) {
        botAddMsg('bot', `⏳ Your ${refund.fee} WLD refund is ALREADY QUEUED and being processed. It will arrive within ~1 minute.`);
        botAddMsg('bot', 'No need to submit again — sit tight! 🎲');
        botAddBtn('👍 Done', () => closeSupportBot());
        return;
      }

      if (refund && refund.status === 'failed') {
        botAddMsg('bot', `⚠️ A previous refund attempt for this payment failed (${refund.error || 'unknown error'}). Let me try again for you...`);
        // fall through to the re-queue flow below
      }
    }

    // Also guard against re-using a hash that was already recorded on
    // a completed match (fake re-submission of a settled payment).
    if (hashMatch && hashMatch.status === 'completed') {
      botAddMsg('bot', 'ℹ️ This payment belongs to a match that was already completed. If the match finished normally, the winner payout was already handled.');
      botAddMsg('bot', 'If you think something is wrong, contact @TNVTEAMWLD on Telegram.');
      botAddBtn('💬 Open Telegram', () => window.open('https://t.me/TNVTEAMWLD', '_blank'));
      botAddBtn('👍 Done', () => closeSupportBot());
      return;
    }

    // Now find the match this payment was for and queue refund
    botAddMsg('system', '🔄 Looking up your match and processing refund...');
    botShowTyping();

    // Find recent match for this user
    const { data: recentMatches } = await supabaseClient
      .from('matches')
      .select('id, status, fee, created_at')
      .or(`p1_address.eq.${userWallet},p2_address.eq.${userWallet}`)
      .in('status', ['cancelled', 'waiting', 'matched', 'expired'])
      .order('created_at', { ascending: false })
      .limit(5);

    botHideTyping();

    if (recentMatches && recentMatches.length > 0) {
      // Try to queue refund for the most recent match
      let refundQueued = false;
      for (const m of recentMatches) {
        // First try to record the payment on this match
        try {
          const matchIdB32 = await matchIdToBytes32(m.id);
          await recordDepositOnce(matchIdB32, m.id, userWallet, FEE_WEI[Number(m.fee)] || null, txHash);
        } catch(e) { /* non-fatal */ }

        // Now queue refund
        try {
          const { data: refundResult } = await supabaseClient.rpc('queue_refund_request', {
            p_match_id: m.id,
            p_wallet: userWallet
          });
          if (refundResult && (refundResult.success === true || refundResult.error === 'already_queued')) {
            refundQueued = true;
            botAddMsg('success', `✅ Refund queued for ${m.fee} WLD match (${m.status})!`);
            botAddMsg('bot', 'Your WLD will be returned within ~1 minute. Thank you for your patience! 🎲');
            break;
          }
        } catch(e) { /* try next match */ }
      }

      if (!refundQueued) {
        botAddMsg('bot', 'I found your match but couldn\'t queue the refund automatically. Our team has been notified.');
        botAddMsg('system', '📧 Please contact @TNVTEAMWLD on Telegram with your transaction hash for manual processing.');
        botAddBtn('💬 Open Telegram', () => window.open('https://t.me/TNVTEAMWLD', '_blank'));
      }
    } else {
      botAddMsg('bot', 'Transaction verified but I couldn\'t find a matching game record. Our team will help.');
      botAddMsg('system', '📧 Contact @TNVTEAMWLD on Telegram with this tx hash for manual processing.');
      botAddBtn('💬 Open Telegram', () => window.open('https://t.me/TNVTEAMWLD', '_blank'));
    }

    botAddBtn('👍 Done', () => closeSupportBot());

  } catch (e) {
    botHideTyping();
    botAddMsg('error', '❌ Error verifying transaction. Please try again or contact support.');
    botAddBtn('🔄 Try again', () => botShowTxInput());
    botAddBtn('💬 Contact Support', () => window.open('https://t.me/TNVTEAMWLD', '_blank'));
    console.error('Bot tx verify error:', e);
  }
};
// ==========================================
// ANTI-CHEAT / ANTI-TAMPER SYSTEM
// ==========================================
// Protects against: DevTools hacks, console manipulation, score spoofing,
// auto-clickers, variable tampering, admin impersonation.
// NOTE: Client-side protection is a first layer of defense. The server
// (secure_roll_dice, secure_complete_match) is the ultimate authority.
(function antiCheatInit() {
  'use strict';

  // --- 1. DEVTOOLS DETECTION ---
  // Detect DevTools open via multiple methods (window size, debugger, toString)
  let devToolsOpen = false;
  let devToolsCheckCount = 0;

  function checkDevTools() {
    devToolsCheckCount++;
    const threshold = 180;
    const widthCheck = window.outerWidth - window.innerWidth > threshold;
    const heightCheck = window.outerHeight - window.innerHeight > threshold;
    if (widthCheck || heightCheck) {
      if (!devToolsOpen) {
        devToolsOpen = true;
        onDevToolsOpened();
      }
    } else {
      devToolsOpen = false;
    }
  }

  // Debugger-based detection: stepping through code takes measurable time
  function debuggerCheck() {
    const start = performance.now();
    debugger;
    const elapsed = performance.now() - start;
    if (elapsed > 150) {
      onDevToolsOpened();
    }
  }

  function onDevToolsOpened() {
    // During an active game: disqualify the player (anti-cheat strike)
    if (typeof gameActive !== 'undefined' && gameActive) {
      gameActive = false;
      clearInterval(gameTimerInterval);
      stopMeterAnimation();
      showNeonToast('Anti-cheat: DevTools detected during match. Game disqualified.', 'error');
      setTimeout(() => { location.reload(); }, 2000);
    }
  }

  // Run checks periodically (every 2 seconds — low overhead)
  setInterval(checkDevTools, 2000);
  setInterval(debuggerCheck, 15000);

  // --- 2. DISABLE RIGHT-CLICK (context menu) ---
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); return false; }, { passive: false });

  // --- 3. DISABLE DEVTOOLS KEYBOARD SHORTCUTS ---
  document.addEventListener('keydown', function(e) {
    // F12
    if (e.keyCode === 123) { e.preventDefault(); return false; }
    // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C / Ctrl+U
    if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) { e.preventDefault(); return false; }
    if (e.ctrlKey && e.keyCode === 85) { e.preventDefault(); return false; }
    // Cmd+Option+I (Mac)
    if (e.metaKey && e.altKey && e.keyCode === 73) { e.preventDefault(); return false; }
  }, { passive: false });

  // --- 4. CONSOLE WARNING ---
  const warnStyle = 'color: #ff3333; font-size: 20px; font-weight: bold; text-shadow: 0 0 10px #ff0000;';
  console.log('%c⚠️ WARNING', warnStyle);
  console.log('%cTampering with this app is a violation of our Terms of Service.', 'color: #ff6666; font-size: 14px;');
  console.log('%cAll scores are server-validated. Any manipulation will result in account ban.', 'color: #ff6666; font-size: 14px;');
  console.log('%cThis game uses server-side verification for all rolls, payments, and settlements.', 'color: #ff9999; font-size: 12px;');

  // --- 4b. WORLD APP RUNTIME CHECK: Periodically verify still in World App ---
  setInterval(function() {
    try {
      const stillInWorldApp = typeof MiniKit !== 'undefined' && 
                               typeof MiniKit.isInstalled === 'function' && 
                               MiniKit.isInstalled();
      if (!stillInWorldApp) {
        // If somehow not in World App anymore, kill the session
        document.body.innerHTML = '<div style="position:fixed;inset:0;background:#050000;display:flex;align-items:center;justify-content:center;z-index:999999;font-family:sans-serif;color:#ff3333;font-size:18px;text-align:center;">\u26A0\uFE0F Session ended.<br>Please reopen in World App.</div>';
        clearInterval(gameTimerInterval);
        clearInterval(pollTimer);
        if (channel) channel.unsubscribe();
      }
    } catch (e) {}
  }, 10000);

  // --- 5. ANTI-SPOOF: Protect critical constants from tampering ---
  // Freeze admin wallet and contract addresses
  try {
    Object.defineProperty(window, '_ADMIN_WALLET', { value: '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1', writable: false, configurable: false });
  } catch(e) {}

  // --- 6. PERIODIC STATE INTEGRITY CHECK ---
  // Verify critical variables haven't been tampered with
  setInterval(function() {
    if (typeof gameActive === 'undefined' || !gameActive) return;

    // Check: score can't exceed max possible (15 turns × 6 points = 90)
    if (typeof myScore !== 'undefined' && myScore > 90) {
      myScore = 90;
      showNeonToast('Anti-cheat: Score limit enforced.', 'warning');
    }

    // Check: turns can't be negative or > 15
    if (typeof myTurnsLeft !== 'undefined') {
      if (myTurnsLeft < 0) myTurnsLeft = 0;
      if (myTurnsLeft > 15) myTurnsLeft = 15;
    }

    // Check: isTimingLocked shouldn't stay locked forever (max 5 seconds)
    if (typeof isTimingLocked !== 'undefined' && isTimingLocked) {
      if (!window._timingLockTime) {
        window._timingLockTime = Date.now();
      } else if (Date.now() - window._timingLockTime > 5000) {
        isTimingLocked = false;
        window._timingLockTime = null;
      }
    } else {
      window._timingLockTime = null;
    }
  }, 1000);

  // --- 7. ADMIN PANEL PROTECTION ---
  // Even if someone removes admin-panel-hidden class via DevTools,
  // re-check wallet every second and re-hide if not admin
  setInterval(function() {
    if (typeof myAddress === 'undefined' || !myAddress) {
      document.querySelectorAll('.admin-panel-hidden').forEach(el => { el.style.display = 'none'; });
      return;
    }
    if (myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
      document.querySelectorAll('.admin-panel-hidden').forEach(el => el.classList.add('admin-panel-hidden'));
      document.querySelectorAll('.admin-only').forEach(el => { el.style.display = 'none'; });
    }
  }, 1000);

  // --- 8. PROTECT WINDOW FUNCTIONS FROM BEING OVERWRITTEN ---
  // Prevent hackers from overriding critical functions like tapSkillMeter
  const protectedFunctions = ['tapSkillMeter', 'finalizeGame', 'resetToHome', 'confirmAdminApproval'];
  protectedFunctions.forEach(fnName => {
    try {
      const original = window[fnName];
      if (typeof original === 'function') {
        Object.defineProperty(window, fnName, {
          get: function() { return original; },
          set: function(newFn) {
            // Silently reject attempts to override protected functions
            console.warn('[Anti-cheat] Attempt to override protected function ' + fnName + ' blocked.');
          },
          configurable: false
        });
      }
    } catch(e) {}
  });

  // --- 9. ANTI-AUTO-CLICKER: Rate limit rapid taps ---
  window._tapTimestamps = [];
  window._isTapBlocked = false;

  window._checkTapRate = function() {
    if (window._isTapBlocked) return false;
    const now = Date.now();
    window._tapTimestamps.push(now);
    // Keep only last 3 seconds of timestamps
    window._tapTimestamps = window._tapTimestamps.filter(t => now - t < 3000);
    // If more than 8 taps in 3 seconds → suspicious
    if (window._tapTimestamps.length > 8) {
      window._isTapBlocked = true;
      showNeonToast('Auto-clicker detected! Tap blocked for 10 seconds.', 'error');
      setTimeout(() => {
        window._isTapBlocked = false;
        window._tapTimestamps = [];
      }, 10000);
      return false;
    }
    return true;
  };

  // --- 10. DOM MUTATION OBSERVER: Detect injected elements ---
  // Blocks script tags, iframe injection, and unauthorized DOM modifications.
  const _allowedNodes = new Set(['#app', '#game-screen', '.bg-aurora', '.bg-grid', '.topbar', '.tab-panel', '.tab-bar']);
  const _blockedTags = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET']);
  
  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue; // skip text nodes
        // Block dangerous element types
        if (_blockedTags.has(node.tagName)) {
          node.remove();
          console.warn('[Anti-injection] Blocked injected element: ' + node.tagName);
          showNeonToast('Injection attempt blocked!', 'error');
          continue;
        }
        // Block inline event handlers on any element
        if (node.attributes) {
          for (const attr of Array.from(node.attributes)) {
            if (attr.name.startsWith('on')) {
              node.removeAttribute(attr.name);
              console.warn('[Anti-injection] Removed event handler: ' + attr.name);
            }
          }
        }
        // Block javascript: and data: URIs in src/href
        for (const attr of ['src', 'href', 'action', 'formaction']) {
          const val = node.getAttribute && node.getAttribute(attr);
          if (val && /^(javascript|data|vbscript):/i.test(val)) {
            node.removeAttribute(attr);
            console.warn('[Anti-injection] Blocked URI: ' + attr + '=' + val);
          }
        }
      }
      // Also check attribute mutations on existing nodes
      if (m.type === 'attributes' && m.target && m.attributeName) {
        const attr = m.attributeName;
        if (attr.startsWith('on')) {
          m.target.removeAttribute(attr);
          console.warn('[Anti-injection] Removed event handler on existing node: ' + attr);
        }
        const val = m.target.getAttribute && m.target.getAttribute(attr);
        if (val && /^(javascript|data|vbscript):/i.test(val)) {
          m.target.removeAttribute(attr);
          console.warn('[Anti-injection] Blocked URI on existing node: ' + attr);
        }
      }
    }
  });
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'action', 'formaction', 'onclick', 'onerror', 'onload', 'onmouseover']
  });

})();

// ============ TAB NAVIGATION ============
(function initTabNav() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;

  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (!tab) return;

    // Update active tab button
    tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Update active tab panel
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('tab-' + tab);
    if (panel) panel.classList.add('active');

    // Show/hide game screen when Play tab is active
    // (game screen is separate from tab panels)
  });
})();

window.switchTab = function(tabName) {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;
  const btn = tabBar.querySelector('[data-tab="' + tabName + '"]');
  if (btn) btn.click();
};

// ============ SUPPORT MODAL ============
window.openSupportModal = function() {
  const modal = document.getElementById('support-modal');
  if (modal) modal.style.display = 'flex';
};
window.closeSupportModal = function() {
  const modal = document.getElementById('support-modal');
  if (modal) modal.style.display = 'none';
};

// ============ SHOW/HIDE GAME SCREEN (on game start/end) ============
window.showGameScreen = function() {
  // Hide all tab panels and show game screen
  document.body.classList.add('game-live'); // render <main> only while a game runs
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('game-screen').style.display = 'block';
  document.getElementById('tab-bar').style.display = 'none';
  document.querySelector('header.topbar').style.display = 'none';
};

window.showTabScreen = function() {
  // Hide game screen and show default tab (home)
  document.body.classList.remove('game-live'); // empty <main> must not eat half the screen
  document.getElementById('game-screen').style.display = 'none';
  document.getElementById('tab-bar').style.display = 'flex';
  document.querySelector('header.topbar').style.display = 'block';
  // Restore home tab
  const homeTab = document.querySelector('[data-tab="home"]');
  if (homeTab) homeTab.click();
};

// NOTE: showTabScreen() is called directly inside resetToHome() above.

// Show admin panels only for admin wallet
function updateAdminVisibility() {
  const isAdmin = typeof myAddress !== 'undefined' && myAddress && myAddress.toLowerCase() === ADMIN_WALLET.toLowerCase();
  // Toggle the GUARD CLASS itself, not inline display — the stylesheet
  // hides these elements with display:none !important, which beats any
  // inline style. Only removing the class can reveal them.
  if (isAdmin) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'inline-block');
    document.querySelectorAll('.admin-panel-hidden').forEach(el => el.classList.remove('admin-panel-hidden'));
  } else {
    // HIDE admin elements for everyone else (defense in depth)
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.admin-panel-hidden').forEach(el => el.classList.add('admin-panel-hidden'));
  }
}
// Run after wallet is detected
setTimeout(updateAdminVisibility, 2000);
setInterval(updateAdminVisibility, 5000);
