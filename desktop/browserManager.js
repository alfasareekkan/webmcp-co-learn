/**
 * browserManager.js — Inline browser embedded in the main window.
 *
 * Architecture:
 *   BrowserWindow (index.html — default session)
 *     └── WebContentsView  (web content — persist:colearn-browser session)
 *
 * The left panel chat UI is rendered in the BrowserWindow's own renderer.
 * The WebContentsView is layered on top of it, starting at (splitX, TOOLBAR_H).
 * The browser toolbar (tabs + URL bar) is part of index.html.
 *
 * KNOWN LIMITATIONS
 * ─────────────────
 * • chrome.debugger NOT supported via session.loadExtension() — CDP features
 *   in the extension will silently fail. Workaround: proxy CDP through
 *   webContents.debugger in the main process and relay over WebSocket.
 * • chrome.identity not available — web-based Google OAuth works fine.
 * • Extension action/popup button requires electron-chrome-extensions for
 *   native rendering; we open popup.html manually instead.
 * • Each tab consumes ~50–150 MB RAM.
 * • Chromium version is tied to the Electron release (no auto-updates).
 */

'use strict';

const { BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
const path = require('path');
const http = require('http');

// ── CDP extraction scripts (run via webContents.executeJavaScript) ─────────────

const EXTRACT_DOM_EXPR = `JSON.stringify((function() {
  return {
    title: document.title,
    url: location.href,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,15)
      .map(h => ({ level: h.tagName, text: (h.innerText||'').slice(0,200) })),
    buttons: Array.from(document.querySelectorAll('button,[role="button"]')).slice(0,20)
      .map(b => ({ text: (b.innerText||b.value||'').slice(0,100) })),
    links: Array.from(document.querySelectorAll('a[href]')).slice(0,20)
      .map(a => ({ text: (a.innerText||'').slice(0,100), href: a.href })),
    inputs: Array.from(document.querySelectorAll('input,textarea,select')).slice(0,10)
      .map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, value: (i.value||'').slice(0,100) })),
    selection: (window.getSelection()||{}).toString?.().slice(0,500)||null,
    bodyText: (document.body?.innerText||'').slice(0,2000),
  };
})())`;

const EXTRACT_ELEMENTS_EXPR = `(function() {
  const SEL = ['button','[role="button"]','a[href]','input','textarea','select',
    '[role="link"]','[role="tab"]','[role="menuitem"]','h1','h2','h3',
    '[data-testid]','[aria-label]','[contenteditable]'];
  const seen = new Set(); const results = [];
  for (const sel of SEL) {
    try {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || results.length >= 80) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top > window.innerHeight + 200) continue;
        results.push({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText||el.value||el.getAttribute('aria-label')||el.title||'').slice(0,100).trim(),
          id: el.id||null, role: el.getAttribute('role')||null, href: el.href||null,
          bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        });
      }
    } catch {}
  }
  return JSON.stringify(results);
})()`;

// ── Overlay injection for Electron ────────────────────────────────────────────
// Extension content scripts loaded via session.loadExtension() are unreliable
// in Electron. This helper reads overlay.js and injects it directly into the
// page via executeJavaScript, ensuring the __colearn_guidance__ event listener
// is always registered.

const fs = require('fs');
let _overlayScriptCache = null;

function getOverlayScript() {
  if (_overlayScriptCache) return _overlayScriptCache;
  try {
    const overlayPath = path.resolve(__dirname, '../Co-extension/overlay.js');
    _overlayScriptCache = fs.readFileSync(overlayPath, 'utf8');
  } catch (err) {
    console.error('[Browser] Failed to read overlay.js:', err.message);
    _overlayScriptCache = '';
  }
  return _overlayScriptCache;
}

async function injectOverlayScript(wc) {
  if (!wc || wc.isDestroyed()) return;
  const script = getOverlayScript();
  if (!script) return;
  // The overlay.js IIFE has its own double-injection guard
  // (__colearn_overlay_injected__), so re-injection is safe.
  await wc.executeJavaScript(script);
  console.log('[Browser] Overlay script injected into page');
}

// ── Config ────────────────────────────────────────────────────────────────────

const EXT_PATH   = path.resolve(__dirname, '../Co-extension');
const EXT_SES    = 'persist:colearn-browser';
const HEALTH_URL = 'https://webmcp-co-learn-production.up.railway.app/api/health';
const POLL_MS    = 800;
const POLL_MAX   = 30_000;

/**
 * Height of the browser toolbar (tab-bar + nav-bar) rendered in index.html.
 * The WebContentsView's y origin is offset by this amount.
 * Must match the CSS .btoolbar height in styles.css.
 */
const TOOLBAR_H = 80;

/** Default x coordinate where the WebContentsView starts (leftPanelWidth + dividerWidth). */
const DEFAULT_SPLIT_X = 344; // 340px left panel + 4px divider

// ── State ─────────────────────────────────────────────────────────────────────

let mainWin   = null;
let tabs      = [];     // [{ id, view, url, title, favicon, loading }]
let activeIdx = -1;
let splitX    = DEFAULT_SPLIT_X;
let extId     = null;
let pollTimer = null;
let ipcReady  = false;

// ── CDP state ────────────────────────────────────────────────────────────────
const cdpAttached = new WeakSet(); // tracks which webContents have debugger attached

// ── Extension loading ─────────────────────────────────────────────────────────

/**
 * initExtension()
 * Loads the Co-extension into the persistent session.
 * Call once in app.whenReady() BEFORE any windows are created.
 */
async function initExtension() {
  const ses = session.fromPartition(EXT_SES);

  ses.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock'].includes(perm));
  });

  try {
    const ext = await ses.loadExtension(EXT_PATH, { allowFileAccess: true });
    extId = ext.id;
    console.log(`[Browser] Extension loaded: "${ext.name}" id=${ext.id}`);
  } catch (err) {
    console.error('[Browser] Extension load failed:', err.message);
    console.error('  Path:', EXT_PATH);
  }
}

