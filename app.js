import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@latest/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { encodeFunctionData, keccak256, toHex } from "https://cdn.jsdelivr.net/npm/viem@2/+esm";

const SB_URL = "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY = "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";
const WORLD_APP_ID = "app_74bd2499a35b025efb62d99125df7883";

// Admin Panel Access Wallet (Ye wallet sirf admin dashboard aur ledger kholenay ke liye hai)
const ADMIN_WALLET = "0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1"; 

// Fee Receive Wallet (Sirf dashboard display aur revenue record ke liye)
const PAYMENT_RECV_WALLET = "0x8FB70CDFb545C7D9b842cBE37B9aba84059Bf14b";

const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
const WORLDCHAIN_RPC = "https://worldchain-mainnet.g.alchemy.com/public";

// ---- On-chain Escrow Payment Contract ----
const CONTRACT_ADDRESS = "0x529225162b86489fcbD6320b88C4BAEAAE586a67";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Tumhari di hui exact ABI for joinMatch
const JOIN_MATCH_ABI = [
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "matchId",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "expectedOpponent",
        "type": "address"
      }
    ],
    "name": "joinMatch",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
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

// Supabase matchId ko bytes32 format me convert krna contract ke liye
function matchIdToBytes32(supabaseMatchId) {
  return keccak256(toHex(supabaseMatchId));
}

// Convert WLD amount to Wei
function wldToWei(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
}

// Escrow Contract me WLD deposit krne ka fixed function
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

// STRICT BROWSER RESTRICTION
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
  try { 
    MiniKit.install(WORLD_APP_ID); 
  } catch(e) {}

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
  const container = $('chat-messages-container');
  container.scrollTop = container.scrollHeight;
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

