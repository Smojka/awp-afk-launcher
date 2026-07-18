import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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
// Subdirectory under the OS temp dir where the macOS self-swap downloads and unpacks the update.
const MAC_UPDATE_DIR = 'chunkkeeper-update';

const execFileP = promisify(execFile);

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

/** One `files:` entry from a `latest-mac.yml` manifest: the asset filename and its base64 sha512. */
export interface MacYmlEntry {
  url: string;
  sha512: string;
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
 * macOS → the native `…-<arch>.zip` self-swap package first, then the `…-<arch>.dmg` (never the
 * Web build); the `.zip$` anchor keeps `.zip.blockmap` and the first-run helper zip out. Null
 * when the arch is missing so the caller can fall back to the release page.
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
      : [
          (name: string) => new RegExp(`-${arch}\\.zip$`, 'i').test(name) && !isWeb(name),
          (name: string) => new RegExp(`-${arch}\\.dmg$`, 'i').test(name) && !isWeb(name)
        ];

  for (const matches of matchers) {
    const found = assets.find((asset) => matches(asset.name));
    if (found) return found.browser_download_url;
  }
  return null;
}

/**
 * Pick the arch-matched native `.dmg` from a release's assets (never the Web build). Used for the
 * manual-install fallback so `openInstaller` opens a mountable DMG rather than the self-swap zip
 * (`pickAssetUrl` may now hand back a `.zip`). Null when the arch's DMG is missing.
 */
export function pickMacDmgUrl(assets: GithubAsset[], arch: string = process.arch): string | null {
  const found = assets.find(
    (asset) => new RegExp(`-${arch}\\.dmg$`, 'i').test(asset.name) && !/web/i.test(asset.name)
  );
  return found?.browser_download_url ?? null;
}

/** Find the `latest-mac.yml` update manifest asset URL, or null when the release omits it. */
export function findLatestMacYmlUrl(assets: GithubAsset[]): string | null {
  const found = assets.find((asset) => asset.name === 'latest-mac.yml');
  return found?.browser_download_url ?? null;
}

/**
 * Decide how an available update installs for this platform/build. Windows always installs in
 * place ('auto'). macOS self-swaps ('auto') only from a packaged build that has both the update
 * zip and its `latest-mac.yml` manifest in the release; everything else (dev run, missing assets,
 * Linux) uses the manual DMG flow ('manual'). The value on `check()` is a prediction — the
 * `downloaded` event carries the real outcome ('auto' = swap succeeded, 'manual' = DMG fallback).
 */
export function resolveInstallMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  assets: GithubAsset[],
  arch: string = process.arch
): UpdateInstallMode {
  if (platform === 'win32') return 'auto';
  if (platform === 'darwin' && isPackaged) {
    const zipMatcher = new RegExp(`-${arch}\\.zip$`, 'i');
    const hasZip = assets.some((asset) => zipMatcher.test(asset.name) && !/web/i.test(asset.name));
    const hasYml = assets.some((asset) => asset.name === 'latest-mac.yml');
    if (hasZip && hasYml) return 'auto';
  }
  return 'manual';
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse the `files:` list out of an electron-builder `latest-mac.yml` without a YAML dependency.
 * Returns each entry's asset filename and base64 sha512. A column-0 key ends the list, which is
 * what keeps the top-level `sha512:` (the checksum of the `path` file, one entry's duplicate)
 * from being mis-attributed to the last file entry. CRLF endings and quoted values are tolerated;
 * entries missing a url or sha512 are dropped, so garbage input yields `[]`.
 */
export function parseLatestMacYml(text: string): MacYmlEntry[] {
  const entries: MacYmlEntry[] = [];
  let inFiles = false;
  let current: MacYmlEntry | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    // A key at column 0 leaves any `files:` list; only `files:` itself (re)enters it.
    if (indent === 0) {
      current = null;
      inFiles = /^files\s*:/.test(body);
      continue;
    }
    if (!inFiles) continue;

    const listMatch = body.match(/^-\s+url\s*:\s*(.+)$/);
    if (listMatch) {
      current = { url: unquoteYaml(listMatch[1]), sha512: '' };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const shaMatch = body.match(/^sha512\s*:\s*(.+)$/);
    if (shaMatch) current.sha512 = unquoteYaml(shaMatch[1]);
  }

  return entries.filter((entry) => entry.url !== '' && entry.sha512 !== '');
}

/** Look up the base64 sha512 for an asset URL by matching its basename against the yml entries. */
export function findMacZipSha512(entries: MacYmlEntry[], assetUrl: string): string | null {
  let basename: string;
  try {
    basename = path.basename(new URL(assetUrl).pathname);
  } catch {
    basename = path.basename(assetUrl);
  }
  if (!basename) return null;
  const match = entries.find((entry) => path.basename(entry.url) === basename);
  return match?.sha512 ?? null;
}

/**
 * Resolve the running `.app` bundle from the executable path (`…/Foo.app/Contents/MacOS/Foo`).
 * Returns null when the exe isn't three levels inside a `.app` — including a `.app.old` backup —
 * so the self-swap never runs against a non-bundle or a bundle we already rotated out.
 */
export function macBundlePathFromExe(exePath: string): string | null {
  const bundle = path.dirname(path.dirname(path.dirname(exePath)));
  return bundle.endsWith('.app') ? bundle : null;
}

/** True when the bundle runs from a randomized read-only App Translocation mount (can't self-swap). */
export function isTranslocated(bundlePath: string): boolean {
  return bundlePath.includes('/AppTranslocation/');
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

// Fetch a text resource (the update manifest). redirect:'follow' is required because GitHub
// asset URLs 302 to a signed CDN location.
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    request.setHeader('User-Agent', `ChunkKeeper/${app.getVersion()}`);

    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (status >= 400) {
          reject(new Error(`Request for ${url} responded ${status}`));
          return;
        }
        resolve(body);
      });
      response.on('error', (error: Error) => reject(error));
    });
    request.on('error', (error) => reject(error));
    request.end();
  });
}

