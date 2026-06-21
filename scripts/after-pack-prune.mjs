import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const keepMacLocales = new Set(['Base.lproj', 'en.lproj', 'en_GB.lproj', 'tr.lproj']);
const keepWinLocales = new Set(['en-US.pak', 'tr.pak']);
const gzipAsync = promisify(gzip);

async function pruneDirectory(dir, shouldRemove) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!shouldRemove(entry.name, entry)) return;
      await rm(path.join(dir, entry.name), { recursive: true, force: true });
      removed += 1;
    })
  );
  return removed;
}

async function walkFiles(dir, visitor) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkFiles(entryPath, visitor);
        return;
      }
      if (entry.isFile()) {
        await visitor(entryPath, entry.name);
      }
    })
  );
}

async function compressChromiumLicenseFiles(appOutDir) {
  await walkFiles(appOutDir, async (filePath, fileName) => {
    if (fileName !== 'LICENSES.chromium.html') return;

    const compressedPath = `${filePath}.gz`;
    const readmePath = path.join(path.dirname(filePath), 'LICENSES.chromium.README.txt');
    const contents = await readFile(filePath);
    const compressed = await gzipAsync(contents, { level: 9 });

    await writeFile(compressedPath, compressed);
    await writeFile(
      readmePath,
      'Chromium license notices are stored in LICENSES.chromium.html.gz to reduce installed app size. Use gzip -d to inspect the HTML file.\n'
    );
    await rm(filePath, { force: true });
  });
}

export default async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename;

  if (context.electronPlatformName === 'darwin') {
    const appRoot = path.join(context.appOutDir, `${productFilename}.app`, 'Contents');
    const frameworkResources = path.join(
      appRoot,
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    );

    await pruneDirectory(frameworkResources, (name, entry) => entry.isDirectory() && name.endsWith('.lproj') && !keepMacLocales.has(name));
    await pruneDirectory(path.join(appRoot, 'Resources'), (name, entry) => entry.isDirectory() && name.endsWith('.lproj') && !keepMacLocales.has(name));
  }

  if (context.electronPlatformName === 'win32') {
    await pruneDirectory(path.join(context.appOutDir, 'locales'), (name, entry) => entry.isFile() && name.endsWith('.pak') && !keepWinLocales.has(name));
  }

  await compressChromiumLicenseFiles(context.appOutDir);
}
