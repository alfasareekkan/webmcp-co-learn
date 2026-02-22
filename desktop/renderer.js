/* ===== State ===== */
const state = {
  connected: false,
  ws: null,
  events: [],
  screenshot: null,
  chatMessages: [],
  aiThinking: false,
  aiEnabled: false,
  agentStatus: { status: "idle" },
  providers: [],
  activeModels: { agent: null, guidance: null },
  sidebarOpen: true,
  chatRatio: 0.45,
  webmcp: { available: false, tools: [], url: null },
  guidanceTaskSummary: null,
  guidanceTotalSteps: 0,
  guidanceSuggestions: [],
};

/* ===== DOM refs ===== */
const $ = (id) => document.getElementById(id);
const app = $("app");
const sidebar = $("sidebar");
const sidebarToggle = $("sidebarToggle");
const connBadge = $("connBadge");
const eventList = $("eventList");
const mainContent = $("mainContent");
const mirrorViewport = $("mirrorViewport");
const mirrorMeta = $("mirrorMeta");
const drawBtn = $("drawBtn");
const savedStrip = $("savedStrip");
const chatMessages = $("chatMessages");
const chatEmpty = $("chatEmpty");
const chatInput = $("chatInput");
const chatForm = $("chatForm");
const chatSendBtn = $("chatSendBtn");
const thinkingBadge = $("thinkingBadge");
const agentBadge = $("agentBadge");
const modelSelector = $("modelSelector");
const modelBtn = $("modelBtn");
const modelLabel = $("modelLabel");
const modelDropdown = $("modelDropdown");
const resizer = $("resizer");
const webmcpScanBtn = $("webmcpScanBtn");
const webmcpPanel = $("webmcpPanel");
const webmcpStatusBar = $("webmcpStatusBar");
const webmcpToolList = $("webmcpToolList");

/* ===== WebSocket ===== */
const WS_URL = "ws://localhost:3001?role=dashboard";
const RECONNECT_DELAY = 2000;
let reconnectTimer = null;

function wsConnect() {
  if (state.ws?.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    updateConnectionUI();
  };
  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
    state.connected = false;
    updateConnectionUI();
    reconnectTimer = setTimeout(wsConnect, RECONNECT_DELAY);
  };
  ws.onerror = () => ws.close();
}

function wsSend(data) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

/* ===== Message handler ===== */
function handleMessage(data) {
  switch (data.type) {
    case "INIT":
      state.events = data.events || [];
      if (data.screenshot) state.screenshot = data.screenshot;
      if (data.aiEnabled !== undefined) state.aiEnabled = data.aiEnabled;
      if (data.providers) state.providers = data.providers;
      if (data.activeAgentModel || data.activeGuidanceModel) {
        state.activeModels = { agent: data.activeAgentModel, guidance: data.activeGuidanceModel };
      }
      if (data.webmcp) state.webmcp = data.webmcp;
      renderEvents();
      renderMirror();
      renderModelSelector();
      renderWebMCP();
      break;
    case "WEBMCP_UPDATE":
      state.webmcp = data.webmcp || { available: false, tools: [] };
      renderWebMCP();
      break;
    case "MODEL_CHANGED":
      state.activeModels = { agent: data.activeAgentModel, guidance: data.activeGuidanceModel };
      renderModelSelector();
      break;
    case "EVENT":
      state.events = [...state.events.slice(-200), data.event];
      renderEvents();
      break;
    case "SCREENSHOT":
      state.screenshot = { dataUrl: data.dataUrl, url: data.url, timestamp: data.timestamp };
      renderMirror();
      break;
    case "CHAT_MESSAGE":
      state.chatMessages = [
        ...state.chatMessages.filter((m) => !m.isLiveStep),
        {
          text: data.text, sender: data.sender, timestamp: data.timestamp,
          context: data.context, image: data.image || null,
          highlights: data.highlights || [], guidance: data.guidance || [],
          agentResult: data.agentResult || null,
        },
      ];
      renderChat();
      break;
    case "AI_THINKING":
      state.aiThinking = data.thinking;
      updateThinkingUI();
      renderChat();
      break;
    case "AGENT_STATUS":
      state.agentStatus = { status: data.status, message: data.message };
      updateThinkingUI();
      renderChat();
      break;
    case "AGENT_STEP": {
      const idx = state.chatMessages.findIndex((m) => m.sender === "agent-step" && m.isLiveStep);
      const stepMsg = {
        text: data.step.description, sender: "agent-step",
        timestamp: data.timestamp, agentAction: data.step.action, isLiveStep: true,
        executionMode: data.executionMode || "langgraph-dom",
      };
      if (idx >= 0) {
        state.chatMessages[idx] = stepMsg;
      } else {
        state.chatMessages.push(stepMsg);
      }
      renderChat();
      break;
    }
    case "GUIDANCE_SESSION_START":
      state.guidanceTaskSummary = data.taskSummary;
      state.guidanceTotalSteps = data.totalSteps || 0;
      state.guidanceSuggestions = [];
      renderChat();
      break;
    case "STEP_PROGRESS":
      state.guidanceTaskSummary = data.taskSummary || state.guidanceTaskSummary;
      state.guidanceTotalSteps = data.totalSteps || state.guidanceTotalSteps;
      state.chatMessages = [
        ...state.chatMessages.filter((m) => !m.isStepProgress),
        {
          isStepProgress: true,
          stepNumber: data.stepNumber,
          totalSteps: data.totalSteps,
          instruction: data.instruction,
          image: data.image,
          guidance: data.guidance,
          timestamp: Date.now(),
        },
      ];
      renderChat();
      renderMirror();
      break;
    case "TASK_COMPLETE":
      state.guidanceSuggestions = data.suggestions || [];
      state.chatMessages.push({
        text: data.message,
        sender: "ai",
        timestamp: Date.now(),
        isTaskComplete: true,
        suggestions: state.guidanceSuggestions,
      });
      state.guidanceTaskSummary = null;
      renderChat();
      break;
    case "GUIDANCE_ABANDONED":
      state.guidanceTaskSummary = null;
      state.guidanceSuggestions = [];
      state.chatMessages.push({
        text: "\u26A0 " + (data.reason || "Guidance stopped"),
        sender: "system",
        timestamp: Date.now(),
      });
      renderChat();
      break;
  }
}

