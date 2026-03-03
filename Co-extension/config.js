/**
 * CoLearn — single source of truth for server / WebSocket URLs.
 *
 * Usage:
 *   Service worker  →  importScripts('config.js');  then COLEARN_CONFIG.wsUrl('extension')
 *   Node / Electron →  const cfg = require('./Co-extension/config.js');
 *   Browser script  →  <script src="config.js"></script>  then window.COLEARN_CONFIG
 */
(function initCoLearnConfig(global) {
  // ── CHANGE THESE TWO LINES TO SWITCH ENVIRONMENTS ──────────────────────────
  const serverOrigin  = "https://webmcp-co-learn-production.up.railway.app";
  const wsOrigin      = "wss://webmcp-co-learn-production.up.railway.app";
  // The host of the dashboard SPA (used to skip extension injection on it)
  const dashboardHost = "webmcp-co-learn-production.up.railway.app";
  // ───────────────────────────────────────────────────────────────────────────

  const cfg = {
    serverOrigin,
    wsOrigin,
    dashboardHost,
    /** Returns the WebSocket URL for a given role, e.g. 'extension', 'dashboard', 'desktop' */
    wsUrl(role) {
      return `${wsOrigin}?role=${encodeURIComponent(role || "unknown")}`;
    },
    /** Returns the HTTP health-check URL */
    healthUrl() {
      return `${serverOrigin}/api/health`;
    },
  };

  // Expose on the global (window / globalThis / ServiceWorkerGlobalScope)
  global.COLEARN_CONFIG = cfg;

  // Also export for CommonJS (Electron / Node)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = cfg;
  }
}(typeof globalThis !== "undefined" ? globalThis : this));