// ── CDP helpers (webContents.debugger) ────────────────────────────────────────

function cdpAttach(wc) {
  if (!wc || wc.isDestroyed() || cdpAttached.has(wc)) return;
  try {
    wc.debugger.attach('1.3');
    cdpAttached.add(wc);
    wc.debugger.sendCommand('Page.enable').catch(() => {});
    wc.debugger.sendCommand('Runtime.enable').catch(() => {});
    wc.debugger.sendCommand('Performance.enable').catch(() => {});
    wc.debugger.on('detach', () => cdpAttached.delete(wc));
    console.log('[Desktop] CDP attached');
  } catch (err) {
    console.warn('[Desktop] CDP attach failed:', err.message);
  }
}

function cdpDetach(wc) {
  if (!wc || wc.isDestroyed() || !cdpAttached.has(wc)) return;
  try { wc.debugger.detach(); } catch {}
  cdpAttached.delete(wc);
}

async function gatherContext() {
  const tab = tabs[activeIdx];
  if (!tab) throw new Error('No active tab');
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) throw new Error('WebContents destroyed');

  if (!cdpAttached.has(wc)) cdpAttach(wc);

  const url   = wc.getURL();
  const title = wc.getTitle();

  const [screenshotResult, domRaw, elementsRaw, viewportRaw, perfResult] = await Promise.allSettled([
    wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 80 }),
    wc.executeJavaScript(EXTRACT_DOM_EXPR),
    wc.executeJavaScript(EXTRACT_ELEMENTS_EXPR),
    wc.executeJavaScript('JSON.stringify({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio})'),
    wc.debugger.sendCommand('Performance.getMetrics'),
  ]);

  const screenshot = screenshotResult.status === 'fulfilled'
    ? `data:image/jpeg;base64,${screenshotResult.value.data}` : null;

  let dom = { title, url, headings: [], links: [], buttons: [], inputs: [], bodyText: '' };
  try { if (domRaw.status === 'fulfilled') dom = JSON.parse(domRaw.value); } catch {}

  let elements = [];
  try { if (elementsRaw.status === 'fulfilled') elements = JSON.parse(elementsRaw.value); } catch {}

  let viewport = { width: 1280, height: 800, dpr: 1 };
  try { if (viewportRaw.status === 'fulfilled') viewport = JSON.parse(viewportRaw.value); } catch {}

  let performance = null;
  try {
    if (perfResult.status === 'fulfilled') {
      performance = {};
      for (const m of (perfResult.value.metrics || [])) performance[m.name] = m.value;
    }
  } catch {}

  return { url, title, screenshot, viewport, dom, elements,
    consoleLogs: [], networkLogs: [], performance,
    webmcp: { available: false, tools: [] }, timestamp: Date.now() };
}

