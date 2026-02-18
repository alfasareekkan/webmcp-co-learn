import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { annotateScreenshot } from "./annotate.js";

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
  console.log("[AI] Gemini model loaded (gemini-2.5-flash-lite)");
} else {
  console.warn("[AI] No GEMINI_API_KEY — AI disabled. Set via: GEMINI_API_KEY=key npm start");
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
// Gemini AI — two-mode prompting
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are CoLearn Assistant — an AI co-pilot that helps users understand and navigate web applications in real time.

You receive:
- A screenshot of the user's current browser tab
- DOM structure (headings, buttons, links, inputs, forms, text)
- Interactive elements with their pixel-level bounding boxes
- Recent network requests and console logs
- Performance metrics

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
- If no visual highlighting is needed (general questions, explanations), set "highlights" to an empty array [].
- Keep text concise and actionable.
- When highlighting, describe the element location in text too (e.g., "top-right corner", "in the sidebar").
- Use numbered labels (1, 2, 3) when highlighting multiple elements to show a sequence/pathway.`;

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

async function askGemini(userMessage, context) {
  if (!geminiModel) {
    return { text: "AI is not configured. Set GEMINI_API_KEY and restart.", highlights: [] };
  }

  const contextText = buildContextText(context);

  try {
    const parts = [];

    if (context.screenshot) {
      const base64Data = context.screenshot.replace(/^data:image\/\w+;base64,/, "");
      parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
    }

    parts.push({
      text: `${SYSTEM_PROMPT}\n\n--- PAGE CONTEXT ---\n${contextText}\n\n--- USER QUESTION ---\n${userMessage}`,
    });

    const result = await geminiModel.generateContent(parts);
    const raw = result.response.text();

    // Parse JSON response from Gemini
    try {
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        text: parsed.text || raw,
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      };
    } catch {
      // Gemini didn't return JSON — treat as plain text
      return { text: raw, highlights: [] };
    }
  } catch (err) {
    console.error("[AI] Gemini error:", err.message);
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
      x: el.bounds.x,
      y: el.bounds.y,
      width: el.bounds.width,
      height: el.bounds.height,
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
      aiEnabled: !!geminiModel,
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

      case "CHAT_MESSAGE": {
        handleChatMessage(msg.text, ws);
        break;
      }

      case "SHOW_GUIDANCE": {
        sendToExtension({
          type: "SHOW_GUIDANCE",
          guides: msg.guides || [],
        });
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
// Chat handler — the brain
// ---------------------------------------------------------------------------
async function handleChatMessage(text, senderWs) {
  const userMsg = {
    type: "CHAT_MESSAGE",
    text,
    sender: "user",
    timestamp: Date.now(),
  };
  pushEvent(userMsg);
  broadcast("dashboard", userMsg);

  broadcast("dashboard", { type: "AI_THINKING", thinking: true });

  try {
    // 1. Gather context from extension
    let context;
    try {
      context = await requestContextFromExtension();
    } catch (err) {
      context = { url: "unknown", title: "unknown", error: err.message };
    }

    // 2. Update screen mirror
    if (context.screenshot) {
      latestScreenshot = {
        dataUrl: context.screenshot,
        url: context.url,
        timestamp: Date.now(),
      };
      broadcast("dashboard", { type: "SCREENSHOT", ...latestScreenshot });
    }

    // 3. Ask Gemini (returns structured { text, highlights })
    const aiResult = await askGemini(text, context);

    // 4. If AI highlighted elements, draw on the screenshot
    let annotatedImage = null;
    if (aiResult.highlights.length > 0) {
      annotatedImage = await buildAnnotatedImage(context, aiResult.highlights);
    }

    // 5. Build guidance data for on-page overlay
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

    // 6. Send AI response with optional annotated image and guidance
    const aiMsg = {
      type: "CHAT_MESSAGE",
      text: aiResult.text,
      sender: "ai",
      timestamp: Date.now(),
      image: annotatedImage,
      highlights: aiResult.highlights,
      guidance: guidanceData,
      context: { url: context.url, title: context.title },
    };
    pushEvent(aiMsg);
    broadcast("dashboard", aiMsg);

    // 7. Auto-send guidance overlay to extension
    if (guidanceData.length > 0) {
      sendToExtension({
        type: "SHOW_GUIDANCE",
        guides: guidanceData,
      });
    }

  } catch (err) {
    broadcast("dashboard", {
      type: "CHAT_MESSAGE",
      text: `Error: ${err.message}`,
      sender: "system",
      timestamp: Date.now(),
    });
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
  console.log(`[CoLearn] Server on http://localhost:${PORT}`);
  console.log(`[CoLearn] WebSocket on ws://localhost:${PORT}`);
});
