import { describe, expect, test } from 'bun:test';
import {
  analyzePixelCraft,
  applyShadeBrush,
  applyShadeLine,
  collectUniqueOpaqueColors,
  computeCenterShift,
  computeTrimBounds,
  createProject,
  CommandBus,
  drawDitherGradientPixels,
  drawPolygonPixels,
  magicWandBounds,
  polishLayerPixelArt,
  remapBufferToPalette,
  renderInspectionRgba,
  replaceColorInBuffer,
  shadePixelStep,
  sortPaletteColors,
  stampBrushWrapped,
  getPixel,
  type RGBA,
} from '../src/index';

const SWEETIE16 = [
  '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070',
  '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
  '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
];

function setPx(buf: Uint8ClampedArray, w: number, x: number, y: number, rgba: RGBA): void {
  const i = (y * w + x) * 4;
  buf[i] = rgba[0];
  buf[i + 1] = rgba[1];
  buf[i + 2] = rgba[2];
  buf[i + 3] = rgba[3];
}

function hexOf(rgba: RGBA): string {
  return `#${rgba[0].toString(16).padStart(2, '0')}${rgba[1].toString(16).padStart(2, '0')}${rgba[2].toString(16).padStart(2, '0')}`;
}

describe('Pro Pixel Craft utilities', () => {
  test('drawPolygonPixels fills a triangle and supports mirrorX + undo via CommandBus', () => {
    const project = createProject({ name: 'poly', width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0]!;
    const frame = clip.frames[0]!;
    const layer = clip.layers[0]!;

    bus.execute('pixels.applyOp', {
      clipId: clip.id,
      frameId: frame.id,
      layerId: layer.id,
      color: [56, 183, 100, 255],
      ops: [
        {
          op: 'polygon',
          points: [
            { x: 4, y: 2 },
            { x: 11, y: 12 },
            { x: 2, y: 12 },
          ],
          filled: true,
        },
      ],
    });

    const cel = bus.getProject().clips[0]!.frames[0]!.cels[layer.id]!;
    // Interior point (5, 9) must be filled; exterior point (14, 2) stays transparent
    expect(getPixel(cel.buffer, 16, 5, 9)).toEqual([56, 183, 100, 255]);
    expect(getPixel(cel.buffer, 16, 14, 2)[3]).toBe(0);

    // Undo restores transparent cel cleanly
    bus.undo();
    const afterUndo = bus.getProject().clips[0]!.frames[0]!.cels[layer.id];
    expect(afterUndo ? getPixel(afterUndo.buffer, 16, 5, 9)[3] : 0).toBe(0);
  });

  test('renderInspectionRgba upscales 8x with crisp pixel grid & checkerboard', () => {
    const src = new Uint8ClampedArray(16 * 16 * 4);
    setPx(src, 16, 4, 4, [56, 183, 100, 255]);
    const res = renderInspectionRgba(src, 16, 16, 8, true);
    expect(res.w).toBe(128);
    expect(res.h).toBe(128);
    // Center of upscaled (4, 4) pixel at (36, 36) keeps exact source green
    expect(getPixel(res.rgba, res.w, 36, 36)).toEqual([56, 183, 100, 255]);
    // Transparent cell (0, 0) gets opaque dark checkerboard when showGrid=true
    expect(getPixel(res.rgba, res.w, 4, 4)[3]).toBe(255);
  });

  test('analyzePixelCraft detects outline doubles, orphan speckles, and pillow shading', () => {
    const w = 16;
    const h = 16;
    const buf = new Uint8ClampedArray(w * h * 4);
    // Draw an 8x8 square (x=4..11, y=4..11) with a thick L-corner dark outline & flat interior
    const dark: RGBA = [26, 28, 44, 255];
    const mid: RGBA = [56, 183, 100, 255];
    for (let y = 4; y <= 11; y++) {
      for (let x = 4; x <= 11; x++) {
        const isEdge = x === 4 || x === 11 || y === 4 || y === 11;
        setPx(buf, w, x, y, isEdge ? dark : mid);
      }
    }
    // Add an isolated 1px orphan speckle at (1, 1)
    setPx(buf, w, 1, 1, mid);

    const report = analyzePixelCraft({ buffer: buf, width: w, height: h, lighting: 'top-left' });
    expect(report.metrics.doublesCount).toBe(4); // all 4 outer corners are L-doubles
    expect(report.metrics.orphansCount).toBe(1);
    expect(report.defects.some((d) => d.kind === 'doubles')).toBe(true);
    expect(report.defects.some((d) => d.kind === 'orphans')).toBe(true);
    expect(report.defects.some((d) => d.kind === 'pillow_shading')).toBe(true);
    expect(report.score).toBeLessThan(80);
  });

  test('polishLayerPixelArt applies palette-locked OKLab sel-out, shading, highlight, and cleans doubles', () => {
    const w = 16;
    const h = 16;
    const buf = new Uint8ClampedArray(w * h * 4);
    const emerald: RGBA = [56, 183, 100, 255]; // #38b764
    const crimson: RGBA = [177, 62, 83, 255];  // #b13e53
    // Top half crimson, bottom half emerald (x=5..10, y=4..11)
    for (let y = 4; y <= 11; y++) {
      for (let x = 5; x <= 10; x++) {
        setPx(buf, w, x, y, y < 8 ? crimson : emerald);
      }
    }

    const changed = polishLayerPixelArt(buf, w, h, {
      palette: SWEETIE16,
      selOut: true,
      shade: true,
      highlight: true,
      cleanDoubles: true,
    });
    expect(changed).toBe(true);

    // Every opaque pixel MUST belong strictly to SWEETIE16 (100% palette-locked)
    const allowed = new Set(SWEETIE16.map((c) => c.toLowerCase()));
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3]! === 0) continue;
      expect(buf[i + 3]).toBe(255);
      expect(allowed.has(hexOf([buf[i]!, buf[i + 1]!, buf[i + 2]!, 255]))).toBe(true);
    }

    // Crimson top-edge sel-out (x=7, y=3) should pick deep plum #5d275d (hue-shifted!) rather than flat black
    expect(hexOf(getPixel(buf, w, 7, 3))).toBe('#5d275d');
    // Emerald lit top-left interior pixel vs emerald shaded bottom-right interior pixel:
    // bottom-right (10, 11) should be darker teal #257179
    expect(hexOf(getPixel(buf, w, 10, 11))).toBe('#257179');

    // Craft linter should report 0 outline doubles after cleanDoubles
    const craft = analyzePixelCraft({ buffer: buf, width: w, height: h, lighting: 'top-left' });
    expect(craft.metrics.doublesCount).toBe(0);
  });

  test('drawPolygonPixels handles outline-only mode without filling interior', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    drawPolygonPixels(
      buf,
      16,
      16,
      [
        { x: 3, y: 3 },
        { x: 12, y: 3 },
        { x: 12, y: 12 },
        { x: 3, y: 12 },
      ],
      [255, 255, 255, 255],
      false,
    );
    expect(getPixel(buf, 16, 3, 3)[3]).toBe(255);
    expect(getPixel(buf, 16, 7, 7)[3]).toBe(0);
  });

  test('shadePixelStep & applyShadeBrush stay palette-locked, respect visited guard, and wrap seamlessly', () => {
    const emerald: RGBA = [56, 183, 100, 255]; // #38b764
    const darker = shadePixelStep(emerald, SWEETIE16, 'darken');
    const lighter = shadePixelStep(emerald, SWEETIE16, 'lighten');
    expect(darker).not.toBeNull();
    expect(lighter).not.toBeNull();
    expect(hexOf(darker!)).toBe('#257179'); // hue-shifted teal shadow
    expect(hexOf(lighter!)).toBe('#a7f070'); // warm lime highlight
    expect(shadePixelStep([0, 0, 0, 0], SWEETIE16, 'darken')).toBeNull();

    // Dragging over the same pixel with a shared `visited` set only steps 1 shade
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    setPx(buf, 8, 0, 0, emerald);
    setPx(buf, 8, 7, 0, emerald);
    const visited = new Set<number>();
    const changed1 = applyShadeBrush(buf, 8, 8, 0, 0, 3, SWEETIE16, 'darken', { wrap: true, visited });
    expect(changed1).toBe(true);
    // Both (0,0) and wrapped neighbor (7,0) stepped once to #257179
    expect(hexOf(getPixel(buf, 8, 0, 0))).toBe('#257179');
    expect(hexOf(getPixel(buf, 8, 7, 0))).toBe('#257179');
    // Second pass in the same stroke must be a no-op because of visited
    const changed2 = applyShadeLine(buf, 8, 8, 0, 0, 7, 0, 1, SWEETIE16, 'darken', { wrap: true, visited });
    expect(changed2).toBe(false);
    expect(hexOf(getPixel(buf, 8, 0, 0))).toBe('#257179');
    // Transparent pixels stay transparent
    expect(getPixel(buf, 8, 3, 3)[3]).toBe(0);
  });

  test('stampBrushWrapped wraps multi-pixel brushes across canvas borders', () => {
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    const red: RGBA = [177, 62, 83, 255];
    stampBrushWrapped(buf, 8, 8, 0, 0, 3, red, false, false, 'square');
    // 3x3 centered at (0,0) covers x in {-1,0,1} -> {7,0,1} and y in {-1,0,1} -> {7,0,1}
    expect(getPixel(buf, 8, 7, 7)).toEqual(red);
    expect(getPixel(buf, 8, 0, 7)).toEqual(red);
    expect(getPixel(buf, 8, 7, 0)).toEqual(red);
    expect(getPixel(buf, 8, 1, 1)).toEqual(red);
    expect(getPixel(buf, 8, 4, 4)[3]).toBe(0);
  });

  test('computeCenterShift returns exact integer centering delta for single or multi-layer buffers', () => {
    const empty = new Uint8ClampedArray(16 * 16 * 4);
    expect(computeCenterShift(empty, 16, 16)).toBeNull();

    const bufA = new Uint8ClampedArray(16 * 16 * 4);
    // 4x4 block at x=1..4, y=2..5 -> center target is x=6..9, y=6..9 => dx=+5, dy=+4
    for (let y = 2; y <= 5; y++) {
      for (let x = 1; x <= 4; x++) setPx(bufA, 16, x, y, [255, 255, 255, 255]);
    }
    const single = computeCenterShift(bufA, 16, 16);
    expect(single).toEqual({ dx: 5, dy: 4, bbox: { x: 1, y: 2, w: 4, h: 4 } });

    // Multi-layer combined bbox: second layer extends to x=6, y=7 -> bbox 1..6 (w=6), 2..7 (h=6)
    // Target x=(16-6)/2=5 -> dx=+4; target y=(16-6)/2=5 -> dy=+3
    const bufB = new Uint8ClampedArray(16 * 16 * 4);
    setPx(bufB, 16, 6, 7, [255, 0, 0, 255]);
    const combined = computeCenterShift([bufA, bufB], 16, 16);
    expect(combined).toEqual({ dx: 4, dy: 3, bbox: { x: 1, y: 2, w: 6, h: 6 } });
  });

  test('sortPaletteColors orders by OKLab lightness and hue cleanly', () => {
    const byL = sortPaletteColors(['#f4f4f4', '#1a1c2c', '#38b764'], 'lightness');
    expect(byL[0]).toBe('#1a1c2c');
    expect(byL[2]).toBe('#f4f4f4');

    const byHue = sortPaletteColors(['#38b764', '#f4f4f4', '#b13e53', '#1a1c2c'], 'hue');
    // Achromatic neutrals come first (dark -> light)
    expect(byHue[0]).toBe('#1a1c2c');
    expect(byHue[1]).toBe('#f4f4f4');
    expect(byHue.length).toBe(4);
  });

  test('remapBufferToPalette preserves luminance ramp contrast and respects palette lock', () => {
    const GAMEBOY = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'];
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    // Dark outline, mid crimson, bright gold
    setPx(buf, 8, 1, 1, [26, 28, 44, 255]);    // #1a1c2c (dark)
    setPx(buf, 8, 2, 1, [177, 62, 83, 255]);   // #b13e53 (mid)
    setPx(buf, 8, 3, 1, [255, 205, 117, 255]); // #ffcd75 (bright)

    const sourceColors = collectUniqueOpaqueColors([buf]);
    const changed = remapBufferToPalette(buf, GAMEBOY, { mode: 'ramp', sourceColors });
    expect(changed).toBe(3);
    // Dark -> darkest GB green, bright -> lightest GB green, mid -> distinct mid GB green
    expect(hexOf(getPixel(buf, 8, 1, 1))).toBe('#0f380f');
    expect(hexOf(getPixel(buf, 8, 3, 1))).toBe('#9bbc0f');
    expect(GAMEBOY.includes(hexOf(getPixel(buf, 8, 2, 1)))).toBe(true);
    expect(hexOf(getPixel(buf, 8, 2, 1))).not.toBe('#0f380f');
    expect(hexOf(getPixel(buf, 8, 2, 1))).not.toBe('#9bbc0f');
    // Transparent stays transparent
    expect(getPixel(buf, 8, 0, 0)[3]).toBe(0);
  });

  test('replaceColorInBuffer replaces exact RGBA pixels and returns count', () => {
    const buf = new Uint8ClampedArray(4 * 4 * 4);
    setPx(buf, 4, 0, 0, [10, 20, 30, 255]);
    setPx(buf, 4, 1, 1, [10, 20, 30, 255]);
    setPx(buf, 4, 2, 2, [40, 50, 60, 255]);
    const count = replaceColorInBuffer(buf, [10, 20, 30, 255], [200, 100, 50, 255]);
    expect(count).toBe(2);
    expect(getPixel(buf, 4, 0, 0)).toEqual([200, 100, 50, 255]);
    expect(getPixel(buf, 4, 2, 2)).toEqual([40, 50, 60, 255]);
  });

  test('computeTrimBounds trims empty margins with padding and respects CANVAS_MIN', () => {
    const buf = new Uint8ClampedArray(64 * 64 * 4);
    // 20x18 sprite at x=12..31, y=20..37
    for (let y = 20; y <= 37; y++) {
      for (let x = 12; x <= 31; x++) setPx(buf, 64, x, y, [255, 255, 255, 255]);
    }
    const trim = computeTrimBounds([buf], 64, 64, 2);
    expect(trim).toEqual({
      bbox: { x: 12, y: 20, w: 20, h: 18 },
      width: 24,
      height: 22,
      dx: -10,
      dy: -18,
    });
    // Tiny 4x4 sprite clamps up to CANVAS_MIN (16x16) centered
    const tiny = new Uint8ClampedArray(32 * 32 * 4);
    setPx(tiny, 32, 20, 20, [255, 255, 255, 255]);
    setPx(tiny, 32, 23, 23, [255, 255, 255, 255]);
    const tinyTrim = computeTrimBounds([tiny], 32, 32, 0);
    expect(tinyTrim).toEqual({
      bbox: { x: 20, y: 20, w: 4, h: 4 },
      width: 16,
      height: 16,
      dx: -14,
      dy: -14,
    });
  });

  test('magicWandBounds flood-selects contiguous color island and respects 4-way vs 8-way', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    const blue: RGBA = [65, 166, 246, 255];
    const green: RGBA = [56, 183, 100, 255];
    setPx(buf, 16, 4, 4, blue);
    setPx(buf, 16, 5, 4, blue);
    setPx(buf, 16, 6, 5, blue); // diagonal neighbor only
    setPx(buf, 16, 5, 5, green);

    expect(magicWandBounds(buf, 16, 16, 4, 4)).toEqual({ x: 4, y: 4, w: 2, h: 1, pixelCount: 2 });
    expect(magicWandBounds(buf, 16, 16, 4, 4, { diagonal: true })).toEqual({ x: 4, y: 4, w: 3, h: 2, pixelCount: 3 });
  });

  test('drawDitherGradientPixels renders Bayer 4x4 transition clipped to selection', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    const from: RGBA = [255, 205, 117, 255];
    const to: RGBA = [26, 28, 44, 255];
    const changed = drawDitherGradientPixels(buf, 16, 16, 2, 2, 10, 2, from, to, {
      clipRect: { x: 2, y: 2, w: 9, h: 4 },
    });
    expect(changed).toBe(true);
    // Start edge uses fromColor, end edge uses toColor, outside clipRect stays transparent
    expect(getPixel(buf, 16, 2, 2)).toEqual(from);
    expect(getPixel(buf, 16, 10, 2)).toEqual(to);
    expect(getPixel(buf, 16, 0, 0)[3]).toBe(0);
    // Midpoint region contains a mix of both colors (true ordered dither)
    let sawFrom = false;
    let sawTo = false;
    for (let y = 2; y <= 5; y++) {
      for (let x = 5; x <= 7; x++) {
        const px = getPixel(buf, 16, x, y);
        if (px[0] === from[0]) sawFrom = true;
        if (px[0] === to[0]) sawTo = true;
      }
    }
    expect(sawFrom && sawTo).toBe(true);
  });
});
