/* ═══════════════════════════════════════════════════════════
   renderer.js — Main window renderer
   Left panel: chat + WebMCP + activity
   Right panel: browser toolbar (tabs + URL bar) + browser content (WebContentsView)
   ═══════════════════════════════════════════════════════════ */

/* ── State ── */
const state = {
  connected:   false,
  ws:          null,
  events:      [],
  chatMessages:[],
  aiThinking:  false,
  aiEnabled:   false,
  agentStatus: { status: "idle" },
  providers:   [],
  activeModels:{ agent: null, guidance: null },
  webmcp:      { available: false, tools: [], url: null },
  guidanceTaskSummary: null,
  guidanceTotalSteps:  0,
  guidanceSuggestions: [],
  guidancePlanSteps: null,
  conversations: [],
  currentThreadId: null,
  // Browser
  browser:     { tabs: [], activeIdx: -1, canGoBack: false, canGoForward: false, currentUrl: "" },
  extConnected: false,
  urlFocused:   false,
};

/* ── DOM refs ── */
const $  = (id) => document.getElementById(id);
const lp = $("lp");

// Left panel
const connBadge    = $("connBadge");
const thinkingBadge= $("thinkingBadge");
const agentBadge   = $("agentBadge");
const modelSelector= $("modelSelector");
const modelBtn     = $("modelBtn");
const modelLabel   = $("modelLabel");
const modelDropdown= $("modelDropdown");
const chatMessages = $("chatMessages");
const chatEmpty    = $("chatEmpty");
const chatInput    = $("chatInput");
const chatForm     = $("chatForm");
const chatSendBtn  = $("chatSendBtn");
const eventList    = $("eventList");
const eventsHd     = $("eventsHd");
const eventsChev   = $("eventsChev");
const webmcpHd     = $("webmcpHd");
const webmcpChev   = $("webmcpChev");
const webmcpScanBtn= $("webmcpScanBtn");
const webmcpPanel  = $("webmcpPanel");
const webmcpStatusBar = $("webmcpStatusBar");
const webmcpToolList  = $("webmcpToolList");

// Divider + right panel
const splitDivider = $("splitDivider");
const dragCapture  = $("dragCapture");

// Browser toolbar
const btabList     = $("btabList");
const btabNew      = $("btabNew");
const bBack        = $("bBack");
const bFwd         = $("bFwd");
const bReload      = $("bReload");
const burlInput    = $("burlInput");
const burlLock     = $("burlLock");
const bExt         = $("bExt");
const bDev         = $("bDev");
const extDot       = $("extDot");

/* ── WebSocket ── */
const WS_URL = "ws://localhost:3001?role=dashboard";
let reconnectTimer = null;

