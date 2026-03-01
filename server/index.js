import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { annotateScreenshot } from "./annotate.js";
import { createBrowserAgent, runBrowserAgent, classifyIntent } from "./agent.js";
import { createChatModel, getAvailableProviders, getDefaultModel, getGuidanceModel } from "./models.js";
import * as sessionManager from "./guidanceSessionManager.js";

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
const clients = { extension: new Set(), dashboard: new Set(), desktop: new Set() };

const recentEvents = [];
const MAX_EVENTS = 500;
let latestScreenshot = null;

const pendingContextRequests = new Map();
const pendingActionRequests = new Map();
const pendingWebMCPRequests = new Map();
// P3: screenshot polling verification timers keyed by threadId
const activePollers = new Map();
const CONTEXT_TIMEOUT = 15000;
const ACTION_TIMEOUT = 10000;

// Latest WebMCP discovery state
let latestWebMCP = { available: false, tools: [], url: null };

// Abort controller for the currently running chat operation (agent or guidance)
let activeChatAbort = null;

// Last page context per threadId (for multi-step guidance session)
const sessionContextMap = new Map();

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

function sendToDesktop(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients.desktop) {
    if (ws.readyState === 1) { ws.send(msg); return true; }
  }
  return false;
}

/**
 * Send a CDP-requiring message (GATHER_CONTEXT / EXECUTE_ACTION).
 * Prefers the Electron desktop client (which uses webContents.debugger);
 * falls back to the extension (which uses chrome.debugger — only available
 * in a real Chrome environment, not Electron).
 */
function sendToCdpClient(data) {
  return sendToDesktop(data) || sendToExtension(data);
}

// ---------------------------------------------------------------------------
// Request context from CDP client (desktop preferred, extension fallback)
// ---------------------------------------------------------------------------
function requestContextFromExtension() {
  return new Promise((resolve, reject) => {
    const requestId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sent = sendToCdpClient({ type: "GATHER_CONTEXT", requestId });
    if (!sent) {
      reject(new Error("No browser client connected. Open the Electron app or attach the extension."));
      return;
    }
    const timer = setTimeout(() => {
      pendingContextRequests.delete(requestId);
      reject(new Error("Context gathering timed out"));
    }, CONTEXT_TIMEOUT);
    pendingContextRequests.set(requestId, { resolve, reject, timer });
  });
}

