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
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";  
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

// Ask the backend to verify the payment on-chain.
// Returns { ok: true } only when the WLD transfer was actually found on
// World Chain — MiniKit's "success" status alone is NOT proof of payment.
// (The escrow contract has no recordDeposit function, so the deposit is NOT
// booked on-chain: Supabase p1_paid/p2_paid is the ledger and refunds go
// through owner emergency transfers.)
async function recordDepositOnce(matchIdB32, playerAddr, feeWei, txHash) {
  const depositRes = await fetch('/api/record-deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      matchIdBytes32: matchIdB32,
      playerAddress: playerAddr,
      feeWei: feeWei,
      txHash: txHash || null,
    }),
  });
  const depositData = await depositRes.json().catch(() => ({}));
  return { ok: depositRes.ok && !!depositData.success, data: depositData };
}

const supabaseClient = createClient(SB_URL, SB_KEY);  

let myAddress = "", myUsername = "", matchId = null, matchIdBytes32Global = null, isP1, myScore = 0, oppScore = 0;  
let gameActive = false, matchmakingActive = false, channel, globalChatChannel, mTimer, pollTimer, gameTimerInterval;  
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

function checkWorldAppEnvironment() {  
  const isWorldApp = (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) || window.ethereum;  
  if (!isWorldApp) {  
    document.body.innerHTML = `  
      <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:#050000; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:999999; font-family:sans-serif; text-align:center; padding:20px;">  
        <div style="background:rgba(255, 0, 0, 0.08); border:2px solid #ff3333; padding:30px; border-radius:20px; box-shadow: 0 0 30px rgba(255, 0, 0, 0.4); max-width:400px;">  
          <h1 style="color:#ff3333; font-size:24px; margin-bottom:15px; text-shadow: 0 0 10px rgba(255,51,51,0.5);">⚠️ ACCESS DENIED</h1>  
          <p style="color:#ffffff; font-size:16px; line-height:1.5; margin-bottom:20px;">This mini app can only be accessed and used inside the official <b>World App</b>.</p>  
          <div style="background:#ff3333; color:#000; font-weight:bold; padding:12px 20px; border-radius:10px; font-size:15px; box-shadow: 0 0 15px #ff3333;">  
            Please open inside World App  
          </div>  
        </div>  
      </div>  
    `;  
    return false;  
  }  
  return true;  
}  

function waitForMiniKitReady(timeoutMs = 2000) {  
  return new Promise((resolve) => {  
    const start = Date.now();  
    (function check() {  
      if ((typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) || window.ethereum) {  
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
  try { MiniKit.install(WORLD_APP_ID); } catch(e) {}  

  const ready = await waitForMiniKitReady();  
  if (!ready) { checkWorldAppEnvironment(); return; }  

  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {  
    if ($('landingHint')) $('landingHint').textContent = 'World App detected — signing in...';  
    try { await performWalletAuth(true); } catch(err) {}  
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
    })  
    .on('broadcast', { event: 'live_bet_alert' }, ({ payload }) => {  
      if (!matchmakingActive && !gameActive && payload && payload.address !== myAddress) {  
        showLiveBetNotification(payload.username, payload.fee);  
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

function showLiveBetNotification(username, fee) {  
  let existingContainer = document.getElementById('live-bet-ticker-container');  
  if (!existingContainer) {  
    existingContainer = document.createElement('div');  
    existingContainer.id = 'live-bet-ticker-container';  
    existingContainer.style.cssText = 'position:fixed; top:70px; left:50%; transform:translateX(-50%); z-index:4000; display:flex; flex-direction:column; gap:6px; pointer-events:none; width:90%; max-width:340px;';  
    document.body.appendChild(existingContainer);  
  }  

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
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(history));  

    const container = $('chat-messages-container');  
    container.innerHTML = `<div style="text-align:center; color:var(--slate); font-size:11px;">Messages are saved for 24 hours. Chat freely!</div>`;  
    history.forEach(item => {  
      renderChatMessageUI(item.sender, item.message, item.address, item.timestamp);  
    });  
  } catch (e) {}  
}  

function saveAndAppendChatMessage(sender, message, senderAddress, timestamp) {  
  try {  
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);  
    let history = raw ? JSON.parse(raw) : [];  
    history.push({ sender, message, address: senderAddress, timestamp });  
    const now = Date.now();  
    history = history.filter(item => (now - item.timestamp) < CHAT_EXPIRY_MS);  
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(history));  
    renderChatMessageUI(sender, message, senderAddress, timestamp);  
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
  const container = $('chat-messages-container');  
  container.scrollTop = container.scrollHeight;  
};  

window.closeChatModal = function() { $('chat-modal').style.display = 'none'; };  

window.sendChatMessage = function() {  
  const input = $('chat-input-field');  
  const msg = input.value.trim();  
  if (!msg) return;  

  let senderName = myUsername || '@Guest';  
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
}  

window.toggleSupportDropdown = function(event) {  
  event.stopPropagation();  
  const dropdown = $('support-dropdown');  
  dropdown.classList.toggle('show');  
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
  try {  
    const paddedAddress = walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');  
    const response = await fetch(WORLDCHAIN_RPC, {  
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
    });  
    const result = await response.json();  
    if (result.error) return null;  
    if (result.result && result.result !== '0x') {  
      const balanceWei = BigInt(result.result);  
      return Number(balanceWei) / 1e18;  
    }  
  } catch (e) {}  
  return null;  
}  

async function fetchUserBalanceAndLeaderboard(wallet) {  
  if (!wallet) return;  
  if (wallet.toLowerCase() === ADMIN_WALLET.toLowerCase()) {  
    $('admin-panel').style.display = 'block';  
    $('admin-cheaters-panel').style.display = 'block';  
    if ($('admin-history-nav-btn')) $('admin-history-nav-btn').style.display = 'inline-block';  
    fetchAdminWithdrawRequests();  
    fetchAdminCheaters();  
  }  

  try {  
    const cleanWallet = wallet ? wallet.toLowerCase().trim() : '';  
    const realBalance = await fetchRealWldBalance(cleanWallet);  

    const { data, error } = await supabaseClient  
      .from('user_rewards')  
      .select('tnv_balance, wld_balance, is_blocked')  
      .eq('wallet_address', cleanWallet)  
      .maybeSingle();  

    if (!error && data && data.is_blocked) { $('blocked-screen').style.display = 'flex'; return; }  

    currentTnvBalance = Number(data?.tnv_balance || 0);  

    if (realBalance !== null) {  
      currentWldBalance = realBalance;  
      if (!data) {  
        await supabaseClient.rpc('secure_ensure_user_row', { p_wallet: cleanWallet });  
      }  
    } else {  
      currentWldBalance = Number(data?.wld_balance || 0);  
      if (!data) {  
        await supabaseClient.rpc('secure_ensure_user_row', { p_wallet: cleanWallet });  
      }  
    }  

    $('balance-num').innerText = currentTnvBalance;  
    if ($('wld-balance-num')) $('wld-balance-num').innerText = currentWldBalance.toFixed(2);  
    $('progress-text').innerText = `${currentTnvBalance.toLocaleString()} / 5,000 TNV`;  
    $('p-fill').style.width = Math.min(100, (currentTnvBalance / 5000) * 100) + '%';  
    if (currentTnvBalance >= 5000) $('withdraw-btn').removeAttribute('disabled');  
    else $('withdraw-btn').setAttribute('disabled', 'true');  
  } catch (e) {}  
  fetchLeaderboard();  
}  

async function logMatchHistory(wallet, type, amount, details) {  
  try {  
    await supabaseClient.from('match_history').insert({  
      wallet_address: wallet ? wallet.toLowerCase().trim() : '',   
      action_type: type,   
      amount: amount,   
      description: details,   
      created_at: new Date().toISOString()  
    });  
  } catch(e) {}  
}  

async function fetchAdminWithdrawRequests() {  
  try {  
    const { data, error } = await supabaseClient.from('withdraw_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false });  
    const container = $('admin-req-container');  
    if (!container) return;  
    if (error || !data || data.length === 0) {  
      container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">No pending requests</div>`;  
      return;  
    }  
    let html = '';  
    data.forEach(req => {  
      let shortAddr = req.wallet_address.slice(0, 6) + '...' + req.wallet_address.slice(-4);  
      html += `  
        <div class="admin-req-item">  
          <div class="admin-req-row">  
            <span style="color:var(--photon); font-family:'JetBrains Mono', monospace;" title="${req.wallet_address}">${shortAddr}</span>  
            <button onclick="navigator.clipboard.writeText('${req.wallet_address}'); showNeonToast('User address copied!','success');" style="background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:9px; padding:2px 6px; border-radius:4px; cursor:pointer;">Copy Addr</button>  
            <span style="color:var(--gold); font-family:'JetBrains Mono', monospace; font-weight:700;">${req.amount} TNV</span>  
          </div>  
          <div class="admin-req-row"><span style="font-size:10px; color:var(--slate);">${new Date(req.created_at).toLocaleString()}</span><button class="approve-btn" onclick="openAdminModal('${req.id}', '${req.wallet_address}', ${req.amount})">APPROVE / PAY</button></div>  
        </div>  
      `;  
    });  
    container.innerHTML = html;  
  } catch (e) {}  
}  

async function fetchAdminCheaters() {  
  try {  
    const { data, error } = await supabaseClient.from('cheater_logs').select('*').order('detected_at', { ascending: false }).limit(20);  
    const container = $('admin-cheaters-container');  
    if (!container) return;  
    if (error || !data || data.length === 0) {  
      container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">No suspicious activity</div>`;  
      return;  
    }  
    let html = '';  
    data.forEach(log => {  
      let shortAddr = log.wallet_address.slice(0, 6) + '...' + log.wallet_address.slice(-4);  
      html += `  
        <div class="admin-req-item">  
          <div class="admin-req-row"><span style="color:var(--signal); font-family:'JetBrains Mono', monospace;">${shortAddr}</span><span style="font-size:10px; color:var(--slate);">${new Date(log.detected_at).toLocaleString()}</span></div>  
          <div class="admin-req-row"><span style="font-size:11px; color:var(--gold); font-weight:600;">Attempts: ${log.click_count}x</span><button class="block-btn" onclick="promptBlockUser('${log.wallet_address}')">BLOCK</button></div>  
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

window.openUserHistoryModal = async function() {  
  if (!myAddress) { showNeonToast('Please sign in first!', 'warning'); return; }  
  $('user-history-modal').style.display = 'flex';  
  const container = $('user-history-list');  
  container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading history...</div>`;  
  try {  
    const { data } = await supabaseClient.from('match_history').select('*').eq('wallet_address', myAddress).neq('action_type', 'ADMIN_FEE').order('created_at', { ascending: false }).limit(20);  
    if (!data || data.length === 0) { container.innerHTML = `<div style="text-align:center; color:var(--slate);">No match history found.</div>`; return; }  
    let html = '';  
    data.forEach(item => {  
      let color = item.action_type === 'DEFEAT' ? 'var(--signal)' : 'var(--photon)';  
      let timeStr = new Date(item.created_at).toLocaleString();  
      html += `<div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:8px 10px; border-radius:8px;"><div style="display:flex; justify-content:space-between; font-weight:700; color:${color};"><span>${item.action_type}</span><span>${item.amount} WLD</span></div><div style="color:var(--slate); font-size:10.5px;">${item.description}</div><div style="color:#777; font-size:9.5px; text-align:right; margin-top:2px;">${timeStr}</div></div>`;  
    });  
    container.innerHTML = html;  
  } catch(e) {}  
};  

window.closeUserHistoryModal = function() { $('user-history-modal').style.display = 'none'; };  
window.openUserWithdrawalsModal = async function() {  
  if (!myAddress) { showNeonToast('Please sign in first!', 'warning'); return; }  
  $('user-withdrawals-modal').style.display = 'flex';  
  const container = $('user-withdrawals-list');  
  container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading requests...</div>`;  
  try {  
    const { data } = await supabaseClient.from('withdraw_requests').select('*').eq('wallet_address', myAddress).order('created_at', { ascending: false });  
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
  $('admin-earnings-modal').style.display = 'flex';  
  const container = $('admin-earnings-list');  
  container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading revenue...</div>`;  
  try {  
    const { data } = await supabaseClient.from('match_history').select('*').eq('wallet_address', PAYMENT_RECV_WALLET).eq('action_type', 'ADMIN_FEE').order('created_at', { ascending: false }).limit(50);  
    if (!data || data.length === 0) { container.innerHTML = `<div style="text-align:center; color:var(--slate);">No fees collected.</div>`; return; }  
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
    container.innerHTML = `<div style="color:var(--gold); font-weight:700; margin-bottom:8px;">Total: ${total.toFixed(2)} WLD</div>` + html;  
  } catch(e) {}  
};  

window.closeAdminEarningsModal = function() { $('admin-earnings-modal').style.display = 'none'; };  

async function fetchLeaderboard() {  
  try {  
    const { data } = await supabaseClient.from('user_rewards').select('wallet_address, tnv_balance').order('tnv_balance', { ascending: false }).limit(10);  
    const lbContainer = $('lb-container');  
    if (!data || data.length === 0) { lbContainer.innerHTML = `<div class="lb-item" style="justify-content:center; color:var(--slate);">No leaders yet</div>`; return; }  
    let html = '';  
    data.forEach((row, index) => {  
      let rankClass = index === 0 ? 'top-1' : (index === 1 ? 'top-2' : (index === 2 ? 'top-3' : ''));  
      let shortWallet = row.wallet_address.startsWith('0xDEV') ? 'Dev_' + row.wallet_address.slice(-4) : row.wallet_address.slice(0, 6) + '...' + row.wallet_address.slice(-4);  
      html += `<div class="lb-item ${rankClass}"><span class="lb-rank">#${index + 1}</span><span class="lb-user">${shortWallet}</span><span class="lb-score">${row.tnv_balance} TNV</span></div>`;  
    });  
    lbContainer.innerHTML = html;  
  } catch (e) {}  
}  

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
};  

function setUserData(username, address){  
  myUsername = username;  
  myAddress = address ? address.toLowerCase() : address;  
  $('display-username').innerText = myUsername;  
  $('my-name-tag').innerText = myUsername;  
  fetchUserBalanceAndLeaderboard(myAddress);  
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
  if (!MiniKit.isInstalled()) return false;  
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
}  

async function handlePlayButtonClick(){  
  if (!checkWorldAppEnvironment()) return;  
  if (matchmakingActive) return;  

  if (!myAddress || !realWorldIdUser) {  
    const signedIn = await performWalletAuth(false);  
    if (!signedIn) return;  
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

  $('wait-status').innerText = `Confirm payment in World App...`;  

  const paymentReference = 'ref_' + randomAlphaNumeric(16);  
  let paymentSuccessful = false;  
  let payRes;  

  try {  
    // Timeout guard: in some environments MiniKit's pay() never resolves.
    // The on-chain fallback below still recovers the payment, so a hang
    // here must not leave the player stuck.
    payRes = await Promise.race([
      MiniKit.commandsAsync.pay({  
        reference: paymentReference,  
        to: DICE_DUEL_CONTRACT,  
        tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(selectedFee, Tokens.WLD).toString() }],  
        description: `Dice Duel entry fee: ${selectedFee} WLD`,  
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('payment_response_timeout')), 120000)),
    ]);
    
    if (payRes && payRes.finalPayload && payRes.finalPayload.status === 'success') {
      paymentSuccessful = true;
    } else {
      paymentSuccessful = false;
    }
  } catch (err) {  
    paymentSuccessful = false;  
  }  

  if (!paymentSuccessful) {  
    // MiniKit reported cancelled/failed (or timed out) — BUT the payment
    // can still have executed on-chain (confirmed real cases). Verify
    // before giving up: recordDepositOnce scans recent WLD transfers and
    // returns ok only if a real payment of the exact fee arrived. If it
    // did, treat the payment as done so the player is never left with
    // stuck money and can still get an automatic refund on cancel.
    let recoveredPayment = false;
    try {
      const r = await recordDepositOnce(matchIdBytes32Global, myAddress, FEE_WEI[selectedFee], null);
      if (r.ok) recoveredPayment = true;
    } catch (e) { /* on-chain check failed — keep the failure state */ }

    if (recoveredPayment) {
      paymentSuccessful = true;
      showNeonToast('✅ Payment confirmed on-chain', 'success');
    } else {
      showNeonToast('⚠️ Payment was cancelled or failed. No WLD was deducted.', 'warning');
      try { await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: matchId, p_wallet: myAddress }); } catch(e) {}  
      resetToHome();  
      return;  
    }
  }  

  // ==========================================
  // VERIFY & RECORD THE DEPOSIT ON-CHAIN
  // ==========================================
  hasPaid = true;

  const txHash = payRes?.finalPayload?.transaction_id || payRes?.finalPayload?.transaction_hash || null;

  // ------------------------------------------------------------------
  // VERIFY THE PAYMENT ON-CHAIN
  //
  // MiniKit's transaction_id is not always the on-chain tx hash and the
  // RPC can be flaky, so we retry here AND in the background below.
  // /api/record-deposit verifies the real payment on-chain (scanning
  // recent WLD transfers if needed) and only then returns success, so
  // a transient failure here never means the player's money is lost.
  // ------------------------------------------------------------------
  let depositBooked = false;
  let lastDepositError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await recordDepositOnce(matchIdBytes32Global, myAddress, FEE_WEI[selectedFee], txHash);
      if (r.ok) { depositBooked = true; paymentVerified = true; break; }
      lastDepositError = JSON.stringify(r.data);
    } catch (e) {
      lastDepositError = e.message || String(e);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // Background retry while the player searches — a transient failure
  // self-heals instead of leaving the deposit unbooked. The loop stops
  // itself once booked or once the search ends; if the search is
  // cancelled or times out, cancelMatchmaking() queues the automatic
  // refund so WLD is never stuck.
  let bookingInFlight = false;
  const bookingRetryTimer = setInterval(async () => {
    if (!matchmakingActive || gameActive || depositBooked) {
      clearInterval(bookingRetryTimer);
      return;
    }
    if (bookingInFlight) return;
    bookingInFlight = true;
    try {
      const r = await recordDepositOnce(matchIdBytes32Global, myAddress, FEE_WEI[selectedFee], txHash);
      if (r.ok) {
        depositBooked = true;
        paymentVerified = true;
        clearInterval(bookingRetryTimer);
        // Delayed verification — make sure the DB paid-flag catches up so
        // matchmaking and refunds both work.
        try {
          await supabaseClient.rpc('force_confirm_payment', { p_match_id: matchId, p_is_p1: isP1 });
        } catch(e) { /* non-fatal */ }
        showNeonToast('✅ Deposit confirmed on-chain', 'success');
      }
    } catch (e) { /* keep retrying */ }
    finally { bookingInFlight = false; }
  }, 5000);

  // Mark the payment as done in the DB so matchmaking can proceed — but
  // ONLY when the payment was actually verified on-chain (record-deposit
  // confirmed it). MiniKit "success" without a real on-chain transfer
  // (test mode) must NOT mark the player as paid — otherwise fake
  // payments would queue refund rows. p1_paid/p2_paid are the gate for
  // both matchmaking and refunds.
  if (depositBooked || paymentVerified) {
    try {
      const { data: fcpData, error: fcpErr } = await supabaseClient.rpc('force_confirm_payment', {
        p_match_id: matchId,
        p_is_p1: isP1
      });
      if (fcpErr) console.warn('force_confirm_payment error:', fcpErr);
    } catch(e) {
      console.warn('force_confirm_payment exception:', e);
    }

    // If the player cancelled while the payment was still completing, the
    // match is already cancelled — queue the refund immediately so the
    // payment that just arrived is not left stuck.
    try {
      const { data: chk } = await supabaseClient.from('matches').select('status').eq('id', matchId).single();
      if (chk && chk.status === 'cancelled') {
        await supabaseClient.rpc('queue_refund_request', {
          p_match_id: matchId, p_wallet: myAddress.toLowerCase().trim()
        });
      }
    } catch(e) { /* non-fatal */ }
  }

  if (depositBooked) {
    showNeonToast('✨ Payment confirmed! Waiting for opponent...', 'success');
  } else {
    console.warn('record-deposit not booked yet:', lastDepositError);
    showNeonToast("⚠️ Payment received — booking deposit. If the match doesn't start, your WLD is refunded automatically.", 'warning');
  }

  $('wait-status').innerText = `SEARCHING... (Cancel anytime)`;  

  if (globalChatChannel) {  
    globalChatChannel.send({  
      type: 'broadcast',  
      event: 'live_bet_alert',  
      payload: { username: myUsername || '@Player', fee: selectedFee, address: myAddress }  
    });  
  }  

  let timeLeft = 60;  
  mTimer = setInterval(async () => {  
    timeLeft--;  
    if (timeLeft <= 0){  
      clearInterval(mTimer);  
      if (!gameActive) await cancelMatchmaking(false);  
    }  
  }, 1000);  

  setupChannel();  
  pollTimer = setInterval(checkBothReady, 1000);  
}  

function selectFee(amount, element){  
  if (matchmakingActive) return;  
  selectedFee = parseFloat(amount);  
  document.querySelectorAll('.fee-chip').forEach(chip => chip.classList.remove('active'));  
  element.classList.add('active');  
  $('start-btn').innerText = `PLAY NOW (${selectedFee} WLD)`;  
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
    })  
    .on('broadcast', { event: 'score_update' }, ({ payload }) => {  
      if (payload.sender !== myAddress){  
        oppScore = payload.score;  
        $('opp-score').innerText = oppScore;  
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

  // ALWAYS attempt the refund on cancel. queue_refund_request is the
  // source of truth: it only queues a refund for a PAID participant of
  // this match (server-side), so a fake/test payment is rejected there
  // and a real payment is never missed due to client-side flag races
  // (hasPaid/paymentVerified). The cron resolver completes the refund
  // within a minute even if the app is closed by then.
  let refundQueued = false;
  if (targetMatchId && targetWallet) {
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
        const r = await recordDepositOnce(matchIdBytes32Global, targetWallet, FEE_WEI[selectedFee] || null, null);
        if (r.ok) {
          try {
            await supabaseClient.rpc('force_confirm_payment', { p_match_id: targetMatchId, p_is_p1: isP1 });
          } catch(e) { /* non-fatal */ }
          const { data: d2 } = await supabaseClient.rpc('queue_refund_request', {
            p_match_id: targetMatchId, p_wallet: targetWallet
          }).catch(() => ({}));
          refundQueued = !!d2 && d2.success === true;
        }
      } catch (e) { /* non-fatal */ }
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
    await supabaseClient.rpc('secure_leave_waiting_match', {
      p_match_id: targetMatchId, p_wallet: targetWallet
    });
  } catch(e) {
    console.error("Leave match error:", e);
  }

  resetToHome();  
}    

async function checkBothReady(){  
  if (!matchmakingActive || gameActive) return;  
  if (!matchId) return;

  const { data, error } = await supabaseClient
    .from('matches')
    .select('status, p1_username, p2_username, p1_paid, p2_paid, match_id')
    .eq('id', matchId)
    .single();  

  if (error || !data) return;  

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

  if (isP1 && matchId) {  
    await supabaseClient.rpc('secure_start_match', { p_match_id: matchId, p_wallet: myAddress });  
  }  

  $('wait-status').style.color = 'var(--photon)';  
  $('wait-status').innerText = 'OPPONENT CONNECTED!';  
  $('target-dot').classList.add('connected');   

  setTimeout(() => {  
    $('waiting-overlay').style.display = 'none';  
    $('setup-screen').style.display = 'none';  
    $('game-screen').style.display = 'block';  
    $('target-dot').classList.remove('connected');  

    myTurnsLeft = 15;  
    $('turn-indicator').innerText = `tap the die to roll (${myTurnsLeft} turns left)`;  
    runTimer(new Date().toISOString());   
  }, 2000);  
}  

async function runTimer(startTime = null){  
    clearInterval(gameTimerInterval);  
    if (!startTime) startTime = new Date().toISOString();  

    gameTimerInterval = setInterval(() => {  
        const elapsed = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000);  
        const remaining = 32 - elapsed;  
        $("game-timer").innerText = Math.max(remaining, 0) + "s";  
        if (remaining <= 2) $('turn-indicator').innerText = 'Calculating winner...';  
        if (remaining <= 0) {  
            clearInterval(gameTimerInterval);  
            if (isP1) channel.send({ type: "broadcast", event: "game_force_end" });  
            finalizeGame();  
        }  
    }, 1000);  
}  

async function rollDice(){  
  if (!checkWorldAppEnvironment()) return;  
  if (!gameActive || $('game-timer').innerText === '0s') return;  
  if (isTimingLocked) return;  
  if (myTurnsLeft <= 0) return;  

  isTimingLocked = true;  
  myTurnsLeft--;  
  $('turn-indicator').innerText = `⏳ Please wait 2s... (${myTurnsLeft} turns left)`;  

  const roll = Math.floor(Math.random() * 6) + 1;  
  myScore += roll;  
  $('my-score').innerText = myScore;  

  const faceRotations = { 1: {x:0, y:0}, 2: {x:0, y:180}, 3: {x:0, y:-90}, 4: {x:0, y:90}, 5: {x:-90, y:0}, 6: {x:90, y:0} };  
  const rot = faceRotations[roll];  
  $('dice-cube').style.transform = `rotateX(${rot.x + 720}deg) rotateY(${rot.y + 720}deg)`;  

  channel.send({ type: 'broadcast', event: 'score_update', payload: { sender: myAddress, score: myScore } });  
  
  const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('secure_roll_dice', {  
    p_match_id: matchId, p_wallet: myAddress, p_roll: roll  
  });  

  if (rpcErr || (rpcRes && !rpcRes.success)) {  
    console.warn("Roll rejected");  
  } else if (rpcRes && rpcRes.taps_left !== undefined) {  
    myTurnsLeft = rpcRes.taps_left;  
  }  

  setTimeout(() => {  
    isTimingLocked = false;  
    if (myTurnsLeft > 0 && gameActive && $('game-timer').innerText !== '0s') {  
      $('turn-indicator').innerText = `tap the die to roll (${myTurnsLeft} turns left)`;  
    }  
  }, 2000);  
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
  const isWin = myFinal > opFinal;  
  const oppAddress = isP1 ? finalRow.p2_address : finalRow.p1_address;
  const winnerWallet = isWin ? myAddress : oppAddress;

  const exactChipEarn = calculatePayout(matchFee);   

  // Only the winner's device triggers the on-chain payout, so it fires
  // exactly once (sessionStorage prevents a duplicate on this device).
  // The payout is an owner emergency transfer of the displayed winnings.
  if (isWin && matchId && winnerWallet) {
    // Only the winner's device triggers the payout, so it fires exactly
    // once (sessionStorage prevents a duplicate on this device, and the
    // API's mark_match_settled guard makes double payouts impossible).
    // The API validates the winner against the Supabase match row and
    // pays the displayed winnings via an owner emergency transfer.
    fetch('/api/refund-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchUuid: matchId,
        action: 'SETTLE_WINNER',
        winnerAddress: winnerWallet
      })
    }).catch(err => console.error("Settle API Error:", err));
  }

  if (myAddress && !sessionStorage.getItem(`settled_${matchId}_${myAddress}`)) {  
      sessionStorage.setItem(`settled_${matchId}_${myAddress}`, "true");  
      try {  
          if (isWin) {  
              await logMatchHistory(myAddress, 'VICTORY', exactChipEarn, `Won match (${matchFee} WLD duel)`);  
          } else {  
              await logMatchHistory(myAddress, 'DEFEAT', -matchFee, `Lost match (${matchFee} WLD duel)`);  
          }  
      } catch(e){}  
  }  

  let winTnv = getTnvRewardForFee(matchFee);  
  let earnedTnv = isWin ? winTnv : Math.floor(winTnv / 3);  

  if (myAddress && !sessionStorage.getItem(`tnv_settled_${matchId}_${myAddress}`)) {  
    sessionStorage.setItem(`tnv_settled_${matchId}_${myAddress}`, "true");  
    try {  
      const { data: tnvResult } = await supabaseClient.rpc('secure_credit_tnv', {  
        p_match_id: matchId, p_wallet: myAddress  
      });  
      if (tnvResult && tnvResult.earnedTnv !== undefined) earnedTnv = tnvResult.earnedTnv;  
    } catch(e) {}  
  }  

  if (isWin){  
    $('result-icon').innerText = '🏆';  
    $('result-title').innerText = 'VICTORY!';  
    $('result-msg').innerText = `+${exactChipEarn} WLD & +${earnedTnv} TNV`;  
    $('result-card').className = 'result-card result-victory';  
    playVictorySound();  
  } else {  
    $('result-icon').innerText = '💀';  
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
  if (channel) channel.unsubscribe();  
  $('waiting-overlay').style.display = 'none';  
  $('start-btn').disabled = false;  
  $('start-btn').innerText = `PLAY NOW (${selectedFee} WLD)`;  
  matchmakingActive = false;  
  gameActive = false;  
  hasPaid = false;
  paymentVerified = false;
  matchId = null;
  matchIdBytes32Global = null;
}  

document.querySelectorAll('.fee-chip').forEach(chip => {  
  chip.addEventListener('click', () => selectFee(chip.dataset.fee, chip));  
});  
$('start-btn').addEventListener('click', handlePlayButtonClick);  
$('dice-scene').addEventListener('click', rollDice);