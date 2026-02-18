import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const PORT = process.env.PORT || 3001;

let geminiModel = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    generationConfig: { temperature: 0 },
  });
  console.log("[AI] Gemini model loaded");
} else {
  console.warn("[AI] No GEMINI_API_KEY set — AI features disabled. Set it via: GEMINI_API_KEY=your_key npm start");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------------------
// Client tracking
// ---------------------------------------------------------------------------
const clients = {
  extension: new Set(),
  dashboard: new Set(),
};

const recentEvents = [];
const MAX_EVENTS = 500;
let latestScreenshot = null;

// Pending context requests (requestId -> { resolve, reject, timer })
const pendingContextRequests = new Map();
const CONTEXT_TIMEOUT = 15000;

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
      reject(new Error("No extension connected. Open a tab with the extension active and attach the debugger."));
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
// Gemini AI
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are CoLearn Assistant — an AI co-pilot that helps users understand and navigate web applications.

You receive rich context about the user's current browser tab including:
- A screenshot of the page
- DOM structure (headings, buttons, links, inputs, forms, visible text)
- Recent network requests
- Console logs
- Performance metrics

Based on this context, answer the user's question helpfully and concisely. When describing UI elements, reference them by their visible text or position. If you see errors in console or network failures, mention them when relevant.

Keep responses short and actionable — this is a real-time co-working assistant.`;

async function askGemini(userMessage, context) {
  if (!geminiModel) {
    return "AI is not configured. Set the GEMINI_API_KEY environment variable and restart the server.";
  }

  // Build a text summary of the context
  const contextParts = [];
  if (context.url) contextParts.push(`**Page URL:** ${context.url}`);
  if (context.title) contextParts.push(`**Page Title:** ${context.title}`);

  if (context.dom) {
    const d = context.dom;
    if (d.headings?.length)
      contextParts.push(`**Headings:** ${d.headings.map(h => `${h.level}: ${h.text}`).join(" | ")}`);
    if (d.buttons?.length)
      contextParts.push(`**Buttons:** ${d.buttons.map(b => b.text).filter(Boolean).join(", ")}`);
    if (d.links?.length)
      contextParts.push(`**Links (sample):** ${d.links.slice(0, 10).map(l => l.text || l.href).join(", ")}`);
    if (d.inputs?.length)
      contextParts.push(`**Inputs:** ${d.inputs.map(i => `${i.type}[${i.name || i.placeholder || ""}]`).join(", ")}`);
    if (d.forms?.length)
      contextParts.push(`**Forms:** ${d.forms.map(f => `${f.method} ${f.action}`).join(", ")}`);
    if (d.selection)
      contextParts.push(`**Selected text:** ${d.selection}`);
    if (d.bodyText)
      contextParts.push(`**Visible text (truncated):** ${d.bodyText.slice(0, 1500)}`);
  }

  if (context.networkLogs?.length) {
    const netSummary = context.networkLogs.slice(-15).map(n =>
      `${n.method || "?"} ${n.status || "..."} ${n.url?.slice(0, 100)}`
    ).join("\n");
    contextParts.push(`**Recent Network Requests:**\n${netSummary}`);
  }

  if (context.consoleLogs?.length) {
    const consoleSummary = context.consoleLogs.slice(-10).map(c =>
      `[${c.level}] ${c.text}`
    ).join("\n");
    contextParts.push(`**Console Logs:**\n${consoleSummary}`);
  }

  if (context.performance) {
    const perfLines = Object.entries(context.performance)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? Math.round(v) : v}`)
      .join(", ");
    contextParts.push(`**Performance:** ${perfLines}`);
  }

  const contextText = contextParts.join("\n\n");

  try {
    // Build request parts — include screenshot as image if present
    const parts = [];

    if (context.screenshot) {
      const base64Data = context.screenshot.replace(/^data:image\/\w+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Data,
        },
      });
    }

    parts.push({
      text: `${SYSTEM_PROMPT}\n\n--- PAGE CONTEXT ---\n${contextText}\n\n--- USER QUESTION ---\n${userMessage}`,
    });

    const result = await geminiModel.generateContent(parts);
    const response = result.response;
    return response.text();
  } catch (err) {
    console.error("[AI] Gemini error:", err.message);
    return `AI error: ${err.message}`;
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
      aiEnabled: !!geminiModel,
    }));
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // --- Events from extension ---
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
          dataUrl: msg.dataUrl,
          tabId: msg.tabId,
          url: msg.url,
          timestamp: Date.now(),
        };
        broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
        break;
      }

      // --- Context response from extension ---
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

      // --- Chat from dashboard ---
      case "CHAT_MESSAGE": {
        handleChatMessage(msg.text, ws);
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
// Chat message handler — the brain
// ---------------------------------------------------------------------------
async function handleChatMessage(text, senderWs) {
  // 1) Echo user message to all dashboards
  const userMsg = {
    type: "CHAT_MESSAGE",
    text,
    sender: "user",
    timestamp: Date.now(),
  };
  pushEvent(userMsg);
  broadcast("dashboard", userMsg);

  // 2) Tell dashboards AI is thinking
  broadcast("dashboard", { type: "AI_THINKING", thinking: true });

  try {
    // 3) Gather context from extension
    let context;
    try {
      context = await requestContextFromExtension();
    } catch (err) {
      // Fall back to minimal context
      context = {
        url: "unknown",
        title: "unknown",
        error: err.message,
      };
    }

    // 4) Update screenshot in dashboard if we got a new one
    if (context.screenshot) {
      latestScreenshot = {
        dataUrl: context.screenshot,
        url: context.url,
        timestamp: Date.now(),
      };
      broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
    }

    // 5) Ask Gemini
    const aiAnswer = await askGemini(text, context);

    // 6) Send AI response
    const aiMsg = {
      type: "CHAT_MESSAGE",
      text: aiAnswer,
      sender: "ai",
      timestamp: Date.now(),
      context: {
        url: context.url,
        title: context.title,
      },
    };
    pushEvent(aiMsg);
    broadcast("dashboard", aiMsg);

  } catch (err) {
    const errorMsg = {
      type: "CHAT_MESSAGE",
      text: `Error: ${err.message}`,
      sender: "system",
      timestamp: Date.now(),
    };
    broadcast("dashboard", errorMsg);
  } finally {
    broadcast("dashboard", { type: "AI_THINKING", thinking: false });
  }
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    aiEnabled: !!geminiModel,
    connections: {
      extension: clients.extension.size,
      dashboard: clients.dashboard.size,
    },
    events: recentEvents.length,
  });
});

app.get("/api/events", (_req, res) => {
  res.json(recentEvents.slice(-50));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[CoLearn] Server running on http://localhost:${PORT}`);
  console.log(`[CoLearn] WebSocket on ws://localhost:${PORT}`);
});
