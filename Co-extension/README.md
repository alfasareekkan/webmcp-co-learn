# CoLearn Agent — Phase 1: Browser Control

A Chrome extension that observes and interacts with web applications to enable future AI-guided co-working and co-learning features.

## Capabilities

- **Detect active web apps** — recognises Figma, Google Sheets, MagicPattern, Notion, Miro (extensible)
- **Observe user interaction** — captures clicks, inputs, and SPA navigations
- **Read page context** — extracts titles, headings, meta tags, and selections via CDP
- **Capture screenshots** — uses `Page.captureScreenshot` for future AI vision integration
- **Chrome DevTools Protocol** — attaches the debugger for deep browser inspection

## Project Structure

```
colearn-agent/
├── manifest.json      # MV3 extension manifest
├── background.js      # Service worker — event hub + CDP controller
├── content.js         # Injected into pages — observes interactions
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic
├── icons/             # Extension icons (16, 48, 128 px)
├── generate-icons.html # Helper to generate PNG icons
└── README.md
```

## Setup

1. **Generate icons** (one-time):
   - Open `generate-icons.html` in Chrome.
   - Right-click each image and save as `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.
   - Alternatively, use any 16/48/128 px PNG icons you prefer.

2. **Load the extension**:
   - Open `chrome://extensions/`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select this project folder

3. **Use it**:
   - Navigate to any web page
   - Click the **CL** extension icon in the toolbar
   - Use the popup to attach the debugger, read context, or capture screenshots
   - Interaction events (clicks, inputs, navigations) appear in the event log automatically

4. **WebMCP tool discovery (optional, like [Model Context Tool Inspector](https://github.com/GoogleChromeLabs/webmcp-tools))**:
   - Chrome **146+** with the **"WebMCP for testing"** flag enabled: `chrome://flags/#enable-webmcp-testing`
   - After attaching the debugger, use **Scan WebMCP Tools** in the popup to list tools exposed by the page via `navigator.modelContext`
   - The extension uses `navigator.modelContextTesting` when available to discover and execute tools (same approach as Google’s inspector)

## Architecture

```
Web App (Figma / Sheets / etc.)
        ↓
Content Script (content.js)
  · click / input / navigation observers
  · page context extraction
        ↓  chrome.runtime.sendMessage
Background Service Worker (background.js)
  · event aggregation
  · CDP session management
  · screenshot capture
        ↓
Popup UI (popup.html + popup.js)
  · status display
  · action buttons
  · event log
        ↓  (Phase 2)
AI Controller
  · context understanding
  · guidance generation
  · action automation
```

## Phase 1 Outcome

The extension can detect active web apps, observe user interaction, read page context, capture screenshots, and control the browser via CDP — laying the foundation for AI guidance in Phase 2.

## Next Phases

| Phase | Focus |
|-------|-------|
| **2** | Context understanding, AI guidance generation |
| **3** | Action automation, cross-app workflows |

---

*Built as part of the Co-Learn interview task.*
