import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@latest/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { encodeFunctionData, keccak256, toHex } from "https://cdn.jsdelivr.net/npm/viem@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";

// Admin Panel Access Wallet (Ye wallet sirf admin dashboard aur ledger kholenay ke liye hai)
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1"; 

// NOTE: PAYMENT_RECV_WALLET is no longer used to collect entry fees — that
// now happens on-chain via the contract below. Kept only because
// openAdminEarningsModal() still reads old off-chain ADMIN_FEE ledger rows
// tied to this address for historical data. New fee revenue now goes to
// the contract's feeRecipient (set at deploy time), not this wallet.
const PAYMENT_RECV_WALLET = "0x8FB70CDFb545C7D9b842cBE37B9aba84059Bf14b";

const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";

// ---- On-chain payment (TnvDuelArena contract) ----
const CONTRACT_ADDRESS = "0x529225162b86489fcbD6320b88C4BAEAAE586a67";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const JOIN_MATCH_ABI = [
  {
    type: "function",
    name: "joinMatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "bytes32" },
      { name: "fee", type: "uint256" },
      { name: "expectedOpponent", type: "address" },
    ],
    outputs: [],
  },
];

const PERMIT2_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
];

// Converts a Supabase match UUID into the same bytes32 matchId the
// contract and the /api/settle-match backend both use — MUST produce
// identical output on both sides.
function matchIdToBytes32(supabaseMatchId) {
  return keccak256(toHex(supabaseMatchId));
}

// Converts a WLD amount (e.g. 0.5) to its wei representation (18 decimals)
// as a BigInt, without floating-point drift.
function wldToWei(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
}

/// Pays the entry fee on-chain via the TnvDuelArena contract, bundling the
/// Permit2 approval + joinMatch call into a single sendTransaction.
async function joinMatchOnChain(supabaseMatchId, feeWld, opponentAddress) {
  const bytes32MatchId = matchIdToBytes32(supabaseMatchId);
  const feeWei = wldToWei(feeWld);

  const result = await MiniKit.sendTransaction({
    chainId: 480,
    transaction: [
      {
        address: PERMIT2_ADDRESS,
        data: encodeFunctionData({
          abi: PERMIT2_APPROVE_ABI,
          functionName: "approve",
          args: [WLD_TOKEN_CONTRACT, CONTRACT_ADDRESS, feeWei, 0],
        }),
      },
      {
        address: CONTRACT_ADDRESS,
        data: encodeFunctionData({
          abi: JOIN_MATCH_ABI,
          functionName: "joinMatch",
          args: [bytes32MatchId, feeWei, opponentAddress],
        }),
      },
    ],
  });

  if (result?.executedWith === "fallback") {
    throw new Error("Not running inside World App");
  }
  const userOpHash = result?.data?.userOpHash;
  if (!userOpHash) {
    throw new Error("On-chain payment failed: " + JSON.stringify(result));
  }
  return userOpHash;
}

// BACKGROUND MUSIC SETUP
let bgMusic = new Audio('assets/bg-music.mp3'); 
bgMusic.loop = true; 
bgMusic.volume = 0.4; 

function startBackgroundMusic() {
  try {
    bgMusic.play().catch(err => console.log("Audio play blocked:", err));
  } catch (e) {}
}

function stopBackgroundMusic() {
  try {
    bgMusic.pause();
    bgMusic.currentTime = 0;
  } catch (e) {}
}

const supabaseClient = createClient(SB_URL, SB_KEY);

