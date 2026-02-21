// CoLearn Browser Agent — LangGraph-powered autonomous browser control
// Uses a ReAct (Reason + Act) loop: observe page → plan → execute action → verify → repeat
// All actions use CSS selectors for reliable element targeting.

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const MAX_AGENT_STEPS = 20;

// ---------------------------------------------------------------------------
// Agent State
// ---------------------------------------------------------------------------
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (curr, update) => [...curr, ...update],
    default: () => [],
  }),
  pageContext: Annotation({
    reducer: (_, update) => update,
    default: () => null,
  }),
  stepCount: Annotation({
    reducer: (_, update) => update,
    default: () => 0,
  }),
  status: Annotation({
    reducer: (_, update) => update,
    default: () => "running",
  }),
  domFingerprint: Annotation({
    reducer: (_, update) => update,
    default: () => null,
  }),
  retryCount: Annotation({
    reducer: (_, update) => update,
    default: () => 0,
  }),
});

// ---------------------------------------------------------------------------
// System prompt — teaches the agent to use selectors & DOM manipulation
// ---------------------------------------------------------------------------
const AGENT_SYSTEM_PROMPT = `You are CoLearn Browser Agent — an AI that controls a real web browser to complete tasks autonomously.

You see the current page as a list of ELEMENTS with CSS selectors, text content, styles, and bounding boxes. Use CSS selectors to target elements.

## TOOLS AVAILABLE

**Interaction tools (simulate user actions):**
- click_element(selector) — click a button, link, or any element
- type_text(selector, text) — type text into an input/textarea
- press_key(key) — press Enter, Tab, Escape, etc.
- scroll_page(direction) — scroll up/down

**DOM manipulation tools (directly modify the page):**
- modify_style(selector, styles) — change CSS properties (color, background, font-size, display, etc.)
- set_attribute(selector, attribute, value) — change any HTML attribute (src, href, class, etc.)
- set_content(selector, text) — change the text content of an element
- execute_js(code) — run arbitrary JavaScript on the page for complex operations

**Navigation & observation:**
- navigate_to(url) — go to a URL
- read_page() — re-read the page to see updated elements after an action
- wait_for_page(ms) — wait for page to load

**Completion:**
- done(summary) — call when the task is complete

## RULES
1. ALWAYS use the CSS "selector" field from the ELEMENTS list to target elements. Example: "#myBtn", ".search-input", "button:nth-of-type(2)"
2. For visual changes (color, size, position, visibility), use modify_style directly — don't look for UI controls.
3. For text changes, use set_content directly.
4. For complex multi-step DOM changes, use execute_js with inline JavaScript.
5. After each action, observe the result. Use read_page if needed.
6. Use ONE tool at a time. Think step by step.
7. Call done() when finished. Include a summary of what you did.
8. If stuck after 3 attempts, explain the issue and call done.`;