function wsConnect() {
  if (state.ws?.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  ws.onopen  = () => { state.connected = true;  updateConnectionUI(); };
  ws.onclose = () => {
    state.connected = false; updateConnectionUI();
    reconnectTimer = setTimeout(wsConnect, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch {} };
}

function wsSend(data) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

/* ── Message handler ── */
function handleMessage(data) {
  switch (data.type) {
    case "INIT":
      state.events = data.events || [];
      if (data.aiEnabled !== undefined) state.aiEnabled = data.aiEnabled;
      if (data.providers) state.providers = data.providers;
      if (data.activeAgentModel || data.activeGuidanceModel) {
        state.activeModels = { agent: data.activeAgentModel, guidance: data.activeGuidanceModel };
      }
      if (data.webmcp) state.webmcp = data.webmcp;
      if (data.conversations) state.conversations = data.conversations;
      // Auto-create first conversation if none exist
      if (!state.currentThreadId) {
        wsSend({ type: "NEW_CHAT" });
      }
      renderEvents();
      renderModelSelector();
      renderWebMCP();
      renderConversationList();
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
    case "CHAT_MESSAGE":
      // Track threadId from server (auto-created on first message if needed)
      if (data.threadId && !state.currentThreadId) {
        state.currentThreadId = data.threadId;
      }
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
      updateThinkingUI(); renderChat();
      break;
    case "AGENT_STATUS":
      state.agentStatus = { status: data.status, message: data.message };
      updateThinkingUI(); renderChat();
      break;
    case "AGENT_STEP": {
      const idx = state.chatMessages.findIndex((m) => m.sender === "agent-step" && m.isLiveStep);
      const stepMsg = {
        text: data.step.description, sender: "agent-step", timestamp: data.timestamp,
        agentAction: data.step.action, isLiveStep: true,
        executionMode: data.executionMode || "langgraph-dom",
      };
      if (idx >= 0) state.chatMessages[idx] = stepMsg;
      else state.chatMessages.push(stepMsg);
      renderChat();
      break;
    }
    case "GUIDANCE_SESSION_START":
      state.guidanceTaskSummary = data.taskSummary;
      state.guidanceTotalSteps  = data.totalSteps || 0;
      state.guidanceSuggestions = [];
      state.guidancePlanSteps   = data.steps || null;
      renderChat();
      break;
    case "STEP_STATUS_UPDATE":
      if (state.guidancePlanSteps) {
        state.guidancePlanSteps = state.guidancePlanSteps.map((s) => {
          if (s.stepNumber === data.completedStep) return { ...s, status: "completed" };
          if (s.stepNumber === data.nextStep) return { ...s, status: "active" };
          return s;
        });
        renderChat();
      }
      break;
    case "STEP_PROGRESS":
      state.guidanceTaskSummary = data.taskSummary || state.guidanceTaskSummary;
      state.guidanceTotalSteps  = data.totalSteps  || state.guidanceTotalSteps;
      state.chatMessages = [
        ...state.chatMessages.filter((m) => !m.isStepProgress),
        {
          isStepProgress: true, stepNumber: data.stepNumber,
          totalSteps: data.totalSteps, instruction: data.instruction,
          image: data.image, guidance: data.guidance, timestamp: Date.now(),
        },
      ];
      renderChat();
      break;
    case "TASK_COMPLETE":
      state.guidanceSuggestions = data.suggestions || [];
      state.chatMessages.push({
        text: data.message, sender: "ai", timestamp: Date.now(),
        isTaskComplete: true, suggestions: state.guidanceSuggestions,
      });
      state.guidanceTaskSummary = null;
      if (state.guidancePlanSteps) {
        state.guidancePlanSteps = state.guidancePlanSteps.map(s => ({ ...s, status: "completed" }));
      }
      renderChat();
      break;
    case "GUIDANCE_ABANDONED":
      state.guidanceTaskSummary = null;
      state.guidanceSuggestions = [];
      state.guidancePlanSteps = null;
      state.chatMessages.push({ text: "\u26A0 " + (data.reason || "Guidance stopped"), sender: "system", timestamp: Date.now() });
      renderChat();
      break;

    // ── Conversation management ──
    case "NEW_CHAT_CREATED":
      state.currentThreadId = data.threadId;
      state.chatMessages = [];
      state.guidanceTaskSummary = null;
      state.guidancePlanSteps = null;
      state.guidanceSuggestions = [];
      if (data.conversations) state.conversations = data.conversations;
      renderConversationList();
      renderChat();
      break;
    case "CHAT_SWITCHED":
      state.currentThreadId = data.threadId;
      state.guidanceTaskSummary = null;
      state.guidancePlanSteps = null;
      state.guidanceSuggestions = [];
      state.chatMessages = (data.messages || []).map((m) => ({
        text: m.text,
        sender: m.role === "user" ? "user" : m.role === "system" ? "system" : "ai",
        timestamp: m.timestamp,
      }));
      if (data.conversations) state.conversations = data.conversations;
      renderConversationList();
      renderChat();
      break;
    case "CHAT_DELETED":
      if (data.conversations) state.conversations = data.conversations;
      if (state.currentThreadId === data.threadId) {
        wsSend({ type: "NEW_CHAT" });
      } else {
        renderConversationList();
      }
      break;
    case "CONVERSATIONS_LIST":
      if (data.conversations) state.conversations = data.conversations;
      renderConversationList();
      break;

    case "SCREENSHOT":
      // Screenshot received — no mirror panel in new UI, but store for future use
      break;
  }
}

/* ── Connection UI ── */
function updateConnectionUI() {
  connBadge.textContent = state.connected ? "Live" : "Offline";
  connBadge.className   = `conn-badge ${state.connected ? "on" : "off"}`;
  chatInput.disabled    = !state.connected || isBusy();
  chatSendBtn.disabled  = !state.connected || !chatInput.value.trim();
  chatInput.placeholder = state.connected ? "Ask a question or give a command…" : "Connecting…";
}

function isBusy() {
  return state.aiThinking || state.agentStatus.status === "running";
}

function updateThinkingUI() {
  thinkingBadge.style.display = state.aiThinking ? "" : "none";
  agentBadge.style.display    = state.agentStatus.status === "running" ? "" : "none";
  chatInput.disabled = !state.connected || isBusy();
  if (isBusy()) {
    chatInput.placeholder = state.agentStatus.status === "running"
      ? "Agent is working…" : "AI is analyzing…";
    chatSendBtn.style.display = "none";
    if (!$("chatStopBtn")) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.id = "chatStopBtn"; btn.className = "chat-stop";
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop';
      btn.onclick = () => {
        wsSend({ type: "STOP_CHAT" });
        state.aiThinking = false;
        state.agentStatus = { status: "idle" };
        updateThinkingUI();
      };
      chatForm.appendChild(btn);
    }
  } else {
    chatInput.placeholder = state.connected ? "Ask a question or give a command…" : "Connecting…";
    chatSendBtn.style.display = "";
    $("chatStopBtn")?.remove();
  }
}

/* ── Helpers ── */
function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatTimeSec(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function escHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function renderText(text) {
  if (!text) return "";
  return escHtml(text)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\n/g, "<br>");
}
function getAppFromUrl(url) {
  if (!url) return null;
  if (url.includes("figma.com"))                    return "Figma";
  if (url.includes("docs.google.com/spreadsheets")) return "Sheets";
  if (url.includes("notion.so"))                    return "Notion";
  if (url.includes("miro.com"))                     return "Miro";
  try { return new URL(url).hostname; } catch { return null; }
}
function senderLabel(s) {
  return { user:"You", ai:"CoLearn AI", system:"System", "agent-step":"Agent" }[s] || s;
}
function senderClass(s) {
  return { user:"self", ai:"ai", system:"system", "agent-step":"agent-step" }[s] || "other";
}

const TYPE_META = {
  USER_CLICK:    { label:"CLICK",  cls:"click" },
  USER_INPUT:    { label:"INPUT",  cls:"input"  },
  NAVIGATION:    { label:"NAV",    cls:"nav"    },
  CONTENT_READY: { label:"READY",  cls:"ready"  },
  CHAT_MESSAGE:  { label:"CHAT",   cls:"chat"   },
};

const ACTION_ICONS = {
  click:"▶", type:"⌨", scroll:"↕", navigate:"🌐", press_key:"⌘", observe:"👁", wait:"⏳", webmcp:"⚡",
};

const HIGHLIGHT_COLORS = ["#FF3B6F","#00BCD4","#FF9800","#4CAF50","#9C27B0","#2196F3"];

/* ── Render: events ── */
function renderEvents() {
  if (!state.events.length) {
    eventList.innerHTML = '<div class="empty">No events yet…<br><span>Interact with the browser to the right</span></div>';
    return;
  }
  eventList.innerHTML = state.events.map((ev) => {
    const meta    = TYPE_META[ev.type] || { label: ev.type, cls: "default" };
    const appName = ev.app || getAppFromUrl(ev.url);
    const text    = escHtml(ev.text || ev.tag || ev.url?.slice(0, 55) || "—");
    return `<div class="event-row">
      <span class="event-badge ${meta.cls}">${meta.label}</span>
      <div class="event-body">
        <span class="event-text">${text}</span>
        <span class="event-meta">
          ${appName ? `<span class="event-app">${escHtml(appName)}</span>` : ""}
          <span>${formatTimeSec(ev.timestamp || ev.receivedAt)}</span>
        </span>
      </div>
    </div>`;
  }).join("");
  eventList.scrollTop = eventList.scrollHeight;
}

/* ── Render: WebMCP ── */
function renderWebMCP() {
  const mcp = state.webmcp;
  if (mcp.available && mcp.tools?.length > 0) {
    webmcpStatusBar.innerHTML = `<span class="webmcp-dot on"></span><span class="webmcp-status-text">${mcp.tools.length} tool(s) active</span>`;
    webmcpToolList.innerHTML  = mcp.tools.map((t) => `
      <div class="webmcp-tool-item">
        <div class="webmcp-tool-header">
          <span class="webmcp-tool-type">${escHtml((t.type||"tool").toUpperCase())}</span>
          <span class="webmcp-tool-name">${escHtml(t.name)}</span>
        </div>
        <div class="webmcp-tool-desc">${escHtml((t.description||"").slice(0,90))}</div>
      </div>`).join("");
  } else if (mcp.available) {
    webmcpStatusBar.innerHTML = '<span class="webmcp-dot on"></span><span class="webmcp-status-text">Active (no tools)</span>';
    webmcpToolList.innerHTML  = "";
  } else {
    webmcpStatusBar.innerHTML = '<span class="webmcp-dot off"></span><span class="webmcp-status-text">Not detected</span>';
    webmcpToolList.innerHTML  = "";
  }
}

/* ── Render: model selector ── */
function renderModelSelector() {
  if (!state.providers?.length) { modelSelector.style.display = "none"; return; }
  modelSelector.style.display = "";
  const allModels = state.providers.flatMap((p) => p.models.map((m) => ({ ...m, providerName: p.name })));
  const cur       = state.activeModels?.agent;
  modelLabel.textContent = allModels.find((m) => m.provider === cur?.provider && m.id === cur?.model)?.label || "Model";

  const cA = state.activeModels?.agent, cG = state.activeModels?.guidance;
  modelDropdown.innerHTML = `
    <div class="model-dropdown-section">
      <div class="model-dropdown-title">Agent Model</div>
      ${allModels.map((m) => `<button class="model-option ${m.provider===cA?.provider&&m.id===cA?.model?"active":""}"
        data-target="agent" data-provider="${m.provider}" data-model="${m.id}">
        <span class="model-option-label">${escHtml(m.label)}</span>
        <span class="model-option-tier tier-${m.tier}">${m.tier}</span>
        <span class="model-option-provider">${escHtml(m.providerName)}</span>
      </button>`).join("")}
    </div>
    <div class="model-dropdown-section">
      <div class="model-dropdown-title">Guidance Model</div>
      ${allModels.map((m) => `<button class="model-option ${m.provider===cG?.provider&&m.id===cG?.model?"active":""}"
        data-target="guidance" data-provider="${m.provider}" data-model="${m.id}">
        <span class="model-option-label">${escHtml(m.label)}</span>
        <span class="model-option-tier tier-${m.tier}">${m.tier}</span>
        <span class="model-option-provider">${escHtml(m.providerName)}</span>
      </button>`).join("")}
    </div>`;
}

/* ── Render: conversation list ── */
function renderConversationList() {
  const convList = $("convList");
  if (!convList) return;
  const convs = state.conversations || [];
  if (convs.length === 0) {
    convList.innerHTML = "";
    return;
  }
  convList.innerHTML = convs.map((c) => {
    const active = c.threadId === state.currentThreadId ? " active" : "";
    const d = new Date(c.lastUpdatedAt);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<div class="conv-item${active}" data-thread-id="${escHtml(c.threadId)}">
      <div class="conv-item-body">
        <div class="conv-title">${escHtml(c.preview || "New conversation")}</div>
        <div class="conv-meta">${time} &middot; ${c.messageCount} msg${c.messageCount !== 1 ? "s" : ""}</div>
      </div>
      <button class="conv-delete" data-thread-id="${escHtml(c.threadId)}" title="Delete">&times;</button>
    </div>`;
  }).join("");
}

/* ── Render: chat ── */
function renderChat() {
  const msgs = state.chatMessages;
  const busy = isBusy();
  chatEmpty.style.display = (msgs.length === 0 && !busy) ? "" : "none";

  let html = "";

  // Render guidance plan card if steps exist
  if (state.guidancePlanSteps?.length) {
    const steps = state.guidancePlanSteps;
    const doneCount = steps.filter(s => s.status === "completed").length;
    html += `<div class="guidance-plan-card">
      <div class="plan-card-header">
        <span class="plan-card-icon">&#128203;</span>
        <span class="plan-card-title">Step-by-step plan</span>
        <span class="plan-card-count">${doneCount}/${steps.length}</span>
      </div>
      <ol class="plan-card-steps">
        ${steps.map(s => {
          const indicator = s.status === "completed" ? "&#x2705;" : s.status === "active" ? "&#x25B6;&#xFE0F;" : "&#x25CB;";
          return `<li class="plan-step plan-step-${s.status}">
            <span class="plan-step-indicator">${indicator}</span>
            <span class="plan-step-text">${escHtml(s.instruction)}</span>
          </li>`;
        }).join("")}
      </ol>
    </div>`;
  }

  for (const msg of msgs) {
    if (msg.isStepProgress) {
      html += `<div class="chat-bubble step-progress">
        <div class="bubble-sender">Step</div>
        <div class="step-progress-text">📍 Step ${msg.stepNumber} of ${msg.totalSteps} — ${escHtml(msg.instruction)}</div>
        ${msg.image ? `<div class="annotated-image-wrap"><img src="${msg.image}" class="annotated-image" onclick="openImageModal(this.src)" /></div>` : ""}
        <div class="bubble-meta">Waiting for you…</div>
      </div>`;
      continue;
    }
    if (msg.isTaskComplete) {
      const sugs = msg.suggestions || [];
      html += `<div class="chat-bubble ai task-complete">
        <div class="bubble-sender">CoLearn AI</div>
        <div class="bubble-text">${renderText(msg.text)}</div>
        ${sugs.length ? `<div class="suggestion-chips" data-suggestions='${JSON.stringify(sugs).replace(/'/g,"&#39;")}'>${sugs.map((s,i)=>`<button type="button" class="suggestion-chip" data-idx="${i}">${escHtml(s)}</button>`).join("")}</div>` : ""}
        <div class="bubble-meta">${formatTime(msg.timestamp)}</div>
      </div>`;
      continue;
    }
    if (msg.sender === "agent-step") {
      const icon  = ACTION_ICONS[msg.agentAction] || "⚙";
      const mode  = msg.executionMode || "langgraph-dom";
      const modeL = mode==="webmcp"?"WebMCP":mode==="langgraph-nav"?"Navigate":"DOM";
      const modeC = mode==="webmcp"?"mode-webmcp":mode==="langgraph-nav"?"mode-nav":"mode-dom";
      html += `<div class="chat-bubble agent-step">
        <div class="agent-step-inner">
          <span class="agent-step-icon">${icon}</span>
          <span class="exec-mode-badge ${modeC}">${modeL}</span>
          <span class="agent-step-text">${escHtml(msg.text)}</span>
          <span class="agent-step-pulse"></span>
        </div>
      </div>`;
      continue;
    }
    const cls = senderClass(msg.sender);
    let inner = `<div class="bubble-sender">${senderLabel(msg.sender)}</div>`;
    if (msg.image) {
      inner += `<div class="annotated-image-wrap">
        <img src="${msg.image}" class="annotated-image" onclick="openImageModal(this.src)" />
        <div class="image-hint">Click to enlarge</div>
      </div>`;
    }
    if (msg.highlights?.length) {
      inner += '<div class="highlight-legend">' + msg.highlights.map((h,i) =>
        `<div class="legend-item"><span class="legend-dot" style="background:${HIGHLIGHT_COLORS[i%HIGHLIGHT_COLORS.length]}"></span><span class="legend-label">${escHtml(h.label)}</span>${h.reason?`<span class="legend-reason"> — ${escHtml(h.reason)}</span>`:""}</div>`
      ).join("") + "</div>";
    }
    if (msg.guidance?.length) {
      inner += `<div class="guidance-actions">
        <button class="guidance-btn" data-guidance='${JSON.stringify(msg.guidance).replace(/'/g,"&#39;")}' onclick="toggleGuidance(this)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Show on Page
        </button>
      </div>`;
    }
    if (msg.agentResult) {
      const ar = msg.agentResult;
      inner += `<div class="agent-result-badge"><span>${ar.status==="completed"?"✓":"⚠"}</span><span>Task ${ar.status} in ${ar.steps} step${ar.steps!==1?"s":""}</span></div>`;
    }
    inner += `<div class="bubble-text">${renderText(msg.text)}</div>`;
    if (msg.context?.url) {
      inner += `<div class="bubble-context">Context: ${escHtml(msg.context.title||msg.context.url)}</div>`;
    }
    inner += `<div class="bubble-meta">${formatTime(msg.timestamp)}</div>`;
    html += `<div class="chat-bubble ${cls}">${inner}</div>`;
  }

  if (state.aiThinking) {
    html += `<div class="chat-bubble ai thinking">
      <div class="bubble-sender">CoLearn AI</div>
      <div class="thinking-status">Capturing screen &amp; analyzing…</div>
      <div class="thinking-dots"><span></span><span></span><span></span></div>
    </div>`;
  }
  if (state.agentStatus.status === "running" && !msgs.some((m) => m.isLiveStep)) {
    html += `<div class="chat-bubble agent-thinking">
      <div class="bubble-sender">Browser Agent</div>
      <div class="thinking-status">${escHtml(state.agentStatus.message||"Analyzing the page…")}</div>
      <div class="agent-progress-bar"><div class="agent-progress-fill"></div></div>
    </div>`;
  }

  const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 60;
  while (chatMessages.lastChild && chatMessages.lastChild !== chatEmpty) chatMessages.removeChild(chatMessages.lastChild);
  while (chatMessages.firstChild && chatMessages.firstChild !== chatEmpty) chatMessages.removeChild(chatMessages.firstChild);
  chatMessages.appendChild(document.createRange().createContextualFragment(html));
  if (wasAtBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

/* ── Guidance overlay (global, called from innerHTML onclick) ── */
window.toggleGuidance = function (btn) {
  const isActive = btn.classList.contains("active");
  if (isActive) {
    wsSend({ type: "CLEAR_GUIDANCE" });
    btn.classList.remove("active");
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Show on Page';
    btn.parentElement.querySelector(".guidance-status")?.remove();
  } else {
    wsSend({ type: "SHOW_GUIDANCE", guides: JSON.parse(btn.dataset.guidance) });
    btn.classList.add("active");
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg> Clear Overlay';
    const s = document.createElement("span");
    s.className = "guidance-status"; s.textContent = "Showing on page";
    btn.parentElement.appendChild(s);
  }
};

/* ── Image modal (full-size popup) ── */
window.openImageModal = function (src) {
  // Remove existing modal if any
  document.getElementById("imageModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "imageModal";
  overlay.className = "image-modal-overlay";
  overlay.innerHTML = `<div class="image-modal-content">
    <img src="${src}" class="image-modal-img" />
    <button class="image-modal-close" onclick="closeImageModal()">&times;</button>
  </div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeImageModal();
  });
  document.body.appendChild(overlay);
};

