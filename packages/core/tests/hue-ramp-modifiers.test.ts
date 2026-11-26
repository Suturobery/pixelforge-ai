import { describe, expect, it } from 'bun:test';
import {
  CommandBus,
  applyLayerModifiers,
  composeFrameRgba,
  createProject,
  generateHueShiftedRamp,
  hasActiveLayerModifiers,
  projectFromSerialized,
  rgbToHsl,
  serializeProjectV2,
  validateLayerModifiers,
  validateSerializedProjectV2,
} from '../src';

describe('Automatic Hue Shifter (generateHueShiftedRamp)', () => {
  it('generates a 5-step dark-to-bright ramp with exact base color in the middle', () => {
    const ramp = generateHueShiftedRamp({ baseHex: '#38b764', steps: 5 });
    expect(ramp).toHaveLength(5);
    expect(ramp[2]).toBe('#38b764');

    // Lightness should increase monotonically from shadow to highlight
    const lightnesses = ramp.map((hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return rgbToHsl(r, g, b)[2];
    });
    for (let i = 1; i < lightnesses.length; i++) {
      expect(lightnesses[i]!).toBeGreaterThan(lightnesses[i - 1]!);
    }

    // Shadow should shift cooler (toward blue-violet) and highlight warmer (toward yellow)
    const parseH = (hex: string) =>
      rgbToHsl(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16))[0];
    expect(parseH(ramp[0]!)).toBeGreaterThan(parseH(ramp[2]!));
    expect(parseH(ramp[4]!)).toBeLessThan(parseH(ramp[2]!));
  });

  it('supports manual signed hue shifts and returns empty array on invalid hex', () => {
    const manual = generateHueShiftedRamp({
      baseHex: '#e05050',
      steps: 3,
      autoShift: false,
      shadowHueShift: -30,
      highlightHueShift: 25,
    });
    expect(manual).toHaveLength(3);
    expect(manual[1]).toBe('#e05050');
    expect(generateHueShiftedRamp({ baseHex: 'not-a-hex' })).toEqual([]);
  });
});

