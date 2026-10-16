// ============================================================
// modal-fallback.js — IMMEDIATE modal helpers (no CDN dependency)
// Loaded BEFORE app.js as a regular (non-module) script.
// Provides fallback open/close functions so onclick handlers
// always work even if the module imports fail or are slow.
// app.js will override these with full versions after loading.
// ============================================================

(function() {
  // Make $ globally available for all functions (module fallback)
  if (typeof window.$ === 'undefined') {
    window.$ = function(id) { return document.getElementById(id); };
  }

  // ---- Storage that can never throw ------------------------------------
  // The Content-Security-Policy on this app has no 'unsafe-inline', so the
  // inline onclick handlers are executed by the binder at the bottom of this
  // file rather than by the browser. Storage is a second single point of
  // failure: in a locked-down WebView (private mode, partitioned storage,
  // blocked third-party storage) merely READING window.localStorage throws a
  // SecurityError. An unguarded call at the top of boot aborted the whole
  // init sequence AND left the consent modal impossible to dismiss — the
  // player was permanently locked out. Every access now goes through this
  // never-throwing shim, which falls back to an in-memory map.
  var _mem = {};
  window.safeStorage = {
    getItem: function(k) {
      try { return localStorage.getItem(k); }
      catch (e) { return Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null; }
    },
    setItem: function(k, v) {
      try { localStorage.setItem(k, v); }
      catch (e) { _mem[k] = String(v); }
    },
    removeItem: function(k) {
      try { localStorage.removeItem(k); }
      catch (e) { delete _mem[k]; }
    }
  };

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
  // Dismiss the consent modal FIRST: consent is a UI gate, not a stored
  // preference, so a storage failure must never trap the user on it.
  window.acceptConsent = function() {
    _modal('consent-modal', 0);
    window.safeStorage.setItem('tnv_consent', '1');
  };
  window.showNeonToast = function(msg, type) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 20px;border-radius:10px;font-size:12px;font-family:Inter,-apple-system,sans-serif;color:#fff;background:' + (type === 'error' ? '#e85d5d' : type === 'warning' ? '#f0b232' : '#29d9c2') + ';transition:opacity 0.3s;text-align:center;max-width:90%;';
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

  // ---- Inline-handler binder -------------------------------------------
  // The app's CSP (script-src without 'unsafe-inline') means the browser
  // REFUSES to compile every `onclick="..."` attribute: the attribute stays
  // in the DOM but no handler is ever attached. This function is what
  // actually makes them work, by re-executing the attribute through
  // new Function() (allowed by 'unsafe-eval').
  //
  // It has to keep working for elements added AFTER load too — app.js injects
  // admin rows, copy buttons and the withdrawal approve button via innerHTML,
  // and app.js ALSO runs a MutationObserver that strips `on*` attributes from
  // added nodes. Binding must therefore happen before that observer strips
  // them, so this observer (registered first) handles each added subtree.
  function bindOne(el) {
    if (!el || el.__inlineBound) return;
    var src = el.getAttribute && el.getAttribute('onclick');
    if (!src) return;
    // If the browser DID compile the inline handler (CSP absent, e.g. a host
    // that serves the page without this meta policy) skip the shim entirely,
    // otherwise the click would run twice.
    if (typeof el.onclick === 'function') { el.__inlineBound = true; return; }
    el.__inlineBound = true;
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      // Re-read at click time: the attribute may have been replaced.
      var onclickStr = el.getAttribute('onclick') || src;
      try {
        new Function(onclickStr)();
      } catch (err) {
        // Fallback: extract all function names and call them
        var matches = onclickStr.match(/(\w+)\s*\(/g);
        if (matches) {
          matches.forEach(function(m) {
            var fnName = m.replace(/\s*\(\s*$/, '').trim();
            if (typeof window[fnName] === 'function') {
              window[fnName]();
            }
          });
        }
      }
    });
  }

  function bindTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.hasAttribute && root.hasAttribute('onclick')) bindOne(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('[onclick]').forEach(bindOne);
    }
  }

  function bindAllButtons() {
    document.querySelectorAll('[onclick]').forEach(bindOne);
    // Also make clicking the modal backdrop (outside .modal-card) close it
    document.querySelectorAll('.custom-modal').forEach(function(modal) {
      modal.addEventListener('click', function(e) {
        // Only close if clicking the backdrop itself, not a child
        if (e.target === modal) {
          modal.style.display = 'none';
        }
      });
    });
  }

  // Cover anything injected later (admin panels, chat, refund rows).
  // Registered HERE, at parse time, on purpose: app.js runs a MutationObserver
  // that deletes `on*` attributes from added nodes, and observers fire in
  // registration order. app.js evaluates its module before DOMContentLoaded,
  // so binding from inside bindAllButtons above would always lose the race and
  // leave every dynamically added button dead. Registering now means we read
  // the attribute first and attach a real listener; app.js stripping it
  // afterwards is then harmless.
  try {
    new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          bindTree(added[j]);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* non-fatal */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllButtons);
  } else {
    bindAllButtons();
  }

  // ---- Boot watchdog ---------------------------------------------------
  // app.js pulls @worldcoin/minikit-js and @supabase/supabase-js as top-level
  // ES imports. If either CDN request fails (offline, blocked, flaky network)
  // the entire module fails to evaluate, no app code runs at all, and the
  // user is left staring at a static, dead first screen with no explanation.
  // app.js sets window.__appBooted as soon as its imports resolve; if that
  // never happens, show a retry panel instead of silence.
  function showBootError() {
    if (window.__appBooted || document.getElementById('boot-error')) return;
    var el = document.createElement('div');
    el.id = 'boot-error';
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;inset:0;z-index:999998;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center;background:#070d0c;color:#e8f6f3;font-family:Inter,-apple-system,sans-serif;';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:700;';
    title.textContent = 'Could not load game resources';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:#8fb0aa;max-width:280px;line-height:1.6;';
    sub.textContent = 'Check your internet connection, then try again.';
    var btn = document.createElement('button');
    btn.id = 'boot-retry';
    btn.type = 'button';
    btn.textContent = 'RETRY';
    btn.style.cssText = 'background:#29d9c2;color:#04211d;border:none;padding:12px 22px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;';
    btn.addEventListener('click', function() { location.reload(); });
    el.appendChild(title);
    el.appendChild(sub);
    el.appendChild(btn);
    document.body.appendChild(el);
  }
  var BOOT_DEADLINE_MS = 12000;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(showBootError, BOOT_DEADLINE_MS); });
  } else {
    setTimeout(showBootError, BOOT_DEADLINE_MS);
  }
})();
