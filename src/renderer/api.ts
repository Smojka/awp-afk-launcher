import type { LauncherApi } from '../shared/types';

export function getLauncherApi(): LauncherApi {
  if (!window.afkLauncher) {
    throw new Error('Launcher bridge is unavailable. Start the Electron app instead of the raw renderer.');
  }
  return window.afkLauncher;
}