let myAddress = "", myUsername = "", matchId, isP1, myScore = 0, oppScore = 0;
let gameActive = false, matchmakingActive = false, channel, globalChatChannel, mTimer, pollTimer, gameTimerInterval;
let selectedFee = 0.5;
let realWorldIdUser = false; 
let currentTnvBalance = 0;
let currentWldBalance = 100;

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
          <h1 style="color:#ff3333; font-size:24px; margin-bottom:15px;">⚠️ ACCESS DENIED</h1>
          <p style="color:#ffffff; font-size:16px; line-height:1.5; margin-bottom:20px;">This mini app can only be accessed and used inside the official <b>World App</b>.</p>
          <div style="background:#ff3333; color:#000; font-weight:bold; padding:12px 20px; border-radius:10px; font-size:15px;">
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
  startBackgroundMusic();

  try { MiniKit.install(WORLD_APP_ID); } catch(e) {}

  const ready = await waitForMiniKitReady();
  if (!ready) { checkWorldAppEnvironment(); return; }

  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
    if ($('landingHint')) $('landingHint').textContent = 'World App detected — signing in...';
    try { await performWalletAuth(true); } catch(err) {}
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
            await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: match.id, p_wallet: myAddress });
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

  if (typeof initGlobalChat === 'function') initGlobalChat();
  fetchLeaderboard();
  await resumeGameIfActive();
});

window.addEventListener('beforeunload', () => {
  if (matchmakingActive && matchId && !gameActive) cancelMatchmaking(false);
});

function initGlobalChat() {
  loadAndCleanChatHistory();
  globalChatChannel = supabaseClient.channel('global_community_chat', {
    config: { presence: { key: myUsername || 'Guest' }, broadcast: { self: true } }
  });

  globalChatChannel
    .on('broadcast', { event: 'new_chat_msg' }, ({ payload }) => {
      if (payload && payload.message) saveAndAppendChatMessage(payload.sender, payload.message, payload.address, payload.timestamp);
    })
    .on('broadcast', { event: 'live_bet_alert' }, ({ payload }) => {
      if (!matchmakingActive && !gameActive && payload && payload.address !== myAddress) showLiveBetNotification(payload.username, payload.fee);
    })
    .on('presence', { event: 'sync' }, () => {
      const state = globalChatChannel.presenceState();
      const onlineCount = Object.keys(state).length || 1;
      if ($('online-count')) $('online-count').innerText = onlineCount;
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await globalChatChannel.track({ online_at: new Date().toISOString() });
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
  ticker.style.cssText = 'background:rgba(17,17,32,0.92); border:1px solid rgba(41,217,194,0.4); backdrop-filter:blur(8px); color:#f1eee6; padding:8px 12px; border-radius:12px; font-size:11.5px; opacity:0; transition:all 0.3s ease; text-align:center;';
  ticker.innerHTML = `🔥 <span style="color:var(--photon); font-weight:700;">${escapeHtml(username)}</span> started a <span style="color:var(--gold); font-weight:700;">${escapeHtml(fee)}</span> WLD duel!`;
  
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
    history.forEach(item => renderChatMessageUI(item.sender, item.message, item.address, item.timestamp));
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
  $('chat-messages-container').scrollTop = $('chat-messages-container').scrollHeight;
};

window.closeChatModal = function() { $('chat-modal').style.display = 'none'; };

window.sendChatMessage = function() {
  const input = $('chat-input-field');
  const msg = input.value.trim();
  if (!msg) return;

  globalChatChannel.send({
    type: 'broadcast',
    event: 'new_chat_msg',
    payload: { sender: myUsername || '@Guest', message: msg, address: myAddress, timestamp: Date.now() }
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
  $('support-dropdown').classList.toggle('show');
};

window.addEventListener('click', () => {
  const dropdown = $('support-dropdown');
  if (dropdown && dropdown.classList.contains('show')) dropdown.classList.remove('show');
});

function calculatePayout(fee) {
  return Number((fee * 1.6).toFixed(2));
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
        params: [{ to: WLD_TOKEN_CONTRACT, data: '0x70a08231' + paddedAddress }, 'latest'],
        id: 1
      })
    });
    const result = await response.json();
    if (result.result && result.result !== '0x') {
      return Number(BigInt(result.result)) / 1e18;
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
    const cleanWallet = wallet.toLowerCase().trim();
    const realBalance = await fetchRealWldBalance(cleanWallet);
    const { data } = await supabaseClient.from('user_rewards').select('tnv_balance, wld_balance, is_blocked').eq('wallet_address', cleanWallet).maybeSingle();

    if (data && data.is_blocked) { $('blocked-screen').style.display = 'flex'; return; }

    currentTnvBalance = Number(data?.tnv_balance || 0);
    currentWldBalance = realBalance !== null ? realBalance : Number(data?.wld_balance || 0);

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
      wallet_address: wallet.toLowerCase().trim(), 
      action_type: type, 
      amount: amount, 
      description: details, 
      created_at: new Date().toISOString()
    });
  } catch(e) {}
}

