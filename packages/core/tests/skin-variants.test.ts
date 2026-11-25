import { describe, expect, test } from 'bun:test';
import {
  buildSkinVariantPlan,
  getSkinPreset,
  listSkinPresets,
} from '../src/pixels/skin-variants';
import type { Clip } from '../src/types/document';

function makeTestClip(): Clip {
  const buf = new Uint8ClampedArray(16 * 16 * 4);
  // 3 shading pixels: dark blue, mid blue, light blue
  const setPx = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * 16 + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  };
  setPx(2, 2, 16, 24, 60);
  setPx(3, 2, 48, 96, 180);
  setPx(4, 2, 180, 220, 255);

  return {
    id: 'cl_hero',
    name: 'hero',
    fps: 10,
    loop: true,
    loopMode: 'forward',
    layers: [{ id: 'ly_1', name: 'Body', visible: true, opacity: 1, linked: false }],
    parts: [],
    frames: [
      { id: 'fr_1', durationMs: 100, cels: { ly_1: { buffer: buf, linked: false } } },
      { id: 'fr_2', durationMs: 150, cels: { ly_1: { buffer: new Uint8ClampedArray(buf), linked: false } } },
    ],
    tags: [],
  };
}

describe('Sprite Skin / Palette Variants', () => {
  test('exposes curated presets and case-insensitive lookup', () => {
    const presets = listSkinPresets();
    expect(presets.length).toBeGreaterThanOrEqual(8);
    expect(getSkinPreset('FIRE')?.id).toBe('fire');
    expect(getSkinPreset('gb')?.id).toBe('gameboy');
    expect(getSkinPreset('unknown-preset')).toBeUndefined();
  });

  test('builds remapped skin variant plan without mutating source clip', () => {
    const source = makeTestClip();
    const origPixel = Array.from(source.frames[0]!.cels['ly_1']!.buffer.slice((2 * 16 + 3) * 4, (2 * 16 + 3) * 4 + 4));

    const fire = getSkinPreset('fire')!;
    const plan = buildSkinVariantPlan(source, {
      name: 'hero_fire',
      palette: fire.palette,
      mode: 'ramp',
    });

    expect(plan.name).toBe('hero_fire');
    expect(plan.fps).toBe(10);
    expect(plan.frameDurations).toEqual([100, 150]);
    expect(plan.cels.length).toBe(2);
    expect(plan.totalRemappedPixels).toBeGreaterThan(0);

    // Source clip pixels must remain completely untouched
    const afterPixel = Array.from(source.frames[0]!.cels['ly_1']!.buffer.slice((2 * 16 + 3) * 4, (2 * 16 + 3) * 4 + 4));
    expect(afterPixel).toEqual(origPixel);

    // Output pixel should now be warmer (R > B) in Fire palette
    const outBuf = plan.cels[0]!.buffer;
    const midIdx = (2 * 16 + 3) * 4;
    expect(outBuf[midIdx]!).toBeGreaterThan(outBuf[midIdx + 2]!);
  });
});
