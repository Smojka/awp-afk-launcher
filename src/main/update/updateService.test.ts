import { describe, expect, it, vi } from 'vitest';

// updateService imports `electron`, which has no implementation under vitest; stub the
// named exports it destructures at module load. The pure helpers below touch none of them.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', isPackaged: false },
  net: {},
  shell: {}
}));

import {
  compareSemver,
  findLatestMacYmlUrl,
  findMacZipSha512,
  installerFileName,
  isTranslocated,
  macBundlePathFromExe,
  parseLatestMacYml,
  pickAssetUrl,
  pickMacDmgUrl,
  resolveInstallMode,
  stripV
} from './updateService';

// A realistic macOS release: arch-matched zip (+ blockmap), dmg (+ blockmap), the Web dmg, the
// first-run helper zip, both update manifests, and the Windows setup exe.
const macAssets = [
  { name: 'ChunkKeeper-0.4.5-arm64.zip', browser_download_url: 'https://x/ChunkKeeper-0.4.5-arm64.zip' },
  { name: 'ChunkKeeper-0.4.5-arm64.zip.blockmap', browser_download_url: 'https://x/ChunkKeeper-0.4.5-arm64.zip.blockmap' },
  { name: 'ChunkKeeper-0.4.5-arm64.dmg', browser_download_url: 'https://x/ChunkKeeper-0.4.5-arm64.dmg' },
  { name: 'ChunkKeeper-0.4.5-arm64.dmg.blockmap', browser_download_url: 'https://x/ChunkKeeper-0.4.5-arm64.dmg.blockmap' },
  { name: 'ChunkKeeper-Web-0.4.5-arm64.dmg', browser_download_url: 'https://x/ChunkKeeper-Web-0.4.5-arm64.dmg' },
  { name: 'ChunkKeeper-macOS-First-Run.zip', browser_download_url: 'https://x/ChunkKeeper-macOS-First-Run.zip' },
  { name: 'latest-mac.yml', browser_download_url: 'https://x/latest-mac.yml' },
  { name: 'ChunkKeeper-Setup-0.4.5-x64.exe', browser_download_url: 'https://x/ChunkKeeper-Setup-0.4.5-x64.exe' },
  { name: 'latest.yml', browser_download_url: 'https://x/latest.yml' }
];

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

  it('prefers the arch-matched zip over the dmg on macOS', () => {
    expect(pickAssetUrl(macAssets, 'darwin', 'arm64')).toBe('https://x/ChunkKeeper-0.4.5-arm64.zip');
  });

  it('falls back to the dmg when the arch has no zip', () => {
    const noZip = macAssets.filter((asset) => !asset.name.endsWith('-arm64.zip'));
    expect(pickAssetUrl(noZip, 'darwin', 'arm64')).toBe('https://x/ChunkKeeper-0.4.5-arm64.dmg');
  });

  it('never picks the blockmap, the first-run helper, or the Web build', () => {
    const onlyExcludable = [
      { name: 'ChunkKeeper-0.4.5-arm64.zip.blockmap', browser_download_url: 'https://x/blockmap' },
      { name: 'ChunkKeeper-macOS-First-Run.zip', browser_download_url: 'https://x/first-run' },
      { name: 'ChunkKeeper-Web-0.4.5-arm64.zip', browser_download_url: 'https://x/web.zip' },
      { name: 'ChunkKeeper-Web-0.4.5-arm64.dmg', browser_download_url: 'https://x/web.dmg' }
    ];
    expect(pickAssetUrl(onlyExcludable, 'darwin', 'arm64')).toBeNull();
  });

  it('returns null when only a mismatched arch is present', () => {
    expect(pickAssetUrl(macAssets, 'darwin', 'x64')).toBeNull();
  });

  it('leaves the Windows selection unchanged', () => {
    expect(pickAssetUrl(macAssets, 'win32', 'x64')).toBe('https://x/ChunkKeeper-Setup-0.4.5-x64.exe');
  });
});

describe('pickMacDmgUrl', () => {
  it('returns the dmg even when a zip is present', () => {
    expect(pickMacDmgUrl(macAssets, 'arm64')).toBe('https://x/ChunkKeeper-0.4.5-arm64.dmg');
  });

  it('returns null when the arch has no dmg', () => {
    expect(pickMacDmgUrl(macAssets, 'x64')).toBeNull();
  });
});

describe('findLatestMacYmlUrl', () => {
  it('matches the manifest by exact name', () => {
    expect(findLatestMacYmlUrl(macAssets)).toBe('https://x/latest-mac.yml');
  });

  it('returns null when the manifest is absent', () => {
    expect(findLatestMacYmlUrl(macAssets.filter((asset) => asset.name !== 'latest-mac.yml'))).toBeNull();
  });
});