window.closeImageModal = function () {
  document.getElementById("imageModal")?.remove();
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeImageModal();
});

/* ── Suggestion chip clicks ── */
chatMessages.addEventListener("click", (e) => {
  const chip = e.target.closest(".suggestion-chip");
  if (!chip) return;
  const container = chip.closest(".suggestion-chips");
  if (!container?.dataset.suggestions) return;
  try {
    const sugs = JSON.parse(container.dataset.suggestions.replace(/&#39;/g,"'"));
    const idx  = parseInt(chip.dataset.idx, 10);
    if (Number.isFinite(idx) && sugs[idx]) wsSend({ type: "CHAT_MESSAGE", text: sugs[idx], threadId: state.currentThreadId });
  } catch {}
});

/* ── Chat form ── */
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  wsSend({ type: "CHAT_MESSAGE", text, threadId: state.currentThreadId });
  chatInput.value = "";
  chatSendBtn.disabled = true;
});
chatInput.addEventListener("input", () => {
  chatSendBtn.disabled = !state.connected || !chatInput.value.trim() || isBusy();
});

/* ── New chat button ── */
$("newChatBtn")?.addEventListener("click", () => {
  wsSend({ type: "NEW_CHAT" });
});

/* ── Conversation list clicks ── */
$("convList")?.addEventListener("click", (e) => {
  const delBtn = e.target.closest(".conv-delete");
  if (delBtn) {
    e.stopPropagation();
    const tid = delBtn.dataset.threadId;
    if (tid) wsSend({ type: "DELETE_CHAT", threadId: tid });
    return;
  }
  const item = e.target.closest(".conv-item");
  if (item) {
    const tid = item.dataset.threadId;
    if (tid && tid !== state.currentThreadId) {
      wsSend({ type: "SWITCH_CHAT", threadId: tid });
    }
  }
});

