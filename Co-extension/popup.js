// CoLearn Agent — Popup Controller

"use strict";

const $ = (sel) => document.querySelector(sel);

const KNOWN_APPS = {
  "figma.com": "Figma",
  "docs.google.com/spreadsheets": "Google Sheets",
  "magicpattern.design": "MagicPattern",
  "notion.so": "Notion",
  "miro.com": "Miro",
};

function detectAppFromUrl(url) {
  if (!url) return null;
  for (const [pattern, name] of Object.entries(KNOWN_APPS)) {
    if (url.includes(pattern)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderEvents(events) {
  const log = $("#event-log");
  if (!events || events.length === 0) {
    log.innerHTML = '<div class="empty-state">No events captured yet.</div>';
    return;
  }

  log.innerHTML = events
    .slice()
    .reverse()
    .map((ev) => {
      let typeClass = "click";
      let typeLabel = ev.type || "CLICK";
      if (ev.type === "USER_INPUT") {
        typeClass = "input";
        typeLabel = "INPUT";
      } else if (ev.type === "NAVIGATION") {
        typeClass = "nav";
        typeLabel = "NAV";
      } else {
        typeLabel = "CLICK";
      }

      const detail = ev.text || ev.url || ev.tag || "—";
      return `
        <div class="event-item">
          <span class="event-type ${typeClass}">${typeLabel}</span>
          <span class="event-detail">${escapeHtml(detail)}</span>
        </div>`;
    })
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setDebuggerStatus(attached) {
  $("#debugger-status").innerHTML = attached
    ? '<span class="dot on"></span>Attached'
    : '<span class="dot off"></span>Detached';
}

// ---------------------------------------------------------------------------
// Refresh state from background
// ---------------------------------------------------------------------------

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response) return;

  renderEvents(response.events);

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab) {
    $("#active-tab").textContent = tab.title?.slice(0, 30) || "—";
    const app = detectAppFromUrl(tab.url);
    $("#detected-app").textContent = app || "Generic";

    const attached = response.debuggerAttached?.includes(tab.id);
    setDebuggerStatus(attached);
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

$("#btn-attach").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: "ATTACH_DEBUGGER", tabId: tab.id });
  if (res?.ok) setDebuggerStatus(true);
  else alert("Attach failed: " + (res?.error || "unknown"));
});

$("#btn-detach").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: "DETACH_DEBUGGER", tabId: tab.id });
  if (res?.ok) setDebuggerStatus(false);
});

$("#btn-context").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: "READ_PAGE_CONTEXT", tabId: tab.id });
  if (res?.ok) {
    console.log("Page context:", res.context);
    alert(`Title: ${res.context.title}\nHeadings: ${res.context.headings?.length || 0}`);
  } else {
    alert("Failed: " + (res?.error || "unknown"));
  }
});

$("#btn-screenshot").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT", tabId: tab.id });
  if (res?.ok && res.dataUrl) {
    const preview = $("#screenshot-preview");
    $("#screenshot-img").src = res.dataUrl;
    preview.style.display = "block";
  } else {
    alert("Screenshot failed: " + (res?.error || "unknown"));
  }
});

// ---------------------------------------------------------------------------
// WebMCP scanning
// ---------------------------------------------------------------------------

$("#btn-webmcp").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const section = $("#webmcp-section");
  const statusEl = $("#webmcp-status");
  const toolsEl = $("#webmcp-tools");

  section.style.display = "";
  statusEl.innerHTML = '<span class="status-label">Status</span><span class="status-value">Scanning...</span>';
  toolsEl.innerHTML = "";

  const res = await chrome.runtime.sendMessage({ type: "SCAN_WEBMCP", tabId: tab.id });

  if (res?.ok && res.available) {
    statusEl.innerHTML = `<span class="status-label">Status</span><span class="status-value"><span class="dot on"></span>${res.tools.length} tool(s) found</span>`;

    if (res.tools.length === 0) {
      toolsEl.innerHTML = '<div class="empty-state">modelContext detected but no tools registered.</div>';
    } else {
      toolsEl.innerHTML = res.tools.map((t) => `
        <div class="event-item" style="flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 6px; width: 100%;">
            <span class="event-type" style="background: #0d948833; color: #0d9488;">${escapeHtml(t.type || "tool").toUpperCase()}</span>
            <strong style="font-size: 12px;">${escapeHtml(t.name)}</strong>
          </div>
          <div style="font-size: 11px; color: var(--text-dim); line-height: 1.4;">${escapeHtml(t.description).slice(0, 120)}</div>
        </div>
      `).join("");
    }
  } else if (res?.ok && !res.available) {
    statusEl.innerHTML = '<span class="status-label">Status</span><span class="status-value"><span class="dot off"></span>Not available</span>';
    toolsEl.innerHTML = '<div class="empty-state">WebMCP not detected on this page.<br>Enable chrome://flags/#enable-webmcp-testing</div>';
  } else {
    statusEl.innerHTML = `<span class="status-label">Status</span><span class="status-value"><span class="dot off"></span>Error</span>`;
    toolsEl.innerHTML = `<div class="empty-state">${escapeHtml(res?.error || "Scan failed")}</div>`;
  }
});

// Initial load
refresh();