// ---------------------------------------------------------------------------
// Request action execution from CDP client (desktop preferred, extension fallback)
// ---------------------------------------------------------------------------
function requestActionExecution(action) {
  return new Promise((resolve, reject) => {
    const requestId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sent = sendToCdpClient({ type: "EXECUTE_ACTION", requestId, action });
    if (!sent) {
      reject(new Error("No browser client connected. Open the Electron app or attach the extension."));
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
        broadcast("dashboard", {
          type: "AGENT_STEP",
          step,
          executionMode: step.executionMode || "langgraph-dom",
          timestamp: Date.now(),
        });
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

  if (context.webmcp?.available && context.webmcp.tools?.length) {
    const toolSummary = context.webmcp.tools.map(t =>
      `- ${t.name} (${t.type}): ${t.description}`
    ).join("\n");
    parts.push(`WebMCP Tools Available:\n${toolSummary}\nNote: This page supports WebMCP — AI agents can call these tools directly for reliable interaction.`);
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
// Multi-step guidance — Gemini prompt and response parser
// ---------------------------------------------------------------------------
const GUIDANCE_MULTI_STEP_PROMPT = `You are a step-by-step UI guidance expert helping a user complete a task inside a web application.

User question: {{userQuestion}}
Current page URL: {{pageUrl}}
DOM elements with indices and bounding boxes: {{domElements}}
{{appHints}}
Analyze the screenshot and DOM, then break this task into 2-5 clear sequential steps. For each step specify:
- A short action instruction (max 10 words)
- Which element index to highlight (skip if the app renders via canvas/WebGL)
- What signals indicate the user completed this step (provide 1-2 signals)

Return ONLY valid JSON, no markdown, no explanation outside JSON:
{
  "taskSummary": "brief description of the full task",
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "Click the Insert menu at the top",
      "highlights": [
        { "elementIndex": 12, "label": "Click here", "color": "#4CAF50", "arrow": true }
      ],
      "completionSignals": [
        {
          "type": "dom_appeared",
          "description": "Insert dropdown menu is now visible",
          "targetSelector": ""
        },
        {
          "type": "user_clicked_target",
          "description": "User clicked the Insert menu",
          "targetSelector": ""
        }
      ]
    }
  ],
  "suggestedFollowUps": [
    "How do I resize this?",
    "How do I delete this?",
    "How do I move this?"
  ]
}

completionSignals type guide:
- dom_appeared: a new element appeared (menu, dialog, panel, modal) — best for Sheets/Notion menus
- dom_disappeared: an element closed or was removed (dialog closed)
- url_changed: the page navigated to a new URL
- user_clicked_target: user clicked the highlighted element itself — most reliable fallback

Prefer 2 completionSignals per step (primary detection + user_clicked_target as fallback).
Always return exactly 3 suggestedFollowUps relevant to what comes after this task completes.`;

/**
 * Returns app-specific prompt hints based on the current page URL.
 * Tells the AI about each app's UI structure, DOM limitations, and best signal types.
 */
function getAppHints(url) {
  if (!url) return "";
  if (url.includes("docs.google.com/spreadsheets")) {
    return `
APP CONTEXT — Google Sheets:
- Sheets renders its grid cells via canvas; most cells are NOT queryable DOM elements.
- Top-bar menus (File, Edit, Insert, Format, Data, Tools) ARE in the DOM with role="menuitem".
- Dialog boxes appear as overlaid divs; formula bar is a real input element.
- Prefer "dom_appeared" for menu opens, "dom_disappeared" for dialog closes.
- Do NOT highlight individual grid cells by elementIndex — they are canvas-rendered.
- For cell value changes, use "user_clicked_target" on the formula bar or a toolbar button.`;
  }
  if (url.includes("figma.com")) {
    return `
APP CONTEXT — Figma:
- Figma renders its design canvas via WebGL/WASM; layers and objects are NOT DOM elements.
- Toolbar buttons, left/right property panels, and top menus ARE in the DOM.
- Prefer "dom_appeared" for panel/dialog openings, "user_clicked_target" for toolbar buttons.
- Use "url_changed" when navigating between pages or opening a different file.
- Do NOT highlight canvas-rendered design objects by elementIndex.`;
  }
  if (url.includes("magicpattern.design")) {
    return `
APP CONTEXT — MagicPattern:
- MagicPattern is a React-based pattern generator; most controls are real DOM elements.
- Sliders, color pickers, dropdowns, and export buttons are all interactable.
- Prefer "dom_appeared" for preview refreshes and new panels, "user_clicked_target" for buttons.
- Color and slider changes trigger DOM mutations — "dom_appeared" works well as primary signal.`;
  }
  if (url.includes("notion.so")) {
    return `
APP CONTEXT — Notion:
- Notion is a block-based editor; block content is in the DOM as contenteditable divs.
- Slash commands open a floating menu (dom_appeared). Selecting a block type closes it (dom_disappeared).
- Page navigation changes the URL (url_changed). Toolbar buttons respond to user_clicked_target.`;
  }
  if (url.includes("miro.com")) {
    return `
APP CONTEXT — Miro:
- Miro renders its board canvas via SVG/canvas; board objects are NOT real DOM elements.
- Toolbar buttons, panel controls, and context menus ARE in the DOM.
- Prefer "user_clicked_target" for toolbar actions, "dom_appeared" for modals and side panels.
- Do NOT highlight canvas board objects by elementIndex.`;
  }
  return "";
}

function buildDomElementsForPrompt(context) {
  if (!context.elements?.length) return "(No elements provided)";
  return context.elements
    .map(
      (el, i) =>
        `[${i}] <${el.tag}> "${(el.text || "").slice(0, 80)}" bounds:{x:${el.bounds?.x ?? 0},y:${el.bounds?.y ?? 0},w:${el.bounds?.width ?? 0},h:${el.bounds?.height ?? 0}}${el.role ? ` role="${el.role}"` : ""}${el.id ? ` id="${el.id}"` : ""}`
    )
    .join("\n");
}

/**
 * Parse Gemini response into a normalized plan.
 * Accepts new multi-step format or old single-step format (text + highlights).
 * @param {string} raw - Raw model response
 * @returns {{ taskSummary: string, steps: Array, suggestedFollowUps: string[] }}
 */
function parseGuidanceResponse(raw) {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      taskSummary: "Complete the task",
      steps: [],
      suggestedFollowUps: [],
    };
  }

  // New format: has steps array
  if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
    const steps = parsed.steps.map((s) => ({
      stepNumber: Number(s.stepNumber) || 0,
      instruction: String(s.instruction || "").slice(0, 80) || "Continue",
      highlights: (Array.isArray(s.highlights) ? s.highlights : []).map((h) => ({
        elementIndex: Number(h.elementIndex),
        label: String(h.label || "").slice(0, 30) || "Click here",
        color: /^#[0-9A-Fa-f]{6}$/.test(h.color) ? h.color : "#4CAF50",
        arrow: Boolean(h.arrow),
      })),
      completionSignals: (() => {
        const VALID = ["dom_appeared", "dom_disappeared", "url_changed", "user_clicked_target"];
        const normalize = (cs) => ({
          type: VALID.includes(cs?.type) ? cs.type : "user_clicked_target",
          description: String(cs?.description || "").slice(0, 200) || "Step completed",
          targetSelector: String(cs?.targetSelector || ""),
        });
        // Prefer new completionSignals array; fall back to singular completionSignal
        if (Array.isArray(s.completionSignals) && s.completionSignals.length > 0) {
          return s.completionSignals.map(normalize);
        }
        if (s.completionSignal) return [normalize(s.completionSignal)];
        return [{ type: "user_clicked_target", description: "Step completed", targetSelector: "" }];
      })(),
      // Keep single-signal alias for backwards compat
      get completionSignal() { return this.completionSignals[0]; },
    }));
    return {
      taskSummary: String(parsed.taskSummary || "Complete the task").slice(0, 300),
      steps,
      suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps)
        ? parsed.suggestedFollowUps.slice(0, 3).map((s) => String(s).slice(0, 100))
        : [],
    };
  }

  // Old format: text + highlights → single-step plan
  const text = String(parsed.text || "").trim();
  const highlights = Array.isArray(parsed.highlights) ? parsed.highlights : [];
  const instruction = text
    .replace(/\*\*[^*]*\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 10)
    .join(" ") || "Follow the guidance below";
  const step = {
    stepNumber: 1,
    instruction,
    highlights: highlights.map((h, i) => ({
      elementIndex: Number(h.elementIndex),
      label: String(h.label || h.reason || `${i + 1}`).slice(0, 30),
      color: HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length],
      arrow: true,
    })),
    completionSignals: [{ type: "user_clicked_target", description: "User clicked the highlighted element", targetSelector: "" }],
    get completionSignal() { return this.completionSignals[0]; },
  };
  return {
    taskSummary: text.slice(0, 300) || "Complete the task",
    steps: [step],
    suggestedFollowUps: [],
  };
}