/* ── Model selector ── */
modelBtn.addEventListener("click", () => modelDropdown.classList.toggle("hidden"));
modelDropdown.addEventListener("click", (e) => {
  const opt = e.target.closest(".model-option");
  if (!opt) return;
  wsSend({ type: "SET_MODEL", target: opt.dataset.target, provider: opt.dataset.provider, model: opt.dataset.model });
  modelDropdown.classList.add("hidden");
});
document.addEventListener("click", (e) => {
  if (!modelSelector.contains(e.target)) modelDropdown.classList.add("hidden");
});

/* ── Collapsible sections ── */
function toggleSection(bodyEl, chevEl) {
  const isOpen = bodyEl.style.display !== "none";
  bodyEl.style.display = isOpen ? "none" : "";
  chevEl.className = `lp-chev ${isOpen ? "closed" : "open"}`;
}
eventsHd.addEventListener("click", () => toggleSection($("eventList"), eventsChev));
webmcpHd.addEventListener("click", () => toggleSection($("webmcpPanel"), webmcpChev));
webmcpScanBtn.addEventListener("click", (e) => {
  e.stopPropagation(); // don't trigger webmcpHd toggle
  wsSend({ type: "WEBMCP_SCAN" });
  webmcpStatusBar.innerHTML = '<span class="webmcp-dot off"></span><span class="webmcp-status-text">Scanning…</span>';
});

