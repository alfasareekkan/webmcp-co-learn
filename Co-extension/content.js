// CoLearn Agent — Content Script
// Injected into every page to observe user interactions and extract page context.
// Skips the CoLearn React app itself.

(function () {
  "use strict";

  // Don't observe our own dashboard
  if (location.host === "localhost:5173") return;

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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_PAGE_CONTEXT") {
      sendResponse(extractPageContext());
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
