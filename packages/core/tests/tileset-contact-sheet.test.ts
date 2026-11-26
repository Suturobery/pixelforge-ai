import { describe, expect, test } from 'bun:test';
import {
  composeClipsContactSheet,
  composeLevelMockup,
  createClip,
  createProject,
  extractTilesetGrid,
  measureClipContactMetrics,
  rotateTileCW,
  stampTileOntoBuffer,
  transformTileBuffer,
} from '../src/index';

function setRgba(buf: Uint8ClampedArray, w: number, x: number, y: number, r: number, g: number, b: number, a = 255) {
  const i = (y * w + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

describe('Phase 3: Tileset Slicer, Transforms & Animated Level Mockup', () => {
  test('extractTilesetGrid slices exact tile grid and counts non-empty tiles', () => {
    const buf = new Uint8ClampedArray(32 * 16 * 4);
    // Draw a pixel in tile (0,0) and tile (1,0)
    setRgba(buf, 32, 2, 3, 255, 0, 0);
    setRgba(buf, 32, 18, 4, 0, 255, 0);

    const grid = extractTilesetGrid(buf, 32, 16, 16);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(1);
    expect(grid.tiles.length).toBe(2);
    expect(grid.nonEmptyCount).toBe(2);
    expect(grid.tiles[0]!.empty).toBe(false);
    expect(grid.tiles[1]!.empty).toBe(false);

    // Check extracted coordinates
    const p0 = (3 * 16 + 2) * 4;
    expect(grid.tiles[0]!.buffer[p0]).toBe(255);
    const p1 = (4 * 16 + 2) * 4;
    expect(grid.tiles[1]!.buffer[p1 + 1]).toBe(255);
  });

  test('transformTileBuffer rotates 90/180/270 and flips cleanly with 4x90 identity', () => {
    const t = 8;
    const tile = new Uint8ClampedArray(t * t * 4);
    // Single marker at top-left (1, 0)
    setRgba(tile, t, 1, 0, 10, 200, 150);

    const r90 = transformTileBuffer(tile, t, { rotation: 90, flipH: false, flipV: false });
    // (1, 0) rotated 90 CW in 8x8 -> (7 - 0, 1) = (7, 1)
    expect(r90[(1 * t + 7) * 4 + 1]).toBe(200);

    const fh = transformTileBuffer(tile, t, { rotation: 0, flipH: true, flipV: false });
    // (1, 0) flipped H in 8x8 -> (6, 0)
    expect(fh[(0 * t + 6) * 4 + 1]).toBe(200);

    let cur: Uint8ClampedArray = tile;
    const rot = rotateTileCW(0);
    expect(rot).toBe(90);
    for (let i = 0; i < 4; i++) {
      cur = transformTileBuffer(cur, t, { rotation: 90 });
    }
    expect(Array.from(cur)).toEqual(Array.from(tile));
  });

  test('stampTileOntoBuffer supports replace and alpha-over modes', () => {
    const dest = new Uint8ClampedArray(16 * 16 * 4);
    setRgba(dest, 16, 0, 0, 255, 255, 255);

    const tile = new Uint8ClampedArray(8 * 8 * 4);
    setRgba(tile, 8, 1, 1, 50, 100, 200);

    // Over mode preserves (0, 0) where tile is transparent
    stampTileOntoBuffer(dest, 16, 16, tile, 8, 0, 0, { mode: 'over' });
    expect(dest[0]).toBe(255);
    expect(dest[(1 * 16 + 1) * 4 + 2]).toBe(200);

    // Replace mode clears (0, 0) where tile is transparent
    stampTileOntoBuffer(dest, 16, 16, tile, 8, 0, 0, { mode: 'replace' });
    expect(dest[3]).toBe(0);
    expect(dest[(1 * 16 + 1) * 4 + 2]).toBe(200);
  });

  test('composeLevelMockup animates multi-frame tiles cleanly across frameIndex', () => {
    const f0 = new Uint8ClampedArray(16 * 16 * 4);
    const f1 = new Uint8ClampedArray(16 * 16 * 4);
    setRgba(f0, 16, 0, 0, 20, 120, 240); // water frame 0
    setRgba(f1, 16, 0, 0, 120, 220, 255); // water frame 1

    const cells = [{ tileIndex: 0 }, { tileIndex: 0, flipH: true }];
    const out0 = composeLevelMockup({
      tilesetFrames: [f0, f1],
      srcW: 16,
      srcH: 16,
      tileSize: 8,
      mapCols: 2,
      mapRows: 1,
      cells,
      frameIndex: 0,
    });
    const out1 = composeLevelMockup({
      tilesetFrames: [f0, f1],
      srcW: 16,
      srcH: 16,
      tileSize: 8,
      mapCols: 2,
      mapRows: 1,
      cells,
      frameIndex: 1,
    });

    expect(out0.width).toBe(16);
    expect(out0.height).toBe(8);
    // Cell 0 (0,0) has frame 0 blue; Cell 1 flipped H puts (0,0) at (15,0)
    expect(out0.buffer[0]).toBe(20);
    expect(out0.buffer[15 * 4]).toBe(20);
    // Frame 1 swaps in lighter animated water color!
    expect(out1.buffer[0]).toBe(120);
    expect(out1.buffer[15 * 4]).toBe(120);
  });
});

describe('Phase 3: Clips Contact Sheet compositor & metrics', () => {
  test('composeClipsContactSheet renders all clips side-by-side with proportion and palette metrics', () => {
    const project = createProject({
      name: 'hero-set',
      width: 16,
      height: 16,
      palette: ['#141013', '#41a6f6', '#ffcd75'],
    });
    const clip2 = createClip({ name: 'walk', width: 16, height: 16, fps: 10 });
    project.clips.push(clip2);

    // Clip 0: 10px tall sprite standing 2px from bottom, strictly in-palette
    const c0Buf = project.clips[0]!.frames[0]!.cels[project.clips[0]!.layers[0]!.id]!.buffer;
    for (let y = 4; y <= 13; y++) {
      setRgba(c0Buf, 16, 8, y, 0x41, 0xa6, 0xf6);
    }

    // Clip 1: 8px tall sprite with 1 out-of-palette pixel
    const c1Buf = clip2.frames[0]!.cels[clip2.layers[0]!.id]!.buffer;
    for (let y = 6; y <= 13; y++) {
      setRgba(c1Buf, 16, 8, y, 0xff, 0x00, 0x55);
    }

    const m0 = measureClipContactMetrics(project, project.clips[0]!, 0);
    expect(m0.metrics.spriteHeight).toBe(10);
    expect(m0.metrics.bottomMargin).toBe(2);
    expect(m0.metrics.outOfPaletteColors).toBe(0);

    const sheet = composeClipsContactSheet(project, { scale: 2, columns: 2, showGroundLine: true, showBounds: true });
    expect(sheet.clips.length).toBe(2);
    expect(sheet.scale).toBe(2);
    expect(sheet.columns).toBe(2);
    expect(sheet.rows).toBe(1);
    expect(sheet.referenceHeight).toBe(10);
    expect(sheet.referenceBottomMargin).toBe(2);
    expect(sheet.clips[1]!.outOfPaletteColors).toBe(1);
    expect(sheet.buffer.length).toBe(sheet.width * sheet.height * 4);
  });
});
