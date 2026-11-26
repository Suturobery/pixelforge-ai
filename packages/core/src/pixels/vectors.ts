/**
 * PixelForge AI — Pixel-Perfect Editable Vectors (pure, DOM-free rasterizer).
 *
 * Stores non-destructive vector primitives (lines, quadratic/cubic Bézier
 * curves, rectangles, ellipses, polygons/polylines) per cel and rasterizes
 * them with crisp zero-AA pixel-art rules (Bresenham lines, midpoint ellipses,
 * pixel-perfect L-corner double removal on curves).
 *
 * Runs BEFORE `applyLayerModifiers`, so editable vectors automatically inherit
 * Live 1px Outlines / Sel-Out, Drop Shadows, and Live Color Remap in real time!
 */

import type { Cel, RGBA, VectorPoint, VectorShape, VectorShapeKind } from '../types/document';
import { drawPolygonPixels } from './craft';
import { drawEllipsePixels } from './ellipse';
import { drawLinePixels, drawRectPixels, stampBrush } from './ops';

const HEX6_RE = /^#[0-9a-f]{6}$/i;
const VALID_KINDS: readonly VectorShapeKind[] = ['line', 'curve', 'rect', 'ellipse', 'polygon'];
export const MAX_VECTORS_PER_CEL = 64;

function hexToRgba(hex: string): RGBA | null {
  const clean = hex.trim();
  if (!HEX6_RE.test(clean)) return null;
  return [
    parseInt(clean.slice(1, 3), 16),
    parseInt(clean.slice(3, 5), 16),
    parseInt(clean.slice(5, 7), 16),
    255,
  ];
}

export function cloneVectorShape(shape: VectorShape): VectorShape {
  return {
    id: shape.id,
    kind: shape.kind,
    points: shape.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    ...(shape.stroke !== undefined ? { stroke: shape.stroke } : {}),
    ...(shape.fill !== undefined ? { fill: shape.fill } : {}),
    ...(shape.strokeWidth !== undefined ? { strokeWidth: shape.strokeWidth } : {}),
    ...(shape.closed !== undefined ? { closed: shape.closed } : {}),
  };
}

export function cloneVectorShapes(vectors?: readonly VectorShape[]): VectorShape[] | undefined {
  if (!vectors || vectors.length === 0) return undefined;
  return vectors.map(cloneVectorShape);
}

export function shiftVectorShapes(
  vectors: readonly VectorShape[] | undefined,
  dx: number,
  dy: number,
): VectorShape[] | undefined {
  if (!vectors || vectors.length === 0) return undefined;
  if (dx === 0 && dy === 0) return cloneVectorShapes(vectors);
  return vectors.map((shape) => ({
    ...cloneVectorShape(shape),
    points: shape.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) })),
  }));
}

