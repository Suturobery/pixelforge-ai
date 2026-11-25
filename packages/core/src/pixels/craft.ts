/**
 * @pixelforge/core — Pro Pixel Craft utilities (pure, DOM-free, deterministic).
 *
 * Powers the artist-grade MCP pixel craft loop:
 *   1. `drawPolygonPixels` — scanline-filled or outlined polygons for organic silhouettes.
 *   2. `renderInspectionRgba` — nearest-neighbor upscaling (up to 8×) with optional
 *      pixel grid + checkerboard so vision-capable IDE agents can inspect pixel flaws.
 *   3. `analyzePixelCraft` — deterministic craft linter that pinpoints exact (x, y)
 *      coordinates of outline doubles, orphan speckles, jaggies, and pillow shading.
 *   4. `polishLayerPixelArt` — OKLab hue-shifted selective outlines (sel-out),
 *      palette-locked directional highlights & shadows, and automatic double cleanup.
 */

import type { RGBA } from '../types/document';
import { CANVAS_MAX, CANVAS_MIN } from '../types/document';
import {
  oklabDistance2,
  parseHexColor,
  rgbToOklab,
  type Oklab,
} from '../ai/oklab';
import { drawLinePixels, inBounds, inBrushDisc, type BrushShape } from './ops';

export interface CraftPoint {
  x: number;
  y: number;
}

function setPx(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: RGBA): void {
  if (!inBounds(w, h, x, y)) return;
  const i = (y * w + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
}

// ---------------------------------------------------------------------------
// 1. Polygon rasterizer (scanline fill + Bresenham edges)
// ---------------------------------------------------------------------------

/**
 * Draw a polygon onto an RGBA buffer (filled or outlined).
 * Uses integer scanline rasterization (even-odd rule) plus crisp Bresenham edges
 * so thin tips and corners never vanish at low pixel-art resolutions.
 */
export function drawPolygonPixels(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  points: readonly CraftPoint[],
  c: RGBA,
  filled = true,
  mirrorX = false,
): void {
  if (points.length < 2) {
    if (points.length === 1) {
      const p = points[0]!;
      setPx(buf, w, h, p.x, p.y, c);
      if (mirrorX) setPx(buf, w, h, w - 1 - p.x, p.y, c);
    }
    return;
  }

  // Always rasterize the perimeter edges so 1px tips and edges remain crisp.
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    drawLinePixels(buf, w, h, a.x, a.y, b.x, b.y, 1, c, mirrorX);
  }

  if (!filled || points.length < 3) return;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(h - 1, Math.ceil(maxY));

  for (let y = yStart; y <= yEnd; y++) {
    const scanY = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i]!;
      const p2 = points[(i + 1) % points.length]!;
      if ((p1.y <= scanY && p2.y > scanY) || (p2.y <= scanY && p1.y > scanY)) {
        const t = (scanY - p1.y) / (p2.y - p1.y);
        xs.push(p1.x + t * (p2.x - p1.x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i]!));
      const x1 = Math.min(w - 1, Math.floor(xs[i + 1]!));
      for (let x = x0; x <= x1; x++) {
        setPx(buf, w, h, x, y, c);
        if (mirrorX) setPx(buf, w, h, w - 1 - x, y, c);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Nearest-neighbor upscaled inspection renderer (with optional grid)
// ---------------------------------------------------------------------------

export type InspectionScale = 0.25 | 0.5 | 1 | 2 | 4 | 8;

/**
 * Render an RGBA frame at nearest-neighbor scale (0.25..8).
 * When `showGrid` is true and `scale >= 4`, renders a subtle dark transparency
 * checkerboard behind transparent pixels plus a crisp 1px pixel grid (with a
 * slightly brighter major grid line every 8 source pixels) so vision-capable
 * agents can inspect exact pixel coordinates and silhouette quality.
 */
export function renderInspectionRgba(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  scale: InspectionScale,
  showGrid = false,
): { rgba: Uint8ClampedArray; w: number; h: number } {
  if (scale === 1 && !showGrid) return { rgba, w, h };

  const ow = Math.max(1, Math.floor(w * scale));
  const oh = Math.max(1, Math.floor(h * scale));
  const out = new Uint8ClampedArray(ow * oh * 4);
  const drawGrid = showGrid && scale >= 4;

  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    const subY = drawGrid ? y % scale : -1;
    const majorY = drawGrid && subY === 0 && sy > 0 && sy % 8 === 0;
    const minorY = drawGrid && subY === 0 && sy > 0 && !majorY;

    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const si = (sy * w + sx) * 4;
      const di = (y * ow + x) * 4;

      let r = rgba[si]!;
      let g = rgba[si + 1]!;
      let b = rgba[si + 2]!;
      let a = rgba[si + 3]!;

      if (drawGrid && a < 255) {
        // Dark neutral checkerboard so transparent edges & dark outlines both read clearly
        const lightTile = (sx + sy) % 2 === 0;
        const bg = lightTile ? 58 : 44;
        if (a === 0) {
          r = bg;
          g = bg;
          b = bg;
          a = 255;
        } else {
          const t = a / 255;
          r = Math.round(r * t + bg * (1 - t));
          g = Math.round(g * t + bg * (1 - t));
          b = Math.round(b * t + bg * (1 - t));
          a = 255;
        }
      }

      if (drawGrid) {
        const subX = x % scale;
        const majorX = subX === 0 && sx > 0 && sx % 8 === 0;
        const minorX = subX === 0 && sx > 0 && !majorX;
        if (majorX || majorY) {
          // Crisp teal-tinted major 8px ruler line
          r = Math.round(r * 0.55 + 94 * 0.45);
          g = Math.round(g * 0.55 + 234 * 0.45);
          b = Math.round(b * 0.55 + 212 * 0.45);
          a = 255;
        } else if (minorX || minorY) {
          // Subtle 1px cell divider
          r = Math.round(r * 0.8 + 120 * 0.2);
          g = Math.round(g * 0.8 + 128 * 0.2);
          b = Math.round(b * 0.8 + 140 * 0.2);
          a = 255;
        }
      }

      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      out[di + 3] = a;
    }
  }

  return { rgba: out, w: ow, h: oh };
}

// ---------------------------------------------------------------------------
// 3. Deterministic Pixel-Art Craft Linter (`analyzePixelCraft`)
// ---------------------------------------------------------------------------

export interface PixelCraftInput {
  buffer: Uint8ClampedArray;
  width: number;
  height: number;
  lighting?: 'top-left' | 'top' | 'front' | 'flat';
}

export interface CraftDefect {
  kind: 'doubles' | 'orphans' | 'jaggies' | 'pillow_shading' | 'empty';
  severity: 'warning' | 'info';
  count: number;
  message: string;
  hint: string;
  /** Up to 24 sample (x, y) pixel coordinates where the defect occurs */
  locations: CraftPoint[];
}

export interface PixelCraftReport {
  /** Deterministic heuristic craft score 0..100 */
  score: number;
  summary: string;
  metrics: {
    opaquePixels: number;
    coveragePercent: number;
    boundingBox: { x: number; y: number; w: number; h: number } | null;
    connectedParts: number;
    uniqueColors: number;
    doublesCount: number;
    orphansCount: number;
    jaggiesCount: number;
    litSideLightness: number | null;
    shadowSideLightness: number | null;
  };
  defects: CraftDefect[];
}

function isOpaqueAt(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return buf[(y * w + x) * 4 + 3]! >= 128;
}

function colorKeyAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number {
  const i = (y * w + x) * 4;
  return (buf[i]! << 16) | (buf[i + 1]! << 8) | buf[i + 2]!;
}

function lightnessAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number {
  const i = (y * w + x) * 4;
  return rgbToOklab(buf[i]!, buf[i + 1]!, buf[i + 2]!).L;
}

/**
 * Analyze a composited sprite buffer for pixel-art craft defects:
 *   - Outline doubles (thick L-shaped outline corners)
 *   - Orphan speckles (isolated 1–2px disconnected opaque specks)
 *   - Silhouette jaggies (irregular 1px stair-steps on diagonal outlines)
 *   - Pillow shading (uniform inward shading ignoring top-left light)
 */
export function analyzePixelCraft(input: PixelCraftInput): PixelCraftReport {
  const { buffer, width: w, height: h } = input;
  const lighting = input.lighting ?? 'top-left';
  const total = w * h;

  let opaquePixels = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  const colors = new Set<number>();

  // Identify boundary pixels (opaque pixels touching at least one transparent 4-neighbor)
  const isBoundary = new Uint8Array(total);
  const isDarkBoundary = new Uint8Array(total);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isOpaqueAt(buffer, w, h, x, y)) continue;
      opaquePixels++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      colors.add(colorKeyAt(buffer, w, x, y));

      const touchesEmpty =
        !isOpaqueAt(buffer, w, h, x - 1, y) ||
        !isOpaqueAt(buffer, w, h, x + 1, y) ||
        !isOpaqueAt(buffer, w, h, x, y - 1) ||
        !isOpaqueAt(buffer, w, h, x, y + 1);
      if (touchesEmpty) {
        const idx = y * w + x;
        isBoundary[idx] = 1;
        if (lightnessAt(buffer, w, x, y) < 0.42) {
          isDarkBoundary[idx] = 1;
        }
      }
    }
  }

  if (opaquePixels === 0) {
    return {
      score: 0,
      summary: 'Frame is empty — block in a silhouette first.',
      metrics: {
        opaquePixels: 0,
        coveragePercent: 0,
        boundingBox: null,
        connectedParts: 0,
        uniqueColors: 0,
        doublesCount: 0,
        orphansCount: 0,
        jaggiesCount: 0,
        litSideLightness: null,
        shadowSideLightness: null,
      },
      defects: [
        {
          kind: 'empty',
          severity: 'warning',
          count: 1,
          message: 'Frame has no visible pixels.',
          hint: 'Use draw_ellipse, draw_polygon, draw_line, or set_pixels to block in the silhouette.',
          locations: [],
        },
      ],
    };
  }

  // 1. Connected components (8-connected) to find orphan speckles (size <= 2 when main body >= 12)
  const visited = new Uint8Array(total);
  const components: CraftPoint[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (visited[start] || !isOpaqueAt(buffer, w, h, x, y)) continue;
      const comp: CraftPoint[] = [];
      const stack: number[] = [start];
      visited[start] = 1;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % w;
        const cy = (cur / w) | 0;
        comp.push({ x: cx, y: cy });
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (!inBounds(w, h, nx, ny)) continue;
            const ni = ny * w + nx;
            if (!visited[ni] && isOpaqueAt(buffer, w, h, nx, ny)) {
              visited[ni] = 1;
              stack.push(ni);
            }
          }
        }
      }
      components.push(comp);
    }
  }
  const largestComp = components.reduce((m, c) => Math.max(m, c.length), 0);
  const orphanLocations: CraftPoint[] = [];
  if (largestComp >= 12) {
    for (const comp of components) {
      if (comp.length <= 2) {
        for (const pt of comp) orphanLocations.push(pt);
      }
    }
  }

  // 2. Outline doubles: dark boundary pixels forming thick outer L-corners
  // An outer corner double at (x, y) has 2 orthogonal dark-boundary neighbors,
  // an interior (non-boundary) opaque pixel on the diagonal between them,
  // and transparent pixels on the two opposite sides.
  const doubleLocations: CraftPoint[] = [];
  const isInterior = (x: number, y: number): boolean =>
    inBounds(w, h, x, y) && isOpaqueAt(buffer, w, h, x, y) && isBoundary[y * w + x] === 0;
  const isDarkEdge = (x: number, y: number): boolean =>
    inBounds(w, h, x, y) && isDarkBoundary[y * w + x] === 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isDarkEdge(x, y)) continue;
      const u = isDarkEdge(x, y - 1);
      const d = isDarkEdge(x, y + 1);
      const l = isDarkEdge(x - 1, y);
      const r = isDarkEdge(x + 1, y);

      const emptyU = !isOpaqueAt(buffer, w, h, x, y - 1);
      const emptyD = !isOpaqueAt(buffer, w, h, x, y + 1);
      const emptyL = !isOpaqueAt(buffer, w, h, x - 1, y);
      const emptyR = !isOpaqueAt(buffer, w, h, x + 1, y);

      const isDoubleCorner =
        (r && d && emptyL && emptyU && isInterior(x + 1, y + 1)) ||
        (l && d && emptyR && emptyU && isInterior(x - 1, y + 1)) ||
        (r && u && emptyL && emptyD && isInterior(x + 1, y - 1)) ||
        (l && u && emptyR && emptyD && isInterior(x - 1, y - 1));

      if (isDoubleCorner) {
        doubleLocations.push({ x, y });
      }
    }
  }

  // 3. Silhouette jaggies: detect 1px stair-step hiccups along horizontal/vertical runs
  // Specifically, a boundary pixel protruding 1px out of a straight run of >= 3 pixels
  const jaggyLocations: CraftPoint[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!isBoundary[y * w + x]) continue;
      // Top-edge 1px bump: empty above, left, right; opaque below, with opaque shelf on both bottom-diagonals
      const bumpTop =
        !isOpaqueAt(buffer, w, h, x, y - 1) &&
        !isOpaqueAt(buffer, w, h, x - 1, y) &&
        !isOpaqueAt(buffer, w, h, x + 1, y) &&
        isOpaqueAt(buffer, w, h, x, y + 1) &&
        isOpaqueAt(buffer, w, h, x - 1, y + 1) &&
        isOpaqueAt(buffer, w, h, x + 1, y + 1) &&
        // exclude deliberate narrow spikes (check neighbors 2px out are also flat)
        isOpaqueAt(buffer, w, h, x - 2, y + 1) &&
        isOpaqueAt(buffer, w, h, x + 2, y + 1);
      const bumpBottom =
        !isOpaqueAt(buffer, w, h, x, y + 1) &&
        !isOpaqueAt(buffer, w, h, x - 1, y) &&
        !isOpaqueAt(buffer, w, h, x + 1, y) &&
        isOpaqueAt(buffer, w, h, x, y - 1) &&
        isOpaqueAt(buffer, w, h, x - 1, y - 1) &&
        isOpaqueAt(buffer, w, h, x + 1, y - 1) &&
        isOpaqueAt(buffer, w, h, x - 2, y - 1) &&
        isOpaqueAt(buffer, w, h, x + 2, y - 1);
      const bumpLeft =
        !isOpaqueAt(buffer, w, h, x - 1, y) &&
        !isOpaqueAt(buffer, w, h, x, y - 1) &&
        !isOpaqueAt(buffer, w, h, x, y + 1) &&
        isOpaqueAt(buffer, w, h, x + 1, y) &&
        isOpaqueAt(buffer, w, h, x + 1, y - 1) &&
        isOpaqueAt(buffer, w, h, x + 1, y + 1) &&
        isOpaqueAt(buffer, w, h, x + 1, y - 2) &&
        isOpaqueAt(buffer, w, h, x + 1, y + 2);
      const bumpRight =
        !isOpaqueAt(buffer, w, h, x + 1, y) &&
        !isOpaqueAt(buffer, w, h, x, y - 1) &&
        !isOpaqueAt(buffer, w, h, x, y + 1) &&
        isOpaqueAt(buffer, w, h, x - 1, y) &&
        isOpaqueAt(buffer, w, h, x - 1, y - 1) &&
        isOpaqueAt(buffer, w, h, x - 1, y + 1) &&
        isOpaqueAt(buffer, w, h, x - 1, y - 2) &&
        isOpaqueAt(buffer, w, h, x - 1, y + 2);

      if (bumpTop || bumpBottom || bumpLeft || bumpRight) {
        jaggyLocations.push({ x, y });
      }
    }
  }

  // 4. Directional lighting / pillow-shading check on interior pixels (excluding dark outlines)
  let litSum = 0;
  let litCount = 0;
  let shadowSum = 0;
  let shadowCount = 0;
  let centerSum = 0;
  let centerCount = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!isInterior(x, y)) continue;
      const L = lightnessAt(buffer, w, x, y);
      const nearTopLeft = isBoundary[y * w + (x - 1)] === 1 || isBoundary[(y - 1) * w + x] === 1;
      const nearBottomRight = isBoundary[y * w + (x + 1)] === 1 || isBoundary[(y + 1) * w + x] === 1;
      if (nearTopLeft && !nearBottomRight) {
        litSum += L;
        litCount++;
      } else if (nearBottomRight && !nearTopLeft) {
        shadowSum += L;
        shadowCount++;
      } else if (!nearTopLeft && !nearBottomRight) {
        centerSum += L;
        centerCount++;
      }
    }
  }

  const litAvg = litCount > 0 ? litSum / litCount : null;
  const shadowAvg = shadowCount > 0 ? shadowSum / shadowCount : null;
  const centerAvg = centerCount > 0 ? centerSum / centerCount : null;

  const defects: CraftDefect[] = [];
  let score = 100;

  if (doubleLocations.length > 0) {
    const severity = doubleLocations.length >= 4 ? 'warning' : 'info';
    score -= Math.min(25, doubleLocations.length * 3);
    defects.push({
      kind: 'doubles',
      severity,
      count: doubleLocations.length,
      message: `${doubleLocations.length} outline double corner(s) detected — thick L-corners make silhouettes look clunky.`,
      hint: 'Remove outer L-corner outline pixels or run beautify_layer with cleanDoubles: true.',
      locations: doubleLocations.slice(0, 24),
    });
  }

  if (orphanLocations.length > 0) {
    score -= Math.min(20, orphanLocations.length * 4);
    defects.push({
      kind: 'orphans',
      severity: 'warning',
      count: orphanLocations.length,
      message: `${orphanLocations.length} isolated stray/orphan pixel(s) detached from the main silhouette.`,
      hint: 'Erase stray pixels unless they are intentional floating sparkles/particles.',
      locations: orphanLocations.slice(0, 24),
    });
  }

  if (jaggyLocations.length > 0) {
    score -= Math.min(18, jaggyLocations.length * 3);
    defects.push({
      kind: 'jaggies',
      severity: jaggyLocations.length >= 3 ? 'warning' : 'info',
      count: jaggyLocations.length,
      message: `${jaggyLocations.length} single-pixel silhouette bump(s) / jaggy step(s) detected.`,
      hint: 'Smooth stair-step runs (e.g. 3-2-1) so curves read cleanly at 1×.',
      locations: jaggyLocations.slice(0, 24),
    });
  }

  if (lighting === 'top-left' && litAvg !== null && shadowAvg !== null && litCount >= 4 && shadowCount >= 4) {
    const contrast = litAvg - shadowAvg;
    const looksPillowed =
      contrast < 0.02 ||
      (centerAvg !== null && centerAvg - litAvg > 0.08 && centerAvg - shadowAvg > 0.08);
    if (looksPillowed) {
      score -= 18;
      defects.push({
        kind: 'pillow_shading',
        severity: 'warning',
        count: 1,
        message: `Weak directional lighting (top-left avg L=${litAvg.toFixed(2)} vs bottom-right avg L=${shadowAvg.toFixed(2)}) — sprite may look flat or pillow-shaded.`,
        hint: 'Brighten top-left facing clusters with warmer highlights and push bottom-right edges into cooler, darker palette shades (or run beautify_layer with shade: true, highlight: true).',
        locations: [],
      });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const warnings = defects.filter((d) => d.severity === 'warning').length;
  const summary =
    warnings === 0 && defects.length === 0
      ? `Clean pixel craft (${score}/100) — no doubles, orphans, jaggies, or pillow shading.`
      : `Pixel craft score ${score}/100 — ${warnings} warning(s), ${defects.length} finding(s) to refine.`;

  return {
    score,
    summary,
    metrics: {
      opaquePixels,
      coveragePercent: Math.round((opaquePixels / total) * 1000) / 10,
      boundingBox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      connectedParts: components.length,
      uniqueColors: colors.size,
      doublesCount: doubleLocations.length,
      orphansCount: orphanLocations.length,
      jaggiesCount: jaggyLocations.length,
      litSideLightness: litAvg !== null ? Math.round(litAvg * 1000) / 1000 : null,
      shadowSideLightness: shadowAvg !== null ? Math.round(shadowAvg * 1000) / 1000 : null,
    },
    defects,
  };
}

// ---------------------------------------------------------------------------
// 4. Pro Artist Polish Engine (OKLab Hue-Shifted Sel-Out, Shading & Cleanup)
// ---------------------------------------------------------------------------

interface PaletteEntry {
  rgba: RGBA;
  lab: Oklab;
}

function buildPaletteEntries(palette: readonly string[]): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const hex of palette) {
    const rgb = parseHexColor(hex);
    if (!rgb) continue;
    out.push({
      rgba: [rgb[0], rgb[1], rgb[2], 255],
      lab: rgbToOklab(rgb[0], rgb[1], rgb[2]),
    });
  }
  return out;
}

/**
 * Find the best hue-shifted darker color in the palette for a given base pixel.
 * Shifts OKLab lightness down and nudges hue subtly cooler (toward indigo/violet).
 */
function pickHueShiftedDarker(
  base: Oklab,
  entries: readonly PaletteEntry[],
  lightnessDelta: number,
  minDrop: number,
  preserveHueWeight = 1.6,
): RGBA | null {
  const target: Oklab = {
    L: Math.max(0.08, base.L - lightnessDelta),
    a: base.a * 0.9 + 0.01,
    b: base.b * 0.9 - 0.025,
  };
  let best: PaletteEntry | null = null;
  let bestDist = Infinity;
  for (const e of entries) {
    if (e.lab.L > base.L - minDrop) continue;
    const dl = target.L - e.lab.L;
    const da = target.a - e.lab.a;
    const db = target.b - e.lab.b;
    const d = dl * dl + preserveHueWeight * (da * da + db * db);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  if (best) return best.rgba;
  // Fallback: darkest color in palette
  let darkest: PaletteEntry | null = null;
  for (const e of entries) {
    if (!darkest || e.lab.L < darkest.lab.L) darkest = e;
  }
  return darkest ? darkest.rgba : null;
}

/**
 * Find the best hue-shifted lighter color in the palette for top-left rim highlights.
 * Shifts OKLab lightness up and nudges hue subtly warmer (toward warm yellow).
 */
function pickHueShiftedLighter(
  base: Oklab,
  entries: readonly PaletteEntry[],
  lightnessDelta: number,
  minRise: number,
): RGBA | null {
  const target: Oklab = {
    L: Math.min(0.98, base.L + lightnessDelta),
    a: base.a * 0.9,
    b: base.b * 0.9 + 0.028,
  };
  let best: PaletteEntry | null = null;
  let bestDist = Infinity;
  for (const e of entries) {
    if (e.lab.L < base.L + minRise) continue;
    // Prefer preserving hue family rather than jumping across opposite hues
    const d = oklabDistance2(target, e.lab) + 1.5 * ((e.lab.a - target.a) ** 2 + (e.lab.b - target.b) ** 2);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best ? best.rgba : null;
}

export interface PolishPixelArtOptions {
  /** Active project palette hexes — locks all shading, highlights & sel-out strictly to palette */
  palette?: readonly string[];
  /** Explicit flat outline color; ignored when `selOut: true` (unless palette is empty); `null` disables outline */
  outline?: RGBA | null;
  /** Use OKLab hue-shifted selective colored outlines (sel-out) matched to each adjacent cluster */
  selOut?: boolean;
  /** Add directional hue-shifted shadows on bottom/right inner edges (top-left light) */
  shade?: boolean;
  /** Add directional hue-shifted rim highlights on top/left inner edges (top-left light) */
  highlight?: boolean;
  /** Remove clunky outer L-shaped outline double corners after outlining */
  cleanDoubles?: boolean;
}

/**
 * Palette-aware pixel-art polish pass:
 *   - Hue-shifted selective outlines (`selOut`) OR flat 1px outline
 *   - Palette-locked directional shadows (bottom/right) and warm highlights (top/left)
 *   - Automatic outer L-corner double cleanup (`cleanDoubles`)
 */
export function polishLayerPixelArt(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  opts: PolishPixelArtOptions = {},
): boolean {
  const entries = opts.palette && opts.palette.length > 0 ? buildPaletteEntries(opts.palette) : [];
  const useSelOut = opts.selOut === true && entries.length > 0;
  const flatOutline = opts.outline === undefined ? ([26, 28, 44, 255] as RGBA) : opts.outline;
  const doOutline = useSelOut || (flatOutline !== null && flatOutline[3] > 0);
  const doShade = opts.shade !== false;
  const doHighlight = opts.highlight === true;
  const doCleanDoubles = opts.cleanDoubles !== false;

  const snapshot = Uint8ClampedArray.from(buf);
  const alphaAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : snapshot[(y * w + x) * 4 + 3]!;
  const labAt = (x: number, y: number): Oklab => {
    const i = (y * w + x) * 4;
    return rgbToOklab(snapshot[i]!, snapshot[i + 1]!, snapshot[i + 2]!);
  };

  let changed = false;
  const addedOutline = new Uint8Array(w * h);

  // 1. Outline pass (flat or OKLab hue-shifted sel-out)
  if (doOutline) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) > 0) continue;
        const neighbors: Array<[number, number]> = [];
        if (alphaAt(x - 1, y) > 0) neighbors.push([x - 1, y]);
        if (alphaAt(x + 1, y) > 0) neighbors.push([x + 1, y]);
        if (alphaAt(x, y - 1) > 0) neighbors.push([x, y - 1]);
        if (alphaAt(x, y + 1) > 0) neighbors.push([x, y + 1]);
        if (neighbors.length === 0) continue;

        let chosen: RGBA | null = flatOutline;
        if (useSelOut) {
          // Average OKLab of opaque 4-neighbors (weighted toward darker/structural color)
          let sumL = 0;
          let sumA = 0;
          let sumB = 0;
          for (const [nx, ny] of neighbors) {
            const lab = labAt(nx, ny);
            sumL += lab.L;
            sumA += lab.a;
            sumB += lab.b;
          }
          const avg: Oklab = {
            L: sumL / neighbors.length,
            a: sumA / neighbors.length,
            b: sumB / neighbors.length,
          };
          // Top-left outline pixels get colored hue-shifted sel-out; bottom-right get deeper anchoring ink
          const isLitSide = alphaAt(x + 1, y) > 0 || alphaAt(x, y + 1) > 0;
          const drop = isLitSide ? 0.2 : 0.36;
          chosen = pickHueShiftedDarker(avg, entries, drop, 0.1, isLitSide ? 2.4 : 1.3) ?? flatOutline;
        }
        if (chosen && chosen[3] > 0) {
          setPx(buf, w, h, x, y, chosen);
          addedOutline[y * w + x] = 1;
          changed = true;
        }
      }
    }
  }

  // 2. Clean outer L-corner doubles (both newly added and pre-existing dark edge doubles)
  if (doCleanDoubles) {
    const postOutline = Uint8ClampedArray.from(buf);
    const isEdgeDark = (x: number, y: number): boolean => {
      if (!inBounds(w, h, x, y)) return false;
      const idx = y * w + x;
      if (addedOutline[idx] === 1) return true;
      const i = idx * 4;
      if (postOutline[i + 3]! < 128) return false;
      const touchesEmpty =
        !isOpaqueAt(postOutline, w, h, x - 1, y) ||
        !isOpaqueAt(postOutline, w, h, x + 1, y) ||
        !isOpaqueAt(postOutline, w, h, x, y - 1) ||
        !isOpaqueAt(postOutline, w, h, x, y + 1);
      if (!touchesEmpty) return false;
      return rgbToOklab(postOutline[i]!, postOutline[i + 1]!, postOutline[i + 2]!).L < 0.4;
    };
    const isOrigInterior = (x: number, y: number): boolean =>
      inBounds(w, h, x, y) && isOpaqueAt(postOutline, w, h, x, y) && !isEdgeDark(x, y);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isEdgeDark(x, y)) continue;
        const u = isEdgeDark(x, y - 1);
        const d = isEdgeDark(x, y + 1);
        const l = isEdgeDark(x - 1, y);
        const r = isEdgeDark(x + 1, y);
        const eU = !isOpaqueAt(postOutline, w, h, x, y - 1);
        const eD = !isOpaqueAt(postOutline, w, h, x, y + 1);
        const eL = !isOpaqueAt(postOutline, w, h, x - 1, y);
        const eR = !isOpaqueAt(postOutline, w, h, x + 1, y);

        const isDouble =
          (r && d && eL && eU && isOrigInterior(x + 1, y + 1)) ||
          (l && d && eR && eU && isOrigInterior(x - 1, y + 1)) ||
          (r && u && eL && eD && isOrigInterior(x + 1, y - 1)) ||
          (l && u && eR && eD && isOrigInterior(x - 1, y - 1));

        if (isDouble) {
          setPx(buf, w, h, x, y, [0, 0, 0, 0]);
          changed = true;
        }
      }
    }
  }

  // 3. Directional shading & top-left rim highlights (strictly palette-locked when palette provided)
  if (doShade || doHighlight) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) === 0) continue; // only shade/highlight original sprite pixels
        const i = (y * w + x) * 4;
        if (buf[i + 3] === 0) continue;

        const baseLab = labAt(x, y);
        // Never shade/highlight already-ink-dark outline pixels (L < 0.25)
        if (baseLab.L < 0.25) continue;

        const edgeDown = alphaAt(x, y + 1) === 0;
        const edgeRight = alphaAt(x + 1, y) === 0;
        const edgeUp = alphaAt(x, y - 1) === 0;
        const edgeLeft = alphaAt(x - 1, y) === 0;

        if (doShade && (edgeDown || edgeRight) && !(edgeUp && edgeLeft)) {
          if (entries.length > 0) {
            const darker = pickHueShiftedDarker(baseLab, entries, 0.16, 0.06);
            if (darker) {
              setPx(buf, w, h, x, y, darker);
              changed = true;
            }
          } else {
            buf[i] = Math.round(buf[i]! * 0.72);
            buf[i + 1] = Math.round(buf[i + 1]! * 0.72);
            buf[i + 2] = Math.round(buf[i + 2]! * 0.72);
            changed = true;
          }
        } else if (doHighlight && (edgeUp || edgeLeft) && !(edgeDown || edgeRight) && entries.length > 0) {
          const lighter = pickHueShiftedLighter(baseLab, entries, 0.14, 0.06);
          if (lighter) {
            setPx(buf, w, h, x, y, lighter);
            changed = true;
          }
        }
      }
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// 5. Palette-Aware OKLab Shading Brush, Wrapped Tile Painting & Center Math
// ---------------------------------------------------------------------------

export type ShadeMode = 'darken' | 'lighten';

/** Positive modulo wrap into [0, size). */
export function wrapCoord(v: number, size: number): number {
  if (size <= 0) return 0;
  return ((v % size) + size) % size;
}

function shadePixelWithEntries(
  rgba: RGBA,
  entries: readonly PaletteEntry[],
  mode: ShadeMode,
): RGBA | null {
  if (rgba[3] === 0) return null;

  if (entries.length > 0) {
    const base = rgbToOklab(rgba[0], rgba[1], rgba[2]);
    let picked: RGBA | null = null;
    if (mode === 'darken') {
      picked = pickHueShiftedDarker(base, entries, 0.14, 0.04, 2.0);
    } else {
      picked = pickHueShiftedLighter(base, entries, 0.14, 0.04);
    }
    if (!picked) return null;
    if (picked[0] === rgba[0] && picked[1] === rgba[1] && picked[2] === rgba[2] && picked[3] === rgba[3]) {
      return null;
    }
    return [picked[0], picked[1], picked[2], rgba[3]];
  }

  // Fallback when palette is empty: subtle perceptual step
  const r = mode === 'darken'
    ? Math.max(0, Math.round(rgba[0] * 0.8))
    : Math.min(255, Math.round(rgba[0] + (255 - rgba[0]) * 0.22));
  const g = mode === 'darken'
    ? Math.max(0, Math.round(rgba[1] * 0.8))
    : Math.min(255, Math.round(rgba[1] + (255 - rgba[1]) * 0.22));
  const b = mode === 'darken'
    ? Math.max(0, Math.round(rgba[2] * 0.8))
    : Math.min(255, Math.round(rgba[2] + (255 - rgba[2]) * 0.22));
  if (r === rgba[0] && g === rgba[1] && b === rgba[2]) return null;
  return [r, g, b, rgba[3]];
}

/**
 * Step a single RGBA pixel one shade darker (cooler OKLab shadow) or lighter
 * (warmer OKLab highlight), strictly locked to `palette` when non-empty.
 * Returns `null` if the pixel is transparent or already at the ramp endpoint.
 */
export function shadePixelStep(
  rgba: RGBA,
  palette: readonly string[],
  mode: ShadeMode,
): RGBA | null {
  const entries = palette.length > 0 ? buildPaletteEntries(palette) : [];
  return shadePixelWithEntries(rgba, entries, mode);
}

export interface ShadeBrushOptions {
  mirrorX?: boolean;
  mirrorY?: boolean;
  wrap?: boolean;
  shape?: BrushShape;
  /** Per-stroke visited pixel set so dragging over a pixel steps it once per stroke. */
  visited?: Set<number>;
}

function applyShadeStampWithEntries(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
  entries: readonly PaletteEntry[],
  mode: ShadeMode,
  opts: ShadeBrushOptions,
): boolean {
  const s = Math.max(1, size);
  const off = Math.floor((s - 1) / 2);
  const shape = opts.shape ?? 'square';
  const wrap = opts.wrap === true;
  const mirrorX = opts.mirrorX === true;
  const mirrorY = opts.mirrorY === true;
  const visited = opts.visited;
  let changed = false;

  const shadeOne = (rawX: number, rawY: number): void => {
    const x = wrap ? wrapCoord(rawX, w) : rawX;
    const y = wrap ? wrapCoord(rawY, h) : rawY;
    if (!inBounds(w, h, x, y)) return;
    const idx = y * w + x;
    if (visited?.has(idx)) return;
    const o = idx * 4;
    if (buf[o + 3] === 0) return;
    const next = shadePixelWithEntries([buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!], entries, mode);
    visited?.add(idx);
    if (!next) return;
    buf[o] = next[0];
    buf[o + 1] = next[1];
    buf[o + 2] = next[2];
    buf[o + 3] = next[3];
    changed = true;
  };

  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (shape === 'circle' && !inBrushDisc(dx, dy, s)) continue;
      const px = cx + dx - off;
      const py = cy + dy - off;
      shadeOne(px, py);
      if (mirrorX) shadeOne(w - 1 - px, py);
      if (mirrorY) shadeOne(px, h - 1 - py);
      if (mirrorX && mirrorY) shadeOne(w - 1 - px, h - 1 - py);
    }
  }
  return changed;
}

/**
 * Stamp the palette-aware OKLab shading brush at `(cx, cy)`.
 * Skips transparent pixels and respects `visited`, `mirrorX`, `mirrorY`, and `wrap`.
 */
export function applyShadeBrush(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
  palette: readonly string[],
  mode: ShadeMode,
  opts: ShadeBrushOptions = {},
): boolean {
  const entries = palette.length > 0 ? buildPaletteEntries(palette) : [];
  return applyShadeStampWithEntries(buf, w, h, cx, cy, size, entries, mode, opts);
}

/**
 * Interpolate the palette-aware shading brush along a Bresenham segment from
 * `(x0, y0)` to `(x1, y1)` so fast pointer drags leave no gaps.
 */
export function applyShadeLine(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  palette: readonly string[],
  mode: ShadeMode,
  opts: ShadeBrushOptions = {},
): boolean {
  const entries = palette.length > 0 ? buildPaletteEntries(palette) : [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let changed = false;
  for (let i = 0; i <= dx + dy + 1; i++) {
    if (applyShadeStampWithEntries(buf, w, h, x, y, size, entries, mode, opts)) {
      changed = true;
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return changed;
}

/**
 * Stamp a brush with seamless toroidal modulo wrapping across canvas edges.
 * Used by Tiled Wrap mode for seamless tilesets and repeating textures.
 */
export function stampBrushWrapped(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  size: number,
  c: RGBA,
  mirrorX = false,
  mirrorY = false,
  shape: BrushShape = 'square',
): void {
  const s = Math.max(1, size);
  const off = Math.floor((s - 1) / 2);
  const put = (rawX: number, rawY: number): void => {
    const x = wrapCoord(rawX, w);
    const y = wrapCoord(rawY, h);
    const i = (y * w + x) * 4;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    buf[i + 3] = c[3];
  };
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (shape === 'circle' && !inBrushDisc(dx, dy, s)) continue;
      const px = cx + dx - off;
      const py = cy + dy - off;
      put(px, py);
      if (mirrorX) put(w - 1 - px, py);
      if (mirrorY) put(px, h - 1 - py);
      if (mirrorX && mirrorY) put(w - 1 - px, h - 1 - py);
    }
  }
}

/**
 * Bresenham line stamped with toroidal modulo wrapping across canvas edges.
 */
export function drawLineWrapped(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  c: RGBA,
  mirrorX = false,
  mirrorY = false,
  shape: BrushShape = 'square',
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (let i = 0; i <= dx + dy + 1; i++) {
    stampBrushWrapped(buf, w, h, x, y, size, c, mirrorX, mirrorY, shape);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export interface CenterShiftResult {
  dx: number;
  dy: number;
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * Compute the integer `(dx, dy)` shift required to center the opaque bounding
 * box of one or more RGBA buffers inside a `w × h` canvas.
 * Returns `null` when every buffer is completely transparent.
 */
export function computeCenterShift(
  buffers: Uint8ClampedArray | readonly Uint8ClampedArray[],
  w: number,
  h: number,
): CenterShiftResult | null {
  const list = buffers instanceof Uint8ClampedArray ? [buffers] : buffers;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (const buf of list) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (buf[(y * w + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const targetX = Math.floor((w - bw) / 2);
  const targetY = Math.floor((h - bh) / 2);
  return {
    dx: targetX - minX,
    dy: targetY - minY,
    bbox: { x: minX, y: minY, w: bw, h: bh },
  };
}

// ---------------------------------------------------------------------------
// 6. Tier 1 Studio Pack: Palette Sort, Color Replace, Skin Remap & Auto-Trim
// ---------------------------------------------------------------------------

export type PaletteSortBy = 'lightness' | 'hue';
export type PaletteRemapMode = 'ramp' | 'nearest';

/**
 * Sort hex palette colors deterministically in OKLab space.
 *   - `'lightness'`: dark → bright by OKLab L (ties broken by chroma, then hue).
 *   - `'hue'`: neutral/achromatic ramp first (sorted by L), followed by chromatic
 *     colors sorted smoothly around the OKLab hue wheel (red → yellow → green → cyan → blue → violet).
 */
export function sortPaletteColors(palette: readonly string[], by: PaletteSortBy = 'lightness'): string[] {
  const seen = new Set<string>();
  const items: Array<{ hex: string; lab: Oklab; chroma: number; hue: number }> = [];
  for (const raw of palette) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rgb = parseHexColor(raw);
    if (!rgb) continue;
    const lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
    const chroma = Math.hypot(lab.a, lab.b);
    let hue = Math.atan2(lab.b, lab.a);
    if (hue < 0) hue += Math.PI * 2;
    items.push({ hex: raw, lab, chroma, hue });
  }

  if (by === 'lightness') {
    items.sort((p, q) => p.lab.L - q.lab.L || p.chroma - q.chroma || p.hue - q.hue);
  } else {
    const isNeutral = (item: { lab: Oklab; chroma: number }): boolean =>
      item.chroma < 0.045 || (item.lab.L < 0.25 && item.chroma < 0.06);
    items.sort((p, q) => {
      const pGray = isNeutral(p);
      const qGray = isNeutral(q);
      if (pGray !== qGray) return pGray ? -1 : 1;
      if (pGray && qGray) return p.lab.L - q.lab.L;
      // Quantize hue slightly into 18° buckets so same-hue ramps group dark→bright cleanly
      const pBucket = Math.floor((p.hue / (Math.PI * 2)) * 20);
      const qBucket = Math.floor((q.hue / (Math.PI * 2)) * 20);
      if (pBucket !== qBucket) return pBucket - qBucket;
      return p.lab.L - q.lab.L || p.hue - q.hue;
    });
  }

  return items.map((it) => it.hex);
}

/**
 * Replace every pixel matching `from` (exact RGBA) with `to` in-place.
 * Returns the number of pixels replaced.
 */
export function replaceColorInBuffer(buf: Uint8ClampedArray, from: RGBA, to: RGBA): number {
  if (from[0] === to[0] && from[1] === to[1] && from[2] === to[2] && from[3] === to[3]) {
    return 0;
  }
  let replaced = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (
      buf[i] === from[0] &&
      buf[i + 1] === from[1] &&
      buf[i + 2] === from[2] &&
      buf[i + 3] === from[3]
    ) {
      buf[i] = to[0];
      buf[i + 1] = to[1];
      buf[i + 2] = to[2];
      buf[i + 3] = to[3];
      replaced++;
    }
  }
  return replaced;
}

/** Collect all unique opaque RGB colors across one or more RGBA buffers. */
export function collectUniqueOpaqueColors(buffers: readonly Uint8ClampedArray[]): RGBA[] {
  const seen = new Map<number, RGBA>();
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3]! === 0) continue;
      const r = buf[i]!;
      const g = buf[i + 1]!;
      const b = buf[i + 2]!;
      const key = (r << 16) | (g << 8) | b;
      if (!seen.has(key)) seen.set(key, [r, g, b, 255]);
    }
  }
  return Array.from(seen.values());
}

/**
 * Remap an RGBA buffer onto `targetPalette` in-place (preserving alpha).
 *   - `'ramp'` (default — Skin Variant Swapper): sorts unique source colors and
 *     target palette colors by OKLab lightness `L` and maps dark→dark, mid→mid,
 *     bright→bright so shading contrast stays crisp across completely different palettes.
 *   - `'nearest'`: maps every opaque pixel to its closest OKLab color in `targetPalette`.
 * Pass `sourceColors` (from `collectUniqueOpaqueColors`) when remapping multiple cels
 * of a frame/clip so every frame shares the exact same color table.
 */
export function remapBufferToPalette(
  buf: Uint8ClampedArray,
  targetPalette: readonly string[],
  opts: { mode?: PaletteRemapMode; sourceColors?: readonly RGBA[] } = {},
): number {
  const entries = buildPaletteEntries(targetPalette);
  if (entries.length === 0) return 0;

  const mode = opts.mode ?? 'ramp';
  const lut = new Map<number, RGBA>();

  if (mode === 'ramp') {
    const srcColors = opts.sourceColors && opts.sourceColors.length > 0
      ? [...opts.sourceColors]
      : collectUniqueOpaqueColors([buf]);
    if (srcColors.length === 0) return 0;

    const srcRanked = srcColors
      .map((rgba) => ({
        key: (rgba[0] << 16) | (rgba[1] << 8) | rgba[2],
        lab: rgbToOklab(rgba[0], rgba[1], rgba[2]),
      }))
      .sort((a, b) => a.lab.L - b.lab.L || a.lab.a - b.lab.a || a.lab.b - b.lab.b);

    const dstRanked = [...entries].sort(
      (a, b) => a.lab.L - b.lab.L || a.lab.a - b.lab.a || a.lab.b - b.lab.b,
    );

    const m = srcRanked.length;
    const n = dstRanked.length;
    for (let i = 0; i < m; i++) {
      const t = m === 1 ? 0.5 : i / (m - 1);
      const dstIdx = Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
      lut.set(srcRanked[i]!.key, dstRanked[dstIdx]!.rgba);
    }
  }

  let changed = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3]! === 0) continue;
    const r = buf[i]!;
    const g = buf[i + 1]!;
    const b = buf[i + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let mapped = lut.get(key);
    if (!mapped) {
      // Nearest OKLab lookup (used for mode='nearest' or any fallback key)
      const lab = rgbToOklab(r, g, b);
      let best = entries[0]!;
      let bestD = oklabDistance2(lab, best.lab);
      for (let j = 1; j < entries.length; j++) {
        const d = oklabDistance2(lab, entries[j]!.lab);
        if (d < bestD) {
          bestD = d;
          best = entries[j]!;
        }
      }
      mapped = best.rgba;
      lut.set(key, mapped);
    }
    if (mapped[0] !== r || mapped[1] !== g || mapped[2] !== b) {
      buf[i] = mapped[0];
      buf[i + 1] = mapped[1];
      buf[i + 2] = mapped[2];
      changed++;
    }
  }
  return changed;
}

export interface TrimBoundsResult {
  bbox: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  dx: number;
  dy: number;
}

/**
 * Compute target canvas dimensions and integer cel shift `(dx, dy)` to trim
 * empty margins around the combined opaque bounding box of `buffers`, with
 * optional uniform padding clamped to `[minSize, maxSize]`.
 */
export function computeTrimBounds(
  buffers: readonly Uint8ClampedArray[],
  w: number,
  h: number,
  padding = 0,
  minSize = CANVAS_MIN,
  maxSize = CANVAS_MAX,
): TrimBoundsResult | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (const buf of buffers) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (buf[(y * w + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  const pad = Math.max(0, Math.min(16, Math.round(padding)));
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const width = Math.max(minSize, Math.min(maxSize, bw + pad * 2));
  const height = Math.max(minSize, Math.min(maxSize, bh + pad * 2));
  const dx = Math.floor((width - bw) / 2) - minX;
  const dy = Math.floor((height - bh) / 2) - minY;
  return {
    bbox: { x: minX, y: minY, w: bw, h: bh },
    width,
    height,
    dx,
    dy,
  };
}

// ---------------------------------------------------------------------------
// 7. Batch 3 Manual Artist Helpers: Magic Wand Bounds & 4×4 Bayer Gradient
// ---------------------------------------------------------------------------

export interface MagicWandResult {
  x: number;
  y: number;
  w: number;
  h: number;
  pixelCount: number;
}

/**
 * Flood-find a contiguous same-color island starting at `(sx, sy)` and return
 * its tight bounding rectangle + pixel count.
 */
export function magicWandBounds(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  opts: { diagonal?: boolean } = {},
): MagicWandResult | null {
  if (!inBounds(w, h, sx, sy)) return null;
  const si = (sy * w + sx) * 4;
  const tr = buf[si]!;
  const tg = buf[si + 1]!;
  const tb = buf[si + 2]!;
  const ta = buf[si + 3]!;

  const matches = (idx: number): boolean => {
    const o = idx * 4;
    if (ta === 0) return buf[o + 3] === 0;
    return buf[o] === tr && buf[o + 1] === tg && buf[o + 2] === tb && buf[o + 3] === ta;
  };

  const visited = new Uint8Array(w * h);
  const start = sy * w + sx;
  visited[start] = 1;
  const stack: number[] = [start];
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  let count = 0;

  const dirs = opts.diagonal
    ? [
        [-1, 0], [1, 0], [0, -1], [0, 1],
        [-1, -1], [1, -1], [-1, 1], [1, 1],
      ]
    : [
        [-1, 0], [1, 0], [0, -1], [0, 1],
      ];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    count++;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx!;
      const ny = cy + dy!;
      if (!inBounds(w, h, nx, ny)) continue;
      const ni = ny * w + nx;
      if (visited[ni]) continue;
      if (matches(ni)) {
        visited[ni] = 1;
        stack.push(ni);
      }
    }
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    pixelCount: count,
  };
}

const BAYER4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export interface DitherGradientOptions {
  mirrorX?: boolean;
  mirrorY?: boolean;
  /** Optional clip rectangle (e.g., active marquee selection). Defaults to full canvas. */
  clipRect?: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Draw a crisp 4×4 ordered Bayer dither linear gradient from `(x0, y0)` (`fromColor`)
 * to `(x1, y1)` (`toColor`), clipped to `clipRect` when provided.
 */
export function drawDitherGradientPixels(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fromColor: RGBA,
  toColor: RGBA,
  opts: DitherGradientOptions = {},
): boolean {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy;

  const rx0 = opts.clipRect ? Math.max(0, opts.clipRect.x) : 0;
  const ry0 = opts.clipRect ? Math.max(0, opts.clipRect.y) : 0;
  const rx1 = opts.clipRect ? Math.min(w - 1, opts.clipRect.x + opts.clipRect.w - 1) : w - 1;
  const ry1 = opts.clipRect ? Math.min(h - 1, opts.clipRect.y + opts.clipRect.h - 1) : h - 1;
  if (rx0 > rx1 || ry0 > ry1) return false;

  const mirrorX = opts.mirrorX === true;
  const mirrorY = opts.mirrorY === true;
  let changed = false;

  const put = (x: number, y: number, c: RGBA): void => {
    if (!inBounds(w, h, x, y)) return;
    const i = (y * w + x) * 4;
    if (buf[i] === c[0] && buf[i + 1] === c[1] && buf[i + 2] === c[2] && buf[i + 3] === c[3]) return;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    buf[i + 3] = c[3];
    changed = true;
  };

  for (let y = ry0; y <= ry1; y++) {
    const row = BAYER4[y & 3]!;
    for (let x = rx0; x <= rx1; x++) {
      let t = 0;
      if (len2 > 0) {
        t = ((x - x0) * vx + (y - y0) * vy) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }
      const threshold = (row[x & 3]! + 0.5) / 16;
      const chosen = t > threshold ? toColor : fromColor;
      put(x, y, chosen);
      if (mirrorX) put(w - 1 - x, y, chosen);
      if (mirrorY) put(x, h - 1 - y, chosen);
      if (mirrorX && mirrorY) put(w - 1 - x, h - 1 - y, chosen);
    }
  }

  return changed;
}