// ---------------------------------------------------------------------------
// Create browser tools using CSS selectors
// ---------------------------------------------------------------------------
function createBrowserTools(context) {
  const { executeAction, requestContext, onProgress } = context;

  const click_element = tool(
    async ({ selector, description }) => {
      onProgress({ action: "click", description: description || `Clicking ${selector}` });
      try {
        const result = await executeAction({ type: "click", selector });
        return `Clicked ${selector}. ${result?.message || "Success."}`;
      } catch (err) {
        return `Failed to click ${selector}: ${err.message}`;
      }
    },
    {
      name: "click_element",
      description: "Click an element on the page using its CSS selector.",
      schema: z.object({
        selector: z.string().describe("CSS selector of the element to click (from ELEMENTS list)"),
        description: z.string().optional().describe("What you are clicking"),
      }),
    }
  );

  const type_text = tool(
    async ({ selector, text, clearFirst, description }) => {
      onProgress({ action: "type", description: description || `Typing "${text.slice(0, 30)}"` });
      try {
        const result = await executeAction({ type: "type", selector, text, clearFirst: clearFirst ?? true });
        return `Typed "${text}" into ${selector}. ${result?.message || "Success."}`;
      } catch (err) {
        return `Failed to type into ${selector}: ${err.message}`;
      }
    },
    {
      name: "type_text",
      description: "Type text into an input, textarea, or contenteditable element.",
      schema: z.object({
        selector: z.string().describe("CSS selector of the input element"),
        text: z.string().describe("Text to type"),
        clearFirst: z.boolean().optional().describe("Clear existing content first (default: true)"),
        description: z.string().optional().describe("What you are typing and why"),
      }),
    }
  );

  const modify_style = tool(
    async ({ selector, styles, description }) => {
      onProgress({ action: "style", description: description || `Modifying style of ${selector}` });
      try {
        const result = await executeAction({ type: "modify_style", selector, styles });
        return `Style updated on ${selector}. ${result?.message || "Success."}`;
      } catch (err) {
        return `Failed to modify style: ${err.message}`;
      }
    },
    {
      name: "modify_style",
      description: "Directly change CSS styles of element(s). Use for visual changes like color, background, font, size, display, opacity, etc.",
      schema: z.object({
        selector: z.string().describe("CSS selector (can match multiple elements)"),
        styles: z.record(z.string()).describe('Object of CSS properties. Use camelCase keys. Example: {"backgroundColor": "blue", "color": "white", "fontSize": "20px"}'),
        description: z.string().optional().describe("What visual change you are making"),
      }),
    }
  );

  const set_attribute = tool(
    async ({ selector, attribute, value, description }) => {
      onProgress({ action: "attribute", description: description || `Setting ${attribute} on ${selector}` });
      try {
        const result = await executeAction({ type: "set_attribute", selector, attribute, value });
        return `Set ${attribute}="${value}" on ${selector}. ${result?.message || "Success."}`;
      } catch (err) {
        return `Failed to set attribute: ${err.message}`;
      }
    },
    {
      name: "set_attribute",
      description: "Set an HTML attribute on element(s). Use for src, href, class, data-*, disabled, placeholder, etc.",
      schema: z.object({
        selector: z.string().describe("CSS selector"),
        attribute: z.string().describe("Attribute name (e.g., 'class', 'src', 'href', 'disabled')"),
        value: z.string().describe("Attribute value"),
        description: z.string().optional(),
      }),
    }
  );

  const set_content = tool(
    async ({ selector, text, html, description }) => {
      onProgress({ action: "content", description: description || `Updating content of ${selector}` });
      try {
        const result = await executeAction({ type: "set_content", selector, text, html });
        return `Content updated for ${selector}. ${result?.message || "Success."}`;
      } catch (err) {
        return `Failed to set content: ${err.message}`;
      }
    },
    {
      name: "set_content",
      description: "Change the text or HTML content of an element. Use text for plain text, html for HTML markup.",
      schema: z.object({
        selector: z.string().describe("CSS selector of the element"),
        text: z.string().optional().describe("Plain text content (sets textContent)"),
        html: z.string().optional().describe("HTML content (sets innerHTML) — use only when needed"),
        description: z.string().optional(),
      }),
    }
  );

  const execute_js = tool(
    async ({ code, description }) => {
      onProgress({ action: "js", description: description || "Executing JavaScript" });
      try {
        const result = await executeAction({ type: "execute_js", code });
        return `JavaScript executed. Result: ${result?.message || "done"}`;
      } catch (err) {
        return `JavaScript error: ${err.message}`;
      }
    },
    {
      name: "execute_js",
      description: "Run arbitrary JavaScript on the page. Use for complex operations that other tools can't handle. The code runs in the page context with full DOM access.",
      schema: z.object({
        code: z.string().describe("JavaScript code to execute. Must be a function body (no wrapping function needed). Use 'return' to return a value."),
        description: z.string().optional().describe("What this code does"),
      }),
    }
  );

  const scroll_page = tool(
    async ({ direction, amount }) => {
      onProgress({ action: "scroll", description: `Scrolling ${direction}` });
      try {
        const result = await executeAction({ type: "scroll", direction, amount: amount || 400 });
        return `Scrolled ${direction}. ${result?.message || ""}`;
      } catch (err) {
        return `Scroll failed: ${err.message}`;
      }
    },
    {
      name: "scroll_page",
      description: "Scroll the page up or down.",
      schema: z.object({
        direction: z.enum(["up", "down"]).describe("Scroll direction"),
        amount: z.number().optional().describe("Pixels to scroll (default: 400)"),
      }),
    }
  );

  const navigate_to = tool(
    async ({ url }) => {
      onProgress({ action: "navigate", description: `Navigating to ${url}` });
      try {
        const result = await executeAction({ type: "navigate", url });
        return `Navigated to ${url}. ${result?.message || "Page loading..."}`;
      } catch (err) {
        return `Navigation failed: ${err.message}`;
      }
    },
    {
      name: "navigate_to",
      description: "Navigate the browser to a URL.",
      schema: z.object({
        url: z.string().describe("The URL to navigate to"),
      }),
    }
  );

  const press_key = tool(
    async ({ key }) => {
      onProgress({ action: "press_key", description: `Pressing ${key}` });
      try {
        const result = await executeAction({ type: "press_key", key });
        return `Pressed ${key}. ${result?.message || "Success."}`;
      } catch (err) {
        return `Key press failed: ${err.message}`;
      }
    },
    {
      name: "press_key",
      description: "Press a keyboard key. Supports: Enter, Tab, Escape, Backspace, Delete, Arrow keys, Space.",
      schema: z.object({
        key: z.string().describe("Key name (e.g., 'Enter', 'Tab', 'Escape')"),
      }),
    }
  );

  const wait_for_page = tool(
    async ({ milliseconds }) => {
      onProgress({ action: "wait", description: `Waiting ${milliseconds}ms` });
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      return `Waited ${milliseconds}ms. Use read_page to see the current state.`;
    },
    {
      name: "wait_for_page",
      description: "Wait for page to load or animations to complete.",
      schema: z.object({
        milliseconds: z.number().describe("Time to wait (100-5000)").default(1000),
      }),
    }
  );

  const read_page = tool(
    async () => {
      onProgress({ action: "observe", description: "Reading current page state" });
      try {
        const ctx = await requestContext();
        return buildContextSummary(ctx);
      } catch (err) {
        return `Failed to read page: ${err.message}`;
      }
    },
    {
      name: "read_page",
      description: "Re-read the current page state to see updated elements after an action.",
      schema: z.object({}),
    }
  );

  const done = tool(
    async ({ summary }) => `TASK_COMPLETE: ${summary}`,
    {
      name: "done",
      description: "Call when the task is complete. Provide a summary.",
      schema: z.object({
        summary: z.string().describe("Summary of what was accomplished"),
      }),
    }
  );

  return [
    click_element, type_text, modify_style, set_attribute,
    set_content, execute_js, scroll_page, navigate_to,
    press_key, wait_for_page, read_page, done,
  ];
}

