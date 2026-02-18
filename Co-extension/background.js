// CoLearn Agent — Background Service Worker
// Observes pages via CDP, gathers rich context with element positions on demand,
// and streams everything to the backend for AI visual guidance.

"use strict";

const WS_URL = "ws://localhost:3001?role=extension";
const COLEARN_APP = "localhost:5173";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  events: [],
  activeTabId: null,
  debuggerAttached: new Set(),
  pageContexts: {},
  consoleLogs: {},
  networkLogs: {},
};

const MAX_EVENTS = 200;
const MAX_LOGS = 100;
let ws = null;
let wsReconnectTimer = null;

// ---------------------------------------------------------------------------
// WebSocket to backend
// ---------------------------------------------------------------------------
function connectWS() {
  if (ws?.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => console.log("[CoLearn] WS connected to backend");

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleBackendMessage(msg);
  };

  ws.onclose = () => {
    console.log("[CoLearn] WS disconnected, reconnecting...");
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

function wsSend(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

connectWS();

// ---------------------------------------------------------------------------
// Handle messages FROM backend
// ---------------------------------------------------------------------------
async function handleBackendMessage(msg) {
  if (msg.type === "GATHER_CONTEXT") {
    const requestId = msg.requestId;
    const tabId = state.activeTabId;
    if (!tabId) {
      wsSend({ type: "CONTEXT_RESPONSE", requestId, ok: false, error: "No active tab" });
      return;
    }

    try {
      const context = await gatherFullContext(tabId);
      wsSend({ type: "CONTEXT_RESPONSE", requestId, ok: true, context });
    } catch (err) {
      wsSend({ type: "CONTEXT_RESPONSE", requestId, ok: false, error: err.message });
    }
  }

  // Relay guidance overlay commands to the active tab's content script
  if (msg.type === "SHOW_GUIDANCE" || msg.type === "CLEAR_GUIDANCE" || msg.type === "STEP_GUIDANCE") {
    const tabId = state.activeTabId;
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, msg);
      } catch (err) {
        console.warn("[CoLearn] Could not send guidance to tab:", err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gather full page context via CDP — now includes element bounding boxes
// ---------------------------------------------------------------------------
async function gatherFullContext(tabId) {
  const attached = await ensureAttached(tabId);
  if (!attached.ok) throw new Error(attached.error);

  const tab = await chrome.tabs.get(tabId);

  const [screenshot, domInfo, elementsWithBounds, performanceMetrics, viewportSize] =
    await Promise.all([
      captureScreenshotRaw(tabId),
      extractDomInfo(tabId),
      extractInteractiveElements(tabId),
      getPerformanceMetrics(tabId),
      getViewportSize(tabId),
    ]);

  return {
    tabId,
    url: tab.url,
    title: tab.title,
    screenshot: screenshot ? `data:image/jpeg;base64,${screenshot}` : null,
    viewport: viewportSize,
    dom: domInfo,
    elements: elementsWithBounds,
    consoleLogs: (state.consoleLogs[tabId] || []).slice(-30),
    networkLogs: (state.networkLogs[tabId] || []).slice(-30),
    performance: performanceMetrics,
    timestamp: Date.now(),
  };
}

async function ensureAttached(tabId) {
  if (state.debuggerAttached.has(tabId)) return { ok: true };
  return attachDebugger(tabId);
}

// ---------------------------------------------------------------------------
// CDP — Extract interactive elements WITH bounding boxes
// ---------------------------------------------------------------------------
async function extractInteractiveElements(tabId) {
  const expr = `(function() {
    const selectors = [
      'button', '[role="button"]', 'a[href]', 'input', 'textarea', 'select',
      '[onclick]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      'img', 'svg', 'icon', '[class*="icon"]', '[class*="btn"]',
      '[class*="logo"]', '[class*="nav"]', 'h1', 'h2', 'h3',
      '[data-testid]', '[aria-label]'
    ];
    const seen = new Set();
    const results = [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (seen.has(el) || results.length >= 60) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.top > window.innerHeight + 100) continue;
          results.push({
            tag: el.tagName,
            text: (el.innerText || el.value || el.alt || el.ariaLabel || el.title || '').slice(0, 100).trim(),
            classes: (el.className?.toString() || '').slice(0, 120),
            id: el.id || null,
            href: el.href || null,
            type: el.type || null,
            role: el.getAttribute('role') || null,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
        }
      } catch {}
    }
    return JSON.stringify(results);
  })()`;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId }, "Runtime.evaluate", { expression: expr }
    );
    return JSON.parse(result.result.value);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CDP — Viewport size
// ---------------------------------------------------------------------------
async function getViewportSize(tabId) {
  const expr = `JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })`;
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId }, "Runtime.evaluate", { expression: expr }
    );
    return JSON.parse(result.result.value);
  } catch {
    return { width: 1280, height: 800, dpr: 1 };
  }
}

// ---------------------------------------------------------------------------
// CDP — DOM / page info
// ---------------------------------------------------------------------------
async function extractDomInfo(tabId) {
  const expr = `JSON.stringify({
    title: document.title,
    url: location.href,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,15)
      .map(h => ({level: h.tagName, text: h.innerText?.slice(0,150)})),
    links: Array.from(document.querySelectorAll('a[href]')).slice(0,20)
      .map(a => ({text: a.innerText?.slice(0,80), href: a.href})),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0,20)
      .map(b => ({text: b.innerText?.slice(0,80) || b.value || b.ariaLabel || '', tag: b.tagName})),
    inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0,20)
      .map(i => ({type: i.type, name: i.name, placeholder: i.placeholder, value: i.value?.slice(0,100)})),
    images: Array.from(document.querySelectorAll('img[src]')).slice(0,10)
      .map(img => ({alt: img.alt, src: img.src?.slice(0,200)})),
    selection: window.getSelection()?.toString()?.slice(0,500) || null,
    bodyText: document.body?.innerText?.slice(0,2000) || null,
    forms: Array.from(document.querySelectorAll('form')).slice(0,5)
      .map(f => ({action: f.action, method: f.method, id: f.id})),
  })`;

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId }, "Runtime.evaluate", { expression: expr }
    );
    return JSON.parse(result.result.value);
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// CDP — Performance metrics
// ---------------------------------------------------------------------------
async function getPerformanceMetrics(tabId) {
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId }, "Performance.getMetrics"
    );
    const interesting = ["Timestamp", "Documents", "Frames", "JSEventListeners",
      "Nodes", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize", "JSHeapTotalSize"];
    return result.metrics
      .filter(m => interesting.includes(m.name))
      .reduce((acc, m) => { acc[m.name] = m.value; return acc; }, {});
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CDP — Screenshot (raw base64)
// ---------------------------------------------------------------------------
async function captureScreenshotRaw(tabId) {
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId }, "Page.captureScreenshot", { format: "jpeg", quality: 70 }
    );
    return result.data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CDP — Console & Network observation
