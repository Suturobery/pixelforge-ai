/**
 * Pixel-editing command: `pixels.applyOp` (v3.1 §2.5 — every tool is a
 * pointer stream → command-bus call; no tool mutates the canvas directly).
 *
 * The interactive path is the stroke flow (begin/end/cancel on the bus,
 * prototype contract kept); this command covers single-shot deterministic
 * edits (MCP tools, AI ops, programmatic edits) and produces the same
 * 16×16 tile-diff history entries.
 */

import type { RGBA } from '../types/document';
import type { ApplyOutcome, CommandContext, CommandDefinition } from '../types/commands';
import { locateCel, replaceCelBuffer } from '../doc/access';
import { cloneBuffer } from '../util/buffers';
import {
  clearBufferInPlace,
  drawLinePixels,
  drawRectPixels,
  floodFill,
  moveBuffer,
  stampBrush,
} from '../pixels/ops';
import { drawEllipsePixels } from '../pixels/ellipse';
import {
  clampRect,
  flipRegionHInPlace,
  flipRegionVInPlace,
  rotateRegionCCWInPlace,
  rotateRegionCWInPlace,
  scaleRegionInPlace,
  scaleRegionToInPlace,
  type PixelRect,
} from '../pixels/region';
import { extractTileDiff } from '../pixels/tile';
import { fail, failNotFound } from './errors';
import { assertObject, getOptionalBool, getRgba, getString, getOptionalInt, getInt } from './validate';

export interface PixelPoint {
  x: number;
  y: number;
}

export type PixelOp =
  | ({ op: 'stamp' } & PixelPoint & { size?: number; mirrorX?: boolean })
  | { op: 'line'; from: PixelPoint; to: PixelPoint; size?: number; mirrorX?: boolean }
  | {
      op: 'rect';
      from: PixelPoint;
      to: PixelPoint;
      size?: number;
      filled?: boolean;
      mirrorX?: boolean;
    }
  | {
      op: 'ellipse';
      from: PixelPoint;
      to: PixelPoint;
      size?: number;
      filled?: boolean;
      mirrorX?: boolean;
    }
  | ({ op: 'fill' } & PixelPoint & { mirrorX?: boolean })
  | { op: 'shift'; dx: number; dy: number }
  | { op: 'clear' }
  /** Region transforms — rect omitted = whole cel. Integer, interpolation-free. */
  | { op: 'flipH'; rect?: PixelRect }
  | { op: 'flipV'; rect?: PixelRect }
  | { op: 'rotateCW'; rect?: PixelRect }
  | { op: 'rotateCCW'; rect?: PixelRect }
  /** Nearest-neighbor scale about the region's top-left corner. factor 0.5
   * downsamples (every-other-pixel), integers 2–8 duplicate pixels. Content
   * pushed outside the canvas is dropped; rect omitted = whole cel. */
  | { op: 'scale'; factor: number; rect?: PixelRect }
  /** Free NN resample: scale the `rect` region into the explicit `to`
   * footprint (per-axis, uniform or not). Overwrites the destination area,
   * clears the source, clips to the canvas. Powers the interactive
   * selection-scale handles. */
  | { op: 'scaleTo'; rect: PixelRect; to: PixelRect }
  /** Full cel replace (AI import path) — buffer must match w*h*4. */
  | { op: 'setBuffer'; buffer: Uint8ClampedArray };

export interface ApplyPixelOpsPayload {
  clipId: string;
  frameId: string;
  layerId: string;
  /** Required for stamp/line/rect/fill; ignored otherwise. */
  color?: RGBA;
  ops: PixelOp[];
}

const OPS_NEEDING_COLOR: ReadonlySet<string> = new Set(['stamp', 'line', 'rect', 'ellipse', 'fill']);

function validateRect(rect: unknown, what: string): void {
  if (!rect || typeof rect !== 'object') fail(`${what} requires a rect object`);
  const r = rect as Record<string, unknown>;
  getInt(r, 'x', what);
  getInt(r, 'y', what);
  const w = getInt(r, 'w', what);
  const h = getInt(r, 'h', what);
  if (w < 1 || h < 1) fail(`${what} rect must be at least 1×1`);
}

