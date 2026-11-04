// PixelForge AI — desktop icon build (designer-approved Grid Four mark).
// Rasterizes build/icon.svg via sharp (workspace dep) into every size
// electron-builder + Windows need, then packs them into build/icon.ico
// (PNG-compressed ICO — supported since Vista, what electron-builder reads).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'apps', 'desktop', 'build');
const SVG = path.join(BUILD, 'icon.svg');
const SIZES = [256, 128, 64, 48, 32, 16];

async function main() {
  const sharpMod = require(path.join(ROOT, 'node_modules', 'sharp'));
  const sharp = sharpMod.default ?? sharpMod;
  const pngs = new Map();
  for (const size of SIZES) {
    const buf = await sharp(SVG, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer();
    pngs.set(size, buf);
    fs.writeFileSync(path.join(BUILD, `icon-${size}.png`), buf);
  }
  fs.writeFileSync(path.join(BUILD, 'icon.png'), pngs.get(256)); // electron-builder linux/mac fallback

  // --- minimal ICO writer: ICONDIR + entries + embedded PNG blobs ----------
  const entries = SIZES.map((size) => {
    const data = pngs.get(size);
    return {
      size,
      data,
      // ICO spec: 0 = 256 for the width/height single-byte fields
      byte: size === 256 ? 0 : size,
    };
  });
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const chunks = [Buffer.alloc(headerSize)];
  chunks[0].writeUInt16LE(0, 0); // reserved
  chunks[0].writeUInt16LE(1, 2); // type: icon
  chunks[0].writeUInt16LE(entries.length, 4);
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    chunks[0].writeUInt8(e.byte, o); // width
    chunks[0].writeUInt8(e.byte, o + 1); // height
    chunks[0].writeUInt8(0, o + 2); // palette
    chunks[0].writeUInt8(0, o + 3); // reserved
    chunks[0].writeUInt16LE(1, o + 4); // planes
    chunks[0].writeUInt16LE(32, o + 6); // bpp
    chunks[0].writeUInt32LE(e.data.length, o + 8);
    chunks[0].writeUInt32LE(offset, o + 12);
    offset += e.data.length;
    chunks.push(e.data);
  });
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), Buffer.concat(chunks));

  console.log(
    'icon build OK → ' +
      SIZES.map((s) => `icon-${s}.png`).join(', ') +
      ' + icon.png + icon.ico',
  );
}

main().catch((err) => {
  console.error('icon build FAILED:', err);
  process.exit(1);
});