/**
 * Call Gemini for multi-step guidance plan. Returns normalized plan; falls back to 1-step on old format or parse error.
 * @param {string} userMessage
 * @param {object} context - { url, screenshot, elements, viewport, ... }
 * @returns {Promise<{ taskSummary: string, steps: Array, suggestedFollowUps: string[] }>}
 */
async function askAIMultiStepPlan(userMessage, context) {
  if (!activeGuidanceModel) {
    return {
      taskSummary: "No AI model configured.",
      steps: [],
      suggestedFollowUps: [],
    };
  }

  const pageUrl = context?.url || "unknown";
  const domElements = buildDomElementsForPrompt(context);
  const prompt = GUIDANCE_MULTI_STEP_PROMPT.replace("{{userQuestion}}", userMessage)
    .replace("{{pageUrl}}", pageUrl)
    .replace("{{domElements}}", domElements)
    .replace("{{appHints}}", getAppHints(pageUrl));

  const contentParts = [];
  if (context?.screenshot) {
    const base64Data = context.screenshot.replace(/^data:image\/\w+;base64,/, "");
    contentParts.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${base64Data}` },
    });
  }
  contentParts.push({ type: "text", text: prompt });

  try {
    const model = createChatModel(activeGuidanceModel.provider, activeGuidanceModel.model);
    const messages = [
      new HumanMessage({ content: contentParts }),
    ];
    let result = await model.invoke(messages);
    let raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    let plan = parseGuidanceResponse(raw);

    // Retry once with stricter prompt on malformed JSON (no steps)
    if (plan.steps.length === 0 && raw.trim().length > 0) {
      const strictPrompt = `${prompt}\n\nIMPORTANT: You must respond with valid JSON only. Include a "steps" array with at least one step.`;
      const retryContent = context?.screenshot
        ? [contentParts[0], { type: "text", text: strictPrompt }]
        : [{ type: "text", text: strictPrompt }];
      result = await model.invoke([new HumanMessage({ content: retryContent })]);
      raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      plan = parseGuidanceResponse(raw);
    }

    if (plan.steps.length === 0) {
      const text = (typeof result?.content === "string" ? result.content : "").slice(0, 500);
      plan = {
        taskSummary: text || "Complete the task",
        steps: [{
          stepNumber: 1,
          instruction: "Follow the guidance above",
          highlights: [],
          completionSignals: [{ type: "user_clicked_target", description: "User acknowledged", targetSelector: "" }],
        }],
        suggestedFollowUps: [],
      };
    }

    return plan;
  } catch (err) {
    console.error("[AI] Multi-step guidance error:", err.message);
    return {
      taskSummary: `Error: ${err.message}`,
      steps: [],
      suggestedFollowUps: [],
    };
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
      webmcp: latestWebMCP,
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
          if (msg.ok) {
            if (msg.context?.webmcp) {
              const changed = JSON.stringify(latestWebMCP.tools) !== JSON.stringify(msg.context.webmcp.tools);
              latestWebMCP = { ...msg.context.webmcp, url: msg.context.url };
              if (changed && latestWebMCP.tools?.length > 0) {
                console.log(`\x1b[36m[WebMCP] 🔍 Discovered ${latestWebMCP.tools.length} tool(s) on ${msg.context.url}:\x1b[0m`);
                latestWebMCP.tools.forEach(t => console.log(`  \x1b[36m• ${t.name}\x1b[0m (${t.type}) — ${(t.description || "").slice(0, 60)}`));
                broadcast("dashboard", {
                  type: "WEBMCP_UPDATE",
                  webmcp: latestWebMCP,
                  timestamp: Date.now(),
                });
              } else if (changed) {
                console.log(`\x1b[36m[WebMCP] Page: ${msg.context.url} — available: ${latestWebMCP.available}, tools: 0\x1b[0m`);
              }
            }
            pending.resolve(msg.context);
          }
          else pending.reject(new Error(msg.error || "Context gather failed"));
        }
        break;
      }

      case "WEBMCP_SCAN_RESULT": {
        const pendingMcp = pendingWebMCPRequests.get(msg.requestId);
        if (pendingMcp) {
          clearTimeout(pendingMcp.timer);
          pendingWebMCPRequests.delete(msg.requestId);
          if (msg.ok) {
            latestWebMCP = { available: msg.available, tools: msg.tools || [], url: null };
            broadcast("dashboard", { type: "WEBMCP_UPDATE", webmcp: latestWebMCP, timestamp: Date.now() });
            pendingMcp.resolve(latestWebMCP);
          } else {
            pendingMcp.reject(new Error(msg.error || "WebMCP scan failed"));
          }
        }
        break;
      }

      case "WEBMCP_EXECUTE_RESULT": {
        const pendingExec = pendingActionRequests.get(msg.requestId);
        if (pendingExec) {
          clearTimeout(pendingExec.timer);
          pendingActionRequests.delete(msg.requestId);
          if (msg.ok) pendingExec.resolve({ result: msg.result });
          else pendingExec.reject(new Error(msg.error || "WebMCP execution failed"));
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

      case "STEP_COMPLETED": {
        handleStepCompleted(msg);
        break;
      }

      case "STEP_ABANDONED": {
        handleStepAbandoned(msg);
        break;
      }

      // P5: User responded to "Did you complete this step?" prompt
      case "STEP_CONFIRM_YES": {
        const tid = msg.threadId || "default";
        const session = sessionManager.getSession(tid);
        if (session) {
          const step = sessionManager.getCurrentStep(tid);
          console.log(`[STEP] User confirmed step ${step?.stepNumber} complete — advancing`);
          handleStepCompleted({ threadId: tid, sessionId: session.sessionId, stepNumber: step?.stepNumber, fromConfirm: true });
        }
        break;
      }

      case "STEP_CONFIRM_NO": {
        const tid = msg.threadId || "default";
        const session = sessionManager.getSession(tid);
        if (session) {
          console.log(`[STEP] User said step not done — restarting watcher`);
          sessionManager.setActive(tid);
          showCurrentStep(tid);
          broadcast("dashboard", {
            type: "CHAT_MESSAGE",
            text: "No problem — keep going! I'm watching for when you complete it.",
            sender: "system",
            timestamp: Date.now(),
          });
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
        sendToDesktop({ type: "SHOW_GUIDANCE", guides: msg.guides || [] });
        sendToExtension({ type: "SHOW_GUIDANCE", guides: msg.guides || [] });
        break;
      }

      case "CLEAR_GUIDANCE": {
        sendToDesktop({ type: "CLEAR_GUIDANCE" });
        sendToExtension({ type: "CLEAR_GUIDANCE" });
        break;
      }

      case "WEBMCP_SCAN": {
        console.log("webmcp");
        
        const reqId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sent = sendToExtension({ type: "WEBMCP_SCAN", requestId: reqId });
        if (sent) {
          const timer = setTimeout(() => pendingWebMCPRequests.delete(reqId), CONTEXT_TIMEOUT);
          pendingWebMCPRequests.set(reqId, {
            resolve: (r) => broadcast("dashboard", { type: "WEBMCP_UPDATE", webmcp: r, timestamp: Date.now() }),
            reject: (e) => broadcast("dashboard", { type: "CHAT_MESSAGE", text: `WebMCP scan error: ${e.message}`, sender: "system", timestamp: Date.now() }),
            timer,
          });
        } else {
          broadcast("dashboard", { type: "CHAT_MESSAGE", text: "No extension connected for WebMCP scan.", sender: "system", timestamp: Date.now() });
        }
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
// Message resolver — "yes" / follow-up suggestions (run first in message handling)
// ---------------------------------------------------------------------------
const AFFIRMATIVES = ["yes", "sure", "yeah", "ok", "please", "yep", "yup", "okay"];

function resolveMessage(threadId, rawText) {
  const suggestions = sessionManager.getLastSuggestions(threadId);
  if (!suggestions || suggestions.length === 0) return rawText;
  const normalized = String(rawText || "").toLowerCase().trim();
  if (AFFIRMATIVES.includes(normalized)) return suggestions[0];
  for (const s of suggestions) {
    if (s.toLowerCase().includes(normalized) || normalized.includes(s.toLowerCase().slice(0, 20))) return s;
  }
  return rawText;
}

// ---------------------------------------------------------------------------
// Multi-step guidance flow — showCurrentStep, handleStepCompleted, verify
// ---------------------------------------------------------------------------
/**
 * Verify step completion using a fresh screenshot.
 * The watcher fires when a DOM/URL/click signal occurs; this call confirms by
 * letting the AI look at the actual screen state.
 *
 * @param {string} instruction  - The step instruction ("Click the Insert menu")
 * @param {string} expected     - The completion signal description ("Insert dropdown visible")
 * @param {object} context      - Fresh page context including screenshot
 * @returns {Promise<{ verified: boolean, reason: string }>}
 */
async function verifyStepWithScreenshot(instruction, expected, context) {
  // No model → trust the watcher
  if (!activeGuidanceModel) return { verified: true, reason: "no model" };
  // No screenshot → trust the watcher (can't verify visually)
  if (!context?.screenshot) {
    console.log("[STEP] No screenshot available — trusting watcher signal");
    return { verified: true, reason: "no screenshot" };
  }

  const VERIFY_TIMEOUT_MS = 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const model = createChatModel(activeGuidanceModel.provider, activeGuidanceModel.model);
    const base64 = context.screenshot.replace(/^data:image\/\w+;base64,/, "");

    const prompt = `You are verifying whether a user completed a UI step.

Step instruction: "${instruction}"
Expected result: "${expected}"

Look at the screenshot carefully. Has the user completed this step?
Reply with ONLY valid JSON — no markdown, no explanation:
{"verified": true or false, "reason": "one sentence explaining what you see"}`;

    const result = await model.invoke([
      new HumanMessage({
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      }),
    ]);

    clearTimeout(timer);
    const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const verified = Boolean(parsed.verified);
    console.log(`[STEP] Screenshot verification: ${verified ? "✅ verified" : "❌ not verified"} — ${parsed.reason || ""}`);
    return { verified, reason: parsed.reason || "" };
  } catch (err) {
    clearTimeout(timer);
    // On timeout or any error → trust the watcher (never block the user)
    console.log(`[STEP] Verification error (${err.message}) — defaulting to verified=true`);
    return { verified: true, reason: "verification error" };
  }
}

async function showCurrentStep(threadId) {
  const session = sessionManager.getSession(threadId);
  const step = sessionManager.getCurrentStep(threadId);
  if (!session || !step) return;

  // P2: Always gather fresh context before showing each step so highlights are accurate.
  let context = sessionContextMap.get(threadId); // start with cached as fallback
  try {
    const fresh = await Promise.race([
      requestContextFromExtension(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);
    if (fresh) {
      context = fresh;
      sessionContextMap.set(threadId, fresh);
      if (fresh.screenshot) {
        latestScreenshot = { dataUrl: fresh.screenshot, url: fresh.url, timestamp: Date.now() };
      }
    }
  } catch (err) {
    console.log(`[STEP] Fresh context unavailable (${err.message}) — using cached`);
  }

  // Reset the _completing flag so the new step can be completed
  if (session._completing) session._completing = false;

  const totalSteps = session.steps.length;
  const stepNumber = step.stepNumber;

  console.log(`[STEP] Showing step ${stepNumber} of ${totalSteps} — ${step.instruction}`);

  const highlights = step.highlights || [];
  const guidanceData = context?.elements?.length
    ? highlights.map((h, i) => {
        const el = context.elements[h.elementIndex];
        if (!el?.bounds) return null;
        // Build a robust CSS selector — prefer ID, fall back to tag + attributes
        let selector = null;
        if (el.id) {
          selector = `#${el.id}`;
        } else {
          // Build a selector from tag, role, aria-label, href, or text content
          const tag = el.tag || '*';
          if (el.role) {
            selector = `${tag}[role="${el.role}"]`;
          } else if (el.href) {
            // Use href attribute for links (truncated to avoid overly long selectors)
            const shortHref = el.href.length > 80 ? el.href.slice(0, 80) : el.href;
            selector = `${tag}[href="${shortHref}"]`;
          } else if (el.text && el.text.length <= 60) {
            // Use :has or xpath-like text matching isn't standard CSS — leave for bounds
            selector = null;
          }
        }
        return {
          bounds: el.bounds,
          label: h.label || `${i + 1}`,
          reason: "",
          color: h.color || HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length],
          selector,
        };
      }).filter(Boolean)
    : [];

  let annotatedImage = null;
  if (highlights.length > 0 && context?.screenshot && context?.elements?.length) {
    const boxes = highlights.map((h, i) => {
      const el = context.elements[h.elementIndex];
      if (!el?.bounds) return null;
      return {
        x: el.bounds.x, y: el.bounds.y,
        width: el.bounds.width, height: el.bounds.height,
        label: h.label || `${i + 1}`,
        color: h.color || HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length],
      };
    }).filter(Boolean);
    if (boxes.length > 0) {
      annotatedImage = await buildAnnotatedImage(context, step.highlights);
    }
  }

  sessionManager.setActive(threadId);

  if (annotatedImage) {
    latestScreenshot = { dataUrl: annotatedImage, url: context?.url || "", timestamp: Date.now() };
    broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
  }

  broadcast("dashboard", {
    type: "STEP_PROGRESS",
    stepNumber,
    totalSteps,
    instruction: step.instruction,
    taskSummary: session.taskSummary,
    image: annotatedImage,
    guidance: guidanceData,
  });

  // Always send SHOW_GUIDANCE before STEP_GUIDANCE so the overlay's
  // currentGuides state is populated.  Previously this was guarded by
  // `guidanceData.length > 0`, which caused STEP_GUIDANCE to reference
  // an empty currentGuides array when no valid highlights were found —
  // resulting in the overlay progress panel appearing with no highlights.
  sendToDesktop({ type: "SHOW_GUIDANCE", guides: guidanceData });
  sendToExtension({ type: "SHOW_GUIDANCE", guides: guidanceData });

  sendToDesktop({
    type: "STEP_GUIDANCE",
    step: session.currentStepIndex,
    stepNumber,
    totalSteps,
    instruction: step.instruction,
    taskSummary: session.taskSummary,
  });
  sendToExtension({
    type: "STEP_GUIDANCE",
    step: session.currentStepIndex,
    stepNumber,
    totalSteps,
    instruction: step.instruction,
    taskSummary: session.taskSummary,
  });
  const selectorFromHighlight = guidanceData[0]?.selector || "";

  // P4: Send all completion signals so the watcher can race them (OR logic).
  const signals = (step.completionSignals || [step.completionSignal]).map((sig) => ({
    ...sig,
    targetSelector: sig.targetSelector || selectorFromHighlight || "",
  }));
  sendToExtension({
    type: "WATCH_FOR_COMPLETION",
    threadId,
    sessionId: session.sessionId,
    stepNumber,
    signals,
  });

  sessionManager.setWaitingForStep(threadId);

  // P3: Start screenshot-polling as an additional completion detector.
  startPollingVerification(threadId, step);
}

// ---------------------------------------------------------------------------
// P3: Screenshot polling verification — catches completions DOM watchers miss
// ---------------------------------------------------------------------------
function stopPollingVerification(threadId) {
  const id = activePollers.get(threadId);
  if (id) {
    clearInterval(id);
    activePollers.delete(threadId);
  }
}

function startPollingVerification(threadId, step) {
  stopPollingVerification(threadId); // clear any previous poller for this thread

  // Only poll on signals where screenshot can help (not user_clicked_target — the watcher handles that)
  const primaryType = step.completionSignals?.[0]?.type || step.completionSignal?.type || "user_clicked_target";
  if (primaryType === "user_clicked_target") return; // watcher is sufficient

  const POLL_INTERVAL_MS = 4000;
  const intervalId = setInterval(async () => {
    const session = sessionManager.getSession(threadId);
    if (!session || session.status !== "waiting_for_step" || session._completing) {
      stopPollingVerification(threadId);
      return;
    }
    const currentStep = sessionManager.getCurrentStep(threadId);
    if (!currentStep || String(currentStep.stepNumber) !== String(step.stepNumber)) {
      stopPollingVerification(threadId);
      return;
    }

    let freshContext = null;
    try {
      freshContext = await Promise.race([
        requestContextFromExtension(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500)),
      ]);
    } catch { return; } // silent — try again next interval

    const { verified } = await verifyStepWithScreenshot(
      step.instruction,
      (step.completionSignals?.[0] || step.completionSignal)?.description || "Step completed",
      freshContext
    );

    if (verified) {
      console.log(`[POLL] Screenshot confirms step ${step.stepNumber} complete — advancing`);
      stopPollingVerification(threadId);
      handleStepCompleted({
        threadId,
        sessionId: session.sessionId,
        stepNumber: step.stepNumber,
        fromPoller: true,
      });
    }
  }, POLL_INTERVAL_MS);

  activePollers.set(threadId, intervalId);
  console.log(`[POLL] Started screenshot polling for step ${step.stepNumber} (interval: ${POLL_INTERVAL_MS}ms)`);
}

async function handleStepCompleted(msg) {
  const { threadId, sessionId, stepNumber } = msg;
  console.log(`[WATCHER] STEP_COMPLETED`, { threadId, sessionId, stepNumber, fromPoller: msg.fromPoller || false });

  const session = sessionManager.getSession(threadId);
  const currentStep = sessionManager.getCurrentStep(threadId);
  if (!session || !currentStep || String(currentStep.stepNumber) !== String(stepNumber)) {
    console.log("[STEP] Ignoring STEP_COMPLETED — session or step mismatch");
    return;
  }

  // Guard against concurrent completion signals (DOM watcher + poller firing at the same time)
  if (session._completing) {
    console.log("[STEP] Ignoring duplicate STEP_COMPLETED signal");
    return;
  }
  session._completing = true;

  // Stop any active poller — we're handling completion now
  stopPollingVerification(threadId);

  // Immediate feedback so the user sees the system reacted
  broadcast("dashboard", {
    type: "CHAT_MESSAGE",
    text: `✔ Step ${stepNumber} detected — verifying…`,
    sender: "system",
    timestamp: Date.now(),
  });

  // Capture a fresh screenshot (capped at 4s so we never hang here).
  let freshContext = null;
  try {
    freshContext = await Promise.race([
      requestContextFromExtension(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("context timeout")), 4000)),
    ]);
    // Keep the dashboard mirror updated with the latest screenshot
    if (freshContext?.screenshot) {
      latestScreenshot = { dataUrl: freshContext.screenshot, url: freshContext.url, timestamp: Date.now() };
      broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
    }
  } catch (err) {
    console.log(`[STEP] Could not capture screenshot for verification: ${err.message} — trusting watcher`);
  }

  const completionDescription = currentStep.completionSignal?.description || "Step completed";
  const { verified } = await verifyStepWithScreenshot(
    currentStep.instruction,
    completionDescription,
    freshContext
  );

  if (!verified) {
    session._verifyRetries = (session._verifyRetries || 0) + 1;
    if (session._verifyRetries <= 2) {
      console.log(`[STEP] Screenshot says not done yet (retry ${session._verifyRetries}/2) — re-watching`);
      session._completing = false; // allow next completion signal through
      sessionManager.setActive(threadId);
      showCurrentStep(threadId); // showCurrentStep resets _completing too
      return;
    }
    console.log("[STEP] Max retries reached — advancing despite screenshot disagreement");
  }

  session._completing = false;
  session._verifyRetries = 0;
  console.log(`[STEP] Advancing from step ${stepNumber}`);

  // Broadcast step status update so plan card can mark this step done
  broadcast("dashboard", {
    type: "STEP_STATUS_UPDATE",
    completedStep: parseInt(stepNumber, 10),
    nextStep: session.currentStepIndex + 1 < session.steps.length
      ? session.steps[session.currentStepIndex + 1].stepNumber
      : null,
  });

  const nextStep = sessionManager.advanceStep(threadId);
  if (nextStep) {
    showCurrentStep(threadId);
  } else {
    sessionManager.completeSession(threadId);
    sendToDesktop({ type: "CLEAR_GUIDANCE" });
    sendToExtension({ type: "CLEAR_GUIDANCE" });
    const suggestions = sessionManager.getLastSuggestions(threadId);
    broadcast("dashboard", {
      type: "TASK_COMPLETE",
      message: `✅ ${session.taskSummary} — all done!`,
      suggestions: suggestions || [],
    });
  }
}

