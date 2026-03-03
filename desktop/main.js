'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const { initExtension, attachBrowserView, registerIpc } = require('./browserManager');

// ── API Key persistent storage ────────────────────────────────────────────────
function getKeysPath() {
  return path.join(app.getPath('userData'), 'colearn-keys.json');
}
function readStoredKeys() {
  try { return JSON.parse(fs.readFileSync(getKeysPath(), 'utf8')); }
  catch { return {}; }
}
function writeStoredKeys(keys) {
  fs.writeFileSync(getKeysPath(), JSON.stringify(keys, null, 2), 'utf8');
}
ipcMain.handle('apikeys:get',  ()        => readStoredKeys());
ipcMain.handle('apikeys:save', (_, keys) => { writeStoredKeys(keys); return { ok: true }; });

// ── Single-instance lock ──────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Chrome flags (must be set before app.whenReady) ───────────────────────────
app.commandLine.appendSwitch('remote-debugging-port', '9223');
app.commandLine.appendSwitch('enable-smooth-scrolling');
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

// ── Window state ──────────────────────────────────────────────────────────────
let mainWindow = null;
let chatPopup  = null;
let popupReady = false;

// ── Main dashboard window ─────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:    1440,
    height:   900,
    minWidth: 900,
    minHeight: 600,
    title: 'CoLearn',
    backgroundColor: '#0a0b0d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  // Attach the browser WebContentsView once the HTML toolbar is rendered
  mainWindow.webContents.once('did-finish-load', () => {
    attachBrowserView(mainWindow);
  });

  mainWindow.on('blur',   () => showChatPopup());
  mainWindow.on('focus',  () => hideChatPopup());
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (chatPopup && !chatPopup.isDestroyed()) chatPopup.close();
    chatPopup = null;
  });
}

// ── Chat popup window ─────────────────────────────────────────────────────────
function createChatPopup() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  chatPopup = new BrowserWindow({
    width: 400, height: 560,
    x: width - 420, y: height - 580,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: true, show: false, minWidth: 320, minHeight: 350,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  chatPopup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  chatPopup.loadFile('popup.html');
  chatPopup.webContents.on('did-finish-load', () => { popupReady = true; });
  chatPopup.on('closed', () => { chatPopup = null; popupReady = false; });
}

function showChatPopup() {
  if (!chatPopup || chatPopup.isDestroyed()) createChatPopup();
  if (popupReady) {
    chatPopup.showInactive();
  } else {
    chatPopup.webContents.once('did-finish-load', () => {
      popupReady = true;
      if (chatPopup && !chatPopup.isDestroyed()) chatPopup.showInactive();
    });
  }
}

function hideChatPopup() {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide();
}

// ── IPC: chat popup ───────────────────────────────────────────────────────────
ipcMain.on('popup:close',      () => hideChatPopup());
ipcMain.on('popup:focus-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
});
ipcMain.on('popup:toggle-pin', (_e, pinned) => {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.setAlwaysOnTop(pinned);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Load the Co-extension into its session BEFORE any windows open
  await initExtension();
  // Register all browser IPC handlers
  registerIpc();

  createMainWindow();
  createChatPopup();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createChatPopup();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