/* ═══════════════════════════════════════════════════════════
   BROWSER CONTROLS
   ═══════════════════════════════════════════════════════════ */

const api = window.electronAPI;

/* Receive state from main process → update toolbar */
api.onBrowserState((bs) => {
  state.browser = bs;
  renderBrowserTabs(bs.tabs);
  bBack.disabled  = !bs.canGoBack;
  bFwd.disabled   = !bs.canGoForward;

  // Toggle reload ↻ / stop × based on active tab loading state
  const activeTab = bs.tabs.find(t => t.active);
  if (activeTab?.loading) {
    bReload.innerHTML = "&#215;";
    bReload.title     = "Stop loading";
    bReload.onclick   = () => api.browserStop();
  } else {
    bReload.innerHTML = "&#8635;";
    bReload.title     = "Reload (Ctrl+R)";
    bReload.onclick   = () => api.browserReload();
  }

  if (!state.urlFocused) updateUrlBar(bs.currentUrl);
});

/* Receive extension connection status */
api.onBrowserExtStatus(({ connected, timedOut }) => {
  state.extConnected = connected;
  if (connected) {
    extDot.className = "ext-dot connected";
    extDot.title     = "Extension: connected ✓";
  } else if (timedOut) {
    extDot.className = "ext-dot failed";
    extDot.title     = "Extension: did not connect — check server";
  }
});

/* Render tab strip */
function renderBrowserTabs(tabs) {
  btabList.innerHTML = tabs.map((tab, idx) => {
    const title     = escHtml(tab.title || "New Tab");
    const faviconEl = tab.loading
      ? `<span class="btab-spinner"></span>`
      : tab.favicon
        ? `<img class="btab-favicon" src="${escHtml(tab.favicon)}" alt="" onerror="this.style.display='none'"/>`
        : `<span class="btab-favicon-ph">🌐</span>`;
    return `<div class="btab-item${tab.active?" active":""}" data-idx="${idx}">
      ${faviconEl}
      <span class="btab-title" title="${title}">${title}</span>
      <button class="btab-close" data-close="${idx}" title="Close">&#215;</button>
    </div>`;
  }).join("");
}

/* Tab strip delegation */
btabList.addEventListener("click", (e) => {
  const close = e.target.closest("[data-close]");
  if (close) { e.stopPropagation(); api.browserCloseTab(parseInt(close.dataset.close, 10)); return; }
  const item  = e.target.closest(".btab-item[data-idx]");
  if (item)  api.browserSwitchTab(parseInt(item.dataset.idx, 10));
});

/* URL bar */
function updateUrlBar(url) {
  burlInput.value = url || "";
  if (!url)                        { burlLock.className = "burl-lock empty"; }
  else if (url.startsWith("https://")) { burlLock.className = "burl-lock secure";   burlLock.textContent = "🔒"; burlLock.title = "Secure"; }
  else if (url.startsWith("http://"))  { burlLock.className = "burl-lock insecure"; burlLock.textContent = "⚠️"; burlLock.title = "Not secure"; }
  else                             { burlLock.className = "burl-lock empty"; }
}

