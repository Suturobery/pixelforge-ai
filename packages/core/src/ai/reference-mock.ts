/**
 * PixelForge AI — deterministic reference test provider (NO network).
 *
 * Stands in for a real image provider in automated tests: it "generates" a
 * candidate by deterministically mutating the approved reference (palette
 * recolor + mirror, seeded by the brief), pasted onto an off-palette solid
 * background — deliberately imperfect input so the candidate pipeline's
 * background removal, palette mapping, and resize are actually exercised.
 *
 * Same brief + same reference + same palette ⇒ byte-identical PNG.
 * Pure TypeScript; encodePng is the only I/O (in-memory bytes).
 */

import { encodePng } from '../persist/png';
import { snapToPaletteHex } from './reference-mock-util';

/** FNV-1a — stable across runtimes, no locale/clock dependence. */
export function hashBrief(brief: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < brief.length; i++) {
    h ^= brief.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build the mock candidate PNG. The reference is recolored by rotating each
 * distinct color's palette index (per-hash offset), mirrored when hash bit 3
 * is set, then pasted centered on a solid off-palette backdrop sized to the
 * reference (or 2× when the target is smaller, so the resize path runs too).
 */
export async function renderMockReferenceCandidate(
  reference: { buffer: Uint8ClampedArray; width: number; height: number },
  palette: string[],
  brief: string,
): Promise<Uint8Array> {
  if (palette.length < 2) throw new Error('reference mock: palette needs at least 2 colors');
  const hash = hashBrief(brief);
  const w = reference.width;
  const h = reference.height;
  const out = new Uint8ClampedArray(w * h * 4);

  // distinct opaque reference colors → palette rotation offset
  const colorIndex = new Map<string, number>();
  const rotate = hash % palette.length;
  const mirrorX = (hash & 0b1000) !== 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + (mirrorX ? w - 1 - x : x)) * 4;
      const d = (y * w + x) * 4;
      if (reference.buffer[s + 3] < 128) continue; // keep transparent
      const hex =
        '#'.concat(
          reference.buffer[s].toString(16).padStart(2, '0'),
          reference.buffer[s + 1].toString(16).padStart(2, '0'),
          reference.buffer[s + 2].toString(16).padStart(2, '0'),
        );
      let idx = colorIndex.get(hex);
      if (idx === undefined) {
        const nearest = snapToPaletteHex(hex, palette);
        idx = palette.findIndex((c) => c.toLowerCase() === nearest.toLowerCase());
        if (idx < 0) idx = 0;
        colorIndex.set(hex, idx);
      }
      const rotated = snapToPaletteHex(palette[(idx + rotate) % palette.length], palette);
      out[d] = parseInt(rotated.slice(1, 3), 16);
      out[d + 1] = parseInt(rotated.slice(3, 5), 16);
      out[d + 2] = parseInt(rotated.slice(5, 7), 16);
      out[d + 3] = 255;
    }
  }

  // paste onto an off-palette backdrop (exercises bg removal + resize)
  const backdropScale = 2;
  const bw = w * backdropScale;
  const bh = h * backdropScale;
  const canvas = new Uint8ClampedArray(bw * bh * 4);
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = 0xbc;
    canvas[i + 1] = 0xde;
    canvas[i + 2] = 0xf0; // #bcdef0 — deliberately not in typical palettes
    canvas[i + 3] = 255;
  }
  const ox = Math.floor((bw - w) / 2);
  const oy = Math.floor((bh - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((oy + y) * bw + ox + x) * 4;
      canvas[d] = out[s];
      canvas[d + 1] = out[s + 1];
      canvas[d + 2] = out[s + 2];
      canvas[d + 3] = out[s + 3];
    }
  }
  return encodePng(bw, bh, canvas);
}
