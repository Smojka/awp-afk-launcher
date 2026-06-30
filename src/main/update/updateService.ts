import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { app, net, shell } from 'electron';
import type { AppUpdater } from 'electron-updater';
import type {
  UpdateCheckResult,
  UpdateDownloadedInfo,
  UpdateInstallMode,
  UpdateProgress
} from '../../shared/types.js';

const REPO_OWNER = 'Smojka';
const REPO_NAME = 'awp-afk-launcher';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  assets: GithubAsset[];
}

/** Strip a leading `v` and surrounding whitespace from a release tag. */
export function stripV(tag: string): string {
  return tag.replace(/^v/i, '').trim();
}

function parseVersion(value: string): [number, number, number] {
  const core = stripV(value).split('-')[0].split('+')[0];
  const parts = core.split('.').map((segment) => Number.parseInt(segment, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** Returns 1 when `a` is newer than `b`, -1 when older, 0 when equal (major.minor.patch). */
export function compareSemver(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Pick the installer asset that matches this platform/arch from a release's assets.
 * Windows → the native NSIS `*Setup*.exe` (never the Web portable build).
 * macOS → the native `…-<arch>.dmg` (never the Web build); null when the arch is missing
 * so the caller can fall back to the release page.
 */
export function pickAssetUrl(
  assets: GithubAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const isWeb = (name: string) => /web/i.test(name);
  const matchers =
    platform === 'win32'
      ? [(name: string) => /setup/i.test(name) && /\.exe$/i.test(name) && !isWeb(name)]
      : [(name: string) => new RegExp(`-${arch}\\.dmg$`, 'i').test(name) && !isWeb(name)];

  for (const matches of matchers) {
    const found = assets.find((asset) => matches(asset.name));
    if (found) return found.browser_download_url;
  }
  return null;
}

function installModeFor(platform: NodeJS.Platform = process.platform): UpdateInstallMode {
  return platform === 'win32' ? 'auto' : 'manual';
}

/**
 * Filename for a manually-downloaded installer. Uses the asset URL's real basename so a
 * Windows `*Setup*.exe` is never saved with a `.dmg` extension (which would refuse to
 * launch); falls back to a platform-correct name when the URL has no usable filename.
 */
export function installerFileName(url: string, version: string, platform: NodeJS.Platform = process.platform): string {
  try {
    const base = path.basename(new URL(url).pathname);
    if (base && /\.[a-z0-9]+$/i.test(base)) return base;
  } catch {
    // Fall through to the platform-default name.
  }
  return `ChunkKeeper-${version}.${platform === 'win32' ? 'exe' : 'dmg'}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fetchLatestRelease(): Promise<GithubRelease> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: LATEST_RELEASE_URL, redirect: 'follow' });
    request.setHeader('User-Agent', `ChunkKeeper/${app.getVersion()}`);
    request.setHeader('Accept', 'application/vnd.github+json');

    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (status >= 400) {
          reject(new Error(`GitHub API responded ${status}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as GithubRelease);
        } catch {
          reject(new Error('Failed to parse GitHub release response'));
        }
      });
      response.on('error', (error: Error) => reject(error));
    });
    request.on('error', (error) => reject(error));
    request.end();
  });
}

interface UpdateServiceEventMap {
  available: UpdateCheckResult;
  progress: UpdateProgress;
  downloaded: UpdateDownloadedInfo;
  error: string;
}

export interface UpdateService {
  on<K extends keyof UpdateServiceEventMap>(event: K, listener: (payload: UpdateServiceEventMap[K]) => void): this;
  emit<K extends keyof UpdateServiceEventMap>(event: K, payload: UpdateServiceEventMap[K]): boolean;
}

/**
 * Checks GitHub Releases for a newer version on launch and drives the download.
 * Windows downloads and installs in place via electron-updater; macOS downloads the
 * `.dmg` and opens it for a manual install (ad-hoc signing rules out silent updates).
 */