async function executeAction(action) {
  const tab = tabs[activeIdx];
  if (!tab) throw new Error('No active tab');
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) throw new Error('WebContents destroyed');
  if (!cdpAttached.has(wc)) cdpAttach(wc);

  switch (action.type) {
    case 'navigate': {
      await new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = (_, code) => {
          cleanup();
          // ERR_ABORTED (-3) means a redirect replaced the load — treat as success
          if (code === -3) resolve();
          else reject(new Error(`Navigation failed (${code})`));
        };
        function cleanup() {
          wc.removeListener('did-stop-loading', done);
          wc.removeListener('did-fail-load', fail);
          clearTimeout(timer);
        }
        wc.once('did-stop-loading', done);
        wc.once('did-fail-load', fail);
        const timer = setTimeout(done, 8000);
        wc.loadURL(normalizeUrl(action.url)).catch(err => {
          // loadURL itself rejects on ERR_ABORTED when a redirect fires
          if (err.code === 'ERR_ABORTED' || err.errno === -3) resolve();
          else reject(err);
        });
      });
      return { navigated: true, url: wc.getURL() };
    }
    case 'click': {
      // Agent sends either { x, y } coordinates or { selector } — resolve selector if needed
      let { x, y, selector } = action;
      if (selector && (x == null || y == null)) {
        const coords = await wc.executeJavaScript(`(function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (!coords) throw new Error(`Element not found: ${selector}`);
        x = coords.x; y = coords.y;
      }
      x = Math.round(Number(x)); y = Math.round(Number(y));
      if (isNaN(x) || isNaN(y)) throw new Error(`Invalid click coordinates: x=${x}, y=${y}`);
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'none' });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return { clicked: true, x, y };
    }
    case 'type': {
      for (const char of String(action.text || '')) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp',   text: char, key: char });
      }
      return { typed: true };
    }
    case 'press_key': {
      const KEY_MAP = {
        Enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13 },
        Tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9  },
        Escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
        Backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8  },
        Delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
        ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
        ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
        ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        Space:      { key: ' ',          code: 'Space',      keyCode: 32 },
      };
      const ki = KEY_MAP[action.key] || { key: action.key, code: `Key${action.key?.toUpperCase()}`, text: action.key };
      const kd = { ...ki, windowsVirtualKeyCode: ki.keyCode, nativeVirtualKeyCode: ki.keyCode };
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...kd });
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp',   ...kd });
      return { pressed: action.key };
    }
    case 'scroll': {
      const { x = 400, y = 400, deltaX = 0, deltaY = 300 } = action;
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
      return { scrolled: true };
    }
    case 'go_back':    { wc.goBack();    return { navigated: true }; }
    case 'go_forward': { wc.goForward(); return { navigated: true }; }
    case 'wait': {
      await new Promise(r => setTimeout(r, Math.min(action.ms || 1000, 10000)));
      return { waited: true };
    }
    default: throw new Error(`Unknown action type: ${action.type}`);
  }
}

// ── Attach browser to main window ─────────────────────────────────────────────

/**
 * attachBrowserView(mw)
 * Creates the first WebContentsView and attaches it to the main window.
 * Call after the main window's did-finish-load event.
 *
 * @param {BrowserWindow} mw  The main application window
 */
async function attachBrowserView(mw) {
  mainWin = mw;
  mainWin.on('resize', updateBounds);
  await addTab('https://www.google.com');
  startPolling();
  // CDP bridge is now handled by renderer.js via role=desktop WebSocket + IPC
  console.log('[Browser] Browser view attached to main window.');
}

// ── Tab management ────────────────────────────────────────────────────────────

async function addTab(url = 'https://www.google.com') {
  if (!mainWin || mainWin.isDestroyed()) return;

  const ses = session.fromPartition(EXT_SES);
  const view = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
  });

  const tab = { id: Date.now() + Math.random(), view, url, title: 'New Tab', favicon: null, loading: false };
  tabs.push(tab);

  const wc = view.webContents;
  wc.on('did-navigate',         (_, u) => { tab.url = u;             pushState(); });
  wc.on('did-navigate-in-page', (_, u) => { tab.url = u;             pushState(); });
  wc.on('page-title-updated',   (_, t) => { tab.title = t;           pushState(); });
  wc.on('page-favicon-updated', (_, f) => { tab.favicon = f[0]||null; pushState(); });
  wc.on('did-start-loading',    ()     => { tab.loading = true;       pushState(); });
  wc.on('did-stop-loading',     ()     => { tab.loading = false;      pushState(); });

  // Inject overlay.js into pages after navigation completes.
  // Extension content script injection via session.loadExtension() is unreliable
  // in Electron, so we manually inject the overlay script to ensure the
  // __colearn_guidance__ event listener is always present.
  wc.on('did-finish-load', () => {
    injectOverlayScript(wc).catch(err =>
      console.warn('[Browser] Overlay injection failed:', err.message)
    );
  });

  // target="_blank" / window.open → new tab
  wc.setWindowOpenHandler(({ url: u }) => { addTab(u); return { action: 'deny' }; });

  switchToTab(tabs.length - 1);
  wc.loadURL(normalizeUrl(url));
  return tab.id;
}

function switchToTab(idx) {
  if (!mainWin || mainWin.isDestroyed() || idx < 0 || idx >= tabs.length) return;
  // Detach CDP from the tab we're leaving
  const prevWc = tabs[activeIdx]?.view?.webContents;
  if (prevWc && !prevWc.isDestroyed()) cdpDetach(prevWc);

  for (const t of tabs) {
    try { mainWin.contentView.removeChildView(t.view); } catch {}
  }
  activeIdx = idx;
  mainWin.contentView.addChildView(tabs[idx].view);
  updateBounds();

  // Attach CDP to the newly-active tab
  const newWc = tabs[idx].view.webContents;
  if (newWc && !newWc.isDestroyed()) cdpAttach(newWc);

  pushState();
}

function closeTab(idx) {
  if (idx < 0 || idx >= tabs.length) return;
  const [removed] = tabs.splice(idx, 1);
  try {
    mainWin.contentView.removeChildView(removed.view);
    removed.view.webContents.destroy();
  } catch {}
  if (tabs.length === 0) { addTab(); return; }
  switchToTab(Math.min(idx, tabs.length - 1));
}

function updateBounds() {
  if (!mainWin || mainWin.isDestroyed() || activeIdx < 0 || activeIdx >= tabs.length) return;
  const [w, h] = mainWin.getContentSize();
  tabs[activeIdx].view.setBounds({
    x:      splitX,
    y:      TOOLBAR_H,
    width:  Math.max(0, w - splitX),
    height: Math.max(0, h - TOOLBAR_H),
  });
}

function pushState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const active = tabs[activeIdx];
  const wc = active?.view?.webContents;

  // Safely resolve canGoBack/canGoForward — navigationHistory.canGoBack may be
  // a method or a property depending on the Electron version; calling a function
  // reference directly via IPC causes "Failed to serialize arguments".
  let canGoBack = false, canGoForward = false;
  if (wc && !wc.isDestroyed()) {
    try {
      const nh = wc.navigationHistory;
      if (nh) {
        canGoBack    = !!nh.canGoBack;
        canGoForward = !!nh.canGoForward;
      } else {
        canGoBack    = !!(wc.canGoBack?.());
        canGoForward = !!(wc.canGoForward?.());
      }
    } catch {}
  }

  try {
    mainWin.webContents.send('browser:state', {
      tabs: tabs.map((t, i) => ({
        id:      t.id,
        url:     t.url     ?? '',
        title:   t.title   ?? 'New Tab',
        favicon: typeof t.favicon === 'string' ? t.favicon : null,
        loading: !!t.loading,
        active:  i === activeIdx,
      })),
      activeIdx,
      canGoBack,
      canGoForward,
      currentUrl: active?.url ?? '',
    });
  } catch (err) {
    console.error('[Browser] pushState send failed:', err.message);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function navigate(url) {
  tabs[activeIdx]?.view.webContents.loadURL(normalizeUrl(url));
}
function goBack()    { const wc = tabs[activeIdx]?.view.webContents; if (wc?.navigationHistory?.canGoBack)    wc.goBack();    }
function goForward() { const wc = tabs[activeIdx]?.view.webContents; if (wc?.navigationHistory?.canGoForward) wc.goForward(); }
function reload()    { tabs[activeIdx]?.view.webContents.reload(); }
function stop()      { tabs[activeIdx]?.view.webContents.stop();   }

function normalizeUrl(input) {
  if (!input) return 'https://www.google.com';
  if (input.startsWith('about:') || input.startsWith('chrome-extension://')) return input;
  return input.includes('://') ? input : `https://${input}`;
}

// ── Extension popup ───────────────────────────────────────────────────────────

function openExtPopup() {
  if (!extId) { console.warn('[Browser] Extension not loaded.'); return; }
  const popup = new BrowserWindow({
    width: 380, height: 520, resizable: false, alwaysOnTop: true, frame: false,
    backgroundColor: '#111316',
    webPreferences: {
      session: session.fromPartition(EXT_SES),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  popup.loadURL(`chrome-extension://${extId}/popup.html`);
  popup.on('blur', () => { if (!popup.isDestroyed()) popup.close(); });
}

// ── Extension connection polling ──────────────────────────────────────────────

function startPolling() {
  let elapsed = 0;
  console.log('[Browser] Polling for extension connection...');
  pollTimer = setInterval(async () => {
    elapsed += POLL_MS;
    try {
      if (await pingHealth()) {
        console.log('[Browser] ✓ Extension connected to server.');
        send('browser:ext-status', { connected: true });
        stopPolling();
        return;
      }
    } catch {}
    if (elapsed >= POLL_MAX) {
      console.warn('[Browser] Extension did not connect within 30s.');
      send('browser:ext-status', { connected: false, timedOut: true });
      stopPolling();
    }
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function pingHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(HEALTH_URL, r => {
      let b = '';
      r.on('data', c => (b += c));
      r.on('end', () => {
        try { resolve((JSON.parse(b).connections?.extension ?? 0) > 0); }
        catch { resolve(false); }
      });
    });
    req.on('error', reject);
    req.setTimeout(500, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function send(ch, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data);
}

// ── IPC registration ──────────────────────────────────────────────────────────

function registerIpc() {
  if (ipcReady) return;
  ipcReady = true;

  ipcMain.on('browser:navigate',    (_, url) => navigate(url));
  ipcMain.on('browser:back',        ()       => goBack());
  ipcMain.on('browser:forward',     ()       => goForward());
  ipcMain.on('browser:reload',      ()       => reload());
  ipcMain.on('browser:stop',        ()       => stop());
  ipcMain.on('browser:new-tab',     (_, url) => addTab(url));
  ipcMain.on('browser:close-tab',   (_, idx) => closeTab(idx));
  ipcMain.on('browser:switch-tab',  (_, idx) => switchToTab(idx));
  ipcMain.on('browser:devtools',    ()       => {
    const wc = tabs[activeIdx]?.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.openDevTools({ mode: 'detach' });
  });
  ipcMain.on('browser:ext-popup',   ()       => openExtPopup());

  // ── CDP proxy — called by renderer's role=desktop WebSocket bridge ──
  ipcMain.handle('cdp:gatherContext', async () => {
    return await gatherContext();
  });
  ipcMain.handle('cdp:executeAction', async (_, action) => {
    return await executeAction(action);
  });

  ipcMain.handle('cdp:showGuidance', async (_, msg) => {
    const wc = tabs[activeIdx]?.view?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error('No active tab');
    const payload = JSON.stringify(msg).replace(/</g, '\\u003c');
    await wc.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('__colearn_guidance__', { detail: ${payload} }))`
    );
    return { ok: true };
  });

  // Called when user drags the panel divider
  ipcMain.on('browser:panel-resize', (_, x) => {
    splitX = x;
    updateBounds();
  });
}

module.exports = { initExtension, attachBrowserView, registerIpc };