/** Validate a single VectorShape (returns error string or null). */
export function validateVectorShape(value: unknown, index = 0): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `vectors[${index}] must be an object`;
  }
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.trim().length === 0 || s.id.length > 64) {
    return `vectors[${index}].id must be a non-empty string (<= 64 chars)`;
  }
  if (typeof s.kind !== 'string' || !VALID_KINDS.includes(s.kind as VectorShapeKind)) {
    return `vectors[${index}].kind must be line | curve | rect | ellipse | polygon`;
  }
  const kind = s.kind as VectorShapeKind;
  if (!Array.isArray(s.points)) return `vectors[${index}].points must be an array`;
  const count = s.points.length;
  if (kind === 'line' || kind === 'rect' || kind === 'ellipse') {
    if (count !== 2) return `vectors[${index}] (${kind}) must have exactly 2 points`;
  } else if (kind === 'curve') {
    if (count !== 3 && count !== 4) return `vectors[${index}] (curve) must have 3 (quadratic) or 4 (cubic) points`;
  } else if (kind === 'polygon') {
    if (count < 2 || count > 64) return `vectors[${index}] (polygon) must have 2..64 points`;
  }
  for (let i = 0; i < count; i++) {
    const pt = s.points[i] as Record<string, unknown> | null | undefined;
    if (!pt || typeof pt !== 'object' || Array.isArray(pt)) {
      return `vectors[${index}].points[${i}] must be { x, y }`;
    }
    if (typeof pt.x !== 'number' || !Number.isFinite(pt.x) || pt.x < -512 || pt.x > 1024) {
      return `vectors[${index}].points[${i}].x must be finite in [-512, 1024]`;
    }
    if (typeof pt.y !== 'number' || !Number.isFinite(pt.y) || pt.y < -512 || pt.y > 1024) {
      return `vectors[${index}].points[${i}].y must be finite in [-512, 1024]`;
    }
  }
  if (s.stroke !== undefined && s.stroke !== null) {
    if (typeof s.stroke !== 'string' || !HEX6_RE.test(s.stroke)) {
      return `vectors[${index}].stroke must be #rrggbb or null`;
    }
  }
  if (s.fill !== undefined && s.fill !== null) {
    if (typeof s.fill !== 'string' || !HEX6_RE.test(s.fill)) {
      return `vectors[${index}].fill must be #rrggbb or null`;
    }
  }
  if (!s.stroke && !s.fill) {
    return `vectors[${index}] must specify at least a stroke or fill color`;
  }
  if (s.strokeWidth !== undefined) {
    if (typeof s.strokeWidth !== 'number' || !Number.isInteger(s.strokeWidth) || s.strokeWidth < 1 || s.strokeWidth > 4) {
      return `vectors[${index}].strokeWidth must be an integer 1..4`;
    }
  }
  if (s.closed !== undefined && typeof s.closed !== 'boolean') {
    return `vectors[${index}].closed must be a boolean`;
  }
  return null;
}

/** Validate an array of VectorShapes (returns error string or null). */
export function validateVectorShapes(value: unknown): string | null {
  if (!Array.isArray(value)) return 'vectors must be an array';
  if (value.length > MAX_VECTORS_PER_CEL) {
    return `vectors may contain at most ${MAX_VECTORS_PER_CEL} shapes per cel`;
  }
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const err = validateVectorShape(value[i], i);
    if (err) return err;
    const id = (value[i] as VectorShape).id;
    if (ids.has(id)) return `vectors[${i}].id "${id}" is duplicated`;
    ids.add(id);
  }
  return null;
}

/** Bresenham points between two integer endpoints (inclusive). */
function bresenhamPoints(x0: number, y0: number, x1: number, y1: number): VectorPoint[] {
  const out: VectorPoint[] = [];
  let cx = x0;
  let cy = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    out.push({ x: cx, y: cy });
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
  return out;
}

/**
 * Sample a Quadratic (3 pts) or Cubic (4 pts) Bézier curve into an ordered
 * sequence of crisp, 1px pixel-perfect coordinates (zero L-corner doubles).
 */
