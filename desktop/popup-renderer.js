/* ===== Popup Chat Renderer ===== */
const state = {
  connected: false,
  ws: null,
  chatMessages: [],
  aiThinking: false,
  agentStatus: { status: "idle" },
  providers: [],
  activeModels: { agent: null, guidance: null },
  pinned: true,
};

const $ = (id) => document.getElementById(id);
const popupStatus = $("popupStatus");
const popupMessages = $("popupMessages");
const popupEmpty = $("popupEmpty");
const popupInput = $("popupInput");
const popupForm = $("popupForm");
const popupSendBtn = $("popupSendBtn");
const popupThinking = $("popupThinking");
const popupAgent = $("popupAgent");
const pinBtn = $("pinBtn");
const mainBtn = $("mainBtn");
const closeBtn = $("closeBtn");

/* ===== WebSocket ===== */
const WS_URL = "wss://webmcp-co-learn-production.up.railway.app?role=dashboard";
let reconnectTimer = null;

function wsConnect() {
  if (state.ws?.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.onopen = () => { state.connected = true; updateUI(); };
  ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    state.connected = false; updateUI();
    reconnectTimer = setTimeout(wsConnect, 2000);
  };
  ws.onerror = () => ws.close();
}

function wsSend(data) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

/* ===== Message handler ===== */
function handleMessage(data) {
  switch (data.type) {
    case "INIT":
      if (data.providers) state.providers = data.providers;
      if (data.activeAgentModel || data.activeGuidanceModel)
        state.activeModels = { agent: data.activeAgentModel, guidance: data.activeGuidanceModel };
      break;
    case "MODEL_CHANGED":
      state.activeModels = { agent: data.activeAgentModel, guidance: data.activeGuidanceModel };
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
      updateUI(); renderChat();
      break;
    case "AGENT_STATUS":
      state.agentStatus = { status: data.status, message: data.message };
      updateUI(); renderChat();
      break;
    case "AGENT_STEP": {
      const idx = state.chatMessages.findIndex((m) => m.sender === "agent-step" && m.isLiveStep);
      const stepMsg = {
        text: data.step.description, sender: "agent-step",
        timestamp: data.timestamp, agentAction: data.step.action, isLiveStep: true,
      };
      if (idx >= 0) state.chatMessages[idx] = stepMsg;
      else state.chatMessages.push(stepMsg);
      renderChat();
      break;
    }
  }
}

/* ===== Helpers ===== */
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

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ACTION_ICONS = {
  click: "\u25B6", type: "\u2328", scroll: "\u2195",
  navigate: "\uD83C\uDF10", press_key: "\u2318", observe: "\uD83D\uDC41", wait: "\u23F3",
};
const HIGHLIGHT_COLORS = ["#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50", "#9C27B0", "#2196F3"];

function senderLabel(s) {
  return { user: "You", ai: "CoLearn AI", system: "System", "agent-step": "Agent" }[s] || s;
}
function senderClass(s) {
  return { user: "self", ai: "ai", system: "system", "agent-step": "agent-step" }[s] || "other";
}

function isBusy() {
  return state.aiThinking || state.agentStatus.status === "running";
}

/* ===== UI ===== */
function updateUI() {
  popupStatus.className = `popup-status ${state.connected ? "online" : "offline"}`;
  popupInput.disabled = !state.connected || isBusy();
  popupSendBtn.disabled = !state.connected || !popupInput.value.trim() || isBusy();
  popupInput.placeholder = !state.connected
    ? "Connecting..."
    : isBusy()
      ? (state.agentStatus.status === "running" ? "Agent is working..." : "AI is analyzing...")
      : "Ask a question or give a command...";

  popupThinking.style.display = state.aiThinking ? "" : "none";
  popupAgent.style.display = state.agentStatus.status === "running" ? "" : "none";

  // Stop button
  const existingStop = $("popupStopBtn");
  if (isBusy()) {
    popupSendBtn.style.display = "none";
    if (!existingStop) {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button"; stopBtn.id = "popupStopBtn"; stopBtn.className = "chat-stop";
      stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop';
      stopBtn.onclick = () => {
        wsSend({ type: "STOP_CHAT" });
        state.aiThinking = false;
        state.agentStatus = { status: "idle" };
        updateUI();
      };
      popupForm.appendChild(stopBtn);
    }
  } else {
    popupSendBtn.style.display = "";
    if (existingStop) existingStop.remove();
  }
}