// ---------------------------------------------------------------------------
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" || method === "Runtime.consoleAPICalled") {
    if (!state.consoleLogs[tabId]) state.consoleLogs[tabId] = [];
    const entry = method === "Console.messageAdded"
      ? { level: params.message?.level, text: params.message?.text?.slice(0, 300) }
      : { level: params.type, text: params.args?.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300) };
    entry.timestamp = Date.now();
    state.consoleLogs[tabId].push(entry);
    if (state.consoleLogs[tabId].length > MAX_LOGS) state.consoleLogs[tabId].shift();
  }

  if (method === "Network.requestWillBeSent") {
    if (!state.networkLogs[tabId]) state.networkLogs[tabId] = [];
    state.networkLogs[tabId].push({
      requestId: params.requestId,
      url: params.request?.url?.slice(0, 300),
      method: params.request?.method,
      type: params.type,
      timestamp: Date.now(),
    });
    if (state.networkLogs[tabId].length > MAX_LOGS) state.networkLogs[tabId].shift();
  }

  if (method === "Network.responseReceived") {
    const logs = state.networkLogs[tabId];
    if (logs) {
      const entry = logs.find(e => e.requestId === params.requestId);
      if (entry) {
        entry.status = params.response?.status;
        entry.mimeType = params.response?.mimeType;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isCoLearnApp(url) {
  return url && url.includes(COLEARN_APP);
}

function pushEvent(event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

// ---------------------------------------------------------------------------
// Message handling from content scripts
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const tabUrl = sender.tab?.url || msg.payload?.url;

  if (isCoLearnApp(tabUrl)) return;

  switch (msg.type) {
    case "USER_CLICK":
    case "USER_INPUT":
    case "NAVIGATION":
      pushEvent({ ...msg.payload, tabId });
      console.log(`[CoLearn] ${msg.type}`, msg.payload);
      wsSend(msg);
      break;

    case "CONTENT_READY":
      console.log("[CoLearn] Content script ready:", msg.payload.url);
      if (tabId) state.pageContexts[tabId] = msg.payload;
      wsSend(msg);
      break;

    case "GET_STATE":
      sendResponse({
        events: state.events.slice(-30),
        activeTabId: state.activeTabId,
        debuggerAttached: [...state.debuggerAttached],
      });
      return true;

    case "ATTACH_DEBUGGER":
      attachDebugger(msg.tabId ?? state.activeTabId).then(sendResponse);
      return true;

    case "DETACH_DEBUGGER":
      detachDebugger(msg.tabId ?? state.activeTabId).then(sendResponse);
      return true;

    case "CAPTURE_SCREENSHOT":
      captureScreenshot(msg.tabId ?? state.activeTabId).then(sendResponse);
      return true;

    case "READ_PAGE_CONTEXT":
      readPageContext(msg.tabId ?? state.activeTabId).then(sendResponse);
      return true;
  }
});

// ---------------------------------------------------------------------------
// Track active tab
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener((activeInfo) => {
  state.activeTabId = activeInfo.tabId;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.debuggerAttached.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    state.debuggerAttached.delete(tabId);
  }
  delete state.pageContexts[tabId];
  delete state.consoleLogs[tabId];
  delete state.networkLogs[tabId];
});

// ---------------------------------------------------------------------------
// CDP — Attach with full observation domains
// ---------------------------------------------------------------------------
async function attachDebugger(tabId) {
  if (!tabId) return { ok: false, error: "No tabId" };
  if (state.debuggerAttached.has(tabId)) return { ok: true, already: true };

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await Promise.all([
      chrome.debugger.sendCommand({ tabId }, "Page.enable"),
      chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
      chrome.debugger.sendCommand({ tabId }, "Network.enable"),
      chrome.debugger.sendCommand({ tabId }, "Console.enable"),
      chrome.debugger.sendCommand({ tabId }, "Performance.enable"),
      chrome.debugger.sendCommand({ tabId }, "DOM.enable"),
    ]);
    state.debuggerAttached.add(tabId);
    state.consoleLogs[tabId] = [];
    state.networkLogs[tabId] = [];
    console.log(`[CoLearn] Debugger attached to tab ${tabId} (all domains)`);
    return { ok: true };
  } catch (err) {
    console.error("[CoLearn] Attach failed:", err);
    return { ok: false, error: err.message };
  }
}

