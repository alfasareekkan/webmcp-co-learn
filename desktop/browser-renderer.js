/**
 * browser-renderer.js
 * Handles the browser toolbar UI: tabs, URL bar, navigation buttons,
 * extension status indicator, and keyboard shortcuts.
 *
 * Communicates with main process exclusively through window.browserAPI
 * (defined in browser-preload.js).
 */
'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const tabList     = document.getElementById('tabList');
const newTabBtn   = document.getElementById('newTabBtn');
const backBtn     = document.getElementById('backBtn');
const fwdBtn      = document.getElementById('fwdBtn');
const reloadBtn   = document.getElementById('reloadBtn');
const urlInput    = document.getElementById('urlInput');
const urlLock     = document.getElementById('urlLock');
const extBtn      = document.getElementById('extBtn');
const devBtn      = document.getElementById('devBtn');
const extStatus   = document.getElementById('extStatus');
const extBanner   = document.getElementById('extBanner');
const extBannerText = document.getElementById('extBannerText');
const extBannerDismiss = document.getElementById('extBannerDismiss');

// ── Local state ───────────────────────────────────────────────────────────────
let currentState = { tabs: [], activeIdx: -1, canGoBack: false, canGoForward: false, currentUrl: '' };
let urlFocused   = false; // Don't overwrite the URL bar while user is typing

// ── State updates from main process ──────────────────────────────────────────

window.browserAPI.onState((state) => {
  currentState = state;
  renderTabs(state.tabs);
  updateNavButtons(state.canGoBack, state.canGoForward, state);
  if (!urlFocused) updateUrlBar(state.currentUrl);
});

window.browserAPI.onExtStatus(({ connected, timedOut }) => {
  if (connected) {
    extStatus.className = 'ext-status connected';
    extStatus.title = 'Extension: connected to server ✓';
    extBanner.classList.remove('visible', 'warning');
  } else if (timedOut) {
    extStatus.className = 'ext-status disconnected';
    extStatus.title = 'Extension: did not connect (30s timeout)';
    extBannerText.textContent = 'Extension did not connect to server. Is the server running?';
    extBanner.classList.add('visible', 'warning');
  }
});

// Show the banner immediately (connecting state).
extBanner.classList.add('visible');

// ── Tab rendering ─────────────────────────────────────────────────────────────

function renderTabs(tabs) {
  // Build HTML for all tabs.
  tabList.innerHTML = tabs.map((tab, idx) => {
    const isActive  = tab.active;
    const title     = escHtml(tab.title || 'New Tab');
    const faviconEl = tab.loading
      ? `<span class="tab-spinner"></span>`
      : tab.favicon
        ? `<img class="tab-favicon" src="${escHtml(tab.favicon)}" alt="" onerror="this.style.display='none'" />`
        : `<span class="tab-favicon-placeholder">&#127760;</span>`;

    return `
      <div class="tab-item${isActive ? ' active' : ''}" data-idx="${idx}" role="tab">
        ${faviconEl}
        <span class="tab-title" title="${title}">${title}</span>
        <button class="tab-close" data-close="${idx}" title="Close tab" tabindex="-1">&#215;</button>
      </div>`;
  }).join('');
}

// Tab click delegation.
tabList.addEventListener('click', (e) => {
  // Close button
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) {
    e.stopPropagation();
    window.browserAPI.closeTab(parseInt(closeBtn.dataset.close, 10));
    return;
  }
  // Tab item
  const tabItem = e.target.closest('.tab-item[data-idx]');
  if (tabItem) {
    window.browserAPI.switchTab(parseInt(tabItem.dataset.idx, 10));
  }
});

// ── URL bar ───────────────────────────────────────────────────────────────────

function updateUrlBar(url) {
  urlInput.value = url || '';
  // Show lock/warning icon based on protocol.
  if (!url) {
    urlLock.className = 'url-lock hidden';
  } else if (url.startsWith('https://')) {
    urlLock.className = 'url-lock secure';
    urlLock.textContent = '\uD83D\uDD12'; // 🔒
    urlLock.title = 'Secure connection (HTTPS)';
  } else if (url.startsWith('http://')) {
    urlLock.className = 'url-lock insecure';
    urlLock.textContent = '\u26A0\uFE0F'; // ⚠️
    urlLock.title = 'Not secure (HTTP)';
  } else {
    urlLock.className = 'url-lock hidden';
  }
}

urlInput.addEventListener('focus', () => {
  urlFocused = true;
  // Select all on focus (like a real browser address bar).
  urlInput.select();
});

urlInput.addEventListener('blur', () => {
  urlFocused = false;
  // Restore the actual URL if user didn't submit.
  updateUrlBar(currentState.currentUrl);
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = urlInput.value.trim();
    if (val) {
      urlInput.blur();
      window.browserAPI.navigate(val);
    }
  } else if (e.key === 'Escape') {
    urlInput.blur();
  }
});

// ── Navigation buttons ────────────────────────────────────────────────────────

function updateNavButtons(canGoBack, canGoForward, state) {
  backBtn.disabled   = !canGoBack;
  fwdBtn.disabled    = !canGoForward;

  // Toggle reload ↺ / stop ✕ based on whether any tab is loading.
  const active = state.tabs.find(t => t.active);
  if (active?.loading) {
    reloadBtn.innerHTML = '&#215;'; // ×
    reloadBtn.title = 'Stop loading (Escape)';
    reloadBtn.onclick = () => window.browserAPI.stop();
  } else {
    reloadBtn.innerHTML = '&#8635;'; // ↻
    reloadBtn.title = 'Reload (Ctrl+R)';
    reloadBtn.onclick = () => window.browserAPI.reload();
  }
}

backBtn.addEventListener('click', () => window.browserAPI.back());
fwdBtn.addEventListener('click',  () => window.browserAPI.forward());

// ── New tab / devtools / ext popup ────────────────────────────────────────────

newTabBtn.addEventListener('click', () => window.browserAPI.newTab());
extBtn.addEventListener('click',    () => window.browserAPI.openExtPopup());
devBtn.addEventListener('click',    () => window.browserAPI.openDevTools());
extBannerDismiss.addEventListener('click', () => extBanner.classList.remove('visible', 'warning'));

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key === 't') {
    e.preventDefault();
    window.browserAPI.newTab();
  } else if (mod && e.key === 'w') {
    e.preventDefault();
    window.browserAPI.closeTab(currentState.activeIdx);
  } else if (mod && e.key === 'r') {
    e.preventDefault();
    window.browserAPI.reload();
  } else if (mod && e.key === 'l') {
    e.preventDefault();
    urlInput.focus();
    urlInput.select();
  } else if (mod && e.key === 'd') {
    // Ctrl/Cmd+D → DevTools for current tab
    e.preventDefault();
    window.browserAPI.openDevTools();
  } else if (e.altKey && e.key === 'ArrowLeft') {
    window.browserAPI.back();
  } else if (e.altKey && e.key === 'ArrowRight') {
    window.browserAPI.forward();
  } else if (mod && e.key >= '1' && e.key <= '9') {
    // Ctrl+1–9 → switch to tab N
    const idx = parseInt(e.key, 10) - 1;
    if (idx < currentState.tabs.length) window.browserAPI.switchTab(idx);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
