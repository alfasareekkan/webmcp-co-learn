# CoLearn Agent — Full Technical Documentation

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Project Structure](#3-project-structure)
4. [Step-by-Step Build Process](#4-step-by-step-build-process)
5. [Component Deep Dive](#5-component-deep-dive)
6. [Data Flow](#6-data-flow)
7. [Setup & Installation](#7-setup--installation)
8. [API Reference](#8-api-reference)
9. [Configuration](#9-configuration)
10. [Phase Roadmap](#10-phase-roadmap)

---

## 1. Project Overview

**CoLearn Agent** is a browser-based co-learning and co-assistance platform. It uses a Chrome extension to observe user interactions across web applications, streams that data to an Express backend, processes it with multi-provider AI (Google Gemini, Anthropic Claude, OpenAI), and presents visual guidance through a React dashboard. It features an autonomous browser agent powered by LangGraph that can execute browser actions on the user's behalf.

### Core Capabilities

| Capability | How |
|---|---|
| Detect active web apps | URL pattern matching (Figma, Sheets, Notion, Miro, etc.) |
| Observe user interaction | Content script captures clicks, inputs, SPA navigations |
| Read page context | CDP Runtime.evaluate extracts DOM, headings, forms, text |
| Capture screenshots | CDP Page.captureScreenshot (JPEG) |
| Monitor network | CDP Network domain logs all requests/responses |
| Monitor console | CDP Console + Runtime domains capture all logs |
| Track performance | CDP Performance.getMetrics (heap, nodes, layout) |
| AI-powered Q&A (Guidance) | Multi-model vision AI processes screenshot + context |
| Autonomous browser control (Agent) | LangGraph ReAct agent executes click, type, scroll, navigate, modify DOM |
| Intent classification | Auto-routes between guidance mode and action mode |
| Visual guidance | Server annotates screenshots with highlights, arrows, labels |
| On-page overlay | Extension renders highlights, step badges, arrows directly on the website |
| Multi-model support | Gemini, Claude, OpenAI via LangChain — switchable at runtime |
| Real-time sync | WebSocket streams events between extension, server, dashboard |

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     USER'S BROWSER                               │
│                                                                  │
│  ┌─────────────┐    ┌──────────────────────────────────────────┐ │
│  │ Other Tabs   │    │ CoLearn React Dashboard (localhost:5173) │ │
│  │ (Figma,      │    │                                          │ │
│  │  Sheets,     │    │  ┌──────────┐ ┌────────────┐ ┌────────┐ │ │
│  │  any site)   │    │  │ Sidebar  │ │Screen      │ │ Chat   │ │ │
│  │              │    │  │ Activity │ │Mirror      │ │ Panel  │ │ │
│  │              │    │  │ Feed     │ │(screenshot)│ │(AI+Agt)│ │ │
│  │              │    │  └──────────┘ └────────────┘ └────────┘ │ │
│  └──────┬───────┘    └──────────────────┬───────────────────────┘ │
│         │                               │                        │
│  ┌──────┴───────────────────────┐       │ WebSocket              │
│  │ Chrome Extension (MV3)      │       │ (ws://localhost:3001    │
│  │                              │       │  ?role=dashboard)       │
│  │  content.js  (observer)     │       │                        │
│  │  overlay.js  (on-page UI)   │       │                        │
│  │  background.js (CDP + WS    ├───────┘                        │
│  │    + action executor)       │                                 │
│  └──────────────┬──────────────┘                                 │
└─────────────────┼────────────────────────────────────────────────┘
                  │ WebSocket
                  │ (ws://localhost:3001?role=extension)
                  │
         ┌────────┴────────────────────────────────────┐
         │         Express Backend (localhost:3001)     │
         │                                              │
         │  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
         │  │ WebSocket│  │ LangChain│  │ Screenshot │ │
         │  │ Hub      │  │ Multi-AI │  │ Annotator  │ │
         │  │          │  │(Gemini,  │  │ (sharp +   │ │
         │  │          │  │ Claude,  │  │  SVG)      │ │
         │  │          │  │ OpenAI)  │  │            │ │
         │  └──────────┘  └────┬─────┘  └────────────┘ │
         │                     │                        │
         │              ┌──────┴──────┐                 │
         │              │  LangGraph  │                 │
         │              │  Browser    │                 │
         │              │  Agent      │                 │
         │              │  (ReAct)    │                 │
         │              └─────────────┘                 │
         └─────────────────────────────────────────────┘
```

### Communication Protocol

- **Extension → Server**: WebSocket with `role=extension`
- **Dashboard → Server**: WebSocket with `role=dashboard`
- **Server → Extension**: Sends `GATHER_CONTEXT` and `EXECUTE_ACTION` requests
- **Extension → Server**: Replies with `CONTEXT_RESPONSE` (screenshot + DOM + network + console + elements with bounding boxes + CSS selectors) or `ACTION_RESULT`
- **Server → Dashboard**: Broadcasts events, screenshots, AI responses, annotated images, agent steps, model changes
- **Server → Extension → overlay.js**: Relays `SHOW_GUIDANCE` / `CLEAR_GUIDANCE` for on-page rendering

### Dual AI Modes

| Mode | Triggered By | Processing | Output |
|---|---|---|---|
| **Guidance** | Questions ("Where is...", "How do I...") | LangChain vision model analyzes screenshot + context | Text answer + annotated screenshot + on-page overlay |
| **Agent** | Commands ("Click the button", "Navigate to...") | LangGraph ReAct loop with browser tools | Autonomous multi-step browser actions + summary |

Intent is classified automatically using pattern matching (`classifyIntent()` in `agent.js`).

---

## 3. Project Structure

```
co-learn-3/
│
├── Co-extension/                 # Chrome Extension (MV3)
│   ├── manifest.json             # Extension manifest
│   ├── background.js             # Service worker — CDP, WebSocket, event hub, action executor
│   ├── content.js                # Page observer — clicks, inputs, navigation
│   ├── overlay.js                # On-page guidance overlay — highlights, arrows, step badges
│   ├── popup.html                # Extension popup UI
│   ├── popup.js                  # Popup controller
│   ├── icons/                    # Extension icons (16, 48, 128 px)
│   └── generate-icons.html       # Icon generation helper
│
├── server/                       # Express Backend
│   ├── index.js                  # Main server — WebSocket, AI orchestrator, chat handler
│   ├── agent.js                  # LangGraph browser agent — ReAct loop, tools, intent classifier
│   ├── models.js                 # Multi-model factory — Gemini, Claude, OpenAI via LangChain
│   ├── annotate.js               # Screenshot annotation engine (sharp + SVG)
│   ├── package.json              # Dependencies
│   ├── .env                      # Environment variables (API keys) — gitignored
│   └── .env.example              # Template for .env
│
├── client/                       # React Dashboard (Vite)
│   ├── src/
│   │   ├── main.jsx              # React entry point
│   │   ├── App.jsx               # Root component — state management, resizable panels
│   │   ├── App.css               # Layout grid + resizer styles
│   │   ├── index.css             # Global styles + CSS variables
│   │   ├── hooks/
│   │   │   └── useWebSocket.js   # WebSocket hook with auto-reconnect
│   │   └── components/
│   │       ├── Sidebar.jsx       # Activity feed component (collapsible)
│   │       ├── Sidebar.css
│   │       ├── ScreenMirror.jsx  # Remote screenshot viewer
│   │       ├── ScreenMirror.css
│   │       ├── ChatPanel.jsx     # AI chat + agent steps + model selector
│   │       ├── ChatPanel.css
│   │       ├── DrawingCanvas.jsx # Freehand drawing/annotation on screenshots
│   │       └── DrawingCanvas.css
│   ├── index.html
│   ├── package.json              # Dependencies (react, react-dom, vite)
│   └── vite.config.js
│
├── .gitignore
└── DOCUMENTATION.md              # This file
```

---

## 4. Step-by-Step Build Process

### Step 1 — Chrome Extension Foundation (MV3)

**Goal**: Create a browser extension that can observe web pages and access Chrome DevTools Protocol.

**Files created**: `manifest.json`, `content.js`, `background.js`, `overlay.js`, `popup.html`, `popup.js`

**manifest.json** — Manifest V3 with permissions:
- `activeTab` — access to the current tab
- `scripting` — inject scripts programmatically
- `debugger` — attach Chrome DevTools Protocol
- `tabs` — query and track tabs

Content scripts match `<all_urls>` to run on every page. Both `content.js` (observer) and `overlay.js` (visual guidance) are injected. The background runs as a service worker.

---

### Step 2 — User Interaction Observer (content.js)

**Goal**: Detect what the user does on any web page.

**What it captures**:
- **Clicks** — element tag, text, CSS path, URL, detected app name
- **Inputs** — debounced at 400ms, captures field value
- **SPA Navigation** — MutationObserver detects URL changes without page reloads
- **Page Context** — title, meta tags, headings (on demand via message)

**App Detection**: URL pattern matching for Figma, Google Sheets, MagicPattern, Notion, Miro.

**Self-exclusion**: `if (location.host === "localhost:5173") return;` — the content script does not observe the CoLearn dashboard itself.

All events are sent to the background via `chrome.runtime.sendMessage`.

---

### Step 3 — Background Service Worker (background.js)

**Goal**: Central hub that receives events, manages CDP debugger sessions, executes browser actions, and communicates with the backend.

**Key responsibilities**:

1. **Event aggregation** — ring buffer of 200 events
2. **Tab tracking** — `chrome.tabs.onActivated` keeps `activeTabId` current
3. **WebSocket to backend** — connects to `ws://localhost:3001?role=extension` with auto-reconnect (3s)
4. **CDP debugger management** — attach/detach per tab, tracks attached set
5. **Context gathering** — responds to `GATHER_CONTEXT` requests from backend
6. **Action execution** — responds to `EXECUTE_ACTION` requests from the LangGraph agent
7. **Guidance relay** — forwards `SHOW_GUIDANCE` / `CLEAR_GUIDANCE` / `STEP_GUIDANCE` to content scripts

**CDP Domains enabled on attach**:
| Domain | Purpose |
|---|---|
| `Page` | Screenshots, navigation events |
| `Runtime` | JavaScript evaluation for DOM extraction + action execution |
| `Network` | Request/response logging |
| `Console` | Console message capture |
| `Performance` | Heap size, layout counts, node counts |
| `DOM` | DOM tree access |

**Browser Action Types** (executed via CDP `Runtime.evaluate`):
| Action | Description |
|---|---|
| `click` | Click an element by CSS selector (scroll into view, focus, click, dispatch MouseEvent) |
| `type` | Type text into input/textarea/contenteditable (with React-compatible event dispatching) |
| `modify_style` | Change CSS properties on one or more elements |
| `set_attribute` | Set any HTML attribute on elements |
| `set_content` | Change text or HTML content of elements |
| `execute_js` | Run arbitrary JavaScript on the page |
| `scroll` | Scroll page up or down by pixel amount |
| `navigate` | Navigate to a URL via CDP `Page.navigate` |
| `press_key` | Dispatch keyboard events via CDP `Input.dispatchKeyEvent` |

---

### Step 4 — Extension Popup UI (popup.html + popup.js)

**Goal**: Quick-access control panel for the extension.

**Features**:
- Status display (active tab, debugger state, detected app)
- Action buttons: Attach Debugger, Detach, Read Context, Screenshot
- Live event log showing recent interactions
- Screenshot preview inline

**Design**: Dark theme matching the React dashboard, 380px width popup.

---

### Step 5 — Express Backend with WebSocket (server/index.js)

**Goal**: Relay events between extension and dashboard, orchestrate AI guidance and agent actions.

**Architecture**:
- Express HTTP server on port 3001
- WebSocket server on the same port
- Clients tracked by role (`extension` or `dashboard`)
- Events stored in a ring buffer (500 max)
- Pending context and action requests tracked with timeouts

**WebSocket message types handled**:

| From | Type | Action |
|---|---|---|
| Extension | `USER_CLICK`, `USER_INPUT`, `NAVIGATION`, `CONTENT_READY` | Store + broadcast to dashboards |
| Extension | `SCREENSHOT` | Store latest + broadcast |
| Extension | `CONTEXT_RESPONSE` | Resolve pending context request |
| Extension | `ACTION_RESULT` | Resolve pending action request |
| Dashboard | `CHAT_MESSAGE` | Classify intent → guidance or agent pipeline |
| Dashboard | `SET_MODEL` | Switch active AI model at runtime |
| Dashboard | `SHOW_GUIDANCE` | Relay to extension for on-page overlay |
| Dashboard | `CLEAR_GUIDANCE` | Relay to extension to remove overlay |

**REST endpoints**:
- `GET /api/health` — connection counts, AI status, active models, providers
- `GET /api/models` — available providers and active model selection
- `GET /api/events` — last 50 events as JSON

---

### Step 6 — Multi-Model AI Support (server/models.js)

**Goal**: Support multiple AI providers (Gemini, Claude, OpenAI) via LangChain, switchable at runtime.

**Providers and models**:

| Provider | Models | Tier | LangChain Class |
|---|---|---|---|
| **Gemini** | gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash | Free | `ChatGoogleGenerativeAI` |
| **Claude** | claude-sonnet-4, claude-3.5-haiku | Paid/Cheap | `ChatAnthropic` |
| **OpenAI** | gpt-4o, gpt-4o-mini, gpt-4.1-mini, gpt-4.1-nano | Paid/Cheap/Free | `ChatOpenAI` |

**Key functions**:
- `getAvailableProviders()` — scans env vars and returns providers with valid API keys
- `createChatModel(provider, modelId)` — factory that returns a LangChain chat model instance
- `getDefaultModel()` — returns the best agent model from available providers (prefers Gemini)
- `getGuidanceModel()` — returns a lighter/cheaper model for guidance Q&A

**Two model slots** are maintained in the server:
- `activeAgentModel` — used by the LangGraph browser agent
- `activeGuidanceModel` — used for visual guidance Q&A

Both can be switched at runtime via the dashboard model selector.

---

### Step 7 — React Dashboard (client/)

**Goal**: Real-time UI showing activity, screen mirror, and AI chat with agent control.

**Technology**: React 19 + Vite 7, no additional UI libraries.

**Layout**: CSS Grid — `320px sidebar (collapsible) | flexible main content`
Main content uses a **vertical resizable split**: `screen mirror | drag handle | chat panel`
The user can drag the resizer to adjust the ratio (15%–85% range).

**Components**:

#### `App.jsx`
Root state management. Holds events, screenshot, chat messages, AI thinking state, agent status, provider/model state. Features:
- **Resizable panels** — drag-to-resize between screen mirror and chat (`chatRatio` state, mouse event handlers)
- **Collapsible sidebar** — toggle open/closed
- WebSocket hook connects on mount with auto-reconnect
- Handles new message types: `MODEL_CHANGED`, `AGENT_STATUS`, `AGENT_STEP`

#### `Sidebar.jsx`
Live activity feed. Events scroll auto-bottom. Color-coded badges: CLICK (purple), INPUT (teal), NAV (yellow), READY (green), CHAT (purple). Shows detected app name and timestamp. Collapsible with toggle button.

#### `ScreenMirror.jsx`
Displays the latest screenshot from the extension. Shows URL and timestamp. Empty state with instructions when no screenshot available.

#### `DrawingCanvas.jsx`
Freehand annotation overlay for screenshots:
- Pen, arrow, rectangle, circle, text, eraser tools
- Color picker (8 colors) and brush size selector
- Undo/redo with keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z)
- Save annotated images with thumbnail strip
- Full-screen overlay with responsive canvas scaling

#### `ChatPanel.jsx`
Full AI chat interface with agent integration:
- **User messages** — purple, right-aligned
- **AI responses** — dark with teal left border
- **System errors** — centered, red
- **Agent step bubbles** — live indicators showing what action the agent is performing (with action icons: ▶ click, ⌨ type, ↕ scroll, 🌐 navigate, ⌘ key, 👁 observe, ⏳ wait)
- **Agent result badges** — shows task completion status and step count
- **Annotated images** — clickable to expand/shrink
- **Highlight legend** — colored dots with labels and reasons
- **Guidance actions** — "Show on Page" / "Clear Overlay" buttons to trigger on-page overlay
- **Model selector dropdown** — switch between AI models for agent and guidance independently
- Thinking indicator — "Capturing screen & analyzing..." with bouncing dots
- Agent progress bar — shows when the agent is working
- Input disabled during AI processing or agent execution
- Dual-mode placeholder text reflects current state

#### `useWebSocket.js`
Custom hook. Connects to `ws://localhost:3001?role=dashboard`. Auto-reconnects on disconnect (2s delay). Exposes `{ connected, send }`.

---

### Step 8 — LangGraph Browser Agent (server/agent.js)

**Goal**: Autonomously control the browser to complete user tasks using a ReAct (Reason + Act) loop.

**Framework**: LangGraph (`@langchain/langgraph`) with a state graph architecture.

**Agent State** (LangGraph Annotation):
- `messages` — conversation history (System, Human, AI, Tool messages)
- `pageContext` — latest page context from the extension
- `stepCount` — current step number (max 20)
- `status` — "running" or "completed"

**Graph Nodes**:
```
START → observe → agent → (tools | done_handler | END)
                            ↓
                        tools → observe → agent → ...
```

1. **observe** — requests fresh page context from the extension, formats it as a `HumanMessage` with element selectors and bounding boxes
2. **agent** — invokes the LLM with all available tools bound; LLM decides what to do next
3. **tools** — executes the selected tool via `ToolNode`
4. **done_handler** — processes the `done()` tool call and sets status to "completed"

**Available Tools** (12 total):

| Category | Tool | Description |
|---|---|---|
| **Interaction** | `click_element(selector)` | Click an element by CSS selector |
| | `type_text(selector, text)` | Type text into an input/textarea |
| | `press_key(key)` | Press a keyboard key |
| | `scroll_page(direction)` | Scroll the page up or down |
| **DOM Manipulation** | `modify_style(selector, styles)` | Change CSS properties directly |
| | `set_attribute(selector, attribute, value)` | Set HTML attributes |
| | `set_content(selector, text/html)` | Change element text or HTML |
| | `execute_js(code)` | Run arbitrary JavaScript on the page |
| **Navigation** | `navigate_to(url)` | Navigate the browser to a URL |
| **Observation** | `read_page()` | Re-read the current page state |
| | `wait_for_page(ms)` | Wait for page load or animations |
| **Completion** | `done(summary)` | Signal task completion |

**Context Summary Format** (sent to the agent):
Each element includes: tag name, CSS selector, text, bounding box, role, ID, type, href, and computed styles (color, background).

**Intent Classification** (`classifyIntent()`):
Uses two sets of regex patterns to score user messages:
- **Action patterns** — click, type, navigate, scroll, create, delete, change, submit, select, drag, login, search, close, copy, refresh
- **Guidance patterns** — how, where, what, show me, explain, guide, which, why

The mode with the higher score wins. Ties default to guidance.

---

### Step 9 — Gemini AI Guidance (Visual Q&A)

**Goal**: Answer user questions using full page context + screenshot vision via LangChain.

**Model**: Configurable (default: `gemini-2.5-flash-lite`), switchable at runtime.

**Prompt design**: The guidance model is instructed to return **JSON** with two fields:
```json
{
  "text": "The answer in plain text with **bold** support",
  "highlights": [
    {
      "elementIndex": 0,
      "label": "Create Button",
      "reason": "Click here to create a new page"
    }
  ]
}
```

**Context sent to the model** (via LangChain `HumanMessage` with multimodal content):
- Screenshot as inline JPEG image (vision input via `image_url`)
- Page URL and title
- DOM: headings, buttons, links, inputs, forms, visible text
- Interactive elements with pixel bounding boxes
- Recent network requests (method, status, URL)
- Console logs (level, text)
- Performance metrics

---

### Step 10 — Visual Guidance (Screenshot Annotation)

**Goal**: When the AI identifies specific UI elements, draw highlights on the screenshot and send it back in chat.

**Flow**:
1. User asks "Where is the create button?"
2. Server classifies intent as "guidance" and sends `GATHER_CONTEXT` to extension
3. Extension captures screenshot + up to 80 interactive elements with bounding boxes + CSS selectors
4. Server sends everything to the guidance model via LangChain
5. Model returns `highlights` array referencing element indices
6. Server's `annotate.js` draws on the screenshot using sharp + SVG compositing
7. Annotated image sent to dashboard as data URL in the chat message
8. Guidance data automatically sent to extension → overlay.js renders on-page

**Annotation features** (`annotate.js`):
- Colored highlight boxes with rounded corners and semi-transparent fill
- Corner dots on each highlighted element
- Numbered label badges above each element
- Arrows pointing from label to element
- Multi-color support (6 colors cycle: pink, teal, orange, green, purple, blue)
- DPR-aware scaling (handles Retina/HiDPI displays)

---

### Step 11 — On-Page Guidance Overlay (overlay.js)

**Goal**: Render visual guides directly on the website the user is browsing.

**Features**:
- **Pulsing highlight boxes** — colored borders with glow animation around target elements
- **Numbered step badges** — clickable pills above each element with label text
- **Tooltips** — pop-up explanations positioned beside highlighted elements
- **Curved arrows** — dashed SVG arrows connecting sequential steps
- **Step-by-step mode** — Prev/Next buttons to walk through one element at a time
- **Show-all mode** — display all highlights simultaneously
- **Controls bar** — fixed bottom bar with navigation, "Show All", and "Dismiss" buttons
- **Dismiss** — removes all overlay elements

**Triggered by**:
1. **Auto** — AI responses with highlights automatically send `SHOW_GUIDANCE` to the extension
2. **Manual** — "Show on Page" / "Clear Overlay" buttons in the chat panel

---

### Step 12 — Element Bounding Box & Selector Extraction

**Goal**: Give the AI precise pixel locations and reliable CSS selectors for all interactive elements.

The extension's `extractInteractiveElements()` function queries the page for:
```
button, [role="button"], a[href], input, textarea, select,
[onclick], [role="link"], [role="tab"], [role="menuitem"],
img, svg, icon, [class*="icon"], [class*="btn"], [class*="logo"],
[class*="nav"], h1, h2, h3, [data-testid], [aria-label],
[contenteditable], div[style*="color"], div[style*="background"],
span[style], p, li, td, th, label
```

For each element (up to 80), it captures:
- Tag name, text content, classes, ID
- ARIA role, href, input type
- **CSS Selector** — built via `buildSelector()`: prioritizes `#id`, `[data-testid]`, `[aria-label]`, then falls back to a parent-chain path with `:nth-of-type()`
- **Computed styles** — color, background-color, display, visibility
- **Bounding box**: `{ x, y, width, height }` via `getBoundingClientRect()`

These are sent as the `elements` array in the context. The guidance AI references them by index for annotations, while the agent uses CSS selectors for reliable targeting.

---

## 5. Component Deep Dive

### Extension Message Flow

```
content.js                    background.js                  WebSocket
    │                              │                            │
    ├── USER_CLICK ───────────────►│                            │
    ├── USER_INPUT ───────────────►│── forward ────────────────►│
    ├── NAVIGATION ───────────────►│                            │
    ├── CONTENT_READY ────────────►│                            │
    │                              │                            │
    │                              │◄── GATHER_CONTEXT ────────│
    │                              │ (runs CDP queries)         │
    │                              │── CONTEXT_RESPONSE ───────►│
    │                              │                            │
    │                              │◄── EXECUTE_ACTION ────────│
    │                              │ (runs CDP action)          │
    │                              │── ACTION_RESULT ──────────►│
    │                              │                            │
overlay.js                        │◄── SHOW_GUIDANCE ──────────│
    │                              │                            │
    │◄── SHOW_GUIDANCE ───────────│ (chrome.tabs.sendMessage)  │
    │    (renders on page)         │                            │
    │◄── CLEAR_GUIDANCE ──────────│                            │
    │◄── STEP_GUIDANCE ───────────│                            │
```

### Chat Message Pipeline — Guidance Mode

```
User types question (e.g. "Where is the search bar?")
        │
        ▼
Dashboard ──CHAT_MESSAGE──► Server
                               │
                               ├── classifyIntent() → "guidance"
                               ├── Echo user message to all dashboards
                               ├── Set AI_THINKING = true
                               ├── Send GATHER_CONTEXT to extension
                               │         │
                               │         ▼
                               │    Extension captures:
                               │    - Screenshot (JPEG 70%)
                               │    - DOM info
                               │    - 80 elements with bounding boxes + CSS selectors
                               │    - Network logs (last 30)
                               │    - Console logs (last 30)
                               │    - Performance metrics
                               │    - Viewport size + DPR
                               │         │
                               │◄── CONTEXT_RESPONSE ──┘
                               │
                               ├── Update screen mirror
                               ├── Build context text + image parts
                               ├── Send to LangChain model (vision + text)
                               │         │
                               │         ▼
                               │    Model returns JSON:
                               │    { text, highlights[] }
                               │         │
                               │◄────────┘
                               │
                               ├── If highlights exist:
                               │   ├── annotateScreenshot()
                               │   │   - Map elementIndex → bounding box
                               │   │   - Draw SVG overlay (boxes, labels, arrows)
                               │   │   - Composite with sharp
                               │   │   - Return data URL
                               │   └── Build guidance data with bounds + colors
                               │
                               ├── Send AI response + annotated image + guidance data
                               ├── Auto-send SHOW_GUIDANCE to extension → overlay.js
                               └── Set AI_THINKING = false
```

### Chat Message Pipeline — Agent Mode

```
User types command (e.g. "Click the search button and type hello")
        │
        ▼
Dashboard ──CHAT_MESSAGE──► Server
                               │
                               ├── classifyIntent() → "action"
                               ├── Echo user message to all dashboards
                               ├── Send AGENT_STATUS = "running"
                               ├── Gather initial context from extension
                               │
                               ├── runBrowserAgent(agent, text, context)
                               │         │
                               │         ▼
                               │    LangGraph ReAct Loop:
                               │    ┌──────────────────────────────┐
                               │    │ observe: read page state     │
                               │    │    ↓                         │
                               │    │ agent: LLM picks tool+args  │──► AGENT_STEP broadcast
                               │    │    ↓                         │
                               │    │ tools: execute action        │──► EXECUTE_ACTION → ext
                               │    │    ↓                         │    ← ACTION_RESULT
                               │    │ (loop until done or max 20) │
                               │    └──────────────────────────────┘
                               │         │
                               │◄── result { summary, steps, status }
                               │
                               ├── Capture final screenshot
                               ├── Send AI response with agent result
                               └── Send AGENT_STATUS = "idle"
```

### Runtime Model Switching

```
Dashboard ModelSelector
        │
        ├── SET_MODEL { target: "agent"|"guidance"|"both", provider, model }
        │
        ▼
Server handleSetModel()
        │
        ├── Validate provider API key exists
        ├── Validate model exists for provider
        ├── Update activeAgentModel / activeGuidanceModel
        ├── Rebuild browserAgent if agent model changed
        ├── Broadcast MODEL_CHANGED to all dashboards
        └── Broadcast system message confirming switch
```

---

## 6. Data Flow

### Event Object Schema

```javascript
{
  type: "USER_CLICK" | "USER_INPUT" | "NAVIGATION" | "CONTENT_READY",
  tag: "BUTTON",
  text: "Submit",
  id: "submit-btn",
  classes: "btn btn-primary",
  path: "div.container > button#submit-btn",
  url: "https://figma.com/...",
  app: "Figma",
  timestamp: 1708300000000,
  tabId: 42,
}
```

### Context Object Schema (from extension)

```javascript
{
  tabId: 42,
  url: "https://example.com",
  title: "Example Page",
  screenshot: "data:image/jpeg;base64,...",
  viewport: { width: 1280, height: 800, dpr: 2 },
  dom: {
    title: "...",
    url: "...",
    headings: [{ level: "H1", text: "..." }],
    buttons: [{ text: "Submit", tag: "BUTTON" }],
    links: [{ text: "Home", href: "..." }],
    inputs: [{ type: "text", name: "search", placeholder: "Search...", value: "" }],
    images: [{ alt: "Logo", src: "..." }],
    forms: [{ action: "/submit", method: "POST", id: "form1" }],
    selection: "selected text...",
    bodyText: "visible page text (2000 chars max)...",
  },
  elements: [
    {
      tag: "BUTTON",
      text: "Create New",
      classes: "btn-create",
      id: "create-btn",
      href: null,
      type: null,
      role: "button",
      selector: "#create-btn",
      style: { color: "rgb(255,255,255)", bg: "rgb(108,92,231)", display: "flex", visibility: "visible" },
      bounds: { x: 100, y: 50, width: 120, height: 36 },
    },
    // ... up to 80 elements
  ],
  consoleLogs: [
    { level: "error", text: "TypeError: ...", timestamp: 1708300000000 }
  ],
  networkLogs: [
    { url: "https://api.example.com/data", method: "GET", status: 200, mimeType: "application/json" }
  ],
  performance: {
    Nodes: 1500,
    JSHeapUsedSize: 15000000,
    LayoutCount: 42,
  },
  timestamp: 1708300000000,
}
```

### Chat Message Schema (WebSocket)

```javascript
// User message
{ type: "CHAT_MESSAGE", text: "Where is the create button?", sender: "user", timestamp: ... }

// AI guidance response (with visual guidance)
{
  type: "CHAT_MESSAGE",
  text: "The **Create** button is in the top-right corner of the toolbar.",
  sender: "ai",
  timestamp: ...,
  image: "data:image/jpeg;base64,...",
  highlights: [
    { elementIndex: 5, label: "Create", reason: "Click here to create a new item" }
  ],
  guidance: [
    { bounds: { x: 100, y: 50, width: 120, height: 36 }, label: "Create", reason: "...", color: "#FF3B6F", selector: "#create-btn" }
  ],
  context: { url: "...", title: "..." },
}

// AI agent response
{
  type: "CHAT_MESSAGE",
  text: "I clicked the search button and typed 'hello' in the search box.",
  sender: "ai",
  timestamp: ...,
  agentResult: { steps: 4, status: "completed" },
  context: { url: "...", title: "..." },
}

// Agent step (live, replaces previous)
{
  type: "AGENT_STEP",
  step: { action: "click", description: "Clicking the search button" },
  timestamp: ...,
}

// System error
{ type: "CHAT_MESSAGE", text: "Error: ...", sender: "system", timestamp: ... }

// Thinking indicator
{ type: "AI_THINKING", thinking: true }

// Agent status
{ type: "AGENT_STATUS", status: "running" | "idle", message: "Agent running (gemini/gemini-2.5-flash)..." }

// Model changed
{
  type: "MODEL_CHANGED",
  activeAgentModel: { provider: "gemini", model: "gemini-2.5-flash" },
  activeGuidanceModel: { provider: "gemini", model: "gemini-2.5-flash-lite" },
}
```

---

## 7. Setup & Installation

### Prerequisites

- Node.js 18+
- Google Chrome
- At least one AI API key:
  - Gemini API key (free — from [aistudio.google.com](https://aistudio.google.com))
  - Anthropic API key (paid — from [console.anthropic.com](https://console.anthropic.com))
  - OpenAI API key (from [platform.openai.com](https://platform.openai.com))

### 1. Clone and Install

```bash
# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

### 2. Configure Environment

```bash
# Create server/.env with your API keys (at least one required)
cat > server/.env << 'EOF'
# Google Gemini (free tier: 15 req/min)
GEMINI_API_KEY=your_gemini_key_here

# Anthropic Claude (optional, requires paid API key)
# ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (optional)
# OPENAI_API_KEY=sk-...

PORT=3001
EOF
```

### 3. Generate Extension Icons (one-time)

Open `Co-extension/generate-icons.html` in Chrome. Right-click each image and save:
- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

### 4. Load the Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `Co-extension/` folder

### 5. Start the Services

```bash
# Terminal 1 — Backend
cd server && npm start

# Terminal 2 — Frontend
cd client && npm run dev
```

### 6. Use It

1. Open the React dashboard at `http://localhost:5173`
2. Open any other tab (e.g. Figma, Google, any website)
3. Click the **CL** extension icon → **Attach Debugger**
4. Go back to the dashboard — activity events appear in the sidebar
5. **Guidance mode**: Ask a question → "Where is the search bar?" → AI analyzes screen and highlights elements
6. **Agent mode**: Give a command → "Click the login button" → Agent autonomously controls the browser
7. Use the gear icon in chat header to switch between AI models

---

## 8. API Reference

### REST Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server status, AI enabled flag, agent enabled, active models, providers, connection counts |
| `GET` | `/api/models` | Available providers and their models, active agent/guidance model selection |
| `GET` | `/api/events` | Last 50 events as JSON array |

### WebSocket Messages

#### Extension → Server

| Type | Payload | Description |
|---|---|---|
| `USER_CLICK` | `{ payload: {...} }` | User clicked an element |
| `USER_INPUT` | `{ payload: {...} }` | User typed in a field |
| `NAVIGATION` | `{ payload: {...} }` | SPA navigation detected |
| `CONTENT_READY` | `{ payload: {...} }` | Content script loaded on a page |
| `SCREENSHOT` | `{ dataUrl, tabId, url }` | Manual screenshot capture |
| `CONTEXT_RESPONSE` | `{ requestId, ok, context }` | Response to GATHER_CONTEXT |
| `ACTION_RESULT` | `{ requestId, ok, result }` | Response to EXECUTE_ACTION |

#### Server → Extension

| Type | Payload | Description |
|---|---|---|
| `GATHER_CONTEXT` | `{ requestId }` | Request full page context for AI |
| `EXECUTE_ACTION` | `{ requestId, action }` | Execute a browser action (click, type, etc.) |
| `SHOW_GUIDANCE` | `{ guides[] }` | Render on-page guidance overlay |
| `CLEAR_GUIDANCE` | — | Remove on-page overlay |

#### Server → Dashboard

| Type | Payload | Description |
|---|---|---|
| `INIT` | `{ events, screenshot, aiEnabled, providers, activeAgentModel, activeGuidanceModel }` | Initial state on connect |
| `EVENT` | `{ event }` | New interaction event |
| `SCREENSHOT` | `{ dataUrl, url, timestamp }` | Updated screenshot |
| `CHAT_MESSAGE` | `{ text, sender, image?, highlights?, guidance?, agentResult? }` | Chat message (user/ai/system) |
| `AI_THINKING` | `{ thinking: boolean }` | Guidance AI processing state |
| `AGENT_STATUS` | `{ status, message? }` | Agent running/idle state |
| `AGENT_STEP` | `{ step: { action, description } }` | Live agent action step |
| `MODEL_CHANGED` | `{ activeAgentModel, activeGuidanceModel }` | Confirmation of model switch |

#### Dashboard → Server

| Type | Payload | Description |
|---|---|---|
| `CHAT_MESSAGE` | `{ text }` | User's question or command |
| `SET_MODEL` | `{ target, provider, model }` | Switch AI model (target: "agent", "guidance", or "both") |
| `SHOW_GUIDANCE` | `{ guides[] }` | Manually trigger on-page overlay |
| `CLEAR_GUIDANCE` | — | Manually clear on-page overlay |

---

## 9. Configuration

### Environment Variables (server/.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | At least one key | — | Google Gemini API key |
| `ANTHROPIC_API_KEY` | At least one key | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | At least one key | — | OpenAI API key |
| `PORT` | No | `3001` | Server port |

### Server Constants (index.js)

| Constant | Value | Description |
|---|---|---|
| `MAX_EVENTS` | `500` | Server-side event ring buffer size |
| `CONTEXT_TIMEOUT` | `15000` | Context gathering timeout (ms) |
| `ACTION_TIMEOUT` | `10000` | Action execution timeout (ms) |
| `HIGHLIGHT_COLORS` | 6 colors | Color cycle for annotations |

### Agent Constants (agent.js)

| Constant | Value | Description |
|---|---|---|
| `MAX_AGENT_STEPS` | `20` | Maximum ReAct loop iterations per task |
| Graph `recursionLimit` | `100` | LangGraph recursion limit |

### Extension Constants (background.js)

| Constant | Value | Description |
|---|---|---|
| `WS_URL` | `ws://localhost:3001?role=extension` | Backend WebSocket URL |
| `COLEARN_APP` | `localhost:5173` | Dashboard URL to exclude from observation |
| `MAX_EVENTS` | `200` | Event ring buffer size |
| `MAX_LOGS` | `100` | Console/network log buffer size |
| Max elements | `80` | Interactive elements extracted per page |

### Dashboard Constants (useWebSocket.js)

| Constant | Value | Description |
|---|---|---|
| `WS_URL` | `ws://localhost:3001?role=dashboard` | Backend WebSocket URL |
| `RECONNECT_DELAY` | `2000` | Reconnect delay in ms |

---

## 10. Phase Roadmap

### Phase 1 (Complete) — Browser Control & AI Chat

- [x] Chrome extension with MV3 manifest
- [x] Content script: click, input, navigation observers
- [x] Background service worker with CDP integration
- [x] Extension popup UI with status and controls
- [x] Express backend with WebSocket relay
- [x] React dashboard: sidebar, screen mirror, chat
- [x] Gemini AI integration with vision
- [x] Visual guidance: annotated screenshots with highlights
- [x] Element bounding box extraction
- [x] Multi-domain CDP observation (Page, DOM, Network, Console, Performance)

### Phase 2 (Complete) — Drawing & On-Page Guidance

- [x] **Drawing Canvas** — Freehand annotation on screenshots
  - Pen, arrow, rectangle, circle, text, eraser tools
  - Color picker (8 colors) and brush size selector
  - Undo/redo with keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z)
  - Save annotated images with thumbnail strip
  - Full-screen overlay with responsive canvas scaling
- [x] **On-Page Guidance Overlay** — Visual guides rendered directly on the website
  - Pulsing highlight boxes around elements with colored borders
  - Numbered step badges with labels
  - Curved arrows connecting sequential steps
  - Tooltips with explanations for each highlighted element
  - Step-by-step mode (Prev/Next) or show-all mode
  - Dismiss button to clear overlay
  - Auto-triggered from AI responses with highlights
  - Manual "Show on Page" / "Clear Overlay" buttons in chat

### Phase 3 (Complete) — Multi-Model AI & Autonomous Browser Agent

- [x] **Multi-Model Support** — Gemini, Claude, OpenAI via LangChain
  - Model factory with `ChatGoogleGenerativeAI`, `ChatAnthropic`, `ChatOpenAI`
  - Auto-detection of available providers from env vars
  - Separate model slots for agent and guidance
  - Runtime model switching from the dashboard
  - Model selector dropdown with provider/tier labels
- [x] **LangGraph Browser Agent** — Autonomous browser control
  - ReAct (Reason + Act) loop with observe → plan → execute → verify cycle
  - 12 browser tools: click, type, scroll, navigate, press key, modify style, set attribute, set content, execute JS, read page, wait, done
  - CSS selector-based element targeting (built from ID, data-testid, aria-label, or parent-chain)
  - Enhanced element extraction: 80 elements with selectors + computed styles
  - React-compatible event dispatching for type actions
  - Max 20 steps per task with graceful completion
- [x] **Intent Classification** — Auto-detect guidance vs action intent
  - Regex-based scoring with action and guidance pattern sets
  - Seamless dual-mode operation from a single chat input
- [x] **Agent UI** — Live progress in the dashboard
  - Agent step bubbles with action icons
  - Agent result badges (status + step count)
  - Agent progress bar during execution
  - Agent status broadcasting
- [x] **Resizable Dashboard Panels** — Drag-to-resize screen mirror / chat split
- [x] **Collapsible Sidebar** — Toggle sidebar open/closed

### Phase 4 (Future) — Context Understanding & Advanced Guidance

- [ ] Persistent conversation history
- [ ] Multi-step task guidance ("How do I create a design in Figma?")
- [ ] Auto-detect user intent from interaction patterns
- [ ] Proactive suggestions (detect confusion, repeated actions)
- [ ] Cross-tab context awareness

### Phase 5 (Future) — Advanced Automation & Collaboration

- [ ] Task recording and playback
- [ ] Cross-app workflow automation
- [ ] Collaborative sessions (multiple users)
- [ ] Custom AI model fine-tuning on user workflows
- [ ] Voice input/output for hands-free guidance

---

*Generated from the co-learn-3 codebase. Last updated: February 2026.*
