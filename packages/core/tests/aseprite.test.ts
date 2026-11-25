import { describe, expect, test } from 'bun:test';
import { importAseprite } from '../src/persist/aseprite';

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const copy = new Uint8Array(new ArrayBuffer(data.length));
  copy.set(data);
  void writer.write(copy).catch(() => {});
  void writer.close().catch(() => {});
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function makeChunk(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length, true);
  v.setUint16(4, type, true);
  out.set(body, 6);
  return out;
}

function makeLayerChunk(opts: {
  name: string;
  flags?: number;
  type?: number;
  blend?: number;
  opacity?: number;
}): Uint8Array {
  const nameBytes = new TextEncoder().encode(opts.name);
  const body = new Uint8Array(18 + nameBytes.length);
  const v = new DataView(body.buffer);
  v.setUint16(0, opts.flags ?? 3, true); // visible + editable
  v.setUint16(2, opts.type ?? 0, true);
  v.setUint16(10, opts.blend ?? 0, true);
  v.setUint8(12, opts.opacity ?? 255);
  v.setUint16(16, nameBytes.length, true);
  body.set(nameBytes, 18);
  return makeChunk(0x2004, body);
}

function makePaletteChunk(colors: Array<[number, number, number, number]>): Uint8Array {
  const body = new Uint8Array(20 + colors.length * 6);
  const v = new DataView(body.buffer);
  v.setUint32(0, colors.length, true);
  v.setUint32(4, 0, true);
  v.setUint32(8, colors.length - 1, true);
  let off = 20;
  for (const [r, g, b, a] of colors) {
    v.setUint16(off, 0, true);
    v.setUint8(off + 2, r);
    v.setUint8(off + 3, g);
    v.setUint8(off + 4, b);
    v.setUint8(off + 5, a);
    off += 6;
  }
  return makeChunk(0x2019, body);
}

function makeTagsChunk(tags: Array<{ name: string; from: number; to: number; dir: number }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(10);
  new DataView(head.buffer).setUint16(0, tags.length, true);
  parts.push(head);
  for (const t of tags) {
    const nb = new TextEncoder().encode(t.name);
    const entry = new Uint8Array(19 + nb.length);
    const v = new DataView(entry.buffer);
    v.setUint16(0, t.from, true);
    v.setUint16(2, t.to, true);
    v.setUint8(4, t.dir);
    v.setUint16(17, nb.length, true);
    entry.set(nb, 19);
    parts.push(entry);
  }
  return makeChunk(0x2018, concatBytes(parts));
}

async function makeCompressedCelChunk(opts: {
  layerIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: Uint8Array;
  opacity?: number;
}): Promise<Uint8Array> {
  const compressed = await deflateZlib(opts.pixels);
  const body = new Uint8Array(20 + compressed.length);
  const v = new DataView(body.buffer);
  v.setUint16(0, opts.layerIndex, true);
  v.setInt16(2, opts.x, true);
  v.setInt16(4, opts.y, true);
  v.setUint8(6, opts.opacity ?? 255);
  v.setUint16(7, 2, true); // compressed image
  v.setUint16(16, opts.w, true);
  v.setUint16(18, opts.h, true);
  body.set(compressed, 20);
  return makeChunk(0x2005, body);
}

function makeLinkedCelChunk(layerIndex: number, linkedFrame: number): Uint8Array {
  const body = new Uint8Array(18);
  const v = new DataView(body.buffer);
  v.setUint16(0, layerIndex, true);
  v.setUint8(6, 255);
  v.setUint16(7, 1, true); // linked cel
  v.setUint16(16, linkedFrame, true);
  return makeChunk(0x2005, body);
}

function makeFrame(durationMs: number, chunks: Uint8Array[]): Uint8Array {
  const body = concatBytes(chunks);
  const out = new Uint8Array(16 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length, true);
  v.setUint16(4, 0xf1fa, true);
  v.setUint16(6, chunks.length, true);
  v.setUint16(8, durationMs, true);
  v.setUint32(12, chunks.length, true);
  out.set(body, 16);
  return out;
}

function makeAsepriteFile(opts: {
  width: number;
  height: number;
  colorDepth: 8 | 16 | 32;
  frames: Uint8Array[];
  transparentIndex?: number;
}): Uint8Array {
  const body = concatBytes(opts.frames);
  const header = new Uint8Array(128);
  const v = new DataView(header.buffer);
  v.setUint32(0, 128 + body.length, true);
  v.setUint16(4, 0xa5e0, true);
  v.setUint16(6, opts.frames.length, true);
  v.setUint16(8, opts.width, true);
  v.setUint16(10, opts.height, true);
  v.setUint16(12, opts.colorDepth, true);
  v.setUint32(14, 1, true); // layer opacity valid
  v.setUint8(28, opts.transparentIndex ?? 0);
  return concatBytes([header, body]);
}