/* ===== Render helpers ===== */
function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTimeSec(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderText(text) {
  if (!text) return "";
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\n/g, "<br>");
}

const TYPE_META = {
  USER_CLICK: { label: "CLICK", cls: "click" },
  USER_INPUT: { label: "INPUT", cls: "input" },
  NAVIGATION: { label: "NAV", cls: "nav" },
  CONTENT_READY: { label: "READY", cls: "ready" },
  CHAT_MESSAGE: { label: "CHAT", cls: "chat" },
};

function getAppFromUrl(url) {
  if (!url) return null;
  if (url.includes("figma.com")) return "Figma";
  if (url.includes("docs.google.com/spreadsheets")) return "Sheets";
  if (url.includes("notion.so")) return "Notion";
  if (url.includes("miro.com")) return "Miro";
  try { return new URL(url).hostname; } catch { return null; }
}

const ACTION_ICONS = {
  click: "\u25B6", type: "\u2328", scroll: "\u2195",
  navigate: "\uD83C\uDF10", press_key: "\u2318", observe: "\uD83D\uDC41", wait: "\u23F3",
  webmcp: "\u26A1",
};

const HIGHLIGHT_COLORS = ["#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50", "#9C27B0", "#2196F3"];

function senderLabel(s) {
  return { user: "You", ai: "CoLearn AI", system: "System", "agent-step": "Agent" }[s] || s;
}
function senderClass(s) {
  return { user: "self", ai: "ai", system: "system", "agent-step": "agent-step" }[s] || "other";
}

/* ===== Connection UI ===== */
function updateConnectionUI() {
  connBadge.textContent = state.connected ? "Live" : "Offline";
  connBadge.className = `conn-badge ${state.connected ? "on" : "off"}`;
  chatInput.disabled = !state.connected || isBusy();
  chatSendBtn.disabled = !state.connected || !chatInput.value.trim();
  chatInput.placeholder = state.connected
    ? "Ask a question or give a command..."
    : "Connecting...";
}

function isBusy() {
  return state.aiThinking || state.agentStatus.status === "running";
}

