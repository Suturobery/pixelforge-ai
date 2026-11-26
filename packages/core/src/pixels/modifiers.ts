/**
 * PixelForge AI — Non-Destructive Layer Modifiers (pure deterministic render pass).
 *
 * Applies live visual effects on top of a cel's raw RGBA buffer WITHOUT mutating
 * the stored pixels:
 *   1. Live Color / Skin Remap (OKLab lightness-ramp or nearest match)
 *   2. Live 1px Outline (Solid color or automatic hue-shifted Sel-Out)
 *   3. Live Drop Shadow (crisp pixel offset underneath the silhouette)
 *
 * Used identically by CanvasStage (`drawCelBuffer`), Core Exports (`composeFrameRgba`),
 * Auto-Eyes visual checks, and `layer.mergeDown` so what you see is 100% what exports.
 */

import type { LayerModifiers } from '../types/document';
import { collectUniqueOpaqueColors, remapBufferToPalette } from './craft';
import { computeSelOutColor } from './hue-ramp';

const HEX6_RE = /^#[0-9a-f]{6}$/i;

function parseHexRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const clean = hex.trim();
  if (!HEX6_RE.test(clean)) return fallback;
  return [
    parseInt(clean.slice(1, 3), 16),
    parseInt(clean.slice(3, 5), 16),
    parseInt(clean.slice(5, 7), 16),
  ];
}

export function hasActiveLayerModifiers(modifiers?: LayerModifiers): boolean {
  if (!modifiers) return false;
  return Boolean(
    modifiers.outline?.enabled ||
      modifiers.shadow?.enabled ||
      (modifiers.colorRemap?.enabled && modifiers.colorRemap.palette.length > 0),
  );
}

