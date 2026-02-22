# CoLearn Agent

A browser-based co-learning assistant. **Chat with AI via the Electron desktop app** (floating window), get step-by-step guidance on any website, or let the AI control the browser for you.

---

## Flow (at a glance)

**Setup flow**

1. Install dependencies (server + client) and add `server/.env` with your API key.
2. Load the **Co-extension** in Chrome (`chrome://extensions/` → Developer mode → **Load unpacked** → select `Co-extension`).
3. Start the backend (`cd server && npm start`), then the **Electron desktop app** for chat (`cd desktop && npx electron .`). Optionally run the web dashboard too (`cd client && npm run dev`).

**Usage flow**

1. **Connect the extension** in Chrome (load it once from `chrome://extensions/`).
2. Use the **Electron desktop app** — from there you control everything: chat with the AI, get guidance on any page, or let the agent act in the browser. No need to attach per-tab; the desktop app works with your Chrome tabs through the extension.

Messages are routed automatically (Chat / Guidance / Agent); switch models with the gear icon in the chat header.

---

## Quick start

### 1. Prerequisites

- **Node.js 18+**
- **Chrome**
- At least one AI API key:
  - **Gemini** (free): [aistudio.google.com](https://aistudio.google.com)
  - **Claude** or **OpenAI** (optional): add keys in `server/.env` if you use them

### 2. Install and configure

```bash
# Server
cd server && npm install

# Client
cd client && npm install
```

Create `server/.env` with your API key and port:

```
GEMINI_API_KEY=your_key_here
PORT=3001
```

### 3. Add the extension in Chrome

1. Open **Chrome** and go to `chrome://extensions/`
2. Turn **Developer mode** ON (top-right)
3. Click **Load unpacked**
4. Choose the **`Co-extension`** folder inside this project

The **CL** icon will appear in your toolbar when the extension is loaded.

### 4. Run the app

**Terminal 1 — backend**

```bash
cd server && npm start
```

**Terminal 2 — desktop app (chat)**

```bash
cd desktop && npx electron .
```

This opens the **Electron desktop app** with a floating chat window — use it to chat with the AI.

**Optional — web dashboard** (sidebar, screen mirror, full UI):

```bash
cd client && npm run dev
```

Then open **http://localhost:5173** in Chrome.

---




---

## Optional: extension icons

If the extension has no icons, open `Co-extension/generate-icons.html` in Chrome, then save the images as:

- `Co-extension/icons/icon16.png`
- `Co-extension/icons/icon48.png`
- `Co-extension/icons/icon128.png`

---

## Web dashboard (optional)

The React dashboard at `http://localhost:5173` (run with `cd client && npm run dev`) gives you the full UI with sidebar activity feed and screen mirror. Chat is available there too; the **primary chat interface is the Electron desktop app**.

---

For full technical details, see [DOCUMENTATION.md](DOCUMENTATION.md).
