// ============================================================
// modal-fallback.js — IMMEDIATE modal helpers (no CDN dependency)
// Loaded BEFORE app.js as a regular (non-module) script.
// Provides fallback open/close functions so onclick handlers
// always work even if the module imports fail or are slow.
// app.js will override these with full versions after loading.
// ============================================================

(function() {
  function _modal(id, show) {
    var m = document.getElementById(id);
    if (m) m.style.display = show ? 'flex' : 'none';
  }

  window.openChatModal = function() { _modal('chat-modal', 1); };
  window.closeChatModal = function() { _modal('chat-modal', 0); };
  window.openSupportModal = function() { _modal('support-modal', 1); };
  window.closeSupportModal = function() { _modal('support-modal', 0); };
  window.openTnvWinningsModal = function() { _modal('tnv-winnings-modal', 1); };
  window.closeTnvWinningsModal = function() { _modal('tnv-winnings-modal', 0); };
  window.openAirdropsModal = function() { _modal('airdrops-modal', 1); };
  window.closeAirdropsModal = function() { _modal('airdrops-modal', 0); };
  window.openUserHistoryModal = function() { _modal('user-history-modal', 1); };
  window.closeUserHistoryModal = function() { _modal('user-history-modal', 0); };
  window.openUserWithdrawalsModal = function() { _modal('user-withdrawals-modal', 1); };
  window.closeUserWithdrawalsModal = function() { _modal('user-withdrawals-modal', 0); };
  window.openAdminEarningsModal = function() { _modal('admin-earnings-modal', 1); };
  window.closeAdminEarningsModal = function() { _modal('admin-earnings-modal', 0); };
  window.openWithdrawModal = function() { _modal('withdraw-modal', 1); };
  window.closeWithdrawModal = function() { _modal('withdraw-modal', 0); };
  window.openSupportBot = function() { _modal('support-bot-modal', 1); };
  window.closeSupportBot = function() { _modal('support-bot-modal', 0); };
  window.openAdminModal = function() { _modal('admin-approve-modal', 1); };
  window.closeAdminModal = function() { _modal('admin-approve-modal', 0); };
  window.openAiAgentModal = function() { _modal('ai-agent-modal', 1); };
  window.closeAiAgentModal = function() { _modal('ai-agent-modal', 0); };
  window.acceptConsent = function() { localStorage.setItem('tnv_consent', '1'); _modal('consent-modal', 0); };
  window.showNeonToast = function(msg, type) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 20px;border-radius:12px;font-size:12px;font-family:Space Grotesk,sans-serif;color:#fff;background:' + (type === 'error' ? 'rgba(255,50,50,0.9)' : type === 'info' ? 'rgba(108,92,231,0.9)' : 'rgba(41,217,194,0.9)') + ';box-shadow:0 4px 20px rgba(0,0,0,0.4);transition:opacity 0.3s;text-align:center;max-width:90%;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.style.opacity = '0'; setTimeout(function() { t.remove(); }, 300); }, 3000);
  };
  window.switchTab = function(tabName) {
    var tabBar = document.getElementById('tab-bar');
    if (!tabBar) return;
    var btn = tabBar.querySelector('[data-tab="' + tabName + '"]');
    if (btn) btn.click();
  };

  // Backup: attach addEventListener to every more-tile button so clicks
  // work even if inline onclick is somehow stripped or blocked.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindMoreTiles);
  } else {
    bindMoreTiles();
  }
  function bindMoreTiles() {
    var tiles = document.querySelectorAll('.more-tile[onclick]');
    tiles.forEach(function(tile) {
      tile.addEventListener('click', function(e) {
        var onclickStr = tile.getAttribute('onclick');
        if (!onclickStr) return;
        // Extract function name: 'openUserHistoryModal()' -> 'openUserHistoryModal'
        var fnName = onclickStr.replace(/\(\).*$/, '').trim();
        if (typeof window[fnName] === 'function') {
          window[fnName]();
        }
      });
    });
  }
})();