describe('resolveInstallMode', () => {
  it('always installs Windows in place', () => {
    expect(resolveInstallMode('win32', false, [])).toBe('auto');
    expect(resolveInstallMode('win32', true, macAssets, 'x64')).toBe('auto');
  });

  it('self-swaps on packaged macOS when both the zip and manifest exist', () => {
    expect(resolveInstallMode('darwin', true, macAssets, 'arm64')).toBe('auto');
  });

  it('falls back to manual when the zip or manifest is missing', () => {
    const noZip = macAssets.filter((asset) => !asset.name.endsWith('-arm64.zip'));
    const noYml = macAssets.filter((asset) => asset.name !== 'latest-mac.yml');
    expect(resolveInstallMode('darwin', true, noZip, 'arm64')).toBe('manual');
    expect(resolveInstallMode('darwin', true, noYml, 'arm64')).toBe('manual');
  });

  it('falls back to manual for an unpackaged macOS run and for Linux', () => {
    expect(resolveInstallMode('darwin', false, macAssets, 'arm64')).toBe('manual');
    expect(resolveInstallMode('linux', true, macAssets, 'arm64')).toBe('manual');
  });
});

describe('parseLatestMacYml', () => {
  const zipSha = 'ZIP0000000000000000000000000000000000000000000000000000000000000000000000000000000000==';
  const dmgSha = 'DMG1111111111111111111111111111111111111111111111111111111111111111111111111111111111==';
  const topLevelSha = 'TOP2222222222222222222222222222222222222222222222222222222222222222222222222222222222==';
  // CRLF endings, a quoted sha512, and a top-level `sha512:` that duplicates the zip's checksum
  // via the `path` file — the parser must not attribute it to the last file entry.
  const yml = [
    'version: 0.4.5',
    'files:',
    '  - url: ChunkKeeper-0.4.5-arm64.zip',
    `    sha512: "${zipSha}"`,
    '    size: 92990237',
    '    blockMapSize: 97377',
    '  - url: ChunkKeeper-0.4.5-arm64.dmg',
    `    sha512: ${dmgSha}`,
    '    size: 96010942',
    'path: ChunkKeeper-0.4.5-arm64.zip',
    `sha512: ${topLevelSha}`,
    "releaseDate: '2026-07-10T12:00:00.000Z'"
  ].join('\r\n');

  it('extracts each file entry with its base64 sha512', () => {
    const entries = parseLatestMacYml(yml);
    expect(entries).toEqual([
      { url: 'ChunkKeeper-0.4.5-arm64.zip', sha512: zipSha },
      { url: 'ChunkKeeper-0.4.5-arm64.dmg', sha512: dmgSha }
    ]);
  });

  it('does not attribute the top-level sha512 to any entry', () => {
    const entries = parseLatestMacYml(yml);
    expect(entries.some((entry) => entry.sha512 === topLevelSha)).toBe(false);
  });

  it('returns an empty list for garbage input', () => {
    expect(parseLatestMacYml('not yaml at all\njust: garbage\n:::')).toEqual([]);
    expect(parseLatestMacYml('')).toEqual([]);
  });
});

describe('findMacZipSha512', () => {
  const entries = [
    { url: 'ChunkKeeper-0.4.5-arm64.zip', sha512: 'ZIPSHA==' },
    { url: 'ChunkKeeper-0.4.5-arm64.dmg', sha512: 'DMGSHA==' }
  ];

  it('matches a browser_download_url against the manifest by basename', () => {
    expect(
      findMacZipSha512(entries, 'https://github.com/x/releases/download/v0.4.5/ChunkKeeper-0.4.5-arm64.zip')
    ).toBe('ZIPSHA==');
  });

  it('returns null when nothing matches or the URL is malformed', () => {
    expect(findMacZipSha512(entries, 'https://x/ChunkKeeper-0.4.5-arm64.pkg')).toBeNull();
    expect(findMacZipSha512(entries, 'not a url')).toBeNull();
  });
});

describe('macBundlePathFromExe', () => {
  it('resolves the .app three levels above the executable', () => {
    expect(macBundlePathFromExe('/Applications/ChunkKeeper.app/Contents/MacOS/ChunkKeeper')).toBe(
      '/Applications/ChunkKeeper.app'
    );
  });

  it('returns null when the exe is not inside a .app', () => {
    expect(macBundlePathFromExe('/usr/local/bin/node')).toBeNull();
  });

  it('refuses to run from a rotated-out .app.old backup', () => {
    expect(macBundlePathFromExe('/Applications/ChunkKeeper.app.old/Contents/MacOS/ChunkKeeper')).toBeNull();
  });
});

describe('isTranslocated', () => {
  it('flags a translocated mount and clears a normal install', () => {
    expect(isTranslocated('/private/var/folders/aa/bb/AppTranslocation/ABC123/d/ChunkKeeper.app')).toBe(true);
    expect(isTranslocated('/Applications/ChunkKeeper.app')).toBe(false);
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
