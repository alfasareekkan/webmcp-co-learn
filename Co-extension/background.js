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

  // Execute browser action from the LangGraph agent
  if (msg.type === "EXECUTE_ACTION") {
    const requestId = msg.requestId;
    const tabId = state.activeTabId;
    if (!tabId) {
      wsSend({ type: "ACTION_RESULT", requestId, ok: false, error: "No active tab" });
      return;
    }

    try {
      const result = await executeBrowserAction(tabId, msg.action);
      wsSend({ type: "ACTION_RESULT", requestId, ok: true, result });
    } catch (err) {
      wsSend({ type: "ACTION_RESULT", requestId, ok: false, error: err.message });
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
// Site-type detection for routing actions through the right execution path
// ---------------------------------------------------------------------------
async function detectSiteType(tabId) {
  return evalOnPage(tabId, `(function() {
    const url = location.href;
    if (url.includes('docs.google.com/spreadsheets')) return JSON.stringify({ type: 'sheets' });
    if (url.includes('figma.com')) return JSON.stringify({ type: 'figma' });
    if (url.includes('miro.com')) return JSON.stringify({ type: 'miro' });
    if (url.includes('canva.com')) return JSON.stringify({ type: 'canvas-app' });
    if (document.querySelector('canvas') && document.querySelectorAll('canvas').length > 0) {
      return JSON.stringify({ type: 'canvas-app' });
    }
    return JSON.stringify({ type: 'standard' });
  })()`);
}

// Sheets-specific click: targets the cell grid via Input.dispatchMouseEvent on coordinates
async function executeSheetsAction(tabId, action) {
  if (action.type === "click") {
    const coords = await evalOnPage(tabId, `(function() {
      const el = document.querySelector(${JSON.stringify(action.selector)});
      if (!el) return JSON.stringify({ ok: false, error: 'Element not found' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`);
    if (!coords.ok) throw new Error(coords.error);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1,
    });
    await sleep(300);
    return { message: `Sheets click at (${Math.round(coords.x)}, ${Math.round(coords.y)})` };
  }
  if (action.type === "type") {
    for (const char of action.text) {
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyDown", text: char, key: char, code: `Key${char.toUpperCase()}`,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp", key: char, code: `Key${char.toUpperCase()}`,
      });
    }
    await sleep(200);
    return { message: `Typed "${action.text.slice(0, 50)}" via Sheets keyboard input` };
  }
  return null;
}

