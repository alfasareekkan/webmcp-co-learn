// CoLearn Agent — Content Script
// Injected into every page to observe user interactions and extract page context.
// Skips the CoLearn React app itself.

(function () {
  "use strict";

  // Don't observe our own dashboard
  const _DASHBOARD_HOST = (typeof COLEARN_CONFIG !== "undefined")
    ? COLEARN_CONFIG.dashboardHost : "localhost:5173";
  if (location.host === _DASHBOARD_HOST) return;
  // Guard against double-injection when scripts are injected programmatically
  if (window.__colearn_content_injected__) return;
  window.__colearn_content_injected__ = true;

  const MAX_TEXT_LENGTH = 100;
  const OBSERVED_APPS = {
    "figma.com": "Figma",
    "docs.google.com/spreadsheets": "Google Sheets",
    "magicpattern.design": "MagicPattern",
    "notion.so": "Notion",
    "miro.com": "Miro",
  };

  function detectApp() {
    const url = location.href;
    for (const [pattern, name] of Object.entries(OBSERVED_APPS)) {
      if (url.includes(pattern)) return name;
    }
    return null;
  }

  function getElementPath(el) {
    const parts = [];
    while (el && el !== document.body) {
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector += `#${el.id}`;
        parts.unshift(selector);
        break;
      }
      if (el.className && typeof el.className === "string") {
        selector += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
      }
      parts.unshift(selector);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  function buildPayload(event, type) {
    const target = event.target;
    return {
      type,
      tag: target.tagName,
      id: target.id || null,
      classes: target.className || null,
      text: target.innerText?.slice(0, MAX_TEXT_LENGTH) || null,
      path: getElementPath(target),
      url: location.href,
      app: detectApp(),
      timestamp: Date.now(),
    };
  }

  // --- Click Observer ---
  document.addEventListener("click", (event) => {
    const payload = buildPayload(event, "USER_CLICK");
    chrome.runtime.sendMessage({ type: "USER_CLICK", payload });
  });

  // --- Input Observer (debounced) ---
  let inputTimer = null;
  document.addEventListener(
    "input",
    (event) => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        const payload = buildPayload(event, "USER_INPUT");
        payload.value = event.target.value?.slice(0, MAX_TEXT_LENGTH) || null;
        chrome.runtime.sendMessage({ type: "USER_INPUT", payload });
      }, 400);
    },
    true
  );

  // --- Navigation Observer ---
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({
        type: "NAVIGATION",
        payload: {
          url: lastUrl,
          app: detectApp(),
          title: document.title,
          timestamp: Date.now(),
        },
      });
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // --- Page Context Extraction ---
  function extractPageContext() {
    return {
      title: document.title,
      url: location.href,
      app: detectApp(),
      meta: {
        description:
          document.querySelector('meta[name="description"]')?.content || null,
        ogTitle:
          document.querySelector('meta[property="og:title"]')?.content || null,
      },
      headings: Array.from(document.querySelectorAll("h1, h2, h3"))
        .slice(0, 10)
        .map((h) => ({ level: h.tagName, text: h.innerText?.slice(0, 120) })),
      timestamp: Date.now(),
    };
  }

  const WATCHER_TIMEOUT_MS = 300000; // 5 minutes

  function runWatcher(config) {
    const { threadId, sessionId, stepNumber } = config;
    // P4: support multiple signals (OR logic) — fall back to single signal or default
    const signals = config.signals
      || (config.signal ? [config.signal] : [{ type: "user_clicked_target", targetSelector: "" }]);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanups = [];

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        runCleanup();
        console.warn("[CoLearn] [WATCHER] Timeout after 5 minutes");
        reject({ type: "STEP_ABANDONED", threadId, sessionId, reason: "Step timed out (5 min)" });
      }, WATCHER_TIMEOUT_MS);

      function runCleanup() {
        clearTimeout(timeoutId);
        cleanups.forEach((fn) => { try { fn(); } catch {} });
      }

      function done(domSnapshot) {
        if (settled) return;
        settled = true;
        runCleanup();
        resolve({
          type: "STEP_COMPLETED",
          threadId,
          sessionId,
          stepNumber,
          domSnapshot: domSnapshot || null,
        });
      }

      // Set up a watcher for each signal — first to fire wins (OR logic)
      for (const signal of signals) {
        const type = signal.type || "user_clicked_target";
        const targetSelector = signal.targetSelector || "";

        if (type === "dom_appeared") {
          const prevCount = document.body ? document.body.getElementsByTagName("*").length : 0;
          let debounceTimer = null;
          const obs = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              const nextCount = document.body ? document.body.getElementsByTagName("*").length : 0;
              if (nextCount > prevCount + 8) done({ elementCount: nextCount });
            }, 300);
          });
          obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
          cleanups.push(() => { clearTimeout(debounceTimer); obs.disconnect(); });

        } else if (type === "dom_disappeared") {
          const prevCount = document.body ? document.body.getElementsByTagName("*").length : 0;
          let debounceTimer = null;
          const obs = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              const nextCount = document.body ? document.body.getElementsByTagName("*").length : 0;
              if (nextCount < prevCount - 8) done({ elementCount: nextCount });
            }, 300);
          });
          obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
          cleanups.push(() => { clearTimeout(debounceTimer); obs.disconnect(); });

        } else if (type === "url_changed") {
          const baseline = location.href;
          const urlInterval = setInterval(() => {
            if (location.href !== baseline) done({ url: location.href });
          }, 500);
          cleanups.push(() => clearInterval(urlInterval));

        } else {
          // user_clicked_target (default)
          const el = targetSelector
            ? document.querySelector(targetSelector)
            : document.querySelector(".__colearn_highlight");
          if (el) {
            const onTargetClick = () => done({ clicked: true });
            el.addEventListener("click", onTargetClick, { once: true });
            cleanups.push(() => el.removeEventListener("click", onTargetClick));
          } else {
            const oneClick = (e) => {
              if (e.target.closest && e.target.closest(".__colearn_highlight")) done({ clicked: true });
            };
            document.body.addEventListener("click", oneClick);
            cleanups.push(() => document.body.removeEventListener("click", oneClick));
          }
        }
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_PAGE_CONTEXT") {
      sendResponse(extractPageContext());
    } else if (msg.type === "WATCH_FOR_COMPLETION") {
      runWatcher(msg)
        .then((result) => {
          chrome.runtime.sendMessage(result);
          sendResponse({ ok: true });
        })
        .catch((result) => {
          if (result && result.type === "STEP_ABANDONED") {
            chrome.runtime.sendMessage(result);
          }
          sendResponse({ ok: false });
        });
      return true;
    }
  });

  chrome.runtime.sendMessage({
    type: "CONTENT_READY",
    payload: {
      url: location.href,
      app: detectApp(),
      title: document.title,
      timestamp: Date.now(),
    },
  });
})();