export function sampleBezierPixelPerfect(points: readonly VectorPoint[]): VectorPoint[] {
  if (points.length < 3) return points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

  // Estimate control polygon length so sampling is always denser than 1px
  let polyLen = 0;
  for (let i = 1; i < points.length; i++) {
    polyLen += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  const steps = Math.max(16, Math.min(2048, Math.ceil(polyLen * 4)));

  const evalAt = (t: number): VectorPoint => {
    const u = 1 - t;
    if (points.length === 3) {
      const [p0, p1, p2] = points as [VectorPoint, VectorPoint, VectorPoint];
      const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
      const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
      return { x: Math.round(x), y: Math.round(y) };
    }
    const [p0, p1, p2, p3] = points as [VectorPoint, VectorPoint, VectorPoint, VectorPoint];
    const x =
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x;
    const y =
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y;
    return { x: Math.round(x), y: Math.round(y) };
  };

  // Connect consecutive rounded samples with Bresenham so the chain is gap-free
  const raw: VectorPoint[] = [];
  let prev = evalAt(0);
  raw.push(prev);
  for (let i = 1; i <= steps; i++) {
    const cur = evalAt(i / steps);
    if (cur.x === prev.x && cur.y === prev.y) continue;
    const seg = bresenhamPoints(prev.x, prev.y, cur.x, cur.y);
    for (let j = 1; j < seg.length; j++) {
      raw.push(seg[j]!);
    }
    prev = cur;
  }

  if (raw.length <= 2) return raw;

  // Pixel-perfect L-corner double cleanup (Aseprite-style):
  // If prev -> curr -> next makes a 1px L-bend where prev and next are diagonal neighbors,
  // drop curr so 1px curves look cleanly hand-pixeled.
  const clean: VectorPoint[] = [raw[0]!];
  for (let i = 1; i < raw.length - 1; i++) {
    const a = clean[clean.length - 1]!;
    const b = raw[i]!;
    const c = raw[i + 1]!;
    const abOrtho = (a.x === b.x && Math.abs(a.y - b.y) === 1) || (a.y === b.y && Math.abs(a.x - b.x) === 1);
    const bcOrtho = (b.x === c.x && Math.abs(b.y - c.y) === 1) || (b.y === c.y && Math.abs(b.x - c.x) === 1);
    const acDiag = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
    if (abOrtho && bcOrtho && acDiag) {
      continue;
    }
    clean.push(b);
  }
  const last = raw[raw.length - 1]!;
  if (clean[clean.length - 1]!.x !== last.x || clean[clean.length - 1]!.y !== last.y) {
    clean.push(last);
  }
  return clean;
}

/** Rasterize one VectorShape into `buf` in place (crisp pixel-art, zero AA). */
export function rasterizeVectorShape(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  shape: VectorShape,
): void {
  const strokeRgba = shape.stroke ? hexToRgba(shape.stroke) : null;
  const fillRgba = shape.fill ? hexToRgba(shape.fill) : null;
  const size = Math.max(1, Math.min(4, Math.round(shape.strokeWidth ?? 1)));
  const pts = shape.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

  if (shape.kind === 'line') {
    if (!strokeRgba || pts.length < 2) return;
    drawLinePixels(buf, w, h, pts[0]!.x, pts[0]!.y, pts[1]!.x, pts[1]!.y, size, strokeRgba, false);
    return;
  }

  if (shape.kind === 'curve') {
    if (!strokeRgba || pts.length < 3) return;
    const sampled = sampleBezierPixelPerfect(pts);
    for (const pt of sampled) {
      stampBrush(buf, w, h, pt.x, pt.y, size, strokeRgba, false, size > 1 ? 'circle' : 'square');
    }
    return;
  }

  if (shape.kind === 'rect') {
    if (pts.length < 2) return;
    if (fillRgba) {
      drawRectPixels(buf, w, h, pts[0]!.x, pts[0]!.y, pts[1]!.x, pts[1]!.y, 1, fillRgba, true, false);
    }
    if (strokeRgba) {
      drawRectPixels(buf, w, h, pts[0]!.x, pts[0]!.y, pts[1]!.x, pts[1]!.y, size, strokeRgba, false, false);
    }
    return;
  }

  if (shape.kind === 'ellipse') {
    if (pts.length < 2) return;
    if (fillRgba) {
      drawEllipsePixels(buf, w, h, pts[0]!.x, pts[0]!.y, pts[1]!.x, pts[1]!.y, 1, fillRgba, true, false);
    }
    if (strokeRgba) {
      drawEllipsePixels(buf, w, h, pts[0]!.x, pts[0]!.y, pts[1]!.x, pts[1]!.y, size, strokeRgba, false, false);
    }
    return;
  }

  if (shape.kind === 'polygon') {
    if (pts.length < 2) return;
    const closed = shape.closed !== false;
    if (fillRgba && closed && pts.length >= 3) {
      drawPolygonPixels(buf, w, h, pts, fillRgba, true);
    }
    if (strokeRgba) {
      const segCount = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segCount; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        drawLinePixels(buf, w, h, a.x, a.y, b.x, b.y, size, strokeRgba, false);
      }
    }
  }
}

