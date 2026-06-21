import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from '../src/main/bot/botManager.js';
import type { AppSettings, LauncherState, SaveProfileInput } from '../src/shared/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let manager: BotManager | null = null;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const useCustomWindowControls = process.platform !== 'darwin';

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0b0f13',
    title: 'ChunkKeeper',
    frame: !useCustomWindowControls,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

function createManager(): BotManager {
  const botManager = new BotManager({
    userDataDir: process.env.AFK_LAUNCHER_USER_DATA_DIR || app.getPath('userData'),
    appVersion: app.getVersion()
  });
  botManager.on('state', (state: LauncherState) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('launcher:state', state);
    });
  });
  return botManager;
}

function registerIpc(): void {
  ipcMain.handle('launcher:getState', async () => getManager().getState());
  ipcMain.handle('profile:save', async (_event, profile: SaveProfileInput) => getManager().saveProfile(profile));
  ipcMain.handle('profile:delete', async (_event, profileId: string) => getManager().deleteProfile(profileId));
  ipcMain.handle('profile:select', async (_event, profileId: string) => getManager().selectProfile(profileId));
  ipcMain.handle('bot:connect', async (_event, profileId: string) => getManager().connect(profileId));
  ipcMain.handle('bot:disconnect', async (_event, profileId: string) => getManager().disconnect(profileId));
  ipcMain.handle('bot:startAll', async () => getManager().startAll());
  ipcMain.handle('bot:stopAll', async () => getManager().stopAll());
  ipcMain.handle('bot:sendChat', async (_event, profileId: string, message: string) => getManager().sendChat(profileId, message));
  ipcMain.handle('app:updateSettings', async (_event, patch: Partial<AppSettings>) => getManager().updateSettings(patch));
  ipcMain.handle('app:openUserData', async () => {
    await shell.openPath(app.getPath('userData'));
  });
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:toggleMaximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return window.isMaximized();
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:isMaximized', (event) => {
    return Boolean(BrowserWindow.fromWebContents(event.sender)?.isMaximized());
  });
}

function getManager(): BotManager {
  if (!manager) throw new Error('Launcher manager is not ready');
  return manager;
}

app.whenReady().then(async () => {
  manager = createManager();
  registerIpc();
  await manager.load();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('before-quit', async () => {
  if (manager) {
    await manager.stopAll();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