window.toggleSupportDropdown = function(event) {
  event.stopPropagation();
  $('support-dropdown').classList.toggle('show');
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
        params: [{ to: WLD_TOKEN_CONTRACT, data: '0x70a08231' + paddedAddress }, 'latest'],
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
      .select('tnv_balance, is_blocked') // wld_balance removed
      .eq('wallet_address', cleanWallet)
      .maybeSingle();

    if (!error && data && data.is_blocked) { $('blocked-screen').style.display = 'flex'; return; }

    currentTnvBalance = Number(data?.tnv_balance || 0);

    // RPC balance used explicitly
    if (realBalance !== null) {
      currentWldBalance = realBalance;
    } else {
      currentWldBalance = 0;
    }

    if (!data) {
      await supabaseClient.rpc('secure_ensure_user_row', { p_wallet: cleanWallet });
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
            <span style="color:var(--gold); font-weight:700;">${req.amount} TNV</span>
          </div>
          <div class="admin-req-row"><span style="font-size:10px; color:var(--slate);">${new Date(req.created_at).toLocaleString()}</span><button class="approve-btn" onclick="openAdminModal('${req.id}', '${req.wallet_address}', ${req.amount})">APPROVE</button></div>
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
  if (confirm(`⚠️ Block user: ${walletToBlock}?`)) {
    const { data: result } = await supabaseClient.rpc('secure_admin_block_user', {
      p_admin_wallet: myAddress, p_target_wallet: walletToBlock
    });
    if (result && result.success) {
      alert('User blocked.');
      fetchAdminCheaters();
    }
  }
};

window.openAdminModal = function(reqId, userWallet, amount) {
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;
  activeAdminReqId = reqId;
  $('admin-modal-info').innerText = `Paying ${amount} TNV to ${userWallet.slice(0,6)}...`;
  $('admin-tx-input').value = "";
  $('admin-approve-modal').style.display = 'flex';
};

window.closeAdminModal = function() { $('admin-approve-modal').style.display = 'none'; };

window.confirmAdminApproval = async function() {
  if (!myAddress || myAddress.toLowerCase() !== ADMIN_WALLET.toLowerCase()) return;
  let txProof = $('admin-tx-input').value.trim();
  if (!txProof) { alert('Enter Tx Hash'); return; }

  const { error } = await supabaseClient.rpc('admin_approve_withdrawal', {
    p_admin_wallet: myAddress,
    p_req_id: activeAdminReqId,
    p_tx_hash: txProof
  });

  if (error) { alert('Approval failed: ' + error.message); return; }
  alert('Approved successfully!');
  closeAdminModal();
  fetchAdminWithdrawRequests();
};

window.openUserHistoryModal = async function() {
  if (!myAddress) { alert('Please sign in first!'); return; }
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
  if (!myAddress) { alert('Please sign in first!'); return; }
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

  const { data: result, error } = await supabaseClient.rpc('secure_submit_withdraw_request', {
    p_wallet: myAddress, p_amount: withdrawAmt
  });

  if (error || !result || !result.success) { alert('Withdrawal request failed: ' + (result?.error || error?.message || 'unknown error')); return; }
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

function showAuthBanner(msg){
  const el = $('auth-banner');
  if (!el) return;
  el.textContent = '⚠️ ' + msg;
  el.style.display = 'block';
}

// FIX: Time sync issue removed for flawless wallet connection
async function performWalletAuth(silent = false) {
  if (!checkWorldAppEnvironment()) return false;
  if (!MiniKit.isInstalled()) return false;
  if (myAddress && realWorldIdUser) return true;

  try {
    // Pehle check karte hain agar MiniKit mein user pehle se logged-in hai
    if (MiniKit.user && MiniKit.user.walletAddress) {
      realWorldIdUser = true;
      const addr = MiniKit.user.walletAddress;
      const username = MiniKit.user.username ? '@' + MiniKit.user.username : '@W_' + addr.substring(2, 8);
      setUserData(username, addr);
      localStorage.setItem("myAddress", myAddress);
      localStorage.setItem("myUsername", username);
      return true;
    }

    // Agar logged-in nahi hai, toh walletAuth prompt trigger karo
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
    alert(`Insufficient WLD balance. You have ${currentWldBalance.toFixed(2)} WLD, need ${selectedFee} WLD.`);
    $('start-btn').disabled = false;
    return;
  }

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
    let existingWarning = document.getElementById('neon-payment-warning');
    if (!existingWarning) {
      existingWarning = document.createElement('div');
      existingWarning.id = 'neon-payment-warning';
      existingWarning.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:99999; background:rgba(15,5,10,0.95); border:2px solid #ff3366; color:#ff3366; padding:14px 20px; border-radius:12px; font-family:"Space Grotesk", sans-serif; font-size:13px; font-weight:700; text-align:center; box-shadow:0 0 20px rgba(255,51,102,0.6); backdrop-filter:blur(8px); transition:opacity 0.3s ease;';
      document.body.appendChild(existingWarning);
    }
    existingWarning.innerHTML = '⚠️ Payment was cancelled or failed.';
    existingWarning.style.opacity = '1';
    setTimeout(() => {
      existingWarning.style.opacity = '0';
      setTimeout(() => { existingWarning.remove(); }, 300);
    }, 4000);

    try { await supabaseClient.rpc('secure_leave_waiting_match', { p_match_id: matchId, p_wallet: myAddress }); } catch(e) {}
    resetToHome();
    return;
  }

  let existingSuccess = document.getElementById('neon-payment-success');
  if (!existingSuccess) {
    existingSuccess = document.createElement('div');
    existingSuccess.id = 'neon-payment-success';
    existingSuccess.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:99999; background:rgba(5,15,10,0.95); border:2px solid #29d9c2; color:#29d9c2; padding:14px 20px; border-radius:12px; font-family:"Space Grotesk", sans-serif; font-size:13px; font-weight:700; text-align:center; box-shadow:0 0 20px rgba(41,217,194,0.6); backdrop-filter:blur(8px); transition:opacity 0.3s ease;';
    document.body.appendChild(existingSuccess);
  }
  existingSuccess.innerHTML = '✨ Payment sent to Escrow! Confirming...';
  existingSuccess.style.opacity = '1';
  setTimeout(() => {
    existingSuccess.style.opacity = '0';
    setTimeout(() => { existingSuccess.remove(); }, 300);
  }, 3000);

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
      await supabaseClient.rpc('secure_leave_waiting_match', {
        p_match_id: matchId, p_wallet: myAddress
      });
      if (showAlert) {
        alert(`Search cancelled. Your ${selectedFee} WLD is still locked on-chain — it's automatically reclaimable after the match timeout if no opponent joined, or once the match resolves.`);
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

  const exactChipEarn = calculatePayout(matchFee); 
  const totalPool = Number((matchFee * 2).toFixed(2)); 
  const adminFeeAmount = Number(Math.max(0, totalPool - exactChipEarn).toFixed(2)); 

  // Backend Settlement Trigger
  if (myAddress && !sessionStorage.getItem(`settled_${matchId}_${myAddress}`)) {
      sessionStorage.setItem(`settled_${matchId}_${myAddress}`, "true");
      try {
          if (isWin) {
              await logMatchHistory(myAddress, 'VICTORY', exactChipEarn, `Won match (${matchFee} WLD duel)`);
              
              // Backend settleMatch endpoint ko call karte hain jo contract me winner release karega
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
}

document.querySelectorAll('.fee-chip').forEach(chip => {
  chip.addEventListener('click', () => selectFee(chip.dataset.fee, chip));
});
$('start-btn').addEventListener('click', handlePlayButtonClick);
$('dice-scene').addEventListener('click', rollDice);