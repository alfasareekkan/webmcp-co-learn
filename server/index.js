import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { annotateScreenshot } from "./annotate.js";
import { createBrowserAgent, runBrowserAgent, classifyIntent } from "./agent.js";
import { createChatModel, getAvailableProviders, getDefaultModel, getGuidanceModel } from "./models.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;

// Active model selection (can be changed at runtime via dashboard)
let activeAgentModel = getDefaultModel();
let activeGuidanceModel = getGuidanceModel();

const availableProviders = getAvailableProviders();
const aiEnabled = availableProviders.length > 0;

if (aiEnabled) {
  console.log(`[AI] Providers available: ${availableProviders.map(p => p.name).join(", ")}`);
  console.log(`[AI] Agent model: ${activeAgentModel?.provider}/${activeAgentModel?.model}`);
  console.log(`[AI] Guidance model: ${activeGuidanceModel?.provider}/${activeGuidanceModel?.model}`);
} else {
  console.warn("[AI] No API keys configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY in .env");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------------------
// Client tracking
// ---------------------------------------------------------------------------
const clients = { extension: new Set(), dashboard: new Set() };

const recentEvents = [];
const MAX_EVENTS = 500;
let latestScreenshot = null;

const pendingContextRequests = new Map();
const pendingActionRequests = new Map();
const CONTEXT_TIMEOUT = 15000;
const ACTION_TIMEOUT = 10000;

// Abort controller for the currently running chat operation (agent or guidance)
let activeChatAbort = null;

function pushEvent(event) {
  recentEvents.push(event);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

function broadcast(role, data) {
  const msg = JSON.stringify(data);
  clients[role].forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function sendToExtension(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients.extension) {
    if (ws.readyState === 1) { ws.send(msg); return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request context from extension
// ---------------------------------------------------------------------------
function requestContextFromExtension() {
  return new Promise((resolve, reject) => {
    const requestId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sent = sendToExtension({ type: "GATHER_CONTEXT", requestId });
    if (!sent) {
      reject(new Error("No extension connected. Attach the debugger from the extension popup."));
      return;
    }
    const timer = setTimeout(() => {
      pendingContextRequests.delete(requestId);
      reject(new Error("Context gathering timed out — is the debugger attached?"));
    }, CONTEXT_TIMEOUT);
    pendingContextRequests.set(requestId, { resolve, reject, timer });
  });
}

// ---------------------------------------------------------------------------
// Request action execution from extension
// ---------------------------------------------------------------------------
function requestActionExecution(action) {
  return new Promise((resolve, reject) => {
    const requestId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sent = sendToExtension({ type: "EXECUTE_ACTION", requestId, action });
    if (!sent) {
      reject(new Error("No extension connected. Attach the debugger from the extension popup."));
      return;
    }
    const timer = setTimeout(() => {
      pendingActionRequests.delete(requestId);
      reject(new Error("Action execution timed out"));
    }, ACTION_TIMEOUT);
    pendingActionRequests.set(requestId, { resolve, reject, timer });
  });
}

// ---------------------------------------------------------------------------
// LangGraph Browser Agent (created on-demand with active model)
// ---------------------------------------------------------------------------
function buildBrowserAgent(modelConfig) {
  if (!modelConfig) return null;
  try {
    const model = createChatModel(modelConfig.provider, modelConfig.model);
    return createBrowserAgent({
      model,
      requestContext: requestContextFromExtension,
      executeAction: requestActionExecution,
      onProgress: (step) => {
        broadcast("dashboard", { type: "AGENT_STEP", step, timestamp: Date.now() });
      },
    });
  } catch (err) {
    console.error("[Agent] Failed to build:", err.message);
    return null;
  }
}

let browserAgent = buildBrowserAgent(activeAgentModel);
if (browserAgent) console.log("[Agent] LangGraph browser agent ready");

// ---------------------------------------------------------------------------
// Guidance AI — multi-model support via LangChain
// ---------------------------------------------------------------------------
const GUIDANCE_SYSTEM_PROMPT = `You are CoLearn Assistant — an AI co-pilot that helps users understand and navigate web applications in real time. You also serve as a general-purpose AI assistant — you can answer any question, have conversations, and help with tasks just like ChatGPT or Gemini.

You MAY receive:
- A screenshot of the user's current browser tab
- DOM structure (headings, buttons, links, inputs, forms, text)
- Interactive elements with their pixel-level bounding boxes
- Recent network requests and console logs
- Performance metrics

If the page context is minimal or missing (e.g. the user is on a new tab or chrome:// page), just answer the question directly as a helpful AI assistant. You don't need page context to answer general knowledge questions, have conversations, or explain concepts.

RESPONSE FORMAT — You MUST reply with valid JSON (no markdown fences). Use this exact structure:

{
  "text": "Your helpful answer in plain text. Use **bold** for emphasis.",
  "highlights": [
    {
      "elementIndex": 0,
      "label": "Short label",
      "reason": "Why this element is relevant"
    }
  ]
}

RULES:
- "text" is always required — your main answer.
- "highlights" is an array of elements to visually highlight on the screenshot. Include it when the user asks WHERE something is, HOW to do something, or when pointing out specific UI elements helps.
- "elementIndex" refers to the index in the ELEMENTS array provided in the context.
- If no visual highlighting is needed (general questions, explanations, conversations), set "highlights" to an empty array [].
- Keep text concise and actionable.
- When highlighting, describe the element location in text too (e.g., "top-right corner", "in the sidebar").
- Use numbered labels (1, 2, 3) when highlighting multiple elements to show a sequence/pathway.
- For general knowledge questions (not related to the current page), just answer naturally. You are a full AI assistant, not just a browser helper.`;

function buildContextText(context) {
  const parts = [];
  if (context.url) parts.push(`Page URL: ${context.url}`);
  if (context.title) parts.push(`Page Title: ${context.title}`);

  if (context.dom) {
    const d = context.dom;
    if (d.headings?.length)
      parts.push(`Headings: ${d.headings.map(h => `${h.level}: ${h.text}`).join(" | ")}`);
    if (d.buttons?.length)
      parts.push(`Buttons: ${d.buttons.map(b => b.text).filter(Boolean).join(", ")}`);
    if (d.links?.length)
      parts.push(`Links: ${d.links.slice(0, 10).map(l => l.text || l.href).join(", ")}`);
    if (d.inputs?.length)
      parts.push(`Inputs: ${d.inputs.map(i => `${i.type}[${i.name || i.placeholder || ""}]`).join(", ")}`);
    if (d.selection)
      parts.push(`Selected text: ${d.selection}`);
    if (d.bodyText)
      parts.push(`Visible text: ${d.bodyText.slice(0, 1500)}`);
  }

  if (context.elements?.length) {
    const elSummary = context.elements.map((el, i) =>
      `[${i}] <${el.tag}> "${el.text}" bounds:{x:${el.bounds.x},y:${el.bounds.y},w:${el.bounds.width},h:${el.bounds.height}}${el.role ? ` role="${el.role}"` : ""}${el.id ? ` id="${el.id}"` : ""}`
    ).join("\n");
    parts.push(`ELEMENTS (with bounding boxes):\n${elSummary}`);
  }

  if (context.networkLogs?.length) {
    const net = context.networkLogs.slice(-10).map(n =>
      `${n.method || "?"} ${n.status || "..."} ${n.url?.slice(0, 80)}`
    ).join("\n");
    parts.push(`Network:\n${net}`);
  }

  if (context.consoleLogs?.length) {
    const con = context.consoleLogs.slice(-8).map(c => `[${c.level}] ${c.text}`).join("\n");
    parts.push(`Console:\n${con}`);
  }

  if (context.performance) {
    const perf = Object.entries(context.performance)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? Math.round(v) : v}`)
      .join(", ");
    parts.push(`Performance: ${perf}`);
  }

  return parts.join("\n\n");
}

async function askAI(userMessage, context) {
  if (!activeGuidanceModel) {
    return { text: "No AI model configured. Add an API key to .env and restart.", highlights: [] };
  }

  const contextText = buildContextText(context);

  try {
    const model = createChatModel(activeGuidanceModel.provider, activeGuidanceModel.model);

    // Build multimodal message with screenshot
    const contentParts = [];

    if (context.screenshot) {
      const base64Data = context.screenshot.replace(/^data:image\/\w+;base64,/, "");
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${base64Data}` },
      });
    }

    contentParts.push({
      type: "text",
      text: `--- PAGE CONTEXT ---\n${contextText}\n\n--- USER QUESTION ---\n${userMessage}`,
    });

    const messages = [
      new SystemMessage(GUIDANCE_SYSTEM_PROMPT),
      new HumanMessage({ content: contentParts }),
    ];

    const result = await model.invoke(messages);
    const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    try {
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        text: parsed.text || raw,
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      };
    } catch {
      return { text: raw, highlights: [] };
    }
  } catch (err) {
    console.error(`[AI] ${activeGuidanceModel.provider} error:`, err.message);
    return { text: `AI error: ${err.message}`, highlights: [] };
  }
}

// ---------------------------------------------------------------------------
// Build annotated screenshot from AI highlights
// ---------------------------------------------------------------------------
const HIGHLIGHT_COLORS = ["#FF3B6F", "#00BCD4", "#FF9800", "#4CAF50", "#9C27B0", "#2196F3"];

async function buildAnnotatedImage(context, highlights) {
  if (!highlights?.length || !context.screenshot || !context.elements?.length) return null;

  const screenshotBase64 = context.screenshot.replace(/^data:image\/\w+;base64,/, "");

  const boxes = highlights.map((h, i) => {
    const elIdx = h.elementIndex;
    const el = context.elements[elIdx];
    if (!el?.bounds) return null;
    return {
      x: el.bounds.x, y: el.bounds.y,
      width: el.bounds.width, height: el.bounds.height,
      label: h.label || `${i + 1}`,
      color: HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length],
    };
  }).filter(Boolean);

  if (!boxes.length) return null;

  try {
    return await annotateScreenshot(screenshotBase64, boxes, context.viewport);
  } catch (err) {
    console.error("[Annotate] Error:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get("role") || "dashboard";

  clients[role]?.add(ws);
  console.log(`[WS] ${role} connected (total: ${clients[role]?.size})`);

  if (role === "dashboard") {
    ws.send(JSON.stringify({
      type: "INIT",
      events: recentEvents.slice(-50),
      screenshot: latestScreenshot,
      aiEnabled,
      providers: availableProviders,
      activeAgentModel,
      activeGuidanceModel,
    }));
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "USER_CLICK":
      case "USER_INPUT":
      case "NAVIGATION":
      case "CONTENT_READY": {
        const event = { ...msg.payload, type: msg.type, receivedAt: Date.now() };
        pushEvent(event);
        broadcast("dashboard", { type: "EVENT", event });
        break;
      }

      case "SCREENSHOT": {
        latestScreenshot = {
          dataUrl: msg.dataUrl, tabId: msg.tabId,
          url: msg.url, timestamp: Date.now(),
        };
        broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
        break;
      }

      case "CONTEXT_RESPONSE": {
        const pending = pendingContextRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingContextRequests.delete(msg.requestId);
          if (msg.ok) pending.resolve(msg.context);
          else pending.reject(new Error(msg.error || "Context gather failed"));
        }
        break;
      }

      case "ACTION_RESULT": {
        const pendingAction = pendingActionRequests.get(msg.requestId);
        if (pendingAction) {
          clearTimeout(pendingAction.timer);
          pendingActionRequests.delete(msg.requestId);
          if (msg.ok) pendingAction.resolve(msg.result || {});
          else pendingAction.reject(new Error(msg.error || "Action failed"));
        }
        break;
      }

      case "CHAT_MESSAGE": {
        handleChatMessage(msg.text, ws);
        break;
      }

      case "STOP_CHAT": {
        handleStopChat();
        break;
      }

      case "SET_MODEL": {
        handleSetModel(msg);
        break;
      }

      case "SHOW_GUIDANCE": {
        sendToExtension({ type: "SHOW_GUIDANCE", guides: msg.guides || [] });
        break;
      }

      case "CLEAR_GUIDANCE": {
        sendToExtension({ type: "CLEAR_GUIDANCE" });
        break;
      }
    }
  });

  ws.on("close", () => {
    clients[role]?.delete(ws);
    console.log(`[WS] ${role} disconnected`);
  });
});

// ---------------------------------------------------------------------------
// Model switching at runtime
// ---------------------------------------------------------------------------
function handleSetModel(msg) {
  const { target, provider, model } = msg;

  const providerInfo = availableProviders.find(p => p.id === provider);
  if (!providerInfo) {
    broadcast("dashboard", {
      type: "CHAT_MESSAGE", text: `Provider "${provider}" not available. Add the API key to .env.`,
      sender: "system", timestamp: Date.now(),
    });
    return;
  }

  const modelInfo = providerInfo.models.find(m => m.id === model);
  if (!modelInfo) {
    broadcast("dashboard", {
      type: "CHAT_MESSAGE", text: `Model "${model}" not found for ${provider}.`,
      sender: "system", timestamp: Date.now(),
    });
    return;
  }

  const config = { provider, model };

  if (target === "agent" || target === "both") {
    activeAgentModel = config;
    browserAgent = buildBrowserAgent(config);
    console.log(`[Model] Agent switched to ${provider}/${model}`);
  }

  if (target === "guidance" || target === "both") {
    activeGuidanceModel = config;
    console.log(`[Model] Guidance switched to ${provider}/${model}`);
  }

  broadcast("dashboard", {
    type: "MODEL_CHANGED",
    activeAgentModel,
    activeGuidanceModel,
    timestamp: Date.now(),
  });

  broadcast("dashboard", {
    type: "CHAT_MESSAGE",
    text: `Model switched to **${modelInfo.label}** (${providerInfo.name}) for ${target}.`,
    sender: "system",
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Chat handler — routes between GUIDANCE and ACTION modes
// ---------------------------------------------------------------------------
function handleStopChat() {
  if (activeChatAbort) {
    activeChatAbort.abort();
    activeChatAbort = null;
    console.log("[Chat] Stop requested by user");
  }
  broadcast("dashboard", { type: "AI_THINKING", thinking: false });
  broadcast("dashboard", { type: "AGENT_STATUS", status: "idle", timestamp: Date.now() });
  broadcast("dashboard", {
    type: "CHAT_MESSAGE", text: "Stopped by user.",
    sender: "system", timestamp: Date.now(),
  });
}

async function handleChatMessage(text, senderWs) {
  const userMsg = { type: "CHAT_MESSAGE", text, sender: "user", timestamp: Date.now() };
  pushEvent(userMsg);
  broadcast("dashboard", userMsg);

  // Cancel any previous in-flight request
  if (activeChatAbort) activeChatAbort.abort();
  const abort = new AbortController();
  activeChatAbort = abort;

  // Gather page context so the classifier sees the current page
  let pageContext = null;
  try {
    pageContext = await requestContextFromExtension();
    if (abort.signal.aborted) return;
    if (pageContext?.screenshot) {
      latestScreenshot = { dataUrl: pageContext.screenshot, url: pageContext.url, timestamp: Date.now() };
      broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
    }
  } catch (err) {
    console.warn(`[Chat] Context gather failed: ${err.message}`);
  }

  if (abort.signal.aborted) return;

  // Use LLM to classify: action | guidance | chat
  let classifierModel = null;
  try {
    if (activeGuidanceModel) {
      classifierModel = createChatModel(activeGuidanceModel.provider, activeGuidanceModel.model);
    }
  } catch {}

  const intent = await classifyIntent(text, pageContext, classifierModel);
  console.log(`[Chat] Intent: "${intent}" for: "${text.slice(0, 60)}" (url: ${pageContext?.url || "unknown"})`);

  if (abort.signal.aborted) return;

  switch (intent) {
    case "action":
      if (browserAgent) {
        await handleAgentAction(text, abort.signal);
      } else {
        await handleNormalChat(text, pageContext, abort.signal);
      }
      break;
    case "guidance":
      await handleGuidanceChat(text, pageContext, abort.signal);
      break;
    case "chat":
    default:
      await handleNormalChat(text, pageContext, abort.signal);
      break;
  }
}

// ---------------------------------------------------------------------------
// GUIDANCE mode
// ---------------------------------------------------------------------------
async function handleGuidanceChat(text, prefetchedContext = null, signal = null) {
  broadcast("dashboard", { type: "AI_THINKING", thinking: true });

  try {
    // Reuse context already gathered during intent classification when available
    let context = prefetchedContext;
    if (!context) {
      try { context = await requestContextFromExtension(); }
      catch (err) {
        context = {
          url: "unknown", title: "unknown", error: err.message,
          dom: {}, elements: [], screenshot: null,
        };
      }

      if (context?.screenshot) {
        latestScreenshot = { dataUrl: context.screenshot, url: context.url, timestamp: Date.now() };
        broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
      }
    }

    if (signal?.aborted) return;

    const aiResult = await askAI(text, context);

    if (signal?.aborted) return;

    let annotatedImage = null;
    if (aiResult.highlights.length > 0) {
      annotatedImage = await buildAnnotatedImage(context, aiResult.highlights);
    }

    const guidanceData = aiResult.highlights.map((h, i) => {
      const el = context.elements?.[h.elementIndex];
      if (!el?.bounds) return null;
      return {
        bounds: el.bounds,
        label: h.label || `${i + 1}`,
        reason: h.reason || "",
        color: HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length],
        selector: el.id ? `#${el.id}` : null,
      };
    }).filter(Boolean);

    const aiMsg = {
      type: "CHAT_MESSAGE", text: aiResult.text, sender: "ai", timestamp: Date.now(),
      image: annotatedImage, highlights: aiResult.highlights,
      guidance: guidanceData, context: { url: context.url, title: context.title },
    };
    pushEvent(aiMsg);
    broadcast("dashboard", aiMsg);

    if (guidanceData.length > 0) {
      sendToExtension({ type: "SHOW_GUIDANCE", guides: guidanceData });
    }

  } catch (err) {
    broadcast("dashboard", {
      type: "CHAT_MESSAGE", text: `Error: ${err.message}`,
      sender: "system", timestamp: Date.now(),
    });
  } finally {
    broadcast("dashboard", { type: "AI_THINKING", thinking: false });
  }
}

// ---------------------------------------------------------------------------
// CHAT mode — general conversation (like ChatGPT / Gemini)
// No page context needed, no highlights, just a helpful AI response.
// ---------------------------------------------------------------------------
const CHAT_SYSTEM_PROMPT = `You are CoLearn Assistant — a helpful, friendly AI assistant. Answer questions, have conversations, explain concepts, and help with anything the user asks. Be concise and clear. Use **bold** for emphasis when helpful. You can use markdown-style formatting.`;

async function handleNormalChat(text, prefetchedContext = null, signal = null) {
  broadcast("dashboard", { type: "AI_THINKING", thinking: true });

  try {
    if (!activeGuidanceModel) {
      broadcast("dashboard", {
        type: "CHAT_MESSAGE", text: "No AI model configured. Add an API key to .env and restart.",
        sender: "system", timestamp: Date.now(),
      });
      return;
    }

    const model = createChatModel(activeGuidanceModel.provider, activeGuidanceModel.model);
    const result = await model.invoke([
      new SystemMessage(CHAT_SYSTEM_PROMPT),
      new HumanMessage(text),
    ]);

    if (signal?.aborted) return;

    const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    const aiMsg = {
      type: "CHAT_MESSAGE", text: raw, sender: "ai", timestamp: Date.now(),
      context: prefetchedContext ? { url: prefetchedContext.url, title: prefetchedContext.title } : null,
    };
    pushEvent(aiMsg);
    broadcast("dashboard", aiMsg);

  } catch (err) {
    if (signal?.aborted) return;
    broadcast("dashboard", {
      type: "CHAT_MESSAGE", text: `AI error: ${err.message}`,
      sender: "system", timestamp: Date.now(),
    });
  } finally {
    broadcast("dashboard", { type: "AI_THINKING", thinking: false });
  }
}

// ---------------------------------------------------------------------------
// ACTION mode
// ---------------------------------------------------------------------------
async function handleAgentAction(text, signal = null) {
  broadcast("dashboard", {
    type: "AGENT_STATUS", status: "running",
    message: `Agent running (${activeAgentModel?.provider}/${activeAgentModel?.model})...`,
    timestamp: Date.now(),
  });

  try {
    const result = await runBrowserAgent(browserAgent, text, null, signal);

    if (signal?.aborted) return;

    try {
      const finalContext = await requestContextFromExtension();
      if (finalContext.screenshot) {
        latestScreenshot = { dataUrl: finalContext.screenshot, url: finalContext.url, timestamp: Date.now() };
        broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
      }
    } catch { /* ignore */ }

    const aiMsg = {
      type: "CHAT_MESSAGE", text: result.summary, sender: "ai", timestamp: Date.now(),
      agentResult: { steps: result.steps, status: result.status },
    };
    pushEvent(aiMsg);
    broadcast("dashboard", aiMsg);

  } catch (err) {
    if (signal?.aborted) return;
    console.error("[Agent] Error:", err);
    broadcast("dashboard", {
      type: "CHAT_MESSAGE", text: `Agent error: ${err.message}`,
      sender: "system", timestamp: Date.now(),
    });
  } finally {
    if (!signal?.aborted) {
      broadcast("dashboard", { type: "AGENT_STATUS", status: "idle", timestamp: Date.now() });
    }
  }
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    aiEnabled,
    agentEnabled: !!browserAgent,
    activeAgentModel,
    activeGuidanceModel,
    providers: availableProviders,
    connections: { extension: clients.extension.size, dashboard: clients.dashboard.size },
    events: recentEvents.length,
  });
});

app.get("/api/models", (_req, res) => {
  res.json({
    providers: availableProviders,
    activeAgentModel,
    activeGuidanceModel,
  });
});

app.get("/api/events", (_req, res) => {
  res.json(recentEvents.slice(-50));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[CoLearn] Server on http://localhost:${PORT}`);
  console.log(`[CoLearn] WebSocket on ws://localhost:${PORT}`);
});
