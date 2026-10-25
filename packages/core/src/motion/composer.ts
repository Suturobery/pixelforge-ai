/**
 * Deterministic motion composer (v3.1 §4.1.1 — Task 10).
 *
 * Pure function: (project, sourceClip, preset, params, anchor) → MotionPlan.
 * Zero DOM, zero clock, zero randomness — same source + parameters produce
 * byte-identical composed buffers (golden-tested).
 *
 * Semantics (R1–R10):
 *  R1  paint order  — parts processed bottom→top (stable z sort, array order
 *                     tie-break); per part: cut owned pixels → apply integer
 *                     offset → paste back. Higher-z parts win overlaps.
 *  R2  ownership    — a pixel belongs to exactly ONE part: the highest-z
 *                     part whose region contains it (computed once from the
 *                     anchor frame; lower parts never move pixels they
 *                     don't own).
 *  R3  transparency — alpha ≥ 128 = opaque (moves; alpha promoted to 255 —
 *                     binary rule, matches normalize v2); alpha < 128 =
 *                     transparent (cleared, does not move). Static remainder
 *                     bytes are never re-written, so untouched semi-alpha
 *                     stays bit-identical (R9) and is flagged by QA instead.
 *  R4  bounds/gaps  — integer offsets; targets outside the canvas are
 *                     dropped (no wrap). Vacated pixels: gapFill 'none'
 *                     leaves them transparent; 'edge-extend' (the default
 *                     since the Phase-1 Task 10 QA correction — with 'none'
 *                     bob/lean/squash frames opened visible seam holes and
 *                     detached limbs) repeats the trailing boundary pixels
 *                     until the hole is closed (C26 — fills 1–3 px strips at
 *                     reference amplitudes).
 *  R5  alignment    — every frame derives from ONE anchor frame (default
 *                     frame 1 = index 0); the same absolute regions and
 *                     per-frame offsets are used for every output frame.
 *  R7  timing       — the composer only produces buffers; frames are written
 *                     with durationMs 0 by the apply command (inherit clip
 *                     fps). Loop props are never modified by the composer.
 *  R8  linked cels  — the source data is read as-is; layers that parts
 *                     target are un-linked by the APPLY command (recorded in
 *                     the same undo entry) and listed in the report.
 *  R9  static rest  — pixels outside all part regions are bit-identical to
 *                     the anchor (the composer starts from a clone and only
 *                     rewrites owned pixels).
 *  R10 scaling      — ampScale = clipHeight / 32; offset(v) =
 *                     sign(v)·max(1, |round(v·ampScale)|) per non-zero curve
 *                     value (direction preserved, magnitude floor 1 px — C25).
 *                     The user `amplitude` parameter multiplies curve values
 *                     BEFORE R10 (intensity), squash included.
 */

import type { Clip, Frame, Project } from '../types/document';
import {
  AMPLITUDE_MAX,
  AMPLITUDE_MIN,
  MOTION_PARAMS_DEFAULTS,
  scaledOffset,
  type ComposedFrame,
  type MotionParams,
  type MotionPlan,
  type MotionPresetId,
  type PresetCurves,
  type SkippedPart,
} from './types';
import { getPreset, resolveParams } from './presets';

interface UsablePart {
  partId: string;
  role: string;
  name: string;
  layerId: string;
  z: number;
  /** Paint-order index within its layer (z asc, array order tie-break). */
  order: number;
  /** true = whole layer (no rect). */
  wholeLayer: boolean;
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

/** Normalize a part name to the canonical role key (case/trim insensitive). */
export function roleKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The swing frame index of an attack curve (max positive dx — smear frame). */
function smearFrameIndex(curves: PresetCurves): number {
  const arm = curves.armL;
  if (!arm || arm.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < arm.length; i++) {
    if (arm[i].dx > arm[best].dx) best = i;
  }
  return arm[best].dx > 0 ? best : -1;
}

export interface PlanMotionOptions {
  preset: MotionPresetId;
  params?: Partial<MotionParams>;
  /** Anchor frame INDEX (0-based; R5 default = frame 1 → index 0). */
  anchorFrameIndex?: number;
}

/**
 * Build the full deterministic plan WITHOUT touching any document (preview
 * path + the motion.apply command both call this — one implementation).
 * Throws Error with a plain message for degenerate inputs (no anchor frame).
 */
export function planMotion(project: Project, source: Clip, opts: PlanMotionOptions): MotionPlan {
  const preset = getPreset(opts.preset);
  if (!preset) throw new Error(`motion: unknown preset "${opts.preset}"`);
  const params = resolveParams(preset, { ...MOTION_PARAMS_DEFAULTS, ...opts.params });
  const amp = Math.min(AMPLITUDE_MAX, Math.max(AMPLITUDE_MIN, params.amplitude));

  const anchorIndex = Math.min(
    Math.max(0, opts.anchorFrameIndex ?? 0),
    source.frames.length - 1
  );
  const anchor: Frame = source.frames[anchorIndex];
  if (!anchor) throw new Error('motion: source clip has no anchor frame');

  const w = project.width;
  const h = project.height;
  const ampScale = h / 32; // R10
  const curves = preset.curvesFor(params.frameCount);

  const skipped: SkippedPart[] = [];
  const usable: UsablePart[] = [];
  const unlinkedLayerIds: string[] = [];

  // ---- role → part resolution (C27: absent roles are skipped + reported) --
  for (const role of Object.keys(curves)) {
    const roleNorm = roleKey(role);
    const part = source.parts.find((p) => roleKey(p.name) === roleNorm);
    if (!part) {
      skipped.push({
        role,
        reason: 'absent',
        detail: `no part named "${role}" is tagged on this clip — role skipped (C27)`,
      });
      continue;
    }
    const layer = source.layers.find((l) => l.id === part.layerId);
    if (!layer) {
      skipped.push({
        role,
        partName: part.name,
        reason: 'absent',
        detail: `part "${part.name}" references a layer that no longer exists — role skipped`,
      });
      continue;
    }
    if (layer.linked) {
      // R8: an explicitly tagged linked layer is un-linked by the apply
      // command (same undo entry); composition proceeds on its anchor cel.
      if (!unlinkedLayerIds.includes(layer.id)) unlinkedLayerIds.push(layer.id);
    }
    const wholeLayer = !part.rect;
    const r = part.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    usable.push({
      partId: part.id,
      role,
      name: part.name,
      layerId: layer.id,
      z: part.z,
      order: 0,
      wholeLayer,
      rx: wholeLayer ? 0 : r.x,
      ry: wholeLayer ? 0 : r.y,
      rw: wholeLayer ? w : r.w,
      rh: wholeLayer ? h : r.h,
    });
  }

  // ---- affected layers + per-layer paint order (R1: stable z sort) --------
  const layerIds: string[] = [];
  for (const p of usable) if (!layerIds.includes(p.layerId)) layerIds.push(p.layerId);

  const partsByLayer = new Map<string, UsablePart[]>();
  for (const layerId of layerIds) {
    const list = usable
      .filter((p) => p.layerId === layerId)
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p.z - b.p.z || a.i - b.i) // z asc, array order tie-break
      .map((e, order) => ({ ...e.p, order }));
    partsByLayer.set(layerId, list);
  }

  // ---- ownership maps (R2): highest-z part whose region contains the px --
  const ownerMaps = new Map<string, Int32Array>();
  for (const [layerId, list] of partsByLayer) {
    const owner = new Int32Array(w * h).fill(-1);
    for (const part of list) {
      for (let y = Math.max(0, part.ry); y < Math.min(h, part.ry + part.rh); y++) {
        for (let x = Math.max(0, part.rx); x < Math.min(w, part.rx + part.rw); x++) {
          owner[y * w + x] = part.order; // later (higher z) parts overwrite earlier
        }
      }
    }
    ownerMaps.set(layerId, owner);
  }

  // ---- compose every frame ------------------------------------------------
  const frames: ComposedFrame[] = [];
  const smearIdx = preset.id === 'attack' && params.smear ? smearFrameIndex(curves) : -1;
  let clippedPixels = 0;

