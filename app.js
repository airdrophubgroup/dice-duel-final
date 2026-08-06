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

const CHAT_STORAGE_KEY = "tnv_global_chat_history";
const CHAT_EXPIRY_MS = 24 * 60 * 60 * 1000;

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

  if (myAddress) {
    try {
      const { data: stuckMatches } = await supabaseClient
        .from('matches')
        .select('*')
        .or(`p1_address.eq.${myAddress},p2_address.eq.${myAddress}`)
        .eq('status', 'waiting');

      if (stuckMatches && stuckMatches.length > 0) {
        for (let match of stuckMatches) {
          if (!match.game_started) {
            let feeToRefund = Number(match.fee || selectedFee);
            const { data: usrData } = await supabaseClient.from('user_rewards').select('wld_balance').eq('wallet_address', myAddress).maybeSingle();
            let curBal = Number(usrData?.wld_balance || 0);
            let refundBal = Number((curBal + feeToRefund).toFixed(2));
            await supabaseClient.from('user_rewards').update({ wld_balance: refundBal }).eq('wallet_address', myAddress);
            await logMatchHistory(myAddress, 'REFUND', feeToRefund, `Search interrupted & fee refunded (${feeToRefund} WLD)`);
            await supabaseClient.from('matches').delete().eq('id', match.id);
          }
        }
      }
    } catch (e) {}
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

  if (typeof initGlobalChat === 'function') {
    initGlobalChat();
  }
  fetchLeaderboard();
  await resumeGameIfActive();
});

window.addEventListener('beforeunload', () => {
  if (matchmakingActive && matchId && !gameActive) {
    cancelMatchmaking(false);
  }
});