// ---------------------------------------------------------------------------
// Build a text summary of page context for the agent
// ---------------------------------------------------------------------------
function buildContextSummary(ctx) {
  if (!ctx) return "No page context available.";

  const parts = [];
  parts.push(`URL: ${ctx.url || "unknown"}`);
  parts.push(`Title: ${ctx.title || "unknown"}`);

  if (ctx.dom) {
    const d = ctx.dom;
    if (d.headings?.length)
      parts.push(`Headings: ${d.headings.map((h) => `${h.level}: ${h.text}`).join(" | ")}`);
    if (d.bodyText)
      parts.push(`Visible text (truncated): ${d.bodyText.slice(0, 1200)}`);
  }

  if (ctx.elements?.length) {
    const elList = ctx.elements.map((el, i) => {
      let line = `  [${i}] <${el.tag}> selector="${el.selector}" text="${el.text}" ` +
        `{x:${el.bounds.x},y:${el.bounds.y},w:${el.bounds.width},h:${el.bounds.height}}`;
      if (el.visible === false) line += ` [HIDDEN]`;
      if (el.frameworkHint) line += ` fw=${el.frameworkHint}`;
      if (el.role) line += ` role="${el.role}"`;
      if (el.id) line += ` #${el.id}`;
      if (el.type) line += ` type="${el.type}"`;
      if (el.href) line += ` href="${el.href}"`;
      if (el.selectorChain?.length > 1) line += ` chain=${el.selectorChain.length}`;
      return line;
    }).join("\n");
    parts.push(`ELEMENTS (use the selector field to target them):\n${elList}`);
  } else {
    parts.push("No interactive elements found on page.");
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Create the LangGraph agent
// ---------------------------------------------------------------------------
function buildDomFingerprint(ctx) {
  if (!ctx?.elements?.length) return "";
  const sig = ctx.elements.slice(0, 40).map(el =>
    `${el.tag}|${el.text?.slice(0, 20)}|${el.bounds?.x},${el.bounds?.y}`
  ).join(";");
  return sig;
}

const MAX_VERIFY_RETRIES = 2;

export function createBrowserAgent({ model, requestContext, executeAction, onProgress }) {
  const tools = createBrowserTools({ executeAction, requestContext, onProgress });
  const modelWithTools = model.bindTools(tools);
  const toolNode = new ToolNode(tools);

  async function observeNode(state) {
    try {
      const ctx = await requestContext();
      const summary = buildContextSummary(ctx);
      const fingerprint = buildDomFingerprint(ctx);
      return {
        messages: [new HumanMessage(
          `[PAGE STATE — Step ${state.stepCount}]\n${summary}\n\nAnalyze the page and decide your next action.`
        )],
        pageContext: ctx,
        domFingerprint: fingerprint,
        stepCount: state.stepCount + 1,
        retryCount: 0,
      };
    } catch (err) {
      return {
        messages: [new HumanMessage(
          `[PAGE STATE ERROR] ${err.message}. Decide your next action based on previous state.`
        )],
        stepCount: state.stepCount + 1,
      };
    }
  }

  async function agentNode(state) {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolsNode(state) {
    return await toolNode.invoke(state);
  }

  // Verify node — compares DOM fingerprint before vs after tool execution
  async function verifyNode(state) {
    const lastMessage = state.messages[state.messages.length - 1];

    if (typeof lastMessage?.content === "string" && lastMessage.content.includes("TASK_COMPLETE")) {
      return {};
    }

    // Skip verification for read-only tools
    const readOnlyTools = new Set(["read_page", "wait_for_page", "scroll_page", "done"]);
    const prevAgent = [...state.messages].reverse().find(m => m.tool_calls?.length > 0);
    if (prevAgent?.tool_calls?.every(tc => readOnlyTools.has(tc.name))) {
      return {};
    }

    try {
      const ctx = await requestContext();
      const newFingerprint = buildDomFingerprint(ctx);
      const unchanged = state.domFingerprint && newFingerprint === state.domFingerprint;

      if (unchanged && state.retryCount < MAX_VERIFY_RETRIES) {
        onProgress({ action: "verify", description: "Action had no effect — retrying with alternative approach" });
        return {
          messages: [new HumanMessage(
            `[VERIFY — NO CHANGE DETECTED] The last action did not modify the DOM. ` +
            `Retry ${state.retryCount + 1}/${MAX_VERIFY_RETRIES}. ` +
            `Try an alternative: use a different selector, execute_js, or a completely different approach.`
          )],
          retryCount: state.retryCount + 1,
          domFingerprint: newFingerprint,
        };
      }

      return { domFingerprint: newFingerprint };
    } catch {
      return {};
    }
  }

  function shouldContinue(state) {
    const lastMessage = state.messages[state.messages.length - 1];
    if (state.stepCount >= MAX_AGENT_STEPS) return "end";
    if (lastMessage?.tool_calls?.length > 0) {
      if (lastMessage.tool_calls.some((tc) => tc.name === "done")) return "done_tool";
      return "tools";
    }
    return "end";
  }

  function afterVerify(state) {
    const lastMessage = state.messages[state.messages.length - 1];
    if (typeof lastMessage?.content === "string" && lastMessage.content.includes("TASK_COMPLETE")) {
      return "end";
    }
    if (typeof lastMessage?.content === "string" && lastMessage.content.includes("[VERIFY — NO CHANGE DETECTED]")) {
      return "agent";
    }
    return "observe";
  }

  const graph = new StateGraph(AgentState)
    .addNode("observe", observeNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("verify", verifyNode)
    .addNode("done_handler", async (state) => {
      const result = await toolNode.invoke(state);
      return { ...result, status: "completed" };
    })
    .addEdge(START, "observe")
    .addEdge("observe", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      done_tool: "done_handler",
      end: END,
    })
    .addEdge("tools", "verify")
    .addConditionalEdges("verify", afterVerify, {
      observe: "observe",
      agent: "agent",
      end: END,
    })
    .addEdge("done_handler", END);

  return graph.compile({ recursionLimit: 100 });
}

// ---------------------------------------------------------------------------
// Run the agent
// ---------------------------------------------------------------------------
export async function runBrowserAgent(agent, userMessage, initialContext, signal = null) {
  if (signal?.aborted) {
    return { summary: "Stopped by user.", steps: 0, status: "stopped" };
  }

  const initialMessages = [
    new SystemMessage(AGENT_SYSTEM_PROMPT),
  ];

  if (initialContext) {
    const contextSummary = buildContextSummary(initialContext);
    initialMessages.push(new HumanMessage(
      `[INITIAL PAGE STATE]\n${contextSummary}\n\n--- USER COMMAND ---\n${userMessage}`
    ));
  } else {
    initialMessages.push(new HumanMessage(
      `--- USER COMMAND ---\n${userMessage}\n\n(Page context will be gathered in the first observe step.)`
    ));
  }

  const invokeOpts = { recursionLimit: 100 };
  if (signal) invokeOpts.signal = signal;

  const result = await agent.invoke(
    {
      messages: initialMessages,
      pageContext: initialContext,
      stepCount: 0,
      status: "running",
      domFingerprint: null,
      retryCount: 0,
    },
    invokeOpts
  );

  const messages = result.messages || [];
  let finalSummary = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg?.content === "string") {
      if (msg.content.includes("TASK_COMPLETE")) {
        finalSummary = msg.content.replace("TASK_COMPLETE: ", "");
        break;
      }
      if (msg instanceof AIMessage && !msg.tool_calls?.length && msg.content.trim()) {
        finalSummary = msg.content;
        break;
      }
    }
  }

  return {
    summary: finalSummary || "Agent completed the task.",
    steps: result.stepCount || 0,
    status: result.status || "completed",
  };
}

// ---------------------------------------------------------------------------
// Intent classification — LLM-based
// Uses the AI model itself to decide how to route the user's message.
// Returns: "action" | "guidance" | "chat"
// ---------------------------------------------------------------------------
const CLASSIFY_PROMPT = `You are an intent router for a browser co-pilot app called CoLearn. Your ONLY job is to classify the user's message into exactly one of three categories. Reply with a single word — nothing else.

Categories:
- ACTION — The user wants you to DO something in the browser: open a page, click a button, navigate somewhere, type text, scroll, create/delete/modify something on the page, log in, fill a form, etc. This includes polite commands like "can you open...", "please click...", "open figma for me".
- GUIDANCE — The user wants help understanding the current page or app: "where is the settings button?", "how do I create a new screen in Figma?", "show me how to export", "guide me through this", "what does this button do?". The user wants to LEARN, not have the agent act.
- CHAT — General conversation or knowledge questions NOT about controlling or navigating the browser: "what is React?", "tell me a joke", "explain CSS flexbox", "hi", "thanks", "who invented the internet?".

Examples:
"open figma" → ACTION
"can you open google sheets?" → ACTION
"click the search button" → ACTION
"navigate to github.com" → ACTION
"create a new file" → ACTION
"how do I create a new screen?" → GUIDANCE
"where is the export button?" → GUIDANCE
"guide me how to use this tool" → GUIDANCE
"show me where the settings are" → GUIDANCE
"what is figma?" → CHAT
"hello" → CHAT
"tell me about javascript" → CHAT
"thanks!" → CHAT
"what's the weather today?" → CHAT

Reply ONLY with: ACTION, GUIDANCE, or CHAT`;

/**
 * Classify user intent using the LLM. Falls back to a simple heuristic
 * if the LLM call fails (e.g. network error, no API key).
 */
export async function classifyIntent(text, pageContext, model) {
  // Try LLM classification first
  if (model) {
    try {
      const contextHint = pageContext?.url
        ? `\n(User is currently on: ${pageContext.url})`
        : "";
      const result = await model.invoke([
        new SystemMessage(CLASSIFY_PROMPT),
        new HumanMessage(`${text}${contextHint}`),
      ]);
      const raw = (typeof result.content === "string" ? result.content : "")
        .trim().toUpperCase();
      if (raw.includes("ACTION")) return "action";
      if (raw.includes("GUIDANCE")) return "guidance";
      if (raw.includes("CHAT")) return "chat";
    } catch (err) {
      console.warn("[Classify] LLM classification failed, using fallback:", err.message);
    }
  }

  // --- Lightweight fallback (no LLM available) ---
  return classifyIntentFallback(text);
}

function classifyIntentFallback(text) {
  const t = text.toLowerCase().trim();

  // Obvious action commands
  if (/^\s*(open|click|tap|navigate|go\s+to|visit|scroll|type|press|create|delete|remove|close|submit|login|sign\s*in|refresh)\b/i.test(t)) {
    return "action";
  }
  if (/\b(can|could|please|would)\b.*\b(open|click|navigate|go\s+to|visit|type|create|delete|close|submit)\b/i.test(t)) {
    return "action";
  }

  // Obvious guidance
  if (/^\s*(how|where|show\s+me|guide|help\s+me|walk\s+me|explain\s+how)\b/i.test(t)) {
    return "guidance";
  }

  // Obvious chat
  if (/^\s*(hi|hello|hey|thanks|thank|what\s+is|who\s+is|tell\s+me\s+about|what\s+are)\b/i.test(t)) {
    return "chat";
  }

  return "chat";
}