burlInput.addEventListener("focus",   () => { state.urlFocused = true;  burlInput.select(); });
burlInput.addEventListener("blur",    () => { state.urlFocused = false; updateUrlBar(state.browser.currentUrl); });
burlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const v = burlInput.value.trim();
    if (v) { burlInput.blur(); api.browserNavigate(v); }
  } else if (e.key === "Escape") { burlInput.blur(); }
});

/* Nav buttons */
bBack.addEventListener("click",   () => api.browserBack());
bFwd.addEventListener("click",    () => api.browserForward());
bReload.addEventListener("click", () => api.browserReload()); // overridden by onBrowserState
btabNew.addEventListener("click", () => api.browserNewTab());
bExt.addEventListener("click",    () => api.browserExtPopup());
bDev.addEventListener("click",    () => api.browserDevtools());

/* Keyboard shortcuts (browser-specific) */
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === "t") { e.preventDefault(); api.browserNewTab(); }
  else if (mod && e.key === "w") { e.preventDefault(); api.browserCloseTab(state.browser.activeIdx); }
  else if (mod && e.key === "r") { e.preventDefault(); api.browserReload(); }
  else if (mod && e.key === "l") { e.preventDefault(); burlInput.focus(); }
  else if (e.altKey && e.key === "ArrowLeft")  api.browserBack();
  else if (e.altKey && e.key === "ArrowRight") api.browserForward();
  else if (mod && e.key >= "1" && e.key <= "9") {
    const idx = parseInt(e.key, 10) - 1;
    if (idx < state.browser.tabs.length) api.browserSwitchTab(idx);
  }
});

/* ═══════════════════════════════════════════════════════════
   PANEL DIVIDER DRAG
   ═══════════════════════════════════════════════════════════ */

splitDivider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  splitDivider.classList.add("dragging");

  // Show invisible full-screen overlay so mouse events aren't captured by the WebContentsView
  dragCapture.style.display = "";

  function onMove(ev) {
    const newW = Math.max(220, Math.min(ev.clientX, window.innerWidth - 340));
    lp.style.width = newW + "px";
    // splitX = leftPanelWidth + dividerWidth (4px)
    api.browserPanelResize(newW + 4);
  }
  function onUp() {
    splitDivider.classList.remove("dragging");
    dragCapture.style.display = "none";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup",   onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup",   onUp);
});

/* ── Desktop CDP bridge (role=desktop WebSocket → IPC → webContents.debugger) ── */
let desktopWs = null;

function desktopWsConnect() {
  if (desktopWs?.readyState === WebSocket.OPEN) return;
  desktopWs = new WebSocket('ws://localhost:3001?role=desktop');

  desktopWs.onopen = () => console.log('[Desktop] CDP bridge connected');

  desktopWs.onclose = () => {
    desktopWs = null;
    setTimeout(desktopWsConnect, 3000);
  };

  desktopWs.onerror = () => desktopWs?.close();

  desktopWs.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'GATHER_CONTEXT') {
      try {
        const context = await window.electronAPI.gatherContext();
        desktopWs?.send(JSON.stringify({ type: 'CONTEXT_RESPONSE', requestId: msg.requestId, ok: true, context }));
      } catch (err) {
        desktopWs?.send(JSON.stringify({ type: 'CONTEXT_RESPONSE', requestId: msg.requestId, ok: false, error: err.message }));
      }
    }

    if (msg.type === 'EXECUTE_ACTION') {
      try {
        const result = await window.electronAPI.executeAction(msg.action);
        desktopWs?.send(JSON.stringify({ type: 'ACTION_RESULT', requestId: msg.requestId, ok: true, result }));
      } catch (err) {
        desktopWs?.send(JSON.stringify({ type: 'ACTION_RESULT', requestId: msg.requestId, ok: false, error: err.message }));
      }
    }

    if (msg.type === 'SHOW_GUIDANCE' || msg.type === 'STEP_GUIDANCE' || msg.type === 'CLEAR_GUIDANCE') {
      window.electronAPI.showGuidance(msg).catch((err) =>
        console.warn('[Desktop] showGuidance failed:', err.message)
      );
    }
  };
}

/* ── Init ── */
wsConnect();
desktopWsConnect();