// Base64 sha512 of a file, streamed so large update zips never load whole into memory. The
// electron-builder manifest stores the checksum base64-encoded, not hex.
function sha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('error', (error) => reject(error));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * Swap `newApp` into `bundlePath`, keeping the previous bundle as `${bundlePath}.old` for
 * rollback. Same-volume renames are atomic; when the extracted bundle sits on another volume the
 * rename fails EXDEV and we copy with `ditto` instead. Any copy failure restores the backup and
 * rethrows so the caller can fall back to the manual flow.
 */
async function swapBundles(bundlePath: string, newApp: string): Promise<void> {
  const backupPath = `${bundlePath}.old`;
  await rm(backupPath, { recursive: true, force: true });
  await rename(bundlePath, backupPath);
  try {
    await rename(newApp, bundlePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      try {
        await execFileP('/usr/bin/ditto', [newApp, bundlePath]);
      } catch (copyError) {
        await rm(bundlePath, { recursive: true, force: true });
        await rename(backupPath, bundlePath);
        throw copyError;
      }
    } else {
      await rename(backupPath, bundlePath);
      throw error;
    }
  }
}

/**
 * Best-effort removal of leftovers from a prior macOS self-swap: the `${bundle}.old` rollback
 * backup and the temp extraction workdir. A no-op off a packaged macOS build; never throws, so a
 * cleanup failure can't block startup.
 */
export async function cleanupMacUpdateLeftovers(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    const bundlePath = macBundlePathFromExe(app.getPath('exe'));
    if (bundlePath) await rm(`${bundlePath}.old`, { recursive: true, force: true });
    await rm(path.join(app.getPath('temp'), MAC_UPDATE_DIR), { recursive: true, force: true });
  } catch (error) {
    console.warn('[update] cleanup of self-swap leftovers failed:', errorMessage(error));
  }
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
 * Checks GitHub Releases for a newer version on launch and every few hours, and drives the
 * download. Windows downloads and installs silently in place via electron-updater and relaunches.
 * macOS downloads the update zip, verifies its sha512, and swaps the running `.app` bundle in
 * place before relaunching; any failure falls back to downloading the `.dmg` for a manual install
 * (ad-hoc signing rules out a Squirrel.Mac-style silent update).
 */
export class UpdateService extends EventEmitter {
  private busy = false;
  private lastResult: UpdateCheckResult | null = null;
  private lastAssets: GithubAsset[] = [];
  private lastNotifiedVersion: string | null = null;

