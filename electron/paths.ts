import { app } from 'electron';
import path from 'node:path';

const SHARED_USER_DATA_DIR_NAME = 'afk-launcher';

export function launcherUserDataDir(): string {
  return process.env.AFK_LAUNCHER_USER_DATA_DIR || path.join(app.getPath('appData'), SHARED_USER_DATA_DIR_NAME);
}