function renderChat() {
  const msgs = state.chatMessages;
  const busy = isBusy();

  popupEmpty.style.display = (msgs.length === 0 && !busy) ? "" : "none";

  let html = "";
  for (const msg of msgs) {
    if (msg.sender === "agent-step") {
      const icon = ACTION_ICONS[msg.agentAction] || "\u2699";
      html += `<div class="chat-bubble agent-step"><div class="agent-step-inner"><span class="agent-step-icon">${icon}</span><span class="agent-step-text">${escapeHtml(msg.text)}</span><span class="agent-step-pulse"></span></div></div>`;
      continue;
    }

    const cls = senderClass(msg.sender);
    let inner = `<div class="bubble-sender">${senderLabel(msg.sender)}</div>`;

    if (msg.image) {
      inner += `<div class="annotated-image-wrap"><img src="${msg.image}" alt="Annotated" class="annotated-image" onclick="this.classList.toggle('expanded')" /><div class="image-hint">Click to expand</div></div>`;
    }
    if (msg.highlights?.length) {
      inner += '<div class="highlight-legend">' + msg.highlights.map((h, i) =>
        `<div class="legend-item"><span class="legend-dot" style="background:${HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length]}"></span><span class="legend-label">${escapeHtml(h.label)}</span>${h.reason ? `<span class="legend-reason">— ${escapeHtml(h.reason)}</span>` : ""}</div>`
      ).join("") + "</div>";
    }
    if (msg.guidance?.length) {
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
    if (msg.context?.url) inner += `<div class="bubble-context">Context: ${escapeHtml(msg.context.title || msg.context.url)}</div>`;
    inner += `<div class="bubble-meta">${formatTime(msg.timestamp)}</div>`;

    html += `<div class="chat-bubble ${cls}">${inner}</div>`;
  }

  if (state.aiThinking) {
    html += `<div class="chat-bubble ai thinking"><div class="bubble-sender">CoLearn AI</div><div class="thinking-status">Capturing screen &amp; analyzing...</div><div class="thinking-dots"><span></span><span></span><span></span></div></div>`;
  }
  if (state.agentStatus.status === "running" && !msgs.some((m) => m.isLiveStep)) {
    html += `<div class="chat-bubble agent-thinking"><div class="bubble-sender">Browser Agent</div><div class="thinking-status">${escapeHtml(state.agentStatus.message || "Analyzing the page...")}</div><div class="agent-progress-bar"><div class="agent-progress-fill"></div></div></div>`;
  }

  const wasAtBottom = popupMessages.scrollHeight - popupMessages.scrollTop - popupMessages.clientHeight < 60;
  while (popupMessages.lastChild && popupMessages.lastChild !== popupEmpty)
    popupMessages.removeChild(popupMessages.lastChild);
  while (popupMessages.firstChild && popupMessages.firstChild !== popupEmpty)
    popupMessages.removeChild(popupMessages.firstChild);
  popupMessages.appendChild(document.createRange().createContextualFragment(html));
  if (wasAtBottom) popupMessages.scrollTop = popupMessages.scrollHeight;
}

/* ===== Event Bindings ===== */
popupForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = popupInput.value.trim();
  if (!text) return;
  wsSend({ type: "CHAT_MESSAGE", text });
  popupInput.value = "";
  popupSendBtn.disabled = true;
});

popupInput.addEventListener("input", () => {
  popupSendBtn.disabled = !state.connected || !popupInput.value.trim() || isBusy();
});

pinBtn.addEventListener("click", () => {
  state.pinned = !state.pinned;
  pinBtn.classList.toggle("active", state.pinned);
  pinBtn.title = state.pinned ? "Unpin from top" : "Pin to top";
  window.electronAPI?.togglePin(state.pinned);
});

mainBtn.addEventListener("click", () => window.electronAPI?.focusMain());
closeBtn.addEventListener("click", () => window.electronAPI?.closePopup());

/* ===== Guidance toggle ===== */
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

/* ===== Init ===== */
wsConnect();
