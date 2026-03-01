'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Chat popup controls ──
  closePopup:  () => ipcRenderer.send('popup:close'),
  focusMain:   () => ipcRenderer.send('popup:focus-main'),
  togglePin:   (pinned) => ipcRenderer.send('popup:toggle-pin', pinned),

  // ── Browser navigation ──
  browserNavigate:    (url) => ipcRenderer.send('browser:navigate', url),
  browserBack:        ()    => ipcRenderer.send('browser:back'),
  browserForward:     ()    => ipcRenderer.send('browser:forward'),
  browserReload:      ()    => ipcRenderer.send('browser:reload'),
  browserStop:        ()    => ipcRenderer.send('browser:stop'),
  browserNewTab:      (url) => ipcRenderer.send('browser:new-tab', url),
  browserCloseTab:    (idx) => ipcRenderer.send('browser:close-tab', idx),
  browserSwitchTab:   (idx) => ipcRenderer.send('browser:switch-tab', idx),
  browserDevtools:    ()    => ipcRenderer.send('browser:devtools'),
  browserExtPopup:    ()    => ipcRenderer.send('browser:ext-popup'),
  // Sent when user drags the panel divider; x = left panel width + divider width
  browserPanelResize: (x)   => ipcRenderer.send('browser:panel-resize', x),

  // ── Browser state callbacks (main → renderer) ──
  onBrowserState:     (cb) => ipcRenderer.on('browser:state',      (_, d) => cb(d)),
  onBrowserExtStatus: (cb) => ipcRenderer.on('browser:ext-status', (_, d) => cb(d)),

  // ── CDP proxy (renderer opens role=desktop WS, bridges here via IPC) ──
  gatherContext:  ()       => ipcRenderer.invoke('cdp:gatherContext'),
  executeAction:  (action) => ipcRenderer.invoke('cdp:executeAction', action),
  showGuidance:   (msg)    => ipcRenderer.invoke('cdp:showGuidance', msg),
});