/**
 * Composite a cel's raster pixels + non-destructive vector shapes.
 * Zero-copy fast path when the cel has no vectors.
 */
export function renderCelWithVectors(
  cel: Pick<Cel, 'buffer' | 'vectors'>,
  w: number,
  h: number,
): Uint8ClampedArray {
  if (!cel.vectors || cel.vectors.length === 0 || w <= 0 || h <= 0 || cel.buffer.length !== w * h * 4) {
    return cel.buffer;
  }
  const out = new Uint8ClampedArray(cel.buffer);
  for (const shape of cel.vectors) {
    rasterizeVectorShape(out, w, h, shape);
  }
  return out;
}

/** Distance from point (px, py) to segment (a, b). */
function pointToSegmentDist(px: number, py: number, a: VectorPoint, b: VectorPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / lenSq));
  return Math.hypot(px - (a.x + t * vx), py - (a.y + t * vy));
}

export type VectorHit =
  | { kind: 'handle'; shapeId: string; pointIndex: number }
  | { kind: 'shape'; shapeId: string };

/**
 * Hit-test vector handles first (topmost shape wins), then shape outlines/fills.
 * Coordinates are in canvas pixel units.
 */
export function hitTestVectorShapes(
  vectors: readonly VectorShape[] | undefined,
  px: number,
  py: number,
  handleRadius = 1.1,
  edgeRadius = 1.2,
): VectorHit | null {
  if (!vectors || vectors.length === 0) return null;

  // 1. Check control/anchor handles first (topmost shape first)
  for (let i = vectors.length - 1; i >= 0; i--) {
    const shape = vectors[i]!;
    for (let pi = 0; pi < shape.points.length; pi++) {
      const pt = shape.points[pi]!;
      if (Math.hypot(px - pt.x, py - pt.y) <= handleRadius) {
        return { kind: 'handle', shapeId: shape.id, pointIndex: pi };
      }
    }
  }

  // 2. Check shape body / edges (topmost shape first)
  for (let i = vectors.length - 1; i >= 0; i--) {
    const shape = vectors[i]!;
    const pts = shape.points;
    if (shape.kind === 'line' && pts.length === 2) {
      if (pointToSegmentDist(px, py, pts[0]!, pts[1]!) <= edgeRadius) {
        return { kind: 'shape', shapeId: shape.id };
      }
    } else if (shape.kind === 'curve' && pts.length >= 3) {
      const sampled = sampleBezierPixelPerfect(pts);
      for (const sp of sampled) {
        if (Math.hypot(px - sp.x, py - sp.y) <= edgeRadius) {
          return { kind: 'shape', shapeId: shape.id };
        }
      }
    } else if ((shape.kind === 'rect' || shape.kind === 'ellipse') && pts.length === 2) {
      const minX = Math.min(pts[0]!.x, pts[1]!.x) - 0.5;
      const maxX = Math.max(pts[0]!.x, pts[1]!.x) + 0.5;
      const minY = Math.min(pts[0]!.y, pts[1]!.y) - 0.5;
      const maxY = Math.max(pts[0]!.y, pts[1]!.y) + 0.5;
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        return { kind: 'shape', shapeId: shape.id };
      }
    } else if (shape.kind === 'polygon' && pts.length >= 2) {
      const closed = shape.closed !== false;
      const segs = closed ? pts.length : pts.length - 1;
      for (let j = 0; j < segs; j++) {
        if (pointToSegmentDist(px, py, pts[j]!, pts[(j + 1) % pts.length]!) <= edgeRadius) {
          return { kind: 'shape', shapeId: shape.id };
        }
      }
      if (closed && pts.length >= 3 && shape.fill) {
        // Point-in-polygon ray cast
        let inside = false;
        for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
          const xi = pts[a]!.x, yi = pts[a]!.y;
          const xj = pts[b]!.x, yj = pts[b]!.y;
          const hit = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
          if (hit) inside = !inside;
        }
        if (inside) return { kind: 'shape', shapeId: shape.id };
      }
    }
  }
  return null;
}