function updateThinkingUI() {
  thinkingBadge.style.display = state.aiThinking ? "" : "none";
  agentBadge.style.display = state.agentStatus.status === "running" ? "" : "none";
  chatInput.disabled = !state.connected || isBusy();
  if (isBusy()) {
    chatInput.placeholder = state.agentStatus.status === "running"
      ? "Agent is working..." : "AI is analyzing the screen...";
    chatSendBtn.style.display = "none";
    if (!$("chatStopBtn")) {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.id = "chatStopBtn";
      stopBtn.className = "chat-stop";
      stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop';
      stopBtn.onclick = () => {
        wsSend({ type: "STOP_CHAT" });
        state.aiThinking = false;
        state.agentStatus = { status: "idle" };
        updateThinkingUI();
      };
      chatForm.appendChild(stopBtn);
    }
  } else {
    chatInput.placeholder = state.connected
      ? "Ask a question or give a command..." : "Connecting...";
    chatSendBtn.style.display = "";
    const stopBtn = $("chatStopBtn");
    if (stopBtn) stopBtn.remove();
  }
}

/* ===== Sidebar ===== */
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  app.classList.toggle("sidebar-collapsed", !state.sidebarOpen);
  sidebar.classList.toggle("hidden", !state.sidebarOpen);
  sidebarToggle.classList.toggle("collapsed", !state.sidebarOpen);
  sidebarToggle.innerHTML = state.sidebarOpen ? "&#9664;" : "&#9654;";
}

function renderEvents() {
  if (state.events.length === 0) {
    eventList.innerHTML = '<div class="empty">Waiting for events...<br><span>Browse other tabs with the extension active</span></div>';
    return;
  }
  eventList.innerHTML = state.events.map((ev) => {
    const meta = TYPE_META[ev.type] || { label: ev.type, cls: "default" };
    const appName = ev.app || getAppFromUrl(ev.url);
    const text = escapeHtml(ev.text || ev.tag || ev.url?.slice(0, 60) || "—");
    return `<div class="event-row">
      <span class="event-badge ${meta.cls}">${meta.label}</span>
      <div class="event-body">
        <span class="event-text">${text}</span>
        <span class="event-meta">
          ${appName ? `<span class="event-app">${escapeHtml(appName)}</span>` : ""}
          <span class="event-time">${formatTimeSec(ev.timestamp || ev.receivedAt)}</span>
        </span>
      </div>
    </div>`;
  }).join("");
  eventList.scrollTop = eventList.scrollHeight;
}

/* ===== Screen Mirror ===== */
function renderMirror() {
  const ss = state.screenshot;
  if (ss?.dataUrl) {
    mirrorViewport.innerHTML = `<img src="${ss.dataUrl}" alt="Remote tab screenshot" />`;
    mirrorMeta.textContent = `${(ss.url || "").slice(0, 60)} · ${formatTimeSec(ss.timestamp)}`;
    drawBtn.style.display = "";
  } else {
    mirrorViewport.innerHTML = '<div class="mirror-empty"><div class="mirror-icon">&#128421;</div><p>No screenshot yet</p><span>Attach the debugger from the extension popup, then click Screenshot</span></div>';
    mirrorMeta.textContent = "";
    drawBtn.style.display = "none";
  }
}