export function cloneLayerModifiers(modifiers?: LayerModifiers): LayerModifiers | undefined {
  if (!modifiers) return undefined;
  const out: LayerModifiers = {};
  if (modifiers.outline) out.outline = { ...modifiers.outline };
  if (modifiers.shadow) out.shadow = { ...modifiers.shadow };
  if (modifiers.colorRemap) {
    out.colorRemap = {
      ...modifiers.colorRemap,
      palette: [...modifiers.colorRemap.palette],
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate a LayerModifiers payload (returns error string or null if valid). */
export function validateLayerModifiers(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'modifiers must be an object';
  }
  const m = value as Record<string, unknown>;
  if (m.outline !== undefined) {
    if (typeof m.outline !== 'object' || m.outline === null || Array.isArray(m.outline)) {
      return 'modifiers.outline must be an object';
    }
    const o = m.outline as Record<string, unknown>;
    if (typeof o.enabled !== 'boolean') return 'modifiers.outline.enabled must be boolean';
    if (o.mode !== 'solid' && o.mode !== 'sel-out') return 'modifiers.outline.mode must be "solid" or "sel-out"';
    if (typeof o.color !== 'string' || !HEX6_RE.test(o.color)) return 'modifiers.outline.color must be #rrggbb';
    if (o.connectivity !== undefined && o.connectivity !== 4 && o.connectivity !== 8) {
      return 'modifiers.outline.connectivity must be 4 or 8';
    }
  }
  if (m.shadow !== undefined) {
    if (typeof m.shadow !== 'object' || m.shadow === null || Array.isArray(m.shadow)) {
      return 'modifiers.shadow must be an object';
    }
    const s = m.shadow as Record<string, unknown>;
    if (typeof s.enabled !== 'boolean') return 'modifiers.shadow.enabled must be boolean';
    if (typeof s.offsetX !== 'number' || !Number.isInteger(s.offsetX) || s.offsetX < -8 || s.offsetX > 8) {
      return 'modifiers.shadow.offsetX must be integer in [-8, 8]';
    }
    if (typeof s.offsetY !== 'number' || !Number.isInteger(s.offsetY) || s.offsetY < -8 || s.offsetY > 8) {
      return 'modifiers.shadow.offsetY must be integer in [-8, 8]';
    }
    if (typeof s.color !== 'string' || !HEX6_RE.test(s.color)) return 'modifiers.shadow.color must be #rrggbb';
    if (typeof s.opacity !== 'number' || !Number.isFinite(s.opacity) || s.opacity < 0.05 || s.opacity > 1) {
      return 'modifiers.shadow.opacity must be in [0.05, 1]';
    }
  }
  if (m.colorRemap !== undefined) {
    if (typeof m.colorRemap !== 'object' || m.colorRemap === null || Array.isArray(m.colorRemap)) {
      return 'modifiers.colorRemap must be an object';
    }
    const c = m.colorRemap as Record<string, unknown>;
    if (typeof c.enabled !== 'boolean') return 'modifiers.colorRemap.enabled must be boolean';
    if (!Array.isArray(c.palette) || c.palette.length > 64) {
      return 'modifiers.colorRemap.palette must be an array of up to 64 #rrggbb colors';
    }
    for (const hex of c.palette) {
      if (typeof hex !== 'string' || !HEX6_RE.test(hex)) {
        return 'modifiers.colorRemap.palette entries must be #rrggbb';
      }
    }
    if (c.presetId !== undefined && (typeof c.presetId !== 'string' || c.presetId.length > 64)) {
      return 'modifiers.colorRemap.presetId must be a string <= 64 chars';
    }
    if (c.mode !== undefined && c.mode !== 'ramp' && c.mode !== 'nearest') {
      return 'modifiers.colorRemap.mode must be "ramp" or "nearest"';
    }
  }
  return null;
}

const DIRS_4: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const DIRS_8: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * Pure non-destructive modifier pass. Returns `src` untouched (zero copy) when
 * no modifier is active; otherwise returns a fresh composited RGBA buffer.
 */
export function applyLayerModifiers(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  modifiers?: LayerModifiers,
): Uint8ClampedArray {
  if (!hasActiveLayerModifiers(modifiers) || w <= 0 || h <= 0 || src.length !== w * h * 4) {
    return src;
  }

  let buf = new Uint8ClampedArray(src);

  // 1. Live Color / Skin Remap
  const remap = modifiers?.colorRemap;
  if (remap?.enabled && remap.palette.length > 0) {
    const sourceColors = collectUniqueOpaqueColors([buf]);
    if (sourceColors.length > 0) {
      remapBufferToPalette(buf, remap.palette, {
        mode: remap.mode ?? 'ramp',
        sourceColors,
      });
    }
  }

  // 2. Live 1px Outline / Sel-Out
  const outline = modifiers?.outline;
  if (outline?.enabled) {
    const next = new Uint8ClampedArray(buf);
    const dirs = outline.connectivity === 8 ? DIRS_8 : DIRS_4;
    const solidRgb = parseHexRgb(outline.color, [26, 28, 44]);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if ((buf[idx + 3] ?? 0) > 0) continue;

        let foundR = 0;
        let foundG = 0;
        let foundB = 0;
        let found = false;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = (ny * w + nx) * 4;
          if ((buf[ni + 3] ?? 0) > 0) {
            foundR = buf[ni]!;
            foundG = buf[ni + 1]!;
            foundB = buf[ni + 2]!;
            found = true;
            break;
          }
        }
        if (!found) continue;

        const [or, og, ob] =
          outline.mode === 'sel-out' ? computeSelOutColor(foundR, foundG, foundB) : solidRgb;
        next[idx] = or;
        next[idx + 1] = og;
        next[idx + 2] = ob;
        next[idx + 3] = 255;
      }
    }
    buf = next;
  }

  // 3. Live Drop Shadow (projected behind the current silhouette + outline)
  const shadow = modifiers?.shadow;
  if (shadow?.enabled && (shadow.offsetX !== 0 || shadow.offsetY !== 0)) {
    const next = new Uint8ClampedArray(buf);
    const [sr, sg, sb] = parseHexRgb(shadow.color, [9, 9, 11]);
    const sa = Math.max(1, Math.min(255, Math.round(shadow.opacity * 255)));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        if ((buf[si + 3] ?? 0) === 0) continue;
        const tx = x + shadow.offsetX;
        const ty = y + shadow.offsetY;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const ti = (ty * w + tx) * 4;
        if ((buf[ti + 3] ?? 0) > 0) continue; // shadow sits strictly behind foreground pixels
        next[ti] = sr;
        next[ti + 1] = sg;
        next[ti + 2] = sb;
        next[ti + 3] = sa;
      }
    }
    buf = next;
  }

  return buf;
}