function validateOp(op: PixelOp, hasColor: boolean, ctx: CommandContext, i: number): void {
  const what = `pixels.applyOp ops[${i}] (${op.op})`;
  if (!op || typeof op !== 'object') fail(`${what} must be an object`);
  switch (op.op) {
    case 'stamp':
    case 'fill':
      getInt(op as unknown as Record<string, unknown>, 'x', what);
      getInt(op as unknown as Record<string, unknown>, 'y', what);
      getOptionalInt(op as unknown as Record<string, unknown>, 'size', what, 1, 8);
      getOptionalBool(op as unknown as Record<string, unknown>, 'mirrorX', what);
      break;
    case 'line':
    case 'rect':
    case 'ellipse':
      if (!op.from || !op.to) fail(`${what} requires from/to points`);
      getInt(op.from as unknown as Record<string, unknown>, 'x', what);
      getInt(op.from as unknown as Record<string, unknown>, 'y', what);
      getInt(op.to as unknown as Record<string, unknown>, 'x', what);
      getInt(op.to as unknown as Record<string, unknown>, 'y', what);
      getOptionalInt(op as unknown as Record<string, unknown>, 'size', what, 1, 8);
      getOptionalBool(op as unknown as Record<string, unknown>, 'mirrorX', what);
      if (op.op !== 'line' && (op as { filled?: boolean }).filled !== undefined) {
        getOptionalBool(op as unknown as Record<string, unknown>, 'filled', what);
      }
      break;
    case 'flipH':
    case 'flipV':
    case 'rotateCW':
    case 'rotateCCW': {
      const rect = (op as { rect?: PixelRect }).rect;
      if (rect !== undefined) validateRect(rect, what);
      break;
    }
    case 'scale': {
      const f = (op as { factor?: unknown }).factor;
      if (f !== 0.5 && !(typeof f === 'number' && Number.isInteger(f) && f >= 2 && f <= 8)) {
        fail(`${what} factor must be 0.5 or an integer 2–8`);
      }
      const rect = (op as { rect?: PixelRect }).rect;
      if (rect !== undefined) validateRect(rect, what);
      break;
    }
    case 'scaleTo': {
      const r = (op as { rect?: PixelRect }).rect;
      const to = (op as { to?: PixelRect }).to;
      if (!r) fail(`${what} requires a source rect`);
      else validateRect(r, what);
      if (!to) fail(`${what} requires a "to" destination rect`);
      else validateRect(to, what);
      break;
    }
    case 'shift':
      getInt(op as unknown as Record<string, unknown>, 'dx', what);
      getInt(op as unknown as Record<string, unknown>, 'dy', what);
      break;
    case 'clear':
      break;
    case 'setBuffer': {
      const buf = (op as { buffer?: Uint8ClampedArray }).buffer;
      if (!(buf instanceof Uint8ClampedArray)) fail(`${what} requires a Uint8ClampedArray buffer`);
      if (buf.length !== ctx.width * ctx.height * 4) {
        fail(`${what} buffer length must be width*height*4 (${ctx.width * ctx.height * 4})`);
      }
      break;
    }
    default:
      fail(`${what}: unknown op kind`);
  }
  if (OPS_NEEDING_COLOR.has(op.op) && !hasColor) {
    fail(`pixels.applyOp: "color" is required for op "${op.op}"`);
  }
}