  async check(): Promise<UpdateCheckResult> {
    const release = await fetchLatestRelease();
    this.lastAssets = release.assets ?? [];
    const currentVersion = app.getVersion();
    const latestVersion = stripV(release.tag_name);
    const result: UpdateCheckResult = {
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
      notes: release.body ?? '',
      htmlUrl: release.html_url,
      assetUrl: pickAssetUrl(this.lastAssets),
      installMode: resolveInstallMode(process.platform, app.isPackaged, this.lastAssets)
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Poll for a newer version without downloading. Emits 'available' at most once per version so
   * periodic checks never re-spam the banner, and stays quiet while a download is in flight.
   * Failures are logged only — a background check must never surface an error or block a launch.
   */
  async checkInBackground(): Promise<void> {
    if (this.busy) return;
    try {
      const result = await this.check();
      if (!result.updateAvailable || this.lastNotifiedVersion === result.latestVersion) return;
      this.lastNotifiedVersion = result.latestVersion;
      this.emit('available', result);
    } catch (error) {
      console.warn('[update] background check failed:', errorMessage(error));
    }
  }

  async download(): Promise<void> {
    const target = this.lastResult;
    if (this.busy || !target || !target.updateAvailable) return;
    this.busy = true;
    try {
      if (process.platform === 'win32' && app.isPackaged) {
        await this.runWindowsAutoUpdate(target);
      } else if (process.platform === 'darwin' && app.isPackaged) {
        await this.runMacSelfSwap(target);
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
      // Brief delay so the renderer can paint the "restarting" state. quitAndInstall installs
      // silently (NSIS `/S`, into the existing directory) and relaunches, which runs the
      // before-quit handler that stops bots first.
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(true, true);
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

  /**
   * macOS in-place update: verify the running bundle is swappable, download and sha512-verify the
   * update zip, extract with `ditto`, gate on `codesign`, then swap the bundle and relaunch. Every
   * failure falls back to the manual DMG flow exactly once and must not emit 'error' here — the
   * fallback's own outcome (including a throw, which lands in `download()`'s catch) drives the UI.
   */
  private async runMacSelfSwap(target: UpdateCheckResult): Promise<void> {
    try {
      // --- Guards, all before any download so a doomed swap costs nothing. ---
      const bundlePath = macBundlePathFromExe(app.getPath('exe'));
      if (!bundlePath) throw new Error('Could not resolve the running .app bundle');
      if (isTranslocated(bundlePath)) throw new Error('App is translocated; cannot swap in place');
      await access(path.dirname(bundlePath), fsConstants.W_OK);

      const zipUrl = pickAssetUrl(this.lastAssets, 'darwin', process.arch);
      const ymlUrl = findLatestMacYmlUrl(this.lastAssets);
      const zipMatcher = new RegExp(`-${process.arch}\\.zip$`, 'i');
      if (!zipUrl || !zipMatcher.test(zipUrl) || !ymlUrl) {
        throw new Error('Release is missing the macOS update zip or its manifest');
      }

      // --- Fetch the manifest, then download the zip into a clean temp workdir. ---
      const expectedSha512 = findMacZipSha512(parseLatestMacYml(await fetchText(ymlUrl)), zipUrl);
      if (!expectedSha512) throw new Error('latest-mac.yml has no sha512 for the update zip');

      const workDir = path.join(app.getPath('temp'), MAC_UPDATE_DIR);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });

      const zipPath = await this.downloadToDisk(zipUrl, target.latestVersion, workDir);
      if ((await sha512Base64(zipPath)) !== expectedSha512) {
        throw new Error('Downloaded update zip failed its sha512 check');
      }

      // --- Extract with ditto (keeps symlinks + the ad-hoc signature), then find the sole .app. ---
      const extractDir = path.join(workDir, 'extract');
      await mkdir(extractDir, { recursive: true });
      await execFileP('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

      const appName = (await readdir(extractDir)).find((entry) => entry.endsWith('.app'));
      if (!appName) throw new Error('Update zip contained no .app bundle');
      const newApp = path.join(extractDir, appName);

      // A freshly downloaded bundle may carry a quarantine xattr that would re-trigger Gatekeeper;
      // stripping it is best-effort (errors are swallowed — an un-quarantined bundle no-ops here).
      await execFileP('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => undefined);
      // Refuse to install a bundle whose signature doesn't verify (corrupt/truncated download).
      await execFileP('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);

      await swapBundles(bundlePath, newApp);

      this.emit('downloaded', { version: target.latestVersion, installMode: 'auto' });
      // Brief delay so the renderer can paint the "restarting" state. relaunch()+quit() run the
      // before-quit handler (guarded by shutdownStarted) that stops bots first.
      setTimeout(() => {
        try {
          app.relaunch();
          app.quit();
        } catch (error) {
          this.busy = false;
          this.emit('error', errorMessage(error));
        }
      }, 1200);
    } catch (error) {
      // Any failure falls back to the manual DMG flow exactly once. Do NOT emit 'error' here:
      // openInstaller drives its own success/failure and its throw lands in download()'s catch,
      // which releases the busy latch so Retry works.
      console.warn('[update] macOS self-swap failed, falling back to DMG:', errorMessage(error));
      await this.openInstaller(target);
    }
  }

  private async openInstaller(target: UpdateCheckResult): Promise<void> {
    // On macOS the picked asset may be the self-swap zip, which Finder can't open — resolve the
    // arch-matched DMG instead. Other platforms keep the asset chosen at check time.
    const assetUrl =
      process.platform === 'darwin' ? pickMacDmgUrl(this.lastAssets, process.arch) : target.assetUrl;
    if (assetUrl) {
      const installerPath = await this.downloadToDisk(assetUrl, target.latestVersion);
      this.emit('downloaded', { version: target.latestVersion, installMode: 'manual' });
      await shell.openPath(installerPath);
    } else {
      await shell.openExternal(target.htmlUrl);
      this.emit('downloaded', { version: target.latestVersion, installMode: 'manual' });
    }
    this.busy = false;
  }

  private downloadToDisk(url: string, version: string, destDir: string = app.getPath('downloads')): Promise<string> {
    return new Promise((resolve, reject) => {
      const dest = path.join(destDir, installerFileName(url, version));
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