async function fetchAdminWithdrawRequests() {
  try {
    const { data } = await supabaseClient.from('withdraw_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    const container = $('admin-req-container');
    if (!container || !data || data.length === 0) {
      if (container) container.innerHTML = `<div style="font-size:11px; color:var(--slate); text-align:center;">No pending requests</div>`;
      return;
    }
    let html = '';
    data.forEach(req => {
      let shortAddr = req.wallet_address.slice(0, 6) + '...' + req.wallet_address.slice(-4);
      html += `
        <div class="admin-req-item">
          <div class="admin-req-row">
            <span style="color:var(--photon); font-family:'JetBrains Mono', monospace;" title="${req.wallet_address}">${shortAddr}</span>
            <span style="color:var(--gold); font-weight:700;">${req.amount} TNV</span>
          </div>
          <div class="admin-req-row"><span>${new Date(req.created_at).toLocaleString()}</span><button class="approve-btn" onclick="openAdminModal('${req.id}', '${req.wallet_address}', ${req.amount})">APPROVE</button></div>
        </div>
      `;
    });
    container.innerHTML = html;
  } catch (e) {}
}

async function fetchAdminCheaters() {
  try {
    const { data } = await supabaseClient.from('cheater_logs').select('*').order('detected_at', { ascending: false }).limit(20);
    const container = $('admin-cheaters-container');
    if (!container || !data || data.length === 0) return;
    let html = '';
    data.forEach(log => {
      html += `<div class="admin-req-item"><div class="admin-req-row"><span style="color:var(--signal);">${log.wallet_address.slice(0,6)}...</span><span>Attempts: ${log.click_count}x</span></div></div>`;
    });
    container.innerHTML = html;
  } catch (e) {}
}

window.openAdminModal = function(reqId, userWallet, amount) {
  activeAdminReqId = reqId;
  $('admin-modal-info').innerText = `Paying ${amount} TNV to ${userWallet}`;
  $('admin-approve-modal').style.display = 'flex';
};
window.closeAdminModal = function() { $('admin-approve-modal').style.display = 'none'; };

window.confirmAdminApproval = async function() {
  let txProof = $('admin-tx-input').value.trim();
  if (!txProof) { alert('Enter Tx Hash'); return; }
  await supabaseClient.rpc('admin_approve_withdrawal', { p_admin_wallet: myAddress, p_req_id: activeAdminReqId, p_tx_hash: txProof });
  alert('Approved successfully!');
  closeAdminModal();
  fetchAdminWithdrawRequests();
};

window.openUserHistoryModal = async function() {
  if (!myAddress) { alert('Sign in first!'); return; }
  $('user-history-modal').style.display = 'flex';
  const container = $('user-history-list');
  const { data } = await supabaseClient.from('match_history').select('*').eq('wallet_address', myAddress).order('created_at', { ascending: false }).limit(20);
  if (!data || data.length === 0) { container.innerHTML = `<div>No history found.</div>`; return; }
  let html = '';
  data.forEach(item => {
    html += `<div style="padding:6px; border-bottom:1px solid rgba(255,255,255,0.05);"><b>${item.action_type}</b>: ${item.amount} WLD (${item.description})</div>`;
  });
  container.innerHTML = html;
};
window.closeUserHistoryModal = function() { $('user-history-modal').style.display = 'none'; };

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
    container.innerHTML = `<div style="color:var(--gold); font-weight:700; margin-bottom:8px;">Total Fees: ${total.toFixed(2)} WLD</div>` + html;
  } catch(e) {}
};