function initGlobalChat() {
  loadAndCleanChatHistory();

  globalChatChannel = supabaseClient.channel('global_community_chat', {
    config: { presence: { key: myUsername || 'User' }, broadcast: { self: true } }
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
  ticker.innerHTML = `🔥 <span style="color:var(--photon); font-weight:700;">${username || 'A player'}</span> started a <span style="color:var(--gold); font-weight:700;">${fee} WLD</span> duel!`;
  
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
    <div class="chat-sender">${sender}</div>
    <div>${message}</div>
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

  let senderName = myUsername || '@User';
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
    console.error("Failed to fetch real WLD balance:", error);
  }
  return 0;
}

async function fetchUserBalanceAndLeaderboard(wallet) {
  if (!wallet) return;
  if (wallet.toLowerCase() === ADMIN_WALLET.toLowerCase()) {
    if ($('admin-panel')) $('admin-panel').style.display = 'block';
    if ($('admin-cheaters-panel')) $('admin-cheaters-panel').style.display = 'block';
    if ($('admin-history-nav-btn')) $('admin-history-nav-btn').style.display = 'inline-block';
    fetchAdminWithdrawRequests();
    fetchAdminCheaters();
  }

  try {
    const cleanWallet = wallet.toLowerCase().trim();
    
    const { data, error } = await supabaseClient
      .from('user_rewards')
      .select('tnv_balance, wld_balance, is_blocked')
      .eq('wallet_address', cleanWallet)
      .maybeSingle();
  
    if (!error && data) {
      if (data.is_blocked) { $('blocked-screen').style.display = 'flex'; return; }
      currentTnvBalance = Number(data.tnv_balance || 0);
      currentWldBalance = await fetchRealWldBalance(cleanWallet);
    } else {
      await supabaseClient.from('user_rewards').upsert({
        wallet_address: cleanWallet,
        tnv_balance: 0,
        wld_balance: 0,
        is_blocked: false
      });
      currentTnvBalance = 0; 
      currentWldBalance = await fetchRealWldBalance(cleanWallet);
    }

    if ($('balance-num')) $('balance-num').innerText = currentTnvBalance;
    
    const wldDisp = $('wld-balance-num') || $('wld-balance');
    if (wldDisp) {
      wldDisp.innerText = Number(currentWldBalance || 0).toFixed(4) + " WLD";
    }

    if ($('progress-text')) $('progress-text').innerText = `${currentTnvBalance.toLocaleString()} / 5,000 TNV`;
    if ($('p-fill')) $('p-fill').style.width = Math.min(100, (currentTnvBalance / 5000) * 100) + '%';
    if (currentTnvBalance >= 5000) {
      if ($('withdraw-btn')) $('withdraw-btn').removeAttribute('disabled');
    } else {
      if ($('withdraw-btn')) $('withdraw-btn').setAttribute('disabled', 'true');
    }
  } catch (e) {
    console.error("Balance fetch error:", e);
  }
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
            <button onclick="navigator.clipboard.writeText('${req.wallet_address}'); alert('User address copied!');" style="background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:9px; padding:2px 6px; border-radius:4px; cursor:pointer;">Copy Addr</button>
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
  if (confirm(`⚠️ Block user: ${walletToBlock}?`)) {
    await supabaseClient.from('user_rewards').update({ is_blocked: true }).eq('wallet_address', walletToBlock);
    alert('User blocked.');
    fetchAdminCheaters();
  }
};

window.openAdminModal = function(reqId, userWallet, amount) {
  activeAdminReqId = reqId;
  $('admin-modal-info').innerText = `Paying ${amount} TNV to ${userWallet.slice(0,6)}...${userWallet.slice(-4)}`;
  $('admin-tx-input').value = "";
  $('admin-approve-modal').style.display = 'flex';
};

window.closeAdminModal = function() { $('admin-approve-modal').style.display = 'none'; };

window.confirmAdminApproval = async function() {
  let txProof = $('admin-tx-input').value.trim();
  if (!txProof) { alert('Enter Tx Hash'); return; }
  await supabaseClient.from('withdraw_requests').update({ status: 'approved', tx_hash: txProof }).eq('id', activeAdminReqId);
  alert('Approved successfully!');
  closeAdminModal();
  fetchAdminWithdrawRequests();
};

window.openUserHistoryModal = async function() {
  if (!myAddress) { alert('Please sign in inside World App!'); return; }
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
  if (!myAddress) { alert('Please sign in inside World App!'); return; }
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

window.closeUserWithdrawalsModal = function() { $('user-withdrawals-modal').style.display = 'none'; };

window.openAdminEarningsModal = async function() {
  const modal = $('admin-earnings-modal');
  if (modal) modal.style.display = 'flex';
  const container = $('admin-earnings-list');
  if (container) container.innerHTML = `<div style="text-align:center; color:var(--slate);">Loading revenue...</div>`;
  try {
    const { data } = await supabaseClient.from('match_history').select('*').eq('wallet_address', ADMIN_WALLET).eq('action_type', 'ADMIN_FEE').order('created_at', { ascending: false }).limit(50);
    if (!container) return;
    if (!data || data.length === 0) { container.innerHTML = `<div style="text-align:center; color:var(--slate);">No fees collected.</div>`; return; }
    let total = 0, html = '';
    data.forEach(i => {
      total += Number(i.amount || 0);
      let timeString = i.created_at ? new Date(i.created_at).toLocaleString() : '';
      html += `
        <div style="background:rgba(243,156,18,0.05); padding:8px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
          <span style="color:var(--gold); font-weight:700;">+${i.amount} WLD</span>
          <span style="font-size:10px; color:var(--slate);">${timeString}</span>
        </div>
      `;
    });
    container.innerHTML = `<div style="color:var(--gold); font-weight:700; margin-bottom:8px;">Total: ${total.toFixed(2)} WLD</div>` + html;
  } catch(e) {}
};

window.closeAdminEarningsModal = function() { 
  const modal = $('admin-earnings-modal');
  if (modal) modal.style.display = 'none'; 
};

async function fetchLeaderboard() {
  try {
    const { data } = await supabaseClient.from('user_rewards').select('wallet_address, tnv_balance').order('tnv_balance', { ascending: false }).limit(10);
    const lbContainer = $('lb-container');
    if (!lbContainer) return;
    if (!data || data.length === 0) { lbContainer.innerHTML = `<div class="lb-item" style="justify-content:center; color:var(--slate);">No leaders yet</div>`; return; }
    let html = '';
    data.forEach((row, index) => {
      let rankClass = index === 0 ? 'top-1' : (index === 1 ? 'top-2' : (index === 2 ? 'top-3' : ''));
      let shortWallet = row.wallet_address.slice(0, 6) + '...' + row.wallet_address.slice(-4);
      html += `<div class="lb-item ${rankClass}"><span class="lb-rank">#${index + 1}</span><span class="lb-user">${shortWallet}</span><span class="lb-score">${row.tnv_balance} TNV</span></div>`;
    });
    lbContainer.innerHTML = html;
  } catch (e) {}
}

window.openWithdrawModal = function() {
  if (currentTnvBalance < 5000) { alert('Min 5,000 TNV required!'); return; }
  $('modal-bal').innerText = currentTnvBalance;
  $('withdraw-input-container').style.display = 'block';
  $('withdraw-amount-input').value = currentTnvBalance;
  $('withdraw-modal').style.display = 'flex';
};

window.closeWithdrawModal = function() { $('withdraw-modal').style.display = 'none'; };

window.submitWithdrawRequest = async function() {
  let withdrawAmt = Number($('withdraw-amount-input').value);
  if (isNaN(withdrawAmt) || withdrawAmt < 5000 || withdrawAmt > currentTnvBalance) { alert('Invalid amount'); return; }
  await supabaseClient.from('withdraw_requests').insert({ wallet_address: myAddress, amount: withdrawAmt, status: 'pending' });
  await supabaseClient.from('user_rewards').update({ tnv_balance: currentTnvBalance - withdrawAmt }).eq('wallet_address', myAddress);
  alert('Withdrawal requested!');
  closeWithdrawModal();
  fetchUserBalanceAndLeaderboard(myAddress);
};

async function resumeGameIfActive() {
  let savedMatchId = localStorage.getItem("currentMatchId");
  if (!savedMatchId && myAddress) {
    try {
      const { data: activeMatch } = await supabaseClient.from('matches').select('*').or(`p1_address.eq.${myAddress},p2_address.eq.${myAddress}`).eq('status', 'playing').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (activeMatch) {
        savedMatchId = activeMatch.id;
        localStorage.setItem("currentMatchId", savedMatchId);
        localStorage.setItem("isP1", (activeMatch.p1_address === myAddress).toString());
      }
    } catch (e) {}
  }
  if (!savedMatchId) return;

  try {
    const { data } = await supabaseClient.from('matches').select('*').eq('id', savedMatchId).single();
    if (data && data.status === 'playing') {
      matchId = savedMatchId;
      isP1 = localStorage.getItem("isP1") === "true";
      selectedFee = Number(data.fee || 0.5);
      gameActive = true;
      myScore = isP1 ? data.p1_score : data.p2_score;
      oppScore = isP1 ? data.p2_score : data.p1_score;
      myTurnsLeft = Math.max(0, 15 - ((isP1 ? data.p1_taps_used : data.p2_taps_used) || 0));

      setUserData(myUsername, myAddress);
      $('opp-name-tag').innerText = (isP1 ? data.p2_username : data.p1_username) || 'OPP';
      $('setup-screen').style.display = 'none';
      $('waiting-overlay').style.display = 'none';
      $('game-screen').style.display = 'block';
      $('my-score').innerText = myScore || 0;
      $('opp-score').innerText = oppScore || 0;
      setupChannel();
      runTimer(data.start_time);
    }
  } catch (e) {}
}

function setUserData(username, address){
  myUsername = username;
  myAddress = address ? address.toLowerCase() : address;
  if ($('display-username')) $('display-username').innerText = myUsername;
  if ($('my-name-tag')) $('my-name-tag').innerText = myUsername;
  if ($('landingHint')) $('landingHint').textContent = 'Wallet Connected Successfully';
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

// Official v2/v3 MiniKit walletAuth Implementation with user interaction
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

// Strictly Real WLD Payment Handler using MiniKit.commandsAsync.pay
async function payRealWldFee(feeAmount) {
  if (!MiniKit.isInstalled()) {
    alert("Please open this game inside World App.");
    return false;
  }

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

    await logMatchHistory(
      ADMIN_WALLET,
      "ADMIN_FEE",
      feeAmount,
      `Entry fee from ${myUsername || myAddress}`
    );

    return true;
  } catch (err) {
    console.error("Payment error:", err);
    if ($('start-btn')) $('start-btn').disabled = false;
    alert("Payment failed.");
    return false;
  }
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

async function initMatchmakingAfterPayment(){
  matchmakingActive = true;
  $('start-btn').disabled = true;
  $('waiting-overlay').style.display = 'flex';
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

  try{
    const { data, error } = await supabaseClient.rpc('join_or_create_match', {
      p_address: myAddress, p_fee: selectedFee, p_username: myUsername,
    });

    if (error || !data){ resetToHome(); return; }
    const matchRow = Array.isArray(data) ? data[0] : data;
    if (!matchRow) { resetToHome(); return; }

    matchId = matchRow.id;
    isP1 = (matchRow.p1_address === myAddress);

    setupChannel();
    pollTimer = setInterval(checkBothReady, 1000);
  }catch(err){ resetToHome(); }
}

async function cancelMatchmaking(showAlert = true) {
  if (!matchmakingActive || gameActive) return;
  if (matchId) {
    try {
      const { data: matchCheck } = await supabaseClient.from('matches').select('status, game_started, fee').eq('id', matchId).single();

      if (matchCheck && !matchCheck.game_started && matchCheck.status === 'waiting') {
        let matchFee = Number(matchCheck.fee || selectedFee);
        const { data: usrData } = await supabaseClient.from('user_rewards').select('wld_balance').eq('wallet_address', myAddress).maybeSingle();
        const currentBal = Number(usrData?.wld_balance || 0);
        const refundBal = Number((currentBal + matchFee).toFixed(2));

        await supabaseClient.from('user_rewards').update({ wld_balance: refundBal }).eq('wallet_address', myAddress);
        await logMatchHistory(myAddress, 'REFUND', matchFee, `Search cancelled & fee refunded (${matchFee} WLD)`);
        await supabaseClient.from('matches').delete().eq('id', matchId).eq('status', 'waiting');

        if (showAlert) alert(`Search cancelled. ${matchFee} WLD entry fee has been refunded.`);
      } else {
        if (showAlert) alert(`Search cancelled.`);
      }
    } catch(e) {}
  }
  resetToHome();
}

async function checkBothReady(){
  if (!matchmakingActive || gameActive) return;
  const { data, error } = await supabaseClient.from('matches').select('status, p1_username, p2_username').eq('id', matchId).single();
  if (error) return;

  if (data.status === 'matched' || data.status === 'playing'){
    if (pollTimer) clearInterval(pollTimer);
    $('opp-name-tag').innerText = (isP1 ? data.p2_username : data.p1_username) || 'OPP';
    localStorage.setItem("currentMatchId", matchId);
    localStorage.setItem("isP1", isP1);

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

  if (isP1) {
    await supabaseClient.from("matches").update({ game_started: true, status: "playing", start_time: new Date().toISOString() }).eq("id", matchId);
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

  localStorage.removeItem("currentMatchId");
  localStorage.removeItem("isP1");

  const { data: m } = await supabaseClient.from('matches').select('*').eq('id', matchId).single();
  if (!m) { resetToHome(); return; }

  let finalRow = m;
  let matchFee = Number(m.fee || selectedFee);

  if (m.status !== 'completed'){
    let winnerAddress = null, winnerUsername = null, payout = calculatePayout(matchFee);
    if (m.p1_score > m.p2_score) { winnerAddress = m.p1_address; winnerUsername = m.p1_username; }
    else if (m.p2_score > m.p1_score) { winnerAddress = m.p2_address; winnerUsername = m.p2_username; }

    const { data: updated } = await supabaseClient
      .from('matches')
      .update({ status: 'completed', winner_address: winnerAddress, winner_username: winnerUsername, payout_amount: payout })
      .eq('id', matchId).eq('status', 'playing').select().single();
    if (updated) finalRow = updated;
  }

  const myFinal = isP1 ? finalRow.p1_score : finalRow.p2_score;
  const opFinal = isP1 ? finalRow.p2_score : finalRow.p1_score;
  const isWin = myFinal > opFinal;

  const exactChipEarn = calculatePayout(matchFee); 
  const totalPool = Number((matchFee * 2).toFixed(2)); 
  const adminFeeAmount = Number(Math.max(0, totalPool - exactChipEarn).toFixed(2)); 

  if (myAddress && !sessionStorage.getItem(`settled_${matchId}_${myAddress}`)) {
    sessionStorage.setItem(`settled_${matchId}_${myAddress}`, "true");
    try {
      const { data: usrData } = await supabaseClient.from('user_rewards').select('wld_balance').eq('wallet_address', myAddress).maybeSingle();
      const currentWld = Number(usrData?.wld_balance || 0);

      if (isWin) {
        await supabaseClient.from('user_rewards').update({ wld_balance: Number((currentWld + exactChipEarn).toFixed(2)) }).eq('wallet_address', myAddress);
        await logMatchHistory(myAddress, 'VICTORY', exactChipEarn, `Won match (${matchFee} WLD duel)`);

        const { data: adminData } = await supabaseClient.from('user_rewards').select('wld_balance').eq('wallet_address', ADMIN_WALLET).maybeSingle();
        await supabaseClient.from('user_rewards').update({ wld_balance: Number((Number(adminData?.wld_balance || 0) + adminFeeAmount).toFixed(2)) }).eq('wallet_address', ADMIN_WALLET);
        await logMatchHistory(ADMIN_WALLET, 'ADMIN_FEE', adminFeeAmount, `Platform fee from match`);
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
      const { data: usrData } = await supabaseClient.from('user_rewards').select('tnv_balance, total_games, games_played, games_won').eq('wallet_address', myAddress).maybeSingle();
      if (usrData) {
        await supabaseClient.from('user_rewards').update({ 
          tnv_balance: Number(usrData.tnv_balance || 0) + earnedTnv,
          total_games: Number(usrData.total_games || 0) + 1,
          games_played: Number(usrData.games_played || 0) + 1,
          games_won: Number(usrData.games_won || 0) + (isWin ? 1 : 0)
        }).eq('wallet_address', myAddress);
      }
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

document.querySelectorAll('.fee-chip').forEach(chip => {
  chip.addEventListener('click', () => selectFee(chip.dataset.fee, chip));
});

// Play Button Click Handler with User Interaction Wallet Connection
async function handlePlayButtonClick() {
  if (matchmakingActive || gameActive) return;

  if (!selectedFee || selectedFee <= 0) {
    alert("Please select an entry fee.");
    return;
  }

  if (!myAddress) {
    const connected = await performWalletAuth();
    if (!connected) return;
  }

  const paymentSuccess = await payRealWldFee(selectedFee);
  if (!paymentSuccess) {
    return;
  }

  await initMatchmakingAfterPayment();
}

$('start-btn').addEventListener('click', handlePlayButtonClick);
$('dice-scene').addEventListener('click', rollDice);