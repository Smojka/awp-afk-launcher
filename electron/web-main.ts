import { app, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from '../src/main/bot/botManager.js';
import { startLocalWebServer, type LocalWebServer } from '../src/main/server/localWebServer.js';
import { launcherUserDataDir } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let manager: BotManager | null = null;
let localWebServer: LocalWebServer | null = null;
let isShuttingDown = false;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function createManager(): BotManager {
  return new BotManager({
    userDataDir: launcherUserDataDir(),
    appVersion: app.getVersion()
  });
}

async function startBrowserDashboard(): Promise<LocalWebServer> {
  const server = await startLocalWebServer({
    manager: getManager(),
    staticDir: path.join(__dirname, '../../dist'),
    devRendererUrl: isDev ? process.env.VITE_DEV_SERVER_URL : undefined,
    openUserData: () => shell.openPath(launcherUserDataDir()).then(() => undefined)
  });
  getManager().setWebDashboardUrl(server.url);
  console.info(`ChunkKeeper Web dashboard: ${server.url}`);
  return server;
}

function getManager(): BotManager {
  if (!manager) throw new Error('Launcher manager is not ready');
  return manager;
}

async function shutdown(): Promise<void> {
  if (manager) {
    await manager.stopAll();
  }
  if (localWebServer) {
    await localWebServer.close();
    manager?.setWebDashboardUrl(null);
    localWebServer = null;
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  manager = createManager();
  await manager.load();

  try {
    localWebServer = await startBrowserDashboard();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('ChunkKeeper Web', `Local web dashboard could not start.\n\n${message}`);
    app.quit();
    return;
  }

  if (process.env.AFK_LAUNCHER_OPEN_BROWSER !== '0') {
    await shell.openExternal(localWebServer.url);
  }
});

app.on('before-quit', (event) => {
  if (isShuttingDown) return;
  event.preventDefault();
  isShuttingDown = true;
  void shutdown().finally(() => app.quit());
});