describe('Aseprite (.ase / .aseprite) importer', () => {
  test('imports 32bpp zlib multi-layer sprite with tags, linked cels, and blend modes', async () => {
    const f0Layer0 = new Uint8Array([255, 0, 0, 255]); // 1x1 red pixel at (2, 3)
    const f0Layer2 = new Uint8Array([0, 255, 128, 255]); // 1x1 teal pixel at (5, 5)

    const frame0 = makeFrame(100, [
      makePaletteChunk([
        [255, 0, 0, 255],
        [0, 255, 128, 255],
      ]),
      makeLayerChunk({ name: 'Body', flags: 3, type: 0, opacity: 255 }),
      makeLayerChunk({ name: 'FX Group', flags: 3, type: 1 }), // group layer skipped cleanly
      makeLayerChunk({ name: 'Glow', flags: 1, type: 0, blend: 2, opacity: 128 }), // locked + screen blend
      makeTagsChunk([
        { name: 'idle', from: 0, to: 1, dir: 0 },
        { name: 'jump', from: 2, to: 2, dir: 2 },
      ]),
      await makeCompressedCelChunk({ layerIndex: 0, x: 2, y: 3, w: 1, h: 1, pixels: f0Layer0 }),
      await makeCompressedCelChunk({ layerIndex: 2, x: 5, y: 5, w: 1, h: 1, pixels: f0Layer2 }),
    ]);

    const frame1 = makeFrame(200, [
      makeLinkedCelChunk(0, 0), // linked back to frame 0 Body layer
    ]);

    const frame2 = makeFrame(150, [
      await makeCompressedCelChunk({ layerIndex: 0, x: 0, y: 0, w: 1, h: 1, pixels: new Uint8Array([0, 0, 255, 255]) }),
    ]);

    const bytes = makeAsepriteFile({
      width: 16,
      height: 16,
      colorDepth: 32,
      frames: [frame0, frame1, frame2],
    });

    const res = await importAseprite(bytes, { name: 'hero-knight.aseprite' });
    expect(res.project.name).toBe('hero-knight');
    expect(res.project.width).toBe(16);
    expect(res.project.height).toBe(16);
    expect(res.project.palette).toEqual(['#ff0000', '#00ff80']);

    // Tags split into two clips
    expect(res.project.clips.length).toBe(2);
    const [idle, jump] = res.project.clips;
    expect(idle!.name).toBe('idle');
    expect(idle!.frames.length).toBe(2);
    expect(idle!.frames[0]!.durationMs).toBe(100);
    expect(idle!.frames[1]!.durationMs).toBe(200);
    expect(idle!.layers.length).toBe(2); // Body + Glow (group skipped)
    expect(idle!.layers[1]!.name).toBe('Glow');
    expect(idle!.layers[1]!.blend).toBe('screen');
    expect(idle!.layers[1]!.locked).toBe(true);

    // Verify red pixel at (2, 3) on frame 0 and linked onto frame 1
    const bodyLayerId = idle!.layers[0]!.id;
    const f0Buf = idle!.frames[0]!.cels[bodyLayerId]!.buffer;
    const idx = (3 * 16 + 2) * 4;
    expect([f0Buf[idx], f0Buf[idx + 1], f0Buf[idx + 2], f0Buf[idx + 3]]).toEqual([255, 0, 0, 255]);

    const f1Buf = idle!.frames[1]!.cels[bodyLayerId]!.buffer;
    expect([f1Buf[idx], f1Buf[idx + 1], f1Buf[idx + 2], f1Buf[idx + 3]]).toEqual([255, 0, 0, 255]);

    expect(jump!.name).toBe('jump');
    expect(jump!.loopMode).toBe('pingpong');
    expect(jump!.frames.length).toBe(1);
  });

  test('imports 8bpp indexed sprite honoring transparentIndex', async () => {
    // 2x1 cel: index 0 (transparent), index 1 (#14b8a6)
    const rawIndexed = new Uint8Array([0, 1]);
    const frame0 = makeFrame(125, [
      makePaletteChunk([
        [0, 0, 0, 255],
        [0x14, 0xb8, 0xa6, 255],
      ]),
      makeLayerChunk({ name: 'Sprite', flags: 3, type: 0 }),
      await makeCompressedCelChunk({ layerIndex: 0, x: 4, y: 4, w: 2, h: 1, pixels: rawIndexed }),
    ]);

    const bytes = makeAsepriteFile({
      width: 16,
      height: 16,
      colorDepth: 8,
      transparentIndex: 0,
      frames: [frame0],
    });

    const res = await importAseprite(bytes, { name: 'slime.ase' });
    expect(res.project.palette).toEqual(['#14b8a6']);
    const clip = res.project.clips[0]!;
    const layerId = clip.layers[0]!.id;
    const buf = clip.frames[0]!.cels[layerId]!.buffer;
    // (4, 4) = transparent index 0 -> alpha 0
    expect(buf[(4 * 16 + 4) * 4 + 3]).toBe(0);
    // (5, 4) = palette index 1 -> #14b8a6
    const p = (4 * 16 + 5) * 4;
    expect([buf[p], buf[p + 1], buf[p + 2], buf[p + 3]]).toEqual([0x14, 0xb8, 0xa6, 255]);
  });

  test('rejects invalid magic header cleanly', async () => {
    await expect(importAseprite(new Uint8Array(128))).rejects.toThrow(/Not a valid Aseprite file/i);
  });
});