window.closeAdminEarningsModal = function() { $('admin-earnings-modal').style.display = 'none'; };

async function fetchLeaderboard() {
  try {
    const { data } = await supabaseClient.from('user_rewards').select('wallet_address, tnv_balance').order('tnv_balance', { ascending: false }).limit(10);
    const lbContainer = $('lb-container');
    if (!data || data.length === 0) return;
    let html = '';
    data.forEach((row, index) => {
      let shortWallet = row.wallet_address.slice(0, 6) + '...' + row.wallet_address.slice(-4);
      html += `<div class="lb-item"><span class="lb-rank">#${index + 1}</span><span class="lb-user">${shortWallet}</span><span class="lb-score">${row.tnv_balance} TNV</span></div>`;
    });
    lbContainer.innerHTML = html;
  } catch (e) {}
}

window.openWithdrawModal = function() {
  if (currentTnvBalance < 5000) { alert('Min 5,000 TNV required!'); return; }
  $('modal-bal').innerText = currentTnvBalance;
  $('withdraw-amount-input').value = currentTnvBalance;
  $('withdraw-modal').style.display = 'flex';
};
window.closeWithdrawModal = function() { $('withdraw-modal').style.display = 'none'; };

window.submitWithdrawRequest = async function() {
  let withdrawAmt = Number($('withdraw-amount-input').value);
  await supabaseClient.rpc('secure_submit_withdraw_request', { p_wallet: myAddress, p_amount: withdrawAmt });
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

// FIX: Removed strict Time limits (notBefore, expirationTime) that block connection 
// on slight device clock mismatches. Added alerts so errors are never hidden.
async function performWalletAuth(silent = false) {
  if (!checkWorldAppEnvironment()) return false;
  if (!MiniKit.isInstalled()) return false;
  if (myAddress && realWorldIdUser) return true;

  try {
    const result = await MiniKit.walletAuth({
      nonce: randomAlphaNumeric(24),
      statement: 'Sign in to TNV Duel Arena.'
    });

    if (result?.executedWith === 'fallback') {
      if (!silent) alert("Please open this app inside the World App.");
      return false;
    }

    if (result?.status === 'error') {
      if (!silent) alert("Connection Cancelled or Failed: " + JSON.stringify(result));
      return false;
    }

    const data = result?.data;
    if (data?.address && data?.signature) {
      realWorldIdUser = true;
      const username = await resolveUsername(data.address);
      setUserData(username, data.address);
      localStorage.setItem("myAddress", myAddress);
      localStorage.setItem("myUsername", username);
      return true;
    }

    if (!silent) alert("Invalid Auth Response: " + JSON.stringify(result));
    return false;
  } catch (err) {
    if (!silent) alert("Connection Error: " + (err.message || err));
    return false;
  }
}

async function checkActiveMatchBeforePlay(walletAddress) {
  try {
    const { data, error } = await supabaseClient
      .from('matches')
      .select('*')
      .or(`p1_address.eq.${walletAddress},p2_address.eq.${walletAddress}`)
      .in('status', ['waiting', 'playing'])
      .maybeSingle();

    if (data) {
      return true; // Matlab user ka pehle se match chal raha hai ya waiting me hai
    }
  } catch (e) {}
  return false;
}

// FIX: entry fee is now collected on-chain via the TnvDuelArena contract
// (joinMatchOnChain) instead of MiniKit.commandsAsync.pay() to a hot
// wallet. Order changed: we now get the Supabase matchId FIRST (from
// join_or_create_match), THEN pay on-chain using that same matchId —
// both players must derive the identical bytes32 matchId, which requires
// the Supabase row to already exist.
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
    alert("Insufficient balance!");
    $('start-btn').disabled = false;
    return;
  }

  matchmakingActive = true;
  $('waiting-overlay').style.display = 'flex';
  $('wait-status').innerText = `Finding a match slot...`;

  // Step 1: get/create the Supabase match row FIRST — this is where the
  // shared matchId (used for both the DB row and the on-chain match) comes
  // from.
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

  // Step 2: pay the entry fee on-chain, using the matchId from step 1.
  $('wait-status').innerText = `Confirm payment in World App...`;

  let paymentSuccessful = false;
  try {
    const opponentAddr = isP1 ? ZERO_ADDRESS : matchRow.p1_address;
    await joinMatchOnChain(matchId, selectedFee, opponentAddr);
    paymentSuccessful = true;
  } catch (err) {
    console.error('On-chain payment failed:', err);
    paymentSuccessful = false;
  }

  if (!paymentSuccessful) {
    alert('Payment was cancelled or failed.');
    // Undo the Supabase-side join/create since payment never went through.
    try { await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: matchId, p_wallet: myAddress }); } catch(e) {}
    resetToHome();
    return;
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
  if (matchId) {
    try {
      await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: matchId, p_wallet: myAddress });
      if (showAlert) alert('Search cancelled.');
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

  stopBackgroundMusic();

  if (isP1) {
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
  
  const { data: rpcRes } = await supabaseClient.rpc('secure_roll_dice', {
    p_match_id: matchId, p_wallet: myAddress, p_roll: roll
  });

  if (rpcRes && rpcRes.taps_left !== undefined) {
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
    const { data: completeResult } = await supabaseClient.rpc('secure_complete_match', { p_match_id: matchId, p_wallet: myAddress });
    if (completeResult && completeResult.match) finalRow = completeResult.match;
  }

  const myFinal = isP1 ? finalRow.p1_score : finalRow.p2_score;
  const opFinal = isP1 ? finalRow.p2_score : finalRow.p1_score;
  const isWin = myFinal > opFinal;

  const exactChipEarn = calculatePayout(matchFee); 

  if (myAddress && !sessionStorage.getItem(`settled_${matchId}_${myAddress}`)) {
      sessionStorage.setItem(`settled_${matchId}_${myAddress}`, "true");
      try {
if (isWin) {
              await logMatchHistory(myAddress, 'VICTORY', exactChipEarn, `Won match (${matchFee} WLD duel)`);
              
              // Background mein fetch call karein taaki screen freeze na ho
              // — this now calls /api/settle-match, which uses the
              // limited-privilege operator key to release the on-chain
              // pot via the contract's settleMatch().
              fetch('/api/settle-match', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      matchId: matchId,
                      winnerAddress: myAddress,
                      loserAddress: isP1 ? finalRow.p2_address : finalRow.p1_address,
                      fee: matchFee
                  })
              }).catch(err => console.error("Background payout error:", err));

          } else {
              await logMatchHistory(myAddress, 'DEFEAT', -matchFee, `Lost match (${matchFee} WLD duel)`);
          }
      } catch(e){
          console.error("Payout trigger error:", e);
      }
  }

  let winTnv = getTnvRewardForFee(matchFee);
  let earnedTnv = isWin ? winTnv : Math.floor(winTnv / 3);

  if (myAddress && !sessionStorage.getItem(`tnv_settled_${matchId}_${myAddress}`)) {
      sessionStorage.setItem(`tnv_settled_${matchId}_${myAddress}`, "true");
  }
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
}

document.querySelectorAll('.fee-chip').forEach(chip => {
  chip.addEventListener('click', () => selectFee(chip.dataset.fee, chip));
});
$('start-btn').addEventListener('click', handlePlayButtonClick);
$('dice-scene').addEventListener('click', rollDice);