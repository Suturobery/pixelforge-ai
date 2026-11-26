/**
 * PixelForge AI — Clips Contact Sheet compositor & multi-clip proportion/color
 * auditor (Phase 3, DOM-free).
 *
 * Renders all clips in a project side-by-side onto a crisp nearest-neighbor
 * contact sheet RGBA buffer with optional shared ground-line guide, trimmed
 * bounds metrics, and palette compliance checks for instant human + MCP review.
 */

import { composeFrameRgba, upscaleRgbaNearest } from './export';
import { analyzePixelCraft, collectUniqueOpaqueColors, computeTrimBounds } from '../pixels/craft';
import type { Clip, Project } from '../types/document';

export interface ContactSheetClipMetrics {
  clipId: string;
  clipName: string;
  frameIndex: number;
  frameCount: number;
  fps: number;
  bounds: { x: number; y: number; w: number; h: number } | null;
  spriteWidth: number;
  spriteHeight: number;
  bottomMargin: number;
  uniqueColors: number;
  topColors: string[];
  outOfPaletteColors: number;
  craftScore: number;
}

export interface ContactSheetOptions {
  /** Nearest-neighbor integer scale per clip cell (1..8, default auto-fitted to ~96px) */
  scale?: number;
  /** Number of columns in the grid (default auto up to 4) */
  columns?: number;
  /** Draw a subtle teal dashed baseline guide at the reference ground line (default true) */
  showGroundLine?: boolean;
  /** Draw subtle bounds rectangle around each sprite (default false) */
  showBounds?: boolean;
  /** Frame index per clip (default 0; or pass a map clipId -> frameIndex for synced animation) */
  frameByClip?: Record<string, number>;
  /** Background theme for exported sheet ('dark' | 'checker' | 'light', default 'dark') */
  background?: 'dark' | 'checker' | 'light';
}

export interface ComposedContactSheet {
  width: number;
  height: number;
  scale: number;
  columns: number;
  rows: number;
  buffer: Uint8ClampedArray;
  clips: ContactSheetClipMetrics[];
  referenceBottomMargin: number | null;
  referenceHeight: number | null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Measure proportion, ground line, palette compliance, and craft metrics for a single clip frame. */
export function measureClipContactMetrics(
  project: Project,
  clip: Clip,
  frameIndex = 0,
): { metrics: ContactSheetClipMetrics; buffer: Uint8ClampedArray } {
  const safeIdx = Math.max(0, Math.min(Math.max(0, clip.frames.length - 1), Math.floor(frameIndex)));
  const frame = clip.frames[safeIdx];
  const w = project.width;
  const h = project.height;
  const buffer = frame ? composeFrameRgba(project, clip, frame) : new Uint8ClampedArray(w * h * 4);
  const trim = computeTrimBounds([buffer], w, h, 0);
  const colors = collectUniqueOpaqueColors([buffer]);
  const allowed = new Set(project.palette.map((c) => c.toLowerCase()));
  let outOfPalette = 0;
  const topColors: string[] = [];
  for (const [r, g, b] of colors) {
    const hex = rgbToHex(r, g, b);
    if (topColors.length < 10) topColors.push(hex);
    if (allowed.size > 0 && !allowed.has(hex)) outOfPalette++;
  }
  const craft = analyzePixelCraft({
    buffer,
    width: w,
    height: h,
    lighting: project.settings.styleProfile?.lighting ?? 'top-left',
  });
  const bounds = trim ? { x: trim.bbox.x, y: trim.bbox.y, w: trim.bbox.w, h: trim.bbox.h } : null;
  const bottomMargin = bounds ? Math.max(0, h - (bounds.y + bounds.h)) : h;

  return {
    buffer,
    metrics: {
      clipId: clip.id,
      clipName: clip.name,
      frameIndex: safeIdx,
      frameCount: clip.frames.length,
      fps: clip.fps,
      bounds,
      spriteWidth: bounds?.w ?? 0,
      spriteHeight: bounds?.h ?? 0,
      bottomMargin,
      uniqueColors: colors.length,
      topColors,
      outOfPaletteColors: outOfPalette,
      craftScore: craft.score,
    },
  };
}

/**
 * Compose all clips of a project side-by-side into a crisp nearest-neighbor
 * RGBA contact sheet buffer, along with per-clip metrics for comparison.
 */
export function composeClipsContactSheet(
  project: Project,
  opts: ContactSheetOptions = {},
): ComposedContactSheet {
  const clips = project.clips;
  const w = project.width;
  const h = project.height;
  const autoScale = Math.max(1, Math.min(6, Math.floor(128 / Math.max(w, h)) || 1));
  const scale = Math.max(1, Math.min(8, Math.round(opts.scale ?? autoScale)));
  const columns = Math.max(1, Math.min(8, Math.round(opts.columns ?? Math.min(4, Math.max(1, clips.length)))));
  const rows = Math.max(1, Math.ceil(Math.max(1, clips.length) / columns));
  const showGroundLine = opts.showGroundLine !== false;
  const showBounds = Boolean(opts.showBounds);
  const bg = opts.background ?? 'dark';

  const cellInnerW = w * scale;
  const cellInnerH = h * scale;
  const pad = 12;
  const gap = 12;
  const outerPad = 16;
  const cellW = cellInnerW + pad * 2;
  const cellH = cellInnerH + pad * 2;

  const outW = outerPad * 2 + columns * cellW + (columns - 1) * gap;
  const outH = outerPad * 2 + rows * cellH + (rows - 1) * gap;
  const out = new Uint8ClampedArray(outW * outH * 4);

  const fillRect = (x0: number, y0: number, rw: number, rh: number, r: number, g: number, b: number, a = 255) => {
    const xEnd = Math.min(outW, x0 + rw);
    const yEnd = Math.min(outH, y0 + rh);
    for (let y = Math.max(0, y0); y < yEnd; y++) {
      for (let x = Math.max(0, x0); x < xEnd; x++) {
        const i = (y * outW + x) * 4;
        if (a === 255) {
          out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
        } else {
          const t = a / 255;
          out[i] = Math.round(r * t + out[i]! * (1 - t));
          out[i + 1] = Math.round(g * t + out[i + 1]! * (1 - t));
          out[i + 2] = Math.round(b * t + out[i + 2]! * (1 - t));
          out[i + 3] = 255;
        }
      }
    }
  };

  // Sheet backdrop
  if (bg === 'light') fillRect(0, 0, outW, outH, 228, 228, 232);
  else fillRect(0, 0, outW, outH, 11, 11, 14);

  const measured = clips.map((clip) => {
    const idx = opts.frameByClip?.[clip.id] ?? 0;
    return measureClipContactMetrics(project, clip, idx);
  });

  // Determine reference ground line & height (pinned Hero Style Anchor > first non-empty clip)
  const anchor = project.settings.styleProfile?.anchor ?? null;
  const firstNonEmpty = measured.find((m) => m.metrics.bounds !== null)?.metrics ?? null;
  const referenceBottomMargin = anchor ? anchor.bottomMargin : firstNonEmpty?.bottomMargin ?? null;
  const referenceHeight = anchor ? anchor.spriteHeight : firstNonEmpty?.spriteHeight ?? null;

  measured.forEach((entry, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const cx = outerPad + col * (cellW + gap);
    const cy = outerPad + row * (cellH + gap);

    // Card surface
    if (bg === 'checker') {
      const tile = 8;
      for (let y = 0; y < cellH; y++) {
        for (let x = 0; x < cellW; x++) {
          const dark = (((x / tile) | 0) + ((y / tile) | 0)) % 2 === 0;
          const v = dark ? 24 : 32;
          const di = ((cy + y) * outW + (cx + x)) * 4;
          out[di] = v; out[di + 1] = v; out[di + 2] = v + 4; out[di + 3] = 255;
        }
      }
    } else if (bg === 'light') {
      fillRect(cx, cy, cellW, cellH, 244, 244, 246);
    } else {
      fillRect(cx, cy, cellW, cellH, 20, 20, 25);
    }

    // Card border (highlight first/anchor clip in teal, subtle zinc for others)
    const isRef = idx === 0;
    const br = isRef ? 45 : bg === 'light' ? 190 : 50;
    const bgc = isRef ? 212 : bg === 'light' ? 190 : 50;
    const bb = isRef ? 191 : bg === 'light' ? 200 : 60;
    fillRect(cx, cy, cellW, 1, br, bgc, bb);
    fillRect(cx, cy + cellH - 1, cellW, 1, br, bgc, bb);
    fillRect(cx, cy, 1, cellH, br, bgc, bb);
    fillRect(cx + cellW - 1, cy, 1, cellH, br, bgc, bb);

    const sx0 = cx + pad;
    const sy0 = cy + pad;

    // Optional reference ground-line dashed rule
    if (showGroundLine && referenceBottomMargin !== null) {
      const groundY = sy0 + (h - referenceBottomMargin) * scale;
      if (groundY >= cy + 1 && groundY < cy + cellH - 1) {
        for (let x = cx + 2; x < cx + cellW - 2; x++) {
          if (((x - cx) & 7) < 4) {
            fillRect(x, groundY, 1, 1, 45, 212, 191, 170);
          }
        }
      }
    }

    // Blit nearest-neighbor scaled clip frame
    const up = scale === 1 ? entry.buffer : upscaleRgbaNearest(entry.buffer, w, h, scale);
    for (let y = 0; y < cellInnerH; y++) {
      for (let x = 0; x < cellInnerW; x++) {
        const si = (y * cellInnerW + x) * 4;
        const sa = up[si + 3]! / 255;
        if (sa <= 0) continue;
        const di = ((sy0 + y) * outW + (sx0 + x)) * 4;
        out[di] = Math.round(up[si]! * sa + out[di]! * (1 - sa));
        out[di + 1] = Math.round(up[si + 1]! * sa + out[di + 1]! * (1 - sa));
        out[di + 2] = Math.round(up[si + 2]! * sa + out[di + 2]! * (1 - sa));
        out[di + 3] = 255;
      }
    }

    // Optional trimmed bounds outline
    if (showBounds && entry.metrics.bounds) {
      const b = entry.metrics.bounds;
      const bx = sx0 + b.x * scale;
      const by = sy0 + b.y * scale;
      const bw = b.w * scale;
      const bh = b.h * scale;
      fillRect(bx, by, bw, 1, 251, 191, 36, 180);
      fillRect(bx, by + bh - 1, bw, 1, 251, 191, 36, 180);
      fillRect(bx, by, 1, bh, 251, 191, 36, 180);
      fillRect(bx + bw - 1, by, 1, bh, 251, 191, 36, 180);
    }
  });

  return {
    width: outW,
    height: outH,
    scale,
    columns,
    rows,
    buffer: out,
    clips: measured.map((m) => m.metrics),
    referenceBottomMargin,
    referenceHeight,
  };
}
