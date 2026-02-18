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

**CoLearn Agent** is a browser-based co-learning and co-assistance platform. It uses a Chrome extension to observe user interactions across web applications, streams that data to an Express backend, processes it with Google Gemini AI, and presents visual guidance through a React dashboard.

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
| AI-powered Q&A | Gemini 2.5 Flash Lite processes screenshot + context |
| Visual guidance | Server annotates screenshots with highlights, arrows, labels |
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
│  │              │    │  │ Feed     │ │(screenshot)│ │ (AI)   │ │ │
│  │              │    │  └──────────┘ └────────────┘ └────────┘ │ │
│  └──────┬───────┘    └──────────────────┬───────────────────────┘ │
│         │                               │                        │
│  ┌──────┴───────────────────────┐       │ WebSocket              │
│  │ Chrome Extension (MV3)      │       │ (ws://localhost:3001    │
│  │                              │       │  ?role=dashboard)       │
│  │  content.js → background.js │       │                        │
│  │  (CDP: Page, DOM, Network,  │       │                        │
│  │   Console, Performance,     ├───────┘                        │
│  │   Runtime)                  │                                 │
│  └──────────────┬──────────────┘                                 │
└─────────────────┼────────────────────────────────────────────────┘
                  │ WebSocket
                  │ (ws://localhost:3001?role=extension)
                  │
         ┌────────┴────────────────────────────────────┐
         │         Express Backend (localhost:3001)     │
         │                                              │
         │  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
         │  │ WebSocket│  │ Gemini   │  │ Screenshot │ │
         │  │ Hub      │  │ AI       │  │ Annotator  │ │
         │  │          │  │ (2.5     │  │ (sharp +   │ │
         │  │          │  │  flash   │  │  SVG)      │ │
         │  │          │  │  lite)   │  │            │ │
         │  └──────────┘  └──────────┘  └────────────┘ │
         └─────────────────────────────────────────────┘
```

### Communication Protocol

- **Extension → Server**: WebSocket with `role=extension`
- **Dashboard → Server**: WebSocket with `role=dashboard`
- **Server → Extension**: Sends `GATHER_CONTEXT` requests
- **Extension → Server**: Replies with `CONTEXT_RESPONSE` (screenshot + DOM + network + console + elements with bounding boxes)
- **Server → Dashboard**: Broadcasts events, screenshots, AI responses, annotated images

---

## 3. Project Structure

```
co-learn-3/
│
├── Co-extension/                 # Chrome Extension (MV3)
│   ├── manifest.json             # Extension manifest
│   ├── background.js             # Service worker — CDP, WebSocket, event hub
│   ├── content.js                # Page observer — clicks, inputs, navigation
│   ├── popup.html                # Extension popup UI
│   ├── popup.js                  # Popup controller
│   ├── icons/                    # Extension icons (16, 48, 128 px)
│   ├── generate-icons.html       # Icon generation helper
│   └── README.md                 # Extension-specific readme
│
├── server/                       # Express Backend
│   ├── index.js                  # Main server — WebSocket, Gemini AI, chat handler
│   ├── annotate.js               # Screenshot annotation engine (sharp + SVG)
│   ├── package.json              # Dependencies (express, ws, sharp, @google/generative-ai)
│   ├── .env                      # Environment variables (GEMINI_API_KEY) — gitignored
│   └── .env.example              # Template for .env
│
├── client/                       # React Dashboard (Vite)
│   ├── src/
│   │   ├── main.jsx              # React entry point
│   │   ├── App.jsx               # Root component — state management
│   │   ├── App.css               # Layout grid
│   │   ├── index.css             # Global styles + CSS variables
│   │   ├── hooks/
│   │   │   └── useWebSocket.js   # WebSocket hook with auto-reconnect
│   │   └── components/
│   │       ├── Sidebar.jsx       # Activity feed component
│   │       ├── Sidebar.css
│   │       ├── ScreenMirror.jsx  # Remote screenshot viewer
│   │       ├── ScreenMirror.css
│   │       ├── ChatPanel.jsx     # AI chat with annotated images
│   │       └── ChatPanel.css
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

**Files created**: `manifest.json`, `content.js`, `background.js`, `popup.html`, `popup.js`

**manifest.json** — Manifest V3 with permissions:
- `activeTab` — access to the current tab
- `scripting` — inject scripts programmatically
- `debugger` — attach Chrome DevTools Protocol
- `tabs` — query and track tabs

Content scripts match `<all_urls>` to run on every page. The background runs as a service worker.

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

**Goal**: Central hub that receives events, manages CDP debugger sessions, and communicates with the backend.

**Key responsibilities**:

1. **Event aggregation** — ring buffer of 200 events
2. **Tab tracking** — `chrome.tabs.onActivated` keeps `activeTabId` current
3. **WebSocket to backend** — connects to `ws://localhost:3001?role=extension` with auto-reconnect (3s)
4. **CDP debugger management** — attach/detach per tab, tracks attached set
5. **Context gathering** — responds to `GATHER_CONTEXT` requests from backend

**CDP Domains enabled on attach**:
| Domain | Purpose |
|---|---|
| `Page` | Screenshots, navigation events |
| `Runtime` | JavaScript evaluation for DOM extraction |
| `Network` | Request/response logging |
| `Console` | Console message capture |
| `Performance` | Heap size, layout counts, node counts |
| `DOM` | DOM tree access |

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

**Goal**: Relay events between extension and dashboard, serve as the AI processing layer.

**Architecture**:
- Express HTTP server on port 3001
- WebSocket server on the same port
- Clients tracked by role (`extension` or `dashboard`)
- Events stored in a ring buffer (500 max)

**WebSocket message types handled**:

| From | Type | Action |
|---|---|---|
| Extension | `USER_CLICK`, `USER_INPUT`, `NAVIGATION`, `CONTENT_READY` | Store + broadcast to dashboards |
| Extension | `SCREENSHOT` | Store latest + broadcast |
| Extension | `CONTEXT_RESPONSE` | Resolve pending context request |
| Dashboard | `CHAT_MESSAGE` | Trigger full AI pipeline |

**REST endpoints**:
- `GET /api/health` — connection counts, AI status
- `GET /api/events` — last 50 events as JSON

---

### Step 6 — React Dashboard (client/)

**Goal**: Real-time UI showing activity, screen mirror, and AI chat.

**Technology**: React 19 + Vite 7, no additional UI libraries.

**Layout**: CSS Grid — `320px sidebar | flexible main content`
Main content splits into `screen mirror (flexible) | chat panel (360px)`

**Components**:

#### `App.jsx`
Root state management. Holds events, screenshot, chat messages, AI thinking state. WebSocket hook connects on mount with auto-reconnect.

#### `Sidebar.jsx`
Live activity feed. Events scroll auto-bottom. Color-coded badges: CLICK (purple), INPUT (teal), NAV (yellow), READY (green), CHAT (purple). Shows detected app name and timestamp.

#### `ScreenMirror.jsx`
Displays the latest screenshot from the extension. Shows URL and timestamp. Empty state with instructions when no screenshot available.

#### `ChatPanel.jsx`
Full AI chat interface:
- User messages (purple, right-aligned)
- AI responses (dark with teal left border)
- System errors (centered, red)
- **Annotated images** — clickable to expand/shrink
- **Highlight legend** — colored dots with labels and reasons
- Thinking indicator — "Capturing screen & analyzing..." with bouncing dots
- Input disabled during AI processing

#### `useWebSocket.js`
Custom hook. Connects to `ws://localhost:3001?role=dashboard`. Auto-reconnects on disconnect (2s delay). Exposes `{ connected, send }`.

---

### Step 7 — Gemini AI Integration

**Goal**: Answer user questions using full page context + screenshot vision.

**Model**: `gemini-2.5-flash-lite` with `temperature: 0`

**Prompt design**: Gemini is instructed to return **JSON** with two fields:
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

**Context sent to Gemini**:
- Screenshot as inline JPEG image (vision input)
- Page URL and title
- DOM: headings, buttons, links, inputs, forms, visible text
- Interactive elements with pixel bounding boxes
- Recent network requests (method, status, URL)
- Console logs (level, text)
- Performance metrics

---

### Step 8 — Visual Guidance (Screenshot Annotation)

**Goal**: When the AI identifies specific UI elements, draw highlights on the screenshot and send it back in chat.

**Flow**:
1. User asks "Where is the create button?"
2. Server sends `GATHER_CONTEXT` to extension
3. Extension captures screenshot + 60 interactive elements with bounding boxes
4. Server sends everything to Gemini
5. Gemini returns `highlights` array referencing element indices
6. Server's `annotate.js` draws on the screenshot using sharp + SVG compositing
7. Annotated image sent to dashboard as data URL in the chat message

**Annotation features** (`annotate.js`):
- Colored highlight boxes with rounded corners and semi-transparent fill
- Corner dots on each highlighted element
- Numbered label badges above each element
- Arrows pointing from label to element
- Multi-color support (6 colors cycle: pink, teal, orange, green, purple, blue)
- DPR-aware scaling (handles Retina/HiDPI displays)

---

### Step 9 — Element Bounding Box Extraction

**Goal**: Give the AI precise pixel locations of all interactive elements.

The extension's `extractInteractiveElements()` function queries the page for:
```
button, [role="button"], a[href], input, textarea, select,
[onclick], [role="link"], [role="tab"], [role="menuitem"],
img, svg, [class*="icon"], [class*="btn"], [class*="logo"],
[class*="nav"], h1, h2, h3, [data-testid], [aria-label]
```

For each element (up to 60), it captures:
- Tag name, text content, classes, ID
- ARIA role, href, input type
- **Bounding box**: `{ x, y, width, height }` via `getBoundingClientRect()`

These are sent as the `elements` array in the context, and the AI references them by index.

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
    │                              │                            │
    │                              │ (runs CDP queries)         │
    │                              │                            │
    │                              │── CONTEXT_RESPONSE ───────►│
```

### Chat Message Pipeline

```
User types question
        │
        ▼
Dashboard ──CHAT_MESSAGE──► Server
                               │
                               ├── Echo user message to all dashboards
                               ├── Set AI_THINKING = true
                               ├── Send GATHER_CONTEXT to extension
                               │         │
                               │         ▼
                               │    Extension captures:
                               │    - Screenshot (JPEG 70%)
                               │    - DOM info
                               │    - 60 elements with bounding boxes
                               │    - Network logs (last 30)
                               │    - Console logs (last 30)
                               │    - Performance metrics
                               │    - Viewport size + DPR
                               │         │
                               │◄── CONTEXT_RESPONSE ──┘
                               │
                               ├── Update screen mirror
                               ├── Build context text + image parts
                               ├── Send to Gemini (vision + text)
                               │         │
                               │         ▼
                               │    Gemini returns JSON:
                               │    { text, highlights[] }
                               │         │
                               │◄────────┘
                               │
                               ├── If highlights exist:
                               │   └── annotateScreenshot()
                               │       - Map elementIndex → bounding box
                               │       - Draw SVG overlay (boxes, labels, arrows)
                               │       - Composite with sharp
                               │       - Return data URL
                               │
                               ├── Send AI response + annotated image
                               └── Set AI_THINKING = false
```

---

## 6. Data Flow

### Event Object Schema

```javascript
{
  type: "USER_CLICK" | "USER_INPUT" | "NAVIGATION" | "CONTENT_READY",
  tag: "BUTTON",              // HTML tag
  text: "Submit",             // visible text (max 100 chars)
  id: "submit-btn",           // element ID
  classes: "btn btn-primary", // CSS classes
  path: "div.container > button#submit-btn",  // CSS selector path
  url: "https://figma.com/...",
  app: "Figma",              // detected app name or null
  timestamp: 1708300000000,
  tabId: 42,                 // Chrome tab ID
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
    inputs: [{ type: "text", name: "search", placeholder: "Search..." }],
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
      role: "button",
      bounds: { x: 100, y: 50, width: 120, height: 36 },
    },
    // ... up to 60 elements
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

// AI response (with visual guidance)
{
  type: "CHAT_MESSAGE",
  text: "The **Create** button is in the top-right corner of the toolbar.",
  sender: "ai",
  timestamp: ...,
  image: "data:image/jpeg;base64,...",   // annotated screenshot
  highlights: [
    { elementIndex: 5, label: "Create", reason: "Click here to create a new item" }
  ],
  context: { url: "...", title: "..." },
}

// System error
{ type: "CHAT_MESSAGE", text: "Error: ...", sender: "system", timestamp: ... }

// Thinking indicator
{ type: "AI_THINKING", thinking: true }
```

---

## 7. Setup & Installation

### Prerequisites

- Node.js 18+
- Google Chrome
- Gemini API key (from [aistudio.google.com](https://aistudio.google.com))

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
# Create server/.env
echo "GEMINI_API_KEY=your_key_here" > server/.env
echo "PORT=3001" >> server/.env
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
5. Type a question in chat → AI captures the screen and responds with annotated guidance

---

## 8. API Reference

### REST Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server status, AI enabled flag, connection counts |
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

#### Server → Extension

| Type | Payload | Description |
|---|---|---|
| `GATHER_CONTEXT` | `{ requestId }` | Request full page context for AI |

#### Server → Dashboard

| Type | Payload | Description |
|---|---|---|
| `INIT` | `{ events, screenshot, aiEnabled }` | Initial state on connect |
| `EVENT` | `{ event }` | New interaction event |
| `SCREENSHOT` | `{ dataUrl, url, timestamp }` | Updated screenshot |
| `CHAT_MESSAGE` | `{ text, sender, image?, highlights? }` | Chat message (user/ai/system) |
| `AI_THINKING` | `{ thinking: boolean }` | AI processing state |

#### Dashboard → Server

| Type | Payload | Description |
|---|---|---|
| `CHAT_MESSAGE` | `{ text }` | User's question |

---

## 9. Configuration

### Environment Variables (server/.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key |
| `PORT` | No | `3001` | Server port |

### Extension Constants (background.js)

| Constant | Value | Description |
|---|---|---|
| `WS_URL` | `ws://localhost:3001?role=extension` | Backend WebSocket URL |
| `COLEARN_APP` | `localhost:5173` | Dashboard URL to exclude from observation |
| `MAX_EVENTS` | `200` | Event ring buffer size |
| `MAX_LOGS` | `100` | Console/network log buffer size |

### Dashboard Constants (useWebSocket.js)

| Constant | Value | Description |
|---|---|---|
| `WS_URL` | `ws://localhost:3001?role=dashboard` | Backend WebSocket URL |
| `RECONNECT_DELAY` | `2000` | Reconnect delay in ms |

---

## 10. Phase Roadmap

### Phase 1 (Current) — Browser Control & AI Chat

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

### Phase 2 (Next) — Context Understanding & Guidance

- [ ] Persistent conversation history
- [ ] Multi-step task guidance ("How do I create a design in Figma?")
- [ ] Auto-detect user intent from interaction patterns
- [ ] Proactive suggestions (detect confusion, repeated actions)
- [ ] Cross-tab context awareness

### Phase 2.5 (Current) — Drawing & On-Page Guidance

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

#### Architecture — On-Page Guidance Flow:
```
AI response with highlights
  ↓
Server maps highlights → element bounds (guidance data)
  ↓
Server auto-sends SHOW_GUIDANCE to extension via WebSocket
  ↓
Background.js relays to active tab via chrome.tabs.sendMessage
  ↓
overlay.js (content script) renders highlights, badges, arrows, tooltips
  ↓
User can navigate step-by-step or dismiss
```

Dashboard can also manually trigger guidance:
```
ChatPanel "Show on Page" button
  ↓
WebSocket sends SHOW_GUIDANCE with guidance data
  ↓
Server relays to extension → overlay.js renders on page
```

### Phase 3 (Future) — Action Automation

- [ ] AI-driven browser actions (click, type, scroll via CDP)
- [ ] Task recording and playback
- [ ] Cross-app workflow automation
- [ ] Collaborative sessions (multiple users)
- [ ] Custom AI model fine-tuning on user workflows

---

*Generated from the co-learn-3 codebase. Last updated: February 2026.*