async function detachDebugger(tabId) {
  if (!tabId || !state.debuggerAttached.has(tabId))
    return { ok: false, error: "Not attached" };
  try {
    await chrome.debugger.detach({ tabId });
    state.debuggerAttached.delete(tabId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

chrome.debugger.onDetach.addListener((source) => {
  state.debuggerAttached.delete(source.tabId);
});

// ---------------------------------------------------------------------------
// CDP — Read page context (for popup)
// ---------------------------------------------------------------------------
async function readPageContext(tabId) {
  if (!tabId) return { ok: false, error: "No tabId" };
  const a = await ensureAttached(tabId);
  if (!a.ok) return a;

  try {
    const dom = await extractDomInfo(tabId);
    return { ok: true, context: dom };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// CDP — Screenshot (public, also forwards to backend)
// ---------------------------------------------------------------------------
async function captureScreenshot(tabId) {
  if (!tabId) return { ok: false, error: "No tabId" };
  const a = await ensureAttached(tabId);
  if (!a.ok) return a;

  try {
    const tab = await chrome.tabs.get(tabId);
    const base64 = await captureScreenshotRaw(tabId);
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    wsSend({ type: "SCREENSHOT", dataUrl, tabId, url: tab.url });
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

console.log("[CoLearn] Background service worker started.");