function handleStepAbandoned(msg) {
  const { threadId, reason } = msg;
  console.log(`[WATCHER] STEP_ABANDONED`, { threadId, reason });

  const isTimeout = reason && String(reason).toLowerCase().includes("timeout");

  // On timeout: P5 — show "Did you complete this step?" confirm instead of silently restarting.
  if (isTimeout) {
    const session = sessionManager.getSession(threadId);
    if (session && session.status !== "complete" && session.status !== "abandoned") {
      stopPollingVerification(threadId);
      const currentStep = sessionManager.getCurrentStep(threadId);
      console.log(`[STEP] Timeout — prompting user for step confirm (step ${currentStep?.stepNumber})`);
      // Keep session alive while we wait for the user to respond
      sessionManager.setActive(threadId);
      broadcast("dashboard", {
        type: "STEP_CONFIRM",
        threadId,
        stepNumber: currentStep?.stepNumber,
        instruction: currentStep?.instruction,
      });
      return;
    }
  }

  // Explicit abandon (Tab unreachable, user cancelled, etc.) — end the session.
  stopPollingVerification(threadId);
  sessionManager.abandonSession(threadId);
  sendToDesktop({ type: "CLEAR_GUIDANCE" });
  sendToExtension({ type: "CLEAR_GUIDANCE" });
  broadcast("dashboard", {
    type: "GUIDANCE_ABANDONED",
    reason: reason || "Guidance stopped",
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
  const threadId = "default";
  const resolvedText = resolveMessage(threadId, text);
  if (resolvedText !== text) {
    console.log(`[SESSION] Resolved message to suggestion: "${resolvedText.slice(0, 50)}"`);
  }

  if (sessionManager.hasActiveSession(threadId)) {
    sessionManager.abandonSession(threadId);
    sessionContextMap.delete(threadId);
    sendToDesktop({ type: "CLEAR_GUIDANCE" });
    sendToExtension({ type: "CLEAR_GUIDANCE" });
    broadcast("dashboard", { type: "GUIDANCE_ABANDONED", reason: "New message started" });
  }

  const userMsg = { type: "CHAT_MESSAGE", text: resolvedText, sender: "user", timestamp: Date.now() };
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

  const intent = await classifyIntent(resolvedText, pageContext, classifierModel);

  // Detailed routing log
  const webmcpStatus = pageContext?.webmcp?.available
    ? `\x1b[36mWebMCP: ${pageContext.webmcp.tools?.length || 0} tool(s)\x1b[0m`
    : `WebMCP: none`;
  const contextInfo = pageContext
    ? `elements=${pageContext.elements?.length || 0}, screenshot=${!!pageContext.screenshot}`
    : "no context";
  console.log(`\x1b[32m[Chat] ━━━ ROUTING ━━━\x1b[0m`);
  console.log(`  Message: "${resolvedText.slice(0, 80)}"`);
  console.log(`  Intent:  \x1b[1m${intent.toUpperCase()}\x1b[0m`);
  console.log(`  URL:     ${pageContext?.url || "unknown"}`);
  console.log(`  Context: ${contextInfo}`);
  console.log(`  ${webmcpStatus}`);

  if (abort.signal.aborted) return;

  switch (intent) {
    case "action":
      if (browserAgent) {
        console.log(`\x1b[32m[Chat] → Routing to \x1b[1mLangGraph Agent\x1b[0m\x1b[32m (${activeAgentModel?.provider}/${activeAgentModel?.model})\x1b[0m`);
        await handleAgentAction(resolvedText, abort.signal);
      } else {
        console.log(`\x1b[32m[Chat] → Agent unavailable, falling back to \x1b[1mChat mode\x1b[0m`);
        await handleNormalChat(resolvedText, pageContext, abort.signal);
      }
      break;
    case "guidance":
      console.log(`\x1b[32m[Chat] → Routing to \x1b[1mGuidance AI\x1b[0m\x1b[32m (screenshot + context analysis)\x1b[0m`);
      await handleGuidanceChat(resolvedText, pageContext, abort.signal);
      break;
    case "chat":
    default:
      console.log(`\x1b[32m[Chat] → Routing to \x1b[1mNormal Chat\x1b[0m`);
      await handleNormalChat(resolvedText, pageContext, abort.signal);
      break;
  }
}

// ---------------------------------------------------------------------------
// GUIDANCE mode — multi-step session
// ---------------------------------------------------------------------------
async function handleGuidanceChat(text, prefetchedContext = null, signal = null) {
  const threadId = "default";
  broadcast("dashboard", { type: "AI_THINKING", thinking: true });

  try {
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

    const plan = await askAIMultiStepPlan(text, context);
    if (signal?.aborted) return;

    if (!plan.steps || plan.steps.length === 0) {
      broadcast("dashboard", {
        type: "CHAT_MESSAGE", text: plan.taskSummary || "No steps generated.",
        sender: "ai", timestamp: Date.now(),
      });
      return;
    }

    sessionManager.createSession(threadId, text, plan);
    sessionContextMap.set(threadId, context);

    broadcast("dashboard", {
      type: "GUIDANCE_SESSION_START",
      taskSummary: plan.taskSummary,
      totalSteps: plan.steps.length,
      steps: plan.steps.map((s, i) => ({
        stepNumber: s.stepNumber || i + 1,
        instruction: s.instruction,
        status: i === 0 ? "active" : "pending",
      })),
    });

    await showCurrentStep(threadId);
  } catch (err) {
    console.error("[Guidance] Error:", err);
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
  console.log(`\x1b[34m[Agent] ━━━ LangGraph Agent Starting ━━━\x1b[0m`);
  console.log(`  Model: ${activeAgentModel?.provider}/${activeAgentModel?.model}`);
  console.log(`  Task:  "${text.slice(0, 100)}"`);
  console.log(`  WebMCP available: ${latestWebMCP.available ? `YES (${latestWebMCP.tools?.length} tools)` : "NO"}`);

  broadcast("dashboard", {
    type: "AGENT_STATUS", status: "running",
    message: `Agent running (${activeAgentModel?.provider}/${activeAgentModel?.model})...`,
    timestamp: Date.now(),
  });

  try {
    const result = await runBrowserAgent(browserAgent, text, null, signal);

    console.log(`\x1b[34m[Agent] ━━━ Agent Finished ━━━\x1b[0m`);
    console.log(`  Status: ${result.status} | Steps: ${result.steps}`);
    console.log(`  Summary: ${result.summary?.slice(0, 120)}`);

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
    connections: { extension: clients.extension.size, dashboard: clients.dashboard.size, desktop: clients.desktop.size },
    events: recentEvents.length,
    webmcp: latestWebMCP,
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
