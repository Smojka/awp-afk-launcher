import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray, type NativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from '../src/main/bot/botManager.js';
import { UpdateService } from '../src/main/update/updateService.js';
import type {
  AppSettings,
  DiscordRuntimeInput,
  InventoryActionRequest,
  LauncherState,
  OperationKind,
  OperationStartRequest,
  SaveProfileInput
} from '../src/shared/types.js';
import { launcherUserDataDir } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let manager: BotManager | null = null;
let updateService: UpdateService | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let shutdownStarted = false;
let hasShownTrayHint = false;
// Mirrors AppSettings.minimizeToTrayOnClose; kept in sync from launcher state so the
// window 'close' handler can decide synchronously without reaching into the manager.
let minimizeToTrayOnClose = true;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const useCustomWindowControls = process.platform !== 'darwin';
const PREFERRED_WINDOW_SIZE = { width: 1280, height: 760 };
const MIN_WINDOW_SIZE = { width: 760, height: 540 };
const WORK_AREA_MARGIN = 32;

async function createWindow(): Promise<void> {
  const initialBounds = getInitialWindowBounds();

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
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

  // On Windows/Linux, closing the window keeps the app alive in the system tray
  // instead of quitting. The real quit path runs through the tray menu (quitApp).
  mainWindow.on('close', (event) => {
    if (isQuitting || !useCustomWindowControls || !minimizeToTrayOnClose) return;
    event.preventDefault();
    minimizeToTray();
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

function getInitialWindowBounds(): { width: number; height: number } {
  const { width: workAreaWidth, height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: fitWindowDimension(PREFERRED_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width, workAreaWidth),
    height: fitWindowDimension(PREFERRED_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height, workAreaHeight)
  };
}

function fitWindowDimension(preferred: number, minimum: number, available: number): number {
  const usable = Math.max(0, available - WORK_AREA_MARGIN);
  if (usable <= 0) return preferred;
  return Math.max(minimum, Math.min(preferred, usable));
}

// Keep the tray icon in step with the user's preference: present only when
// close-to-tray is enabled, so disabling the feature also removes the icon.
function reconcileTray(): void {
  if (!useCustomWindowControls || isQuitting) return;
  if (minimizeToTrayOnClose && !tray) {
    createTray();
  } else if (!minimizeToTrayOnClose && tray) {
    tray.destroy();
    tray = null;
  }
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(resolveTrayIcon());
  tray.setToolTip('ChunkKeeper');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'ChunkKeeper’i aç', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Çıkış', click: () => quitApp() }
  ]);
}

function resolveTrayIcon(): NativeImage {
  // build/ is bundled into the asar via the electron-builder "files" list.
  const preferred = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const primary = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', preferred));
  if (!primary.isEmpty()) return primary;
  return nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png'));
}

function minimizeToTray(): void {
  if (!mainWindow) return;
  mainWindow.hide();
  if (process.platform === 'win32') showTrayHintOnce();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp(): void {
  isQuitting = true;
  app.quit();
}

function showTrayHintOnce(): void {
  if (hasShownTrayHint || !tray) return;
  hasShownTrayHint = true;
  tray.displayBalloon({
    title: 'ChunkKeeper arka planda çalışıyor',
    content:
      'Pencere sistem tepsisine küçültüldü. Açmak için tepsi simgesine tıklayın; tamamen kapatmak için sağ tıklayıp Çıkış’ı seçin.'
  });
}

function createManager(): BotManager {
  const botManager = new BotManager({
    userDataDir: launcherUserDataDir(),
    appVersion: app.getVersion()
  });
  botManager.on('state', (state: LauncherState) => {
    minimizeToTrayOnClose = state.settings.minimizeToTrayOnClose;
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('launcher:state', state);
    });
    reconcileTray();
  });
  return botManager;
}

function broadcast(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(channel, payload);
  });
}

function createUpdateService(): UpdateService {
  const service = new UpdateService();
  service.on('available', (info) => broadcast('update:available', info));
  service.on('progress', (progress) => broadcast('update:progress', progress));
  service.on('downloaded', (info) => broadcast('update:downloaded', info));
  service.on('error', (message) => broadcast('update:error', message));
  return service;
}

function getUpdateService(): UpdateService {
  if (!updateService) throw new Error('Update service is not ready');
  return updateService;
}

async function runUpdateCheckOnLaunch(): Promise<void> {
  try {
    const result = await getUpdateService().check();
    if (result.updateAvailable) {
      broadcast('update:available', result);
    }
  } catch (error) {
    // Offline or rate-limited checks must never block startup.
    console.warn('[update] launch check failed:', error instanceof Error ? error.message : error);
  }
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
  ipcMain.handle('bot:startOperation', async (_event, profileId: string, request: OperationStartRequest) =>
    getManager().startOperation(profileId, request)
  );
  ipcMain.handle('bot:stopOperation', async (_event, profileId: string, kind: OperationKind) =>
    getManager().stopOperation(profileId, kind)
  );
  ipcMain.handle('bot:runQuickScript', async (_event, profileId: string, command: string) =>
    getManager().runQuickScript(profileId, command)
  );
  ipcMain.handle('bot:inventoryAction', async (_event, profileId: string, request: InventoryActionRequest) =>
    getManager().inventoryAction(profileId, request)
  );
  ipcMain.handle('bot:completeChat', async (_event, profileId: string, partial: string) =>
    getManager().completeChat(profileId, partial)
  );
  ipcMain.handle('bot:capturePosition', async (_event, profileId: string) =>
    getManager().capturePosition(profileId)
  );
  ipcMain.handle('bot:configureDiscord', async (_event, profileId: string, input: DiscordRuntimeInput) =>
    getManager().configureDiscord(profileId, input)
  );
  ipcMain.handle('app:updateSettings', async (_event, patch: Partial<AppSettings>) => getManager().updateSettings(patch));
  ipcMain.handle('secret:isAvailable', async () => getManager().secretAvailable());
  ipcMain.handle('app:openUserData', async () => {
    await shell.openPath(launcherUserDataDir());
  });
  ipcMain.handle('update:check', async () => getUpdateService().check());
  ipcMain.handle('update:download', async () => {
    await getUpdateService().download();
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

// Only one launcher instance may run at a time: a second launch (e.g. while the
// app sits in the tray) just surfaces the existing window instead of spawning a
// duplicate that would reconnect every bot a second time.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    manager = createManager();
    updateService = createUpdateService();
    registerIpc();
    await manager.load();
    // Warm the heavy mineflayer/pathfinder imports off the critical path so the first connect
    // doesn't pay their module-load latency.
    void manager.prewarm();
    minimizeToTrayOnClose = manager.getState().settings.minimizeToTrayOnClose;
    await createWindow();
    reconcileTray();
    void runUpdateCheckOnLaunch();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (shutdownStarted) return;
  shutdownStarted = true;
  tray?.destroy();
  tray = null;
  if (!manager) return;
  // Electron does not await async before-quit handlers, so a bare `await stopAll()`
  // never actually delays the quit and bots are torn down mid-flight. Cancel this pass,
  // disconnect every bot, then quit for real (the re-entry is short-circuited above).
  event.preventDefault();
  void manager
    .stopAll()
    .catch((error) => console.warn('[shutdown] stopAll failed:', error instanceof Error ? error.message : error))
    .finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