/* ===== Chat ===== */
function renderChat() {
  const msgs = state.chatMessages;
  const busy = isBusy();

  if (msgs.length === 0 && !busy) {
    chatEmpty.style.display = "";
  } else {
    chatEmpty.style.display = "none";
  }

  const existingEmpty = chatMessages.querySelector(".chat-empty");
  let html = "";

  for (const msg of msgs) {
    if (msg.isStepProgress) {
      html += `<div class="chat-bubble step-progress">
        <div class="bubble-sender">Step</div>
        <div class="step-progress-text">\uD83D\uCCCD Step ${msg.stepNumber} of ${msg.totalSteps} — ${escapeHtml(msg.instruction)}</div>
        ${msg.image ? `<div class="annotated-image-wrap"><img src="${msg.image}" alt="Step" class="annotated-image" onclick="this.classList.toggle('expanded')" /></div>` : ""}
        <div class="bubble-meta">Waiting for you...</div>
      </div>`;
      continue;
    }
    if (msg.isTaskComplete) {
      const sugs = msg.suggestions || [];
      html += `<div class="chat-bubble ai task-complete">
        <div class="bubble-sender">CoLearn AI</div>
        <div class="bubble-text">${renderText(msg.text)}</div>
        ${sugs.length ? `<div class="suggestion-chips" data-suggestions='${JSON.stringify(sugs).replace(/'/g, "&#39;")}'>${sugs.map((s, i) => `<button type="button" class="suggestion-chip" data-idx="${i}">${escapeHtml(s)}</button>`).join("")}</div>` : ""}
        <div class="bubble-meta">${formatTime(msg.timestamp)}</div>
      </div>`;
      continue;
    }
    if (msg.sender === "agent-step") {
      const icon = ACTION_ICONS[msg.agentAction] || "\u2699";
      const mode = msg.executionMode || "langgraph-dom";
      const modeLabel = mode === "webmcp" ? "WebMCP" : mode === "langgraph-nav" ? "Navigate" : "DOM";
      const modeClass = mode === "webmcp" ? "mode-webmcp" : mode === "langgraph-nav" ? "mode-nav" : "mode-dom";
      html += `<div class="chat-bubble agent-step">
        <div class="agent-step-inner">
          <span class="agent-step-icon">${icon}</span>
          <span class="exec-mode-badge ${modeClass}">${modeLabel}</span>
          <span class="agent-step-text">${escapeHtml(msg.text)}</span>
          <span class="agent-step-pulse"></span>
        </div>
      </div>`;
      continue;
    }

    const cls = senderClass(msg.sender);
    let inner = `<div class="bubble-sender">${senderLabel(msg.sender)}</div>`;

    if (msg.image) {
      inner += `<div class="annotated-image-wrap">
        <img src="${msg.image}" alt="Annotated screenshot" class="annotated-image" onclick="this.classList.toggle('expanded')" />
        <div class="image-hint">Click to expand</div>
      </div>`;
    }
    if (msg.highlights?.length) {
      inner += '<div class="highlight-legend">' + msg.highlights.map((h, i) =>
        `<div class="legend-item"><span class="legend-dot" style="background:${HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length]}"></span><span class="legend-label">${escapeHtml(h.label)}</span>${h.reason ? `<span class="legend-reason">— ${escapeHtml(h.reason)}</span>` : ""}</div>`
      ).join("") + "</div>";
    }
    if (msg.guidance?.length) {
      const gid = "guide-" + Math.random().toString(36).slice(2, 8);
      inner += `<div class="guidance-actions">
        <button class="guidance-btn" data-guidance='${JSON.stringify(msg.guidance).replace(/'/g, "&#39;")}' onclick="toggleGuidance(this)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Show on Page
        </button>
      </div>`;
    }
    if (msg.agentResult) {
      const ar = msg.agentResult;
      inner += `<div class="agent-result-badge"><span class="agent-result-icon">${ar.status === "completed" ? "\u2713" : "\u26A0"}</span><span>Task ${ar.status} in ${ar.steps} step${ar.steps !== 1 ? "s" : ""}</span></div>`;
    }
    inner += `<div class="bubble-text">${renderText(msg.text)}</div>`;
    if (msg.context?.url) {
      inner += `<div class="bubble-context">Context: ${escapeHtml(msg.context.title || msg.context.url)}</div>`;
    }
    inner += `<div class="bubble-meta">${formatTime(msg.timestamp)}</div>`;

    html += `<div class="chat-bubble ${cls}">${inner}</div>`;
  }

  if (state.aiThinking) {
    html += `<div class="chat-bubble ai thinking">
      <div class="bubble-sender">CoLearn AI</div>
      <div class="thinking-status">Capturing screen &amp; analyzing...</div>
      <div class="thinking-dots"><span></span><span></span><span></span></div>
    </div>`;
  }

  if (state.agentStatus.status === "running" && !msgs.some((m) => m.isLiveStep)) {
    html += `<div class="chat-bubble agent-thinking">
      <div class="bubble-sender">Browser Agent</div>
      <div class="thinking-status">${escapeHtml(state.agentStatus.message || "Analyzing the page...")}</div>
      <div class="agent-progress-bar"><div class="agent-progress-fill"></div></div>
    </div>`;
  }

  const scrollEl = chatMessages;
  const wasAtBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;

  // Keep the empty placeholder, replace the rest
  const frag = document.createRange().createContextualFragment(html);
  // Remove all children except #chatEmpty
  while (chatMessages.lastChild && chatMessages.lastChild !== chatEmpty) {
    chatMessages.removeChild(chatMessages.lastChild);
  }
  // Remove anything before chatEmpty too
  while (chatMessages.firstChild && chatMessages.firstChild !== chatEmpty) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
  chatMessages.appendChild(frag);

  if (wasAtBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
}

chatMessages.addEventListener("click", (e) => {
  const chip = e.target.closest(".suggestion-chip");
  if (!chip) return;
  const container = chip.closest(".suggestion-chips");
  if (!container || !container.dataset.suggestions) return;
  try {
    const suggestions = JSON.parse(container.dataset.suggestions.replace(/&#39;/g, "'"));
    const idx = parseInt(chip.dataset.idx, 10);
    if (Number.isFinite(idx) && suggestions[idx]) {
      wsSend({ type: "CHAT_MESSAGE", text: suggestions[idx] });
    }
  } catch (_) {}
});

// Guidance toggle handler (global)
window.toggleGuidance = function (btn) {
  const isActive = btn.classList.contains("active");
  if (isActive) {
    wsSend({ type: "CLEAR_GUIDANCE" });
    btn.classList.remove("active");
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Show on Page';
    const status = btn.parentElement.querySelector(".guidance-status");
    if (status) status.remove();
  } else {
    const guides = JSON.parse(btn.dataset.guidance);
    wsSend({ type: "SHOW_GUIDANCE", guides });
    btn.classList.add("active");
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg> Clear Overlay';
    const status = document.createElement("span");
    status.className = "guidance-status";
    status.textContent = "Showing on page";
    btn.parentElement.appendChild(status);
  }
};

/* ===== WebMCP Panel ===== */
function renderWebMCP() {
  const mcp = state.webmcp;
  if (mcp.available && mcp.tools?.length > 0) {
    webmcpStatusBar.innerHTML = `<span class="webmcp-dot on"></span><span class="webmcp-status-text">${mcp.tools.length} tool(s) active</span>`;
    webmcpToolList.innerHTML = mcp.tools.map((t) => `
      <div class="webmcp-tool-item">
        <div class="webmcp-tool-header">
          <span class="webmcp-tool-type">${escapeHtml((t.type || "tool").toUpperCase())}</span>
          <span class="webmcp-tool-name">${escapeHtml(t.name)}</span>
        </div>
        <div class="webmcp-tool-desc">${escapeHtml((t.description || "").slice(0, 100))}</div>
      </div>
    `).join("");
  } else if (mcp.available) {
    webmcpStatusBar.innerHTML = '<span class="webmcp-dot on"></span><span class="webmcp-status-text">Active (no tools)</span>';
    webmcpToolList.innerHTML = "";
  } else {
    webmcpStatusBar.innerHTML = '<span class="webmcp-dot off"></span><span class="webmcp-status-text">Not detected</span>';
    webmcpToolList.innerHTML = "";
  }
}

webmcpScanBtn.addEventListener("click", () => {
  wsSend({ type: "WEBMCP_SCAN" });
  webmcpStatusBar.innerHTML = '<span class="webmcp-dot off"></span><span class="webmcp-status-text">Scanning...</span>';
});

/* ===== Model Selector ===== */
function renderModelSelector() {
  if (!state.providers?.length) {
    modelSelector.style.display = "none";
    return;
  }
  modelSelector.style.display = "";
  const allModels = state.providers.flatMap((p) => p.models.map((m) => ({ ...m, providerName: p.name })));
  const cur = state.activeModels?.agent;
  const label = allModels.find((m) => m.provider === cur?.provider && m.id === cur?.model)?.label || "Not set";
  modelLabel.textContent = label;

  const curAgent = state.activeModels?.agent;
  const curGuide = state.activeModels?.guidance;

  modelDropdown.innerHTML = `
    <div class="model-dropdown-section">
      <div class="model-dropdown-title">Agent Model</div>
      ${allModels.map((m) => `<button class="model-option ${m.provider === curAgent?.provider && m.id === curAgent?.model ? "active" : ""}" data-target="agent" data-provider="${m.provider}" data-model="${m.id}">
        <span class="model-option-label">${escapeHtml(m.label)}</span>
        <span class="model-option-tier tier-${m.tier}">${m.tier}</span>
        <span class="model-option-provider">${escapeHtml(m.providerName)}</span>
      </button>`).join("")}
    </div>
    <div class="model-dropdown-section">
      <div class="model-dropdown-title">Guidance Model</div>
      ${allModels.map((m) => `<button class="model-option ${m.provider === curGuide?.provider && m.id === curGuide?.model ? "active" : ""}" data-target="guidance" data-provider="${m.provider}" data-model="${m.id}">
        <span class="model-option-label">${escapeHtml(m.label)}</span>
        <span class="model-option-tier tier-${m.tier}">${m.tier}</span>
        <span class="model-option-provider">${escapeHtml(m.providerName)}</span>
      </button>`).join("")}
    </div>`;
}

/* ===== Resizer ===== */
let dragging = false;
resizer.addEventListener("mousedown", (e) => { e.preventDefault(); dragging = true; resizer.classList.add("active"); });
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const rect = mainContent.getBoundingClientRect();
  const y = e.clientY - rect.top;
  state.chatRatio = Math.min(0.85, Math.max(0.15, 1 - y / rect.height));
  const mp = ((1 - state.chatRatio) * 100).toFixed(2);
  const cp = (state.chatRatio * 100).toFixed(2);
  mainContent.style.gridTemplateRows = `${mp}% 6px ${cp}%`;
});
window.addEventListener("mouseup", () => { dragging = false; resizer.classList.remove("active"); });

/* ===== Event Bindings ===== */
sidebarToggle.addEventListener("click", toggleSidebar);

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  wsSend({ type: "CHAT_MESSAGE", text });
  chatInput.value = "";
  chatSendBtn.disabled = true;
});

chatInput.addEventListener("input", () => {
  chatSendBtn.disabled = !state.connected || !chatInput.value.trim() || isBusy();
});

modelBtn.addEventListener("click", () => {
  modelDropdown.classList.toggle("hidden");
});

modelDropdown.addEventListener("click", (e) => {
  const opt = e.target.closest(".model-option");
  if (!opt) return;
  wsSend({ type: "SET_MODEL", target: opt.dataset.target, provider: opt.dataset.provider, model: opt.dataset.model });
  modelDropdown.classList.add("hidden");
});

document.addEventListener("click", (e) => {
  if (!modelSelector.contains(e.target)) modelDropdown.classList.add("hidden");
});

/* ===== Drawing (simplified -- opens overlay) ===== */
const savedDrawings = [];

drawBtn.addEventListener("click", () => {
  if (!state.screenshot?.dataUrl) return;
  openDrawing(state.screenshot.dataUrl);
});

function openDrawing(imageUrl) {
  const overlay = $("drawingOverlay");
  const container = $("drawingCanvasContainer");
  const base = $("drawingBase");
  const over = $("drawingOverlayCanvas");
  overlay.classList.remove("hidden");

  const img = new Image();
  img.onload = () => {
    const cw = container.clientWidth, ch = container.clientHeight;
    const scale = Math.min(cw / img.width, ch / img.height, 1);
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    base.width = w; base.height = h;
    over.width = w; over.height = h;
    base.getContext("2d").drawImage(img, 0, 0, w, h);

    buildDrawingToolbar(overlay, base, over, img, scale);
  };
  img.src = imageUrl;
}

function buildDrawingToolbar(overlay, base, over, srcImg, scale) {
  const toolbar = $("drawingToolbar");
  let tool = "pen", color = "#FF3B6F", size = 4, drawing = false, startPos = null;
  const history = [];

  toolbar.innerHTML = `
    <div class="toolbar-group">
      <button class="tool-btn active" data-tool="pen" title="Pen">&#9998;</button>
      <button class="tool-btn" data-tool="rect" title="Rectangle">&#9634;</button>
      <button class="tool-btn" data-tool="arrow" title="Arrow">&#8599;</button>
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group colors">
      ${["#FF3B6F","#00BCD4","#FF9800","#4CAF50","#9C27B0","#2196F3","#FFFFFF","#FFD600"].map((c) => `<button class="color-btn ${c === color ? "active" : ""}" style="background:${c}" data-color="${c}"></button>`).join("")}
    </div>
    <div class="toolbar-divider"></div>
    <div class="toolbar-group sizes">
      ${[2,4,6,10].map((s) => `<button class="size-btn ${s === size ? "active" : ""}" data-size="${s}"><span class="size-dot" style="width:${s+4}px;height:${s+4}px"></span></button>`).join("")}
    </div>
    <div class="toolbar-spacer"></div>
    <div class="toolbar-group">
      <button class="save-btn" id="drawSave">Save</button>
      <button class="close-btn" id="drawClose">Close</button>
    </div>`;

  toolbar.addEventListener("click", (e) => {
    const tb = e.target.closest("[data-tool]");
    if (tb) { tool = tb.dataset.tool; toolbar.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b === tb)); }
    const cb = e.target.closest("[data-color]");
    if (cb) { color = cb.dataset.color; toolbar.querySelectorAll(".color-btn").forEach((b) => b.classList.toggle("active", b === cb)); }
    const sb = e.target.closest("[data-size]");
    if (sb) { size = +sb.dataset.size; toolbar.querySelectorAll(".size-btn").forEach((b) => b.classList.toggle("active", b === sb)); }
  });

  $("drawSave").onclick = () => {
    const dataUrl = base.toDataURL("image/png");
    savedDrawings.push({ dataUrl, timestamp: Date.now() });
    renderSavedDrawings();
    overlay.classList.add("hidden");
  };
  $("drawClose").onclick = () => overlay.classList.add("hidden");

  const ctx = base.getContext("2d");
  const oCtx = over.getContext("2d");

  over.onmousedown = (e) => {
    drawing = true;
    history.push(base.toDataURL());
    const rect = over.getBoundingClientRect();
    startPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (tool === "pen") {
      ctx.beginPath();
      ctx.moveTo(startPos.x, startPos.y);
      ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = "round"; ctx.lineJoin = "round";
    }
  };
  over.onmousemove = (e) => {
    if (!drawing) return;
    const rect = over.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (tool === "pen") { ctx.lineTo(pos.x, pos.y); ctx.stroke(); }
    else {
      oCtx.clearRect(0, 0, over.width, over.height);
      oCtx.strokeStyle = color; oCtx.lineWidth = size; oCtx.lineCap = "round";
      const dx = pos.x - startPos.x, dy = pos.y - startPos.y;
      if (tool === "rect") { oCtx.strokeRect(startPos.x, startPos.y, dx, dy); }
      else if (tool === "arrow") {
        oCtx.beginPath(); oCtx.moveTo(startPos.x, startPos.y); oCtx.lineTo(pos.x, pos.y); oCtx.stroke();
        const a = Math.atan2(dy, dx), hl = 14;
        oCtx.beginPath(); oCtx.fillStyle = color;
        oCtx.moveTo(pos.x, pos.y);
        oCtx.lineTo(pos.x - hl * Math.cos(a - Math.PI / 6), pos.y - hl * Math.sin(a - Math.PI / 6));
        oCtx.lineTo(pos.x - hl * Math.cos(a + Math.PI / 6), pos.y - hl * Math.sin(a + Math.PI / 6));
        oCtx.fill();
      }
    }
  };
  over.onmouseup = (e) => {
    if (!drawing) return;
    drawing = false;
    if (tool === "pen") { ctx.closePath(); }
    else {
      const rect = over.getBoundingClientRect();
      const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      oCtx.clearRect(0, 0, over.width, over.height);
      ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = "round";
      const dx = pos.x - startPos.x, dy = pos.y - startPos.y;
      if (tool === "rect") { ctx.strokeRect(startPos.x, startPos.y, dx, dy); }
      else if (tool === "arrow") {
        ctx.beginPath(); ctx.moveTo(startPos.x, startPos.y); ctx.lineTo(pos.x, pos.y); ctx.stroke();
        const a = Math.atan2(dy, dx), hl = 14;
        ctx.beginPath(); ctx.fillStyle = color;
        ctx.moveTo(pos.x, pos.y);
        ctx.lineTo(pos.x - hl * Math.cos(a - Math.PI / 6), pos.y - hl * Math.sin(a - Math.PI / 6));
        ctx.lineTo(pos.x - hl * Math.cos(a + Math.PI / 6), pos.y - hl * Math.sin(a + Math.PI / 6));
        ctx.fill();
      }
    }
  };
}

function renderSavedDrawings() {
  if (savedDrawings.length === 0) { savedStrip.style.display = "none"; return; }
  savedStrip.style.display = "";
  savedStrip.innerHTML = savedDrawings.map((d, i) =>
    `<img src="${d.dataUrl}" alt="Drawing ${i + 1}" class="saved-thumb" title="Saved ${formatTimeSec(d.timestamp)}" />`
  ).join("");
}

/* ===== Init ===== */
wsConnect();
