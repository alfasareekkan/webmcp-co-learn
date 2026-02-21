const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");

let mainWindow = null;
let chatPopup = null;
let popupReady = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "CoLearn",
    backgroundColor: "#0b0d11",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");

  mainWindow.on("blur", () => {
    showChatPopup();
  });

  mainWindow.on("focus", () => {
    hideChatPopup();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (chatPopup && !chatPopup.isDestroyed()) chatPopup.close();
    chatPopup = null;
  });
}

function createChatPopup() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  chatPopup = new BrowserWindow({
    width: 400,
    height: 560,
    x: width - 420,
    y: height - 580,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    show: false,
    minWidth: 320,
    minHeight: 350,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chatPopup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  chatPopup.loadFile("popup.html");

  chatPopup.webContents.on("did-finish-load", () => {
    popupReady = true;
  });

  chatPopup.on("closed", () => {
    chatPopup = null;
    popupReady = false;
  });
}

function showChatPopup() {
  if (!chatPopup || chatPopup.isDestroyed()) {
    createChatPopup();
  }
  if (popupReady) {
    chatPopup.showInactive();
  } else {
    chatPopup.webContents.once("did-finish-load", () => {
      popupReady = true;
      if (chatPopup && !chatPopup.isDestroyed()) chatPopup.showInactive();
    });
  }
}

function hideChatPopup() {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide();
}

ipcMain.on("popup:close", () => hideChatPopup());

ipcMain.on("popup:focus-main", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.on("popup:toggle-pin", (_e, pinned) => {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.setAlwaysOnTop(pinned);
});

app.whenReady().then(() => {
  createMainWindow();
  createChatPopup();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createChatPopup();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