export const applyPixelOpsCommand: CommandDefinition<ApplyPixelOpsPayload> = {
  type: 'pixels.applyOp',
  defaultLabel: 'Pixel edit',

  validate(payload, ctx) {
    const p = assertObject(payload, 'pixels.applyOp payload');
    getString(p, 'clipId', 'pixels.applyOp');
    getString(p, 'frameId', 'pixels.applyOp');
    getString(p, 'layerId', 'pixels.applyOp');
    let hasColor = false;
    let color: RGBA | undefined;
    if (p.color !== undefined) {
      color = getRgba(p, 'color', 'pixels.applyOp');
      hasColor = true;
    }
    if (!Array.isArray(p.ops) || p.ops.length === 0) {
      fail('pixels.applyOp: "ops" must be a non-empty array');
    }
    if (p.ops.length > 4096) fail('pixels.applyOp: too many ops in one command (max 4096)');
    for (let i = 0; i < p.ops.length; i++) {
      validateOp(p.ops[i] as PixelOp, hasColor, ctx, i);
    }
    void color;
  },

  apply(payload, ctx) {
    const { clipId, frameId, layerId } = payload;
    const loc = locateCel(ctx.project, clipId, frameId, layerId);
    if (!loc) failNotFound(`pixels.applyOp: cel target ${clipId}/${frameId}/${layerId} not found`);
    const { width, height } = ctx.project;

    // Missing cel = transparent (C2): painting creates the cel.
    const base = loc.cel
      ? cloneBuffer(loc.cel.buffer)
      : new Uint8ClampedArray(width * height * 4);

    for (const op of payload.ops) {
      const c = payload.color as RGBA;
      switch (op.op) {
        case 'stamp':
          stampBrush(base, width, height, op.x, op.y, op.size ?? 1, c, op.mirrorX ?? false);
          break;
        case 'line':
          drawLinePixels(base, width, height, op.from.x, op.from.y, op.to.x, op.to.y, op.size ?? 1, c, op.mirrorX ?? false);
          break;
        case 'rect':
          drawRectPixels(base, width, height, op.from.x, op.from.y, op.to.x, op.to.y, op.size ?? 1, c, op.filled ?? false, op.mirrorX ?? false);
          break;
        case 'ellipse':
          drawEllipsePixels(base, width, height, op.from.x, op.from.y, op.to.x, op.to.y, op.size ?? 1, c, op.filled ?? false, op.mirrorX ?? false);
          break;
        case 'fill':
          floodFill(base, width, height, op.x, op.y, c, op.mirrorX ?? false);
          break;
        case 'flipH':
        case 'flipV':
        case 'rotateCW':
        case 'rotateCCW': {
          const rect = (op as { rect?: PixelRect }).rect;
          const scope = rect ? clampRect(rect, width, height) : { x: 0, y: 0, w: width, h: height };
          if (!scope) break; // rect fully outside the canvas → visual no-op
          if (op.op === 'flipH') flipRegionHInPlace(base, width, height, scope);
          else if (op.op === 'flipV') flipRegionVInPlace(base, width, height, scope);
          else if (op.op === 'rotateCW') rotateRegionCWInPlace(base, width, height, scope);
          else rotateRegionCCWInPlace(base, width, height, scope);
          break;
        }
        case 'scale': {
          const rect = (op as { rect?: PixelRect }).rect;
          const scope = rect ? clampRect(rect, width, height) : { x: 0, y: 0, w: width, h: height };
          if (!scope) break; // rect fully outside the canvas → visual no-op
          scaleRegionInPlace(base, width, height, scope, op.factor);
          break;
        }
        case 'scaleTo':
          scaleRegionToInPlace(base, width, height, op.rect, op.to);
          break;
        case 'shift': {
          const moved = moveBuffer(base, width, height, op.dx, op.dy);
          base.set(moved);
          break;
        }
        case 'clear':
          clearBufferInPlace(base);
          break;
        case 'setBuffer':
          base.set(op.buffer);
          break;
      }
    }

    const tiles = extractTileDiff(
      loc.cel ? loc.cel.buffer : new Uint8ClampedArray(width * height * 4),
      base,
      width,
      height
    );

    const project = replaceCelBuffer(ctx.project, clipId, frameId, layerId, base, loc.layer.linked);
    if (!project) failNotFound('pixels.applyOp: cel target vanished during apply');

    // Always mark the pixel path (even with zero tiles) so the bus never
    // records a structural snapshot for a visual no-op.
    const outcome: ApplyOutcome = {
      project,
      pixels: { clipId, frameId, layerId, tiles },
    };
    if (tiles.length > 0) {
      outcome.label = payload.ops.length === 1 ? describeOp(payload.ops[0]) : `Pixel edit (${payload.ops.length} ops)`;
    }
    return outcome;
  },
};

function describeOp(op: PixelOp): string {
  const scope = 'rect' in op && op.rect ? ' (selection)' : '';
  switch (op.op) {
    case 'stamp': return 'Brush';
    case 'line': return 'Line';
    case 'rect': return (op as { filled?: boolean }).filled ? 'Filled rect' : 'Rect';
    case 'ellipse': return ((op as { filled?: boolean }).filled ? 'Filled ellipse' : 'Ellipse') + scope;
    case 'fill': return 'Fill';
    case 'flipH': return 'Flip horizontal' + scope;
    case 'flipV': return 'Flip vertical' + scope;
    case 'rotateCW': return 'Rotate 90° CW' + scope;
    case 'rotateCCW': return 'Rotate 90° CCW' + scope;
    case 'scale': return `Scale ${op.factor === 0.5 ? '÷2' : `×${op.factor}`}` + scope;
    case 'scaleTo': return `Scale to ${op.to.w}×${op.to.h}` + scope;
    case 'shift': return 'Move layer';
    case 'clear': return 'Clear cel';
    case 'setBuffer': return 'Replace cel';
    default: return 'Pixel edit';
  }
}
