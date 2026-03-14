const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const https = require('https');
const extractZip = require('extract-zip');
const { exec } = require('child_process');
const RPC = require('discord-rpc');

const store = new Store();
let mainWindow = null;

const DISCORD_CLIENT_ID = '1482242427883356231';
const DISCORD_BUTTONS = [
  { label: 'Download Now!', url: 'https://github.com/Jaruwyd/LCE-Launcher' }
];
let rpcClient = null;
let rpcReady = false;
let rpcWarned = false;
let rpcLastSentAt = 0;
let rpcPendingTimer = null;
let rpcLatestPayload = null;

function buildRpcActivity(payload) {
  const nowSec = Math.floor(Date.now() / 1000);
  const type = payload?.type || 'browsing';

  if (type === 'playing') {
    const label = payload?.label || 'Legacy (nightly)';
    const startTimestamp = payload?.startTimestamp
      ? Math.floor(payload.startTimestamp / 1000)
      : nowSec;

    return {
      details: 'Playing',
      state: payload?.server ? `${label} | ${payload.server}` : label,
startTimestamp,
      buttons: DISCORD_BUTTONS,
      partySize: payload?.partySize,
      partyMax: payload?.partyMax
    };
  }

  if (type === 'hosting') {
    const world = payload?.world || 'world';
    const maxPlayers = Number.isFinite(payload?.maxPlayers) ? payload.maxPlayers : null;
    const state = maxPlayers ? `${world} | Max ${maxPlayers}` : world;
    const startTimestamp = payload?.startTimestamp
      ? Math.floor(payload.startTimestamp / 1000)
      : nowSec;

    return {
      details: 'Hosting Server',
      state,
      startTimestamp,
      buttons: DISCORD_BUTTONS,
      partySize: payload?.partySize,
      partyMax: payload?.partyMax
    };
  }

  const view = payload?.view || 'Play Now';
  return {
    details: 'Browsing',
    state: view,
    buttons: DISCORD_BUTTONS
  };
}

function rpcSendActivity(payload) {
  if (!rpcClient || !rpcReady) return;

  // Throttle updates; nav switching can be noisy.
  const now = Date.now();
  const minIntervalMs = 1200;
  const msSince = now - rpcLastSentAt;
  if (msSince < minIntervalMs) {
    rpcLatestPayload = payload;
    if (!rpcPendingTimer) {
      rpcPendingTimer = setTimeout(() => {
        rpcPendingTimer = null;
        if (rpcLatestPayload) {
          const p = rpcLatestPayload;
          rpcLatestPayload = null;
          rpcSendActivity(p);
        }
      }, minIntervalMs - msSince);
    }
    return;
  }

  rpcLastSentAt = now;
  const activity = buildRpcActivity(payload);
  rpcClient.setActivity(activity).catch((e) => {
    if (!rpcWarned) {
      rpcWarned = true;
      console.warn('Discord RPC setActivity failed:', e?.message || e);
    }
  });
}

function initDiscordRPC() {
  try {
    RPC.register(DISCORD_CLIENT_ID);
    rpcClient = new RPC.Client({ transport: 'ipc' });

    rpcClient.on('ready', () => {
      rpcReady = true;
      rpcWarned = false;
      // Default presence on boot.
      rpcSendActivity({ type: 'browsing', view: 'Play Now' });
    });

    rpcClient.login({ clientId: DISCORD_CLIENT_ID }).catch((e) => {
      // Discord may not be running; that's fine.
      if (!rpcWarned) {
        rpcWarned = true;
        console.warn('Discord RPC login failed (is Discord running?):', e?.message || e);
      }
    });
  } catch (e) {
    console.warn('Discord RPC init failed:', e?.message || e);
  }
}

function setupAutoUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  autoUpdater.on('update-available', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { state: 'available' });
  });

  autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { state: 'none' });
  });

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { state: 'downloaded' });
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    center: true,
    resizable: true,
    frame: false, 
    icon: path.join(__dirname, '512x512.png'),
    transparent: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true, 
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  mainWindow = win;
  win.loadFile('index.html');

  ipcMain.on('window-minimize', () => win.minimize());
  ipcMain.on('window-maximize', () => {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on('window-close', () => win.close());

  ipcMain.on('rpc-presence', (event, payload) => {
    rpcSendActivity(payload);
  });

  ipcMain.handle('store-get', (event, key) => store.get(key));
  ipcMain.handle('store-set', (event, key, value) => store.set(key, value));
  
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    return result.filePaths[0];
  });
 
  win.on('maximize', () => win.webContents.send('window-is-maximized', true));
  win.on('unmaximize', () => win.webContents.send('window-is-maximized', false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdates();
  initDiscordRPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  try {
    if (rpcClient) {
      await rpcClient.clearActivity().catch(() => {});
      rpcClient.destroy();
      rpcClient = null;
    }
  } catch (_) {}
});