// Figma/canvas-app: uses coordinate-based CDP mouse events since canvas ignores DOM selectors
async function executeFigmaAction(tabId, action) {
  if (action.type === "click") {
    const coords = await evalOnPage(tabId, `(function() {
      const el = document.querySelector(${JSON.stringify(action.selector)});
      if (!el) {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const r = canvas.getBoundingClientRect();
          return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, fallback: true });
        }
        return JSON.stringify({ ok: false, error: 'Element not found and no canvas' });
      }
      const rect = el.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()`);
    if (!coords.ok) throw new Error(coords.error);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1,
    });
    await sleep(50);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1,
    });
    await sleep(300);
    return { message: `Canvas click at (${Math.round(coords.x)}, ${Math.round(coords.y)})${coords.fallback ? ' (canvas fallback)' : ''}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execute browser actions via CDP Runtime.evaluate (JS-based, reliable)
// ---------------------------------------------------------------------------
async function executeBrowserAction(tabId, action) {
  const attached = await ensureAttached(tabId);
  if (!attached.ok) throw new Error(attached.error);

  const siteType = await detectSiteType(tabId);
  const site = siteType?.type || 'standard';

  // Route to specialised handler when applicable
  if (site === 'sheets' && (action.type === 'click' || action.type === 'type')) {
    const result = await executeSheetsAction(tabId, action);
    if (result) return result;
  }
  if ((site === 'figma' || site === 'canvas-app' || site === 'miro') && action.type === 'click') {
    const result = await executeFigmaAction(tabId, action);
    if (result) return result;
  }

  switch (action.type) {
    case "click": {
      const selector = action.selector;
      const result = await evalOnPage(tabId, buildMouseEventChain(JSON.stringify(selector)));
      await sleep(400);
      if (!result.ok) throw new Error(result.error);
      return { message: `Clicked <${result.tag}> "${result.text}"` };
    }

    case "type": {
      const selector = action.selector;
      const text = action.text;
      const clear = action.clearFirst !== false;
      const result = await evalOnPage(tabId, `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ${selector}' });
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        el.click();
        if (${clear}) {
          if ('value' in el) el.value = '';
          else el.textContent = '';
        }
        if ('value' in el) {
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Also fire React-compatible events
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter && 'value' in el) {
          nativeInputValueSetter.call(el, ${JSON.stringify(text)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return JSON.stringify({ ok: true, tag: el.tagName });
      })()`);
      await sleep(200);
      if (!result.ok) throw new Error(result.error);
      return { message: `Typed "${text.slice(0, 50)}" into <${result.tag}>` };
    }

    case "modify_style": {
      const selector = action.selector;
      const styles = action.styles;
      const result = await evalOnPage(tabId, `(function() {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        if (!els.length) return JSON.stringify({ ok: false, error: 'No elements match: ${selector}' });
        const styles = ${JSON.stringify(styles)};
        els.forEach(el => {
          Object.entries(styles).forEach(([prop, val]) => {
            el.style[prop] = val;
          });
        });
        return JSON.stringify({ ok: true, count: els.length, applied: Object.keys(styles) });
      })()`);
      if (!result.ok) throw new Error(result.error);
      return { message: `Modified style on ${result.count} element(s): ${result.applied.join(', ')}` };
    }

    case "set_attribute": {
      const selector = action.selector;
      const result = await evalOnPage(tabId, `(function() {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        if (!els.length) return JSON.stringify({ ok: false, error: 'No elements match: ${selector}' });
        els.forEach(el => {
          el.setAttribute(${JSON.stringify(action.attribute)}, ${JSON.stringify(action.value)});
        });
        return JSON.stringify({ ok: true, count: els.length });
      })()`);
      if (!result.ok) throw new Error(result.error);
      return { message: `Set ${action.attribute}="${action.value}" on ${result.count} element(s)` };
    }

    case "set_content": {
      const selector = action.selector;
      const result = await evalOnPage(tabId, `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ${selector}' });
        if (${JSON.stringify(!!action.html)}) {
          el.innerHTML = ${JSON.stringify(action.html || '')};
        } else {
          el.textContent = ${JSON.stringify(action.text || '')};
        }
        return JSON.stringify({ ok: true, tag: el.tagName });
      })()`);
      if (!result.ok) throw new Error(result.error);
      return { message: `Updated content of <${result.tag}>` };
    }

    case "execute_js": {
      const result = await evalOnPage(tabId, `(function() {
        try {
          const __result = (function() { ${action.code} })();
          return JSON.stringify({ ok: true, result: String(__result ?? 'done').slice(0, 500) });
        } catch(e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })()`);
      if (!result.ok) throw new Error(result.error);
      return { message: result.result };
    }

    case "scroll": {
      const amount = action.amount || 400;
      const dir = action.direction === "down" ? amount : -amount;
      await evalOnPage(tabId, `window.scrollBy({ top: ${dir}, behavior: 'smooth' })`);
      await sleep(400);
      return { message: `Scrolled ${action.direction} by ${Math.abs(dir)}px` };
    }

    case "navigate": {
      await chrome.debugger.sendCommand({ tabId }, "Page.navigate", {
        url: action.url,
      });
      await sleep(2000);
      return { message: `Navigated to ${action.url}` };
    }

    case "press_key": {
      const keyMap = {
        Enter: { key: "Enter", code: "Enter", keyCode: 13 },
        Tab: { key: "Tab", code: "Tab", keyCode: 9 },
        Escape: { key: "Escape", code: "Escape", keyCode: 27 },
        Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
        Delete: { key: "Delete", code: "Delete", keyCode: 46 },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
        ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
        ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
        Space: { key: " ", code: "Space", keyCode: 32 },
      };
      const keyInfo = keyMap[action.key] || {
        key: action.key, code: `Key${action.key.toUpperCase()}`, text: action.key,
      };
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyDown", ...keyInfo,
        windowsVirtualKeyCode: keyInfo.keyCode, nativeVirtualKeyCode: keyInfo.keyCode,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp", ...keyInfo,
        windowsVirtualKeyCode: keyInfo.keyCode, nativeVirtualKeyCode: keyInfo.keyCode,
      });
      await sleep(150);
      return { message: `Pressed ${action.key}` };
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

// Evaluate JS on page and parse JSON result
async function evalOnPage(tabId, expression) {
  const result = await chrome.debugger.sendCommand(
    { tabId }, "Runtime.evaluate",
    { expression, returnByValue: true }
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "JS evaluation failed");
  }
  try {
    return JSON.parse(result.result.value);
  } catch {
    return { ok: true, result: result.result.value };
  }
}

// Detect which UI framework owns the page so actions can be adapted
async function detectFramework(tabId) {
  return evalOnPage(tabId, `(function() {
    const fw = { react: false, angular: false, vue: false, svelte: false, plain: true };
    if (document.querySelector('[data-reactroot]') || document.querySelector('[id="__next"]')
        || Object.keys(document.querySelector('body')?.__proto__ || {}).some(k => k.startsWith('__react'))
        || document.querySelector('body')?._reactRootContainer
        || Array.from(document.querySelectorAll('*')).some(el => Object.keys(el).some(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')))) {
      fw.react = true; fw.plain = false;
    }
    if (document.querySelector('[ng-version]') || document.querySelector('[_nghost-ng-c]')
        || window.ng || window.getAllAngularRootElements) {
      fw.angular = true; fw.plain = false;
    }
    if (window.__VUE__ || document.querySelector('[data-v-]') || window.__vue_app__) {
      fw.vue = true; fw.plain = false;
    }
    if (document.querySelector('[class*="svelte-"]')) {
      fw.svelte = true; fw.plain = false;
    }
    return JSON.stringify(fw);
  })()`);
}

// Full synthetic mouse event chain that triggers framework listeners
function buildMouseEventChain(selectorStr) {
  return `(function() {
    const el = document.querySelector(${selectorStr});
    if (!el) return JSON.stringify({ ok: false, error: 'Element not found' });

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };

    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));

    // React <=17 reads from the native input setter; trigger the internal handler
    const reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (reactKey) {
      const synth = new MouseEvent('click', opts);
      el.dispatchEvent(synth);
    }

    return JSON.stringify({ ok: true, tag: el.tagName, text: (el.innerText || '').slice(0, 50) });
  })()`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
// CDP — Extract interactive elements WITH bounding boxes AND unique selectors
// ---------------------------------------------------------------------------
async function extractInteractiveElements(tabId) {
  const expr = `(function() {
    // Build a chain of selectors from the element up to an identifiable ancestor
    function buildSelectorChain(el) {
      const chain = [];
      let current = el;
      while (current && current !== document.body && current !== document.documentElement) {
        let seg = current.tagName.toLowerCase();
        if (current.id) {
          chain.unshift('#' + CSS.escape(current.id));
          break;
        }
        if (current.getAttribute('data-testid')) {
          chain.unshift('[data-testid="' + current.getAttribute('data-testid') + '"]');
          break;
        }
        if (current.getAttribute('aria-label')) {
          chain.unshift(seg + '[aria-label="' + current.getAttribute('aria-label') + '"]');
          break;
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
          if (siblings.length > 1) {
            seg += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          }
        }
        chain.unshift(seg);
        current = current.parentElement;
      }
      return chain;
    }

    function isVisible(el, cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return true;
    }

    function detectElementFramework(el) {
      const keys = Object.keys(el);
      if (keys.some(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))) return 'react';
      if (keys.some(k => k.startsWith('__ngContext__') || k.startsWith('__ng_'))) return 'angular';
      if (el.__vue__ || el.__vueParentComponent) return 'vue';
      if (el.className?.toString().match(/svelte-/)) return 'svelte';
      return null;
    }

    const querySelectors = [
      'button', '[role="button"]', 'a[href]', 'input', 'textarea', 'select',
      '[onclick]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      'img', 'svg', 'icon', '[class*="icon"]', '[class*="btn"]',
      '[class*="logo"]', '[class*="nav"]', 'h1', 'h2', 'h3',
      '[data-testid]', '[aria-label]', '[contenteditable]',
      'div[style*="color"]', 'div[style*="background"]', 'span[style]',
      'p', 'li', 'td', 'th', 'label'
    ];
    const seen = new Set();
    const results = [];
    for (const sel of querySelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (seen.has(el) || results.length >= 100) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.top > window.innerHeight + 200) continue;
          const cs = window.getComputedStyle(el);
          const selectorChain = buildSelectorChain(el);
          results.push({
            tag: el.tagName,
            text: (el.innerText || el.value || el.alt || el.ariaLabel || el.title || '').slice(0, 100).trim(),
            classes: (el.className?.toString() || '').slice(0, 120),
            id: el.id || null,
            href: el.href || null,
            type: el.type || null,
            role: el.getAttribute('role') || null,
            selectorChain: selectorChain,
            selector: selectorChain.join(' > '),
            visible: isVisible(el, cs),
            frameworkHint: detectElementFramework(el),
            style: {
              color: cs.color,
              bg: cs.backgroundColor,
              display: cs.display,
              visibility: cs.visibility,
            },
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
