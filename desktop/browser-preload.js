/**
 * browser-preload.js
 * Context bridge for the browser window's toolbar (browser.html).
 * Exposes a safe, narrow API surface — no Node.js access in the renderer.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  // ── Navigation commands (renderer → main) ──
  navigate:  (url) => ipcRenderer.send('browser:navigate', url),
  back:      ()    => ipcRenderer.send('browser:back'),
  forward:   ()    => ipcRenderer.send('browser:forward'),
  reload:    ()    => ipcRenderer.send('browser:reload'),
  stop:      ()    => ipcRenderer.send('browser:stop'),

  // ── Tab commands ──
  newTab:    (url) => ipcRenderer.send('browser:new-tab', url || 'https://www.google.com'),
  closeTab:  (idx) => ipcRenderer.send('browser:close-tab', idx),
  switchTab: (idx) => ipcRenderer.send('browser:switch-tab', idx),

  // ── Utility ──
  openDevTools: () => ipcRenderer.send('browser:devtools'),
  openExtPopup: () => ipcRenderer.send('browser:ext-popup'),

  // ── State updates (main → renderer) ──
  // Registers a callback for tab/URL/button state changes.
  onState:     (cb) => ipcRenderer.on('browser:state',      (_, data) => cb(data)),
  // Registers a callback for extension connection status.
  onExtStatus: (cb) => ipcRenderer.on('browser:ext-status', (_, data) => cb(data)),
});