describe('Non-Destructive Layer Modifiers', () => {
  it('returns the original buffer untouched (zero-copy) when no modifier is active', () => {
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    buf[(3 * 8 + 3) * 4] = 200;
    buf[(3 * 8 + 3) * 4 + 3] = 255;
    expect(applyLayerModifiers(buf, 8, 8, undefined)).toBe(buf);
    expect(applyLayerModifiers(buf, 8, 8, { outline: { enabled: false, mode: 'solid', color: '#1a1c2c' } })).toBe(buf);
    expect(hasActiveLayerModifiers(undefined)).toBe(false);
  });

  it('applies live solid 4-way and 8-way outlines without mutating the source buffer', () => {
    const w = 7;
    const h = 7;
    const src = new Uint8ClampedArray(w * h * 4);
    const center = (3 * w + 3) * 4;
    src[center] = 80;
    src[center + 1] = 200;
    src[center + 2] = 120;
    src[center + 3] = 255;

    const out4 = applyLayerModifiers(src, w, h, {
      outline: { enabled: true, mode: 'solid', color: '#1a1c2c', connectivity: 4 },
    });
    // Source remains untouched
    expect(src[(2 * w + 3) * 4 + 3]).toBe(0);
    // Cardinal neighbor gets outline, diagonal stays transparent
    expect(out4[(2 * w + 3) * 4]).toBe(0x1a);
    expect(out4[(2 * w + 3) * 4 + 3]).toBe(255);
    expect(out4[(2 * w + 2) * 4 + 3]).toBe(0);

    const out8 = applyLayerModifiers(src, w, h, {
      outline: { enabled: true, mode: 'solid', color: '#1a1c2c', connectivity: 8 },
    });
    expect(out8[(2 * w + 2) * 4 + 3]).toBe(255);
  });

  it('applies sel-out outline, drop shadow behind foreground, and live color remap', () => {
    const w = 8;
    const h = 8;
    const src = new Uint8ClampedArray(w * h * 4);
    const idx = (3 * w + 3) * 4;
    src[idx] = 220;
    src[idx + 1] = 90;
    src[idx + 2] = 80;
    src[idx + 3] = 255;

    const out = applyLayerModifiers(src, w, h, {
      colorRemap: { enabled: true, palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'], mode: 'ramp' },
      outline: { enabled: true, mode: 'sel-out', color: '#1a1c2c', connectivity: 4 },
      shadow: { enabled: true, offsetX: 2, offsetY: 2, color: '#000000', opacity: 0.5 },
    });

    // Center pixel remapped onto green GB palette
    expect(out[idx + 1]!).toBeGreaterThan(out[idx]!);
    // Cardinal outline pixel is opaque and darker than center
    const up = (2 * w + 3) * 4;
    expect(out[up + 3]).toBe(255);
    // Drop shadow landed at (3+2, 3+2) = (5,5)
    const sh = (5 * w + 5) * 4;
    expect(out[sh + 3]).toBeGreaterThan(100);
    expect(out[sh + 3]).toBeLessThan(150);
  });

  it('supports layer.setProps undo/redo, export composition, mergeDown baking, and .pixelforgeproj round-trip', async () => {
    const proj = createProject({ name: 'fx-test', width: 16, height: 16 });
    const bus = new CommandBus(proj);
    const clip = bus.getProject().clips[0]!;
    const frame = clip.frames[0]!;
    const bottomLayer = clip.layers[0]!;

    // Add a top layer and paint one pixel at (8, 8)
    bus.execute('layer.add', { clipId: clip.id, name: 'Hero' }, 'ui');
    const topLayer = bus.getProject().clips[0]!.layers[1]!;
    bus.execute(
      'pixels.applyOp',
      { clipId: clip.id, frameId: frame.id, layerId: topLayer.id, ops: [{ op: 'stamp', x: 8, y: 8, size: 1, color: [56, 183, 100, 255] }] },
      'ui',
    );

    // Attach non-destructive outline modifier
    const modifiers = {
      outline: { enabled: true, mode: 'solid' as const, color: '#112233', connectivity: 4 as const },
    };
    bus.execute('layer.setProps', { clipId: clip.id, layerId: topLayer.id, patch: { modifiers } }, 'ui');

    // Composited export includes the live outline at (8, 7) even though raw cel buffer does not
    const cur = bus.getProject();
    expect(cur.clips[0]!.frames[0]!.cels[topLayer.id]!.buffer[(7 * 16 + 8) * 4 + 3]).toBe(0);
    const composed = composeFrameRgba(cur, cur.clips[0]!, cur.clips[0]!.frames[0]!);
    expect(composed[(7 * 16 + 8) * 4]).toBe(0x11);
    expect(composed[(7 * 16 + 8) * 4 + 1]).toBe(0x22);
    expect(composed[(7 * 16 + 8) * 4 + 2]).toBe(0x33);
    expect(composed[(7 * 16 + 8) * 4 + 3]).toBe(255);

    // Full v2 serialization + schema validation + round-trip preserves modifiers
    const { projectJson, celPngs } = await serializeProjectV2(cur);
    expect(validateSerializedProjectV2(projectJson)).toEqual([]);
    const loaded = await projectFromSerialized(projectJson, (src) => celPngs.get(src));
    expect(loaded.clips[0]!.layers[1]!.modifiers).toEqual(modifiers);

    // Merge down bakes the live outline into the bottom layer
    bus.execute('layer.mergeDown', { clipId: clip.id, layerId: topLayer.id }, 'ui');
    const mergedBottom = bus.getProject().clips[0]!.frames[0]!.cels[bottomLayer.id]!.buffer;
    expect(mergedBottom[(7 * 16 + 8) * 4]).toBe(0x11);
    expect(mergedBottom[(7 * 16 + 8) * 4 + 3]).toBe(255);

    // Undo restores the top layer + live modifiers
    bus.undo();
    expect(bus.getProject().clips[0]!.layers).toHaveLength(2);
    expect(bus.getProject().clips[0]!.layers[1]!.modifiers?.outline?.enabled).toBe(true);
  });

  it('rejects malformed modifier payloads in validateLayerModifiers', () => {
    expect(validateLayerModifiers('bad')).toBeTruthy();
    expect(validateLayerModifiers({ outline: { enabled: true, mode: 'invalid', color: '#000000' } })).toBeTruthy();
    expect(validateLayerModifiers({ shadow: { enabled: true, offsetX: 99, offsetY: 1, color: '#000000', opacity: 0.5 } })).toBeTruthy();
    expect(validateLayerModifiers({ colorRemap: { enabled: true, palette: ['not-hex'] } })).toBeTruthy();
  });
});
