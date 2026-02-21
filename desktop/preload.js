const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  closePopup: () => ipcRenderer.send("popup:close"),
  focusMain: () => ipcRenderer.send("popup:focus-main"),
  togglePin: (pinned) => ipcRenderer.send("popup:toggle-pin", pinned),
});
