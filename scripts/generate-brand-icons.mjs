import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const buildDir = path.join(root, 'build');
const publicDir = path.join(root, 'public');
const iconsetDir = path.join(buildDir, 'icon.iconset');

const palette = {
  clear: [0, 0, 0, 0],
  obsidian: [6, 8, 16, 255],
  deepslate: [13, 17, 23, 255],
  deepslate2: [20, 27, 36, 255],
  border: [139, 92, 246, 255],
  borderDim: [46, 28, 86, 255],
  amethyst: [167, 139, 250, 255],
  amethystMid: [139, 92, 246, 255],
  amethystDark: [79, 70, 229, 255],
  soil: [116, 73, 42, 255],
  soilDark: [64, 38, 24, 255],
  glowstone: [251, 191, 36, 255],
  redstone: [244, 63, 94, 255],
  water: [56, 189, 248, 255],
  shadow: [0, 0, 0, 85]
};

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND')
  ]);
}

function setPixel(buffer, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const index = (y * width + x) * 4;
  buffer[index] = color[0];
  buffer[index + 1] = color[1];
  buffer[index + 2] = color[2];
  buffer[index + 3] = color[3];
}

function rect(buffer, width, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) setPixel(buffer, width, xx, yy, color);
  }
}

function roundedRect(buffer, width, x, y, w, h, radius, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const left = xx - x;
      const right = x + w - 1 - xx;
      const top = yy - y;
      const bottom = y + h - 1 - yy;
      const nearX = Math.min(left, right);
      const nearY = Math.min(top, bottom);
      if (nearX >= radius || nearY >= radius || nearX + nearY >= radius) setPixel(buffer, width, xx, yy, color);
    }
  }
}

function logicalIcon() {
  const size = 64;
  const buffer = Buffer.alloc(size * size * 4);
  rect(buffer, size, 0, 0, size, size, palette.clear);
  roundedRect(buffer, size, 2, 2, 60, 60, 8, palette.obsidian);
  roundedRect(buffer, size, 5, 5, 54, 54, 6, palette.deepslate);
  rect(buffer, size, 7, 7, 50, 2, palette.borderDim);
  rect(buffer, size, 7, 55, 50, 2, palette.borderDim);
  rect(buffer, size, 7, 9, 2, 46, palette.borderDim);
  rect(buffer, size, 55, 9, 2, 46, palette.borderDim);

  for (let y = 8; y < 56; y += 8) {
    for (let x = 8; x < 56; x += 8) {
      if ((x + y) % 16 === 0) rect(buffer, size, x, y, 4, 4, palette.deepslate2);
    }
  }

  rect(buffer, size, 17, 18, 34, 35, palette.shadow);
  rect(buffer, size, 14, 14, 36, 12, palette.amethystDark);
  rect(buffer, size, 16, 12, 32, 12, palette.amethystMid);
  rect(buffer, size, 18, 14, 5, 3, palette.amethyst);
  rect(buffer, size, 31, 13, 7, 3, [196, 181, 253, 255]);
  rect(buffer, size, 43, 16, 4, 3, palette.amethyst);

  rect(buffer, size, 16, 24, 32, 24, palette.soil);
  rect(buffer, size, 16, 24, 3, 24, palette.soilDark);
  rect(buffer, size, 45, 24, 3, 24, palette.soilDark);
  rect(buffer, size, 21, 30, 4, 3, [146, 91, 51, 255]);
  rect(buffer, size, 37, 28, 5, 3, [82, 48, 29, 255]);
  rect(buffer, size, 27, 41, 5, 3, [146, 91, 51, 255]);

  rect(buffer, size, 20, 40, 24, 4, palette.redstone);
  rect(buffer, size, 27, 40, 10, 4, palette.glowstone);
  rect(buffer, size, 18, 50, 28, 3, palette.water);

  rect(buffer, size, 28, 27, 5, 17, palette.glowstone);
  rect(buffer, size, 33, 30, 5, 4, palette.glowstone);
  rect(buffer, size, 37, 27, 4, 4, palette.glowstone);
  rect(buffer, size, 33, 38, 5, 4, palette.glowstone);
  rect(buffer, size, 38, 42, 4, 4, palette.glowstone);

  return buffer;
}

function scaleNearest(source, sourceSize, targetSize) {
  const out = Buffer.alloc(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const sx = Math.floor((x / targetSize) * sourceSize);
      const sy = Math.floor((y / targetSize) * sourceSize);
      const src = (sy * sourceSize + sx) * 4;
      const dst = (y * targetSize + x) * 4;
      source.copy(out, dst, src, src + 4);
    }
  }
  return out;
}

function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = frame.size === 256 ? 0 : frame.size;
    entry[1] = frame.size === 256 ? 0 : frame.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += frame.png.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.png)]);
}

function svgMarkup() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges">
  <rect x="2" y="2" width="60" height="60" rx="8" fill="#060810"/>
  <rect x="5" y="5" width="54" height="54" rx="6" fill="#0d1117"/>
  <path d="M7 8h50M7 56h50M8 7v50M56 7v50" stroke="#2e1c56" stroke-width="2"/>
  <rect x="14" y="14" width="36" height="12" fill="#4f46e5"/>
  <rect x="16" y="12" width="32" height="12" fill="#8b5cf6"/>
  <rect x="16" y="24" width="32" height="24" fill="#74492a"/>
  <rect x="16" y="24" width="3" height="24" fill="#402618"/>
  <rect x="45" y="24" width="3" height="24" fill="#402618"/>
  <rect x="20" y="40" width="24" height="4" fill="#f43f5e"/>
  <rect x="27" y="40" width="10" height="4" fill="#fbbf24"/>
  <rect x="18" y="50" width="28" height="3" fill="#38bdf8"/>
  <rect x="28" y="27" width="5" height="17" fill="#fbbf24"/>
  <rect x="33" y="30" width="5" height="4" fill="#fbbf24"/>
  <rect x="37" y="27" width="4" height="4" fill="#fbbf24"/>
  <rect x="33" y="38" width="5" height="4" fill="#fbbf24"/>
  <rect x="38" y="42" width="4" height="4" fill="#fbbf24"/>
</svg>
`;
}

await mkdir(buildDir, { recursive: true });
await mkdir(publicDir, { recursive: true });
await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });

const source = logicalIcon();
const pngForSize = (size) => writePng(size, size, scaleNearest(source, 64, size));

const iconsetFiles = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];

for (const [name, size] of iconsetFiles) {
  await writeFile(path.join(iconsetDir, name), pngForSize(size));
}

const icoFrames = [16, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngForSize(size) }));
await writeFile(path.join(buildDir, 'icon.ico'), ico(icoFrames));
await writeFile(path.join(buildDir, 'icon.png'), pngForSize(1024));
await writeFile(path.join(buildDir, 'icon.svg'), svgMarkup());
await writeFile(path.join(publicDir, 'favicon.svg'), svgMarkup());

execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], { stdio: 'inherit' });