export class UpdateService extends EventEmitter {
  private busy = false;
  private lastResult: UpdateCheckResult | null = null;

  async check(): Promise<UpdateCheckResult> {
    const release = await fetchLatestRelease();
    const currentVersion = app.getVersion();
    const latestVersion = stripV(release.tag_name);
    const result: UpdateCheckResult = {
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
      notes: release.body ?? '',
      htmlUrl: release.html_url,
      assetUrl: pickAssetUrl(release.assets ?? []),
      installMode: installModeFor()
    };
    this.lastResult = result;
    return result;
  }

  async download(): Promise<void> {
    const target = this.lastResult;
    if (this.busy || !target || !target.updateAvailable) return;
    this.busy = true;
    try {
      if (process.platform === 'win32' && app.isPackaged) {
        await this.runWindowsAutoUpdate(target);
      } else {
        await this.openInstaller(target);
      }
    } catch (error) {
      this.busy = false;
      this.emit('error', errorMessage(error));
    }
  }

  private async runWindowsAutoUpdate(target: UpdateCheckResult): Promise<void> {
    const electronUpdater = await import('electron-updater');
    const autoUpdater: AppUpdater =
      (electronUpdater as unknown as { autoUpdater?: AppUpdater }).autoUpdater ??
      (electronUpdater as unknown as { default: { autoUpdater: AppUpdater } }).default.autoUpdater;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.removeAllListeners();

    autoUpdater.on('download-progress', (progress) => {
      this.emit('progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      });
    });
    autoUpdater.on('update-downloaded', () => {
      this.emit('downloaded', { version: target.latestVersion, installMode: 'auto' });
      // Brief delay so the renderer can paint the "restarting" state. quitAndInstall
      // triggers app quit, which runs the before-quit handler that stops bots first.
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (error) {
          // Release the busy latch so the user can retry instead of being wedged.
          this.busy = false;
          this.emit('error', errorMessage(error));
        }
      }, 1200);
    });
    autoUpdater.on('error', (error) => {
      this.busy = false;
      this.emit('error', errorMessage(error));
    });

    await autoUpdater.checkForUpdates();
    await autoUpdater.downloadUpdate();
  }

  private async openInstaller(target: UpdateCheckResult): Promise<void> {
    if (target.assetUrl) {
      const installerPath = await this.downloadToDisk(target.assetUrl, target.latestVersion);
      this.emit('downloaded', { version: target.latestVersion, installMode: 'manual' });
      await shell.openPath(installerPath);
    } else {
      await shell.openExternal(target.htmlUrl);
      this.emit('downloaded', { version: target.latestVersion, installMode: 'manual' });
    }
    this.busy = false;
  }

  private downloadToDisk(url: string, version: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const dest = path.join(app.getPath('downloads'), installerFileName(url, version));
      const request = net.request({ url, redirect: 'follow' });
      request.setHeader('User-Agent', `ChunkKeeper/${app.getVersion()}`);

      request.on('response', (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 400) {
          response.on('data', () => undefined);
          response.on('end', () => reject(new Error(`Download failed with HTTP ${status}`)));
          return;
        }
        const header = response.headers['content-length'];
        const total = Number(Array.isArray(header) ? header[0] : header) || 0;
        const startedAt = Date.now();
        let transferred = 0;
        const fileStream = createWriteStream(dest);
        fileStream.on('error', (error) => reject(error));

        response.on('data', (chunk) => {
          transferred += chunk.length;
          fileStream.write(chunk);
          if (total > 0) {
            const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
            this.emit('progress', {
              percent: (transferred / total) * 100,
              transferred,
              total,
              bytesPerSecond: Math.round(transferred / elapsedSeconds)
            });
          }
        });
        response.on('end', () => {
          fileStream.end(() => resolve(dest));
        });
        response.on('error', (error: Error) => reject(error));
      });
      request.on('error', (error) => reject(error));
      request.end();
    });
  }
}
