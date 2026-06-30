import { describe, expect, it, vi } from 'vitest';

// updateService imports `electron`, which has no implementation under vitest; stub the
// named exports it destructures at module load. The pure helpers below touch none of them.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', isPackaged: false },
  net: {},
  shell: {}
}));

import { compareSemver, installerFileName, pickAssetUrl, stripV } from './updateService';

describe('stripV', () => {
  it('removes a leading v and trims whitespace', () => {
    expect(stripV('v1.2.3')).toBe('1.2.3');
    expect(stripV('V0.2.1')).toBe('0.2.1');
    expect(stripV('  1.0.0 ')).toBe('1.0.0');
  });
});

describe('compareSemver', () => {
  it('detects newer versions across each segment', () => {
    expect(compareSemver('0.2.2', '0.2.1')).toBe(1);
    expect(compareSemver('0.3.0', '0.2.9')).toBe(1);
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
  });

  it('detects older and equal versions, ignoring a leading v', () => {
    expect(compareSemver('0.2.0', '0.2.1')).toBe(-1);
    expect(compareSemver('0.2.1', '0.2.1')).toBe(0);
    expect(compareSemver('v0.2.1', '0.2.1')).toBe(0);
  });

  it('ignores prerelease/build suffixes', () => {
    expect(compareSemver('0.2.1-beta.1', '0.2.1')).toBe(0);
  });
});

describe('pickAssetUrl', () => {
  const assets = [
    { name: 'ChunkKeeper-Setup-0.2.2-x64.exe', browser_download_url: 'https://x/setup.exe' },
    { name: 'ChunkKeeper-Web-Portable-0.2.2-x64.exe', browser_download_url: 'https://x/web.exe' },
    { name: 'ChunkKeeper-0.2.2-arm64.dmg', browser_download_url: 'https://x/arm64.dmg' },
    { name: 'ChunkKeeper-Web-0.2.2-arm64.dmg', browser_download_url: 'https://x/web.dmg' },
    { name: 'latest.yml', browser_download_url: 'https://x/latest.yml' }
  ];

  it('selects the native Windows installer, never the Web portable', () => {
    expect(pickAssetUrl(assets, 'win32', 'x64')).toBe('https://x/setup.exe');
  });

  it('selects the native arch-matched dmg on macOS, never the Web dmg', () => {
    expect(pickAssetUrl(assets, 'darwin', 'arm64')).toBe('https://x/arm64.dmg');
  });

  it('returns null when no asset matches the arch so the caller can use the release page', () => {
    expect(pickAssetUrl(assets, 'darwin', 'x64')).toBeNull();
  });
});

describe('installerFileName', () => {
  it('keeps the asset URL basename so the real extension is preserved', () => {
    expect(installerFileName('https://x/download/ChunkKeeper-Setup-0.3.0-x64.exe', '0.3.0')).toBe(
      'ChunkKeeper-Setup-0.3.0-x64.exe'
    );
    expect(installerFileName('https://x/download/ChunkKeeper-0.3.0-arm64.dmg', '0.3.0')).toBe(
      'ChunkKeeper-0.3.0-arm64.dmg'
    );
  });

  it('falls back to a platform-correct name when the URL has no usable filename', () => {
    expect(installerFileName('https://x/download/', '0.3.0', 'win32')).toBe('ChunkKeeper-0.3.0.exe');
    expect(installerFileName('not a url', '0.3.0', 'darwin')).toBe('ChunkKeeper-0.3.0.dmg');
  });
});