  for (let fi = 0; fi < params.frameCount; fi++) {
    const cels: Record<string, Uint8ClampedArray> = {};
    for (const layerId of layerIds) {
      const srcCel = anchor.cels[layerId];
      const working = srcCel
        ? new Uint8ClampedArray(srcCel.buffer)
        : new Uint8ClampedArray(w * h * 4);
      const list = partsByLayer.get(layerId) as UsablePart[];
      const owner = ownerMaps.get(layerId) as Int32Array;

      for (const part of list) {
        const off = curves[part.role][fi];
        const dxs = scaledOffset(off.dx * amp, ampScale);
        const dys = scaledOffset(off.dy * amp, ampScale);
        const squashPx =
          off.squash !== undefined ? scaledOffset(off.squash * amp, ampScale) : 0;
        // effective paste/fill displacement (squash pushes content down)
        const ex = dxs;
        const ey = dys + squashPx;

        // -- collect owned opaque pixels (R2 + R3); snapshot colors, then cut
        const srcX: number[] = [];
        const srcY: number[] = [];
        const snap: number[] = []; // rgb triplets (alpha becomes 255 on paste)
        for (let y = Math.max(0, part.ry); y < Math.min(h, part.ry + part.rh); y++) {
          for (let x = Math.max(0, part.rx); x < Math.min(w, part.rx + part.rw); x++) {
            const idx = y * w + x;
            if (owner[idx] !== part.order) continue; // owned by a higher-z part
            const o = idx * 4;
            if (working[o + 3] >= 128) {
              srcX.push(x);
              srcY.push(y);
              snap.push(working[o], working[o + 1], working[o + 2]);
            }
            working[o] = 0;
            working[o + 1] = 0;
            working[o + 2] = 0;
            working[o + 3] = 0;
          }
        }

        // -- paste at the frame's integer offset (R4: clip at edges, no wrap)
        const pasted = new Set<number>();
        const pasteAt = (ox: number, oy: number): void => {
          for (let k = 0; k < srcX.length; k++) {
            const sy = srcY[k];
            if (squashPx > 0 && sy < part.ry + squashPx) continue; // top rows dropped
            const tx = srcX[k] + ox;
            const ty = sy + oy;
            if (tx < 0 || ty < 0 || tx >= w || ty >= h) {
              clippedPixels++;
              continue;
            }
            const d = (ty * w + tx) * 4;
            working[d] = snap[k * 3];
            working[d + 1] = snap[k * 3 + 1];
            working[d + 2] = snap[k * 3 + 2];
            working[d + 3] = 255; // R3: binary alpha on moved pixels
            pasted.add(ty * w + tx);
          }
        };
        if (fi === smearIdx) pasteAt(ex - 1, ey); // 1-px smear trail first
        pasteAt(ex, ey);

        // -- gapFill 'edge-extend' (R4 / C26) ------------------------------
        if (params.gapFill === 'edge-extend' && (ex !== 0 || ey !== 0)) {
          const steps = Math.max(Math.abs(ex), Math.abs(ey));
          // march from each vacated pixel TOWARD the pasted content (the
          // content moved by (ex, ey); the fill repeats the trailing
          // boundary row/column of the pasted region until the hole closes)
          const stepX = ex !== 0 ? Math.sign(ex) : 0;
          const stepY = stepX === 0 && ey !== 0 ? Math.sign(ey) : 0;
          for (let k = 0; k < srcX.length; k++) {
            const px = srcX[k];
            const py = srcY[k];
            if (pasted.has(py * w + px)) continue; // covered by the paste
            if (working[(py * w + px) * 4 + 3] !== 0) continue; // not a hole
            for (let s = 1; s <= steps; s++) {
              const cx = px + stepX * s;
              const cy = py + stepY * s;
              if (cx < 0 || cy < 0 || cx >= w || cy >= h) break;
              const ci = (cy * w + cx) * 4;
              if (working[ci + 3] >= 128) {
                // repeat the trailing boundary pixel into the hole
                const di = (py * w + px) * 4;
                working[di] = working[ci];
                working[di + 1] = working[ci + 1];
                working[di + 2] = working[ci + 2];
                working[di + 3] = working[ci + 3];
                break;
              }
            }
          }
        }
      }
      cels[layerId] = working;
    }
    frames.push({ cels });
  }

  // ---- report --------------------------------------------------------------
  const moved = usable.map((p) => ({ role: p.role, partName: p.name, layerId: p.layerId }));
  const warnings: { code: string; message: string }[] = [];
  if (moved.length === 0) {
    warnings.push({
      code: 'no_moving_parts',
      message:
        'No tagged part matched any preset role — output frames are holds of the anchor frame. Tag parts (head, body, armL…) to see motion.',
    });
  }
  if (clippedPixels > 0) {
    warnings.push({
      code: 'edge_clipped',
      message: `${clippedPixels} part pixels moved past the canvas edge and were dropped (R4: no wrap).`,
    });
  }

  return {
    width: w,
    height: h,
    frames,
    report: {
      preset: preset.id,
      params,
      frameCount: params.frameCount,
      ampScale,
      anchorFrameId: anchor.id,
      anchorFrameIndex: anchorIndex,
      affectedLayerIds: layerIds,
      unlinkedLayerIds,
      skipped,
      moved,
      clippedPixels,
      warnings,
    },
  };
}
