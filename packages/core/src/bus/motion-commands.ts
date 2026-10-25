/**
 * Motion & part commands (v3.1 §4.1/§4.1.1, Task 10) — thin CommandBus
 * wrappers over the deterministic composer, following builtins.ts discipline:
 * pure (document in) → (document out), hand-rolled validation, structural
 * snapshot history (exact undo), trash never involved (nothing is deleted).
 *
 *  part.set     — replace a clip's whole parts array in ONE undoable step
 *                 (the plan's `set_parts` MCP tool maps here; regions only,
 *                 never cuts — C4).
 *  motion.apply — run a preset through planMotion() and commit the frames
 *                 atomically (new clip sized exactly / overwrite with
 *                 holds, R6), unlinking tagged linked layers in the same
 *                 undo entry (R8). Generated frames get durationMs 0 (R7).
 *
 * New clip/frame/part ids use the shared uid() generators like every other
 * structural command; PIXEL content is fully deterministic (the composer is
 * pure) — "same source + parameters = byte-identical output" holds for the
 * composed buffers, which is what golden tests assert.
 */

import type { Cel, Clip, Frame, Layer, LoopMode, Part, Project } from '../types/document';
import type { CommandDefinition } from '../types/commands';
import { findClip, mapClip, newClipId, newFrameId, newLayerId, newPartId } from '../doc/access';
import { fail, failNotFound } from './errors';
import {
  assertObject,
  getBool,
  getInt,
  getNumber,
  getOptionalLoopMode,
  getOptionalString,
  getString,
} from './validate';
import { AMPLITUDE_MAX, AMPLITUDE_MIN, type GapFillMode, type MotionPresetId } from '../motion/types';
import { getPreset, PRESET_IDS } from '../motion/presets';
import { planMotion } from '../motion/composer';

// ---------------------------------------------------------------------------
// part.set
// ---------------------------------------------------------------------------

export interface PartSetPayload {
  clipId: string;
  parts: Array<{
    name: string;
    layerId: string;
    rect?: { x: number; y: number; w: number; h: number };
    anchorFrameId?: string;
    z?: number;
  }>;
}

export const partSet: CommandDefinition<PartSetPayload> = {
  type: 'part.set',
  defaultLabel: 'Set motion parts',
  validate(payload, ctx) {
    const p = assertObject(payload, 'part.set');
    const clipId = getString(p, 'clipId', 'part.set');
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`part.set: clip "${clipId}" not found`);
    if (!Array.isArray(p.parts)) fail('part.set: parts must be an array');
    if (p.parts.length > 32) fail('part.set: at most 32 parts per clip');
    const names = new Set<string>();
    p.parts.forEach((raw, i) => {
      const part = assertObject(raw as Record<string, unknown>, `part.set parts[${i}]`);
      const name = getString(part, 'name', `part.set parts[${i}]`);
      if (name.length > 40) fail(`part.set parts[${i}]: name too long (max 40)`);
      const key = name.trim().toLowerCase();
      if (names.has(key)) {
        fail(`part.set: duplicate part name "${name}" (names are role keys, case-insensitive)`);
      }
      names.add(key);
      const layerId = getString(part, 'layerId', `part.set parts[${i}]`);
      if (!clip.layers.some((l) => l.id === layerId)) {
        failNotFound(`part.set parts[${i}]: layer "${layerId}" not found in clip "${clip.name}"`);
      }
      if (part.anchorFrameId !== undefined) {
        const anchorId = getOptionalString(part, 'anchorFrameId', `part.set parts[${i}]`);
        if (anchorId !== undefined && !clip.frames.some((f) => f.id === anchorId)) {
          failNotFound(`part.set parts[${i}]: anchor frame "${anchorId}" not found`);
        }
      }
      if (part.z !== undefined) getInt(part, 'z', `part.set parts[${i}]`, -99, 99);
      if (part.rect !== undefined) {
        const r = assertObject(part.rect as Record<string, unknown>, `part.set parts[${i}].rect`);
        const x = getInt(r, 'x', 'part.set rect', 0, ctx.width - 1);
        const y = getInt(r, 'y', 'part.set rect', 0, ctx.height - 1);
        const w = getInt(r, 'w', 'part.set rect', 1, ctx.width);
        const h = getInt(r, 'h', 'part.set rect', 1, ctx.height);
        if (x + w > ctx.width || y + h > ctx.height) {
          fail(`part.set parts[${i}]: rect extends past the ${ctx.width}×${ctx.height} canvas`);
        }
      }
    });
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const parts: Part[] = payload.parts.map((p, i) => ({
      id: newPartId(),
      name: p.name.trim(),
      layerId: p.layerId,
      ...(p.rect ? { rect: { ...p.rect } } : {}),
      anchorFrameId: p.anchorFrameId ?? clip.frames[0].id,
      z: p.z ?? i,
    }));
    return {
      project: mapClip(ctx.project, payload.clipId, (c) => ({ ...c, parts })),
      label: parts.length > 0 ? 'Tag motion parts' : 'Clear motion parts',
    };
  },
};

// ---------------------------------------------------------------------------
// motion.apply
// ---------------------------------------------------------------------------

export interface MotionApplyPayload {
  sourceClipId: string;
  preset: MotionPresetId;
  params?: {
    amplitude?: number;
    frameCount?: number;
    gapFill?: GapFillMode;
    smear?: boolean;
  };
  /** Anchor frame INDEX (0-based; default 0 = frame 1, R5). */
  anchorFrameIndex?: number;
  target:
    | { kind: 'new'; name: string; fps?: number; loop?: boolean; loopMode?: LoopMode }
    | { kind: 'existing'; clipId: string; overwrite: true };
}

const GAP_FILL_MODES: readonly GapFillMode[] = ['none', 'edge-extend'];

export const motionApply: CommandDefinition<MotionApplyPayload> = {
  type: 'motion.apply',
  defaultLabel: 'Apply motion preset',
  validate(payload, ctx) {
    const p = assertObject(payload, 'motion.apply');
    const sourceClipId = getString(p, 'sourceClipId', 'motion.apply');
    const source = findClip(ctx.project, sourceClipId);
    if (!source) failNotFound(`motion.apply: source clip "${sourceClipId}" not found`);
    const presetId = getString(p, 'preset', 'motion.apply');
    const preset = getPreset(presetId);
    if (!preset) fail(`motion.apply: preset must be one of ${PRESET_IDS.join(' | ')}`);
    if (p.params !== undefined) {
      const params = assertObject(p.params as Record<string, unknown>, 'motion.apply params');
      if (params.amplitude !== undefined) {
        const a = getNumber(params, 'amplitude', 'motion.apply params');
        if (a < AMPLITUDE_MIN || a > AMPLITUDE_MAX) {
          fail(`motion.apply params: amplitude must be ${AMPLITUDE_MIN}–${AMPLITUDE_MAX}`);
        }
      }
      if (params.frameCount !== undefined) {
        const fc = getInt(params, 'frameCount', 'motion.apply params', 1, 64);
        if (!preset.frameCounts.includes(fc)) {
          fail(`motion.apply params: "${preset.id}" supports frame counts ${preset.frameCounts.join('/')} (got ${fc})`);
        }
      }
      if (params.gapFill !== undefined) {
        const g = params.gapFill;
        if (typeof g !== 'string' || !GAP_FILL_MODES.includes(g as GapFillMode)) {
          fail('motion.apply params: gapFill must be "none" | "edge-extend"');
        }
      }
      if (params.smear !== undefined) getBool(params, 'smear', 'motion.apply params');
    }
    if (p.anchorFrameIndex !== undefined) {
      getInt(p, 'anchorFrameIndex', 'motion.apply', 0, source.frames.length - 1);
    }
    const target = assertObject(p.target as Record<string, unknown>, 'motion.apply target');
    const kind = getString(target, 'kind', 'motion.apply target');
    if (kind === 'new') {
      const name = getString(target, 'name', 'motion.apply target');
      if (name.length > 120) fail('motion.apply target: name too long (max 120)');
      if (target.fps !== undefined) getInt(target, 'fps', 'motion.apply target', 1, 60);
      if (target.loop !== undefined) getBool(target, 'loop', 'motion.apply target');
      if (target.loopMode !== undefined) getOptionalLoopMode(target, 'loopMode', 'motion.apply target');
    } else if (kind === 'existing') {
      const clipId = getString(target, 'clipId', 'motion.apply target');
      if (!findClip(ctx.project, clipId)) failNotFound(`motion.apply target: clip "${clipId}" not found`);
      // v3.1 R6: overwriting an existing clip is only defined with overwrite:true
      if (target.overwrite !== true) {
        fail('motion.apply target: overwriting an existing clip requires overwrite:true (existing frames are never silently replaced)');
      }
    } else {
      fail('motion.apply target: kind must be "new" | "existing"');
    }
  },
  apply(payload, ctx) {
    const source = findClip(ctx.project, payload.sourceClipId) as Clip;
    const plan = planMotion(ctx.project, source, {
      preset: payload.preset,
      params: payload.params,
      anchorFrameIndex: payload.anchorFrameIndex,
    });
    const target = payload.target;

    if (target.kind === 'new') {
      return {
        project: applyToNewClip(ctx.project, source, plan, target),
        label: `Motion: ${plan.report.preset} → "${target.name}"`,
      };
    }
    const targetName = findClip(ctx.project, target.clipId)?.name ?? '';
    return {
      project: applyToExistingClip(ctx.project, source, plan, target.clipId),
      label: `Motion: ${plan.report.preset} → "${targetName}"`,
    };
  },
};

// ---------------------------------------------------------------------------
// apply targets (R6 reconciliation + R7 timing + R8 unlink)
// ---------------------------------------------------------------------------

/** Copy of the source layer stack for a NEW target clip (fresh ids). */
function cloneLayerForTarget(layer: Layer, unlinked: Set<string>): Layer {
  return {
    id: newLayerId(),
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    // R8: layers that parts target are un-linked in the target clip; a
    // pinned background with no part stays linked (must not bob).
    linked: layer.linked && !unlinked.has(layer.id),
  };
}

function applyToNewClip(
  project: Project,
  source: Clip,
  plan: ReturnType<typeof planMotion>,
  target: { kind: 'new'; name: string; fps?: number; loop?: boolean; loopMode?: LoopMode }
): Project {
  const unlinked = new Set(plan.report.unlinkedLayerIds);
  const layerMap = new Map<string, Layer>(); // source layer id → new layer
  const layers = source.layers.map((l) => {
    const copy = cloneLayerForTarget(l, unlinked);
    layerMap.set(l.id, copy);
    return copy;
  });

  const anchor = source.frames[plan.report.anchorFrameIndex];
  const affected = new Set(plan.report.affectedLayerIds);

  // Still-linked layers share ONE cel object across every frame (C2).
  const sharedCelByLayerId = new Map<string, Cel>();
  for (const [srcId, copy] of layerMap) {
    if (!copy.linked) continue;
    const src = anchor.cels[srcId];
    if (src) {
      sharedCelByLayerId.set(copy.id, {
        buffer: new Uint8ClampedArray(src.buffer),
        linked: true,
      });
    }
  }

  const frames: Frame[] = plan.frames.map((composed) => {
    const cels: Frame['cels'] = {};
    for (const [srcId, copy] of layerMap) {
      if (affected.has(srcId) && composed.cels[srcId]) {
        cels[copy.id] = { buffer: composed.cels[srcId], linked: false };
      } else if (sharedCelByLayerId.has(copy.id)) {
        cels[copy.id] = sharedCelByLayerId.get(copy.id) as Cel;
      } else {
        const src = anchor.cels[srcId];
        // R9: non-affected frames carry bit-identical copies of the anchor
        if (src) cels[copy.id] = { buffer: new Uint8ClampedArray(src.buffer), linked: false };
      }
    }
    return { id: newFrameId(), durationMs: 0, cels }; // R7: inherit clip fps
  });

  const clip: Clip = {
    id: newClipId(),
    name: target.name,
    fps: Math.min(60, Math.max(1, Math.round(target.fps ?? source.fps))),
    loop: target.loop ?? source.loop,
    loopMode: target.loopMode ?? source.loopMode,
    layers,
    // parts carry over (remapped) so presets can be re-applied/re-parameterized
    parts: source.parts
      .map((p): Part | null => {
        const copy = layerMap.get(p.layerId);
        if (!copy) return null;
        return {
          id: newPartId(),
          name: p.name,
          layerId: copy.id,
          ...(p.rect ? { rect: { ...p.rect } } : {}),
          anchorFrameId: frames[0].id,
          z: p.z,
        };
      })
      .filter((p): p is Part => p !== null),
    frames,
    tags: [],
  };
  return { ...project, clips: [...project.clips, clip] };
}

function applyToExistingClip(
  project: Project,
  source: Clip,
  plan: ReturnType<typeof planMotion>,
  targetClipId: string
): Project {
  const affected = new Set(plan.report.affectedLayerIds);
  const unlinked = new Set(plan.report.unlinkedLayerIds);

  // R8: unlink tagged linked layers in the target clip (same undo entry)
  let next = mapClip(project, targetClipId, (c) => ({
    ...c,
    layers: c.layers.map((l) => (unlinked.has(l.id) ? { ...l, linked: false } : l)),
  }));

  const target = findClip(next, targetClipId) as Clip;
  const anchor = source.frames[plan.report.anchorFrameIndex];
  const n = plan.report.frameCount;

  // R6: fewer frames → append holds of the reference (exact anchor copies)
  const appended: Frame[] = [];
  for (let i = target.frames.length; i < n; i++) {
    const cels: Frame['cels'] = {};
    for (const layer of target.layers) {
      const src = anchor.cels[layer.id];
      if (!src) continue;
      cels[layer.id] = layer.linked
        ? src // stays shared
        : { buffer: new Uint8ClampedArray(src.buffer), linked: false };
    }
    appended.push({ id: newFrameId(), durationMs: 0, cels });
  }
  if (appended.length > 0) {
    next = mapClip(next, targetClipId, (c) => ({ ...c, frames: [...c.frames, ...appended] }));
  }

  // R5: write composed cels into frames 0..n−1 (affected layers only);
  // frames ≥ n are left untouched; generated frames get durationMs 0 (R7).
  next = mapClip(next, targetClipId, (c) => ({
    ...c,
    frames: c.frames.map((frame, i) => {
      if (i >= n) return frame;
      const composed = plan.frames[i];
      const cels = { ...frame.cels };
      for (const layerId of affected) {
        const buf = composed.cels[layerId];
        if (buf) cels[layerId] = { buffer: buf, linked: false };
      }
      return { ...frame, durationMs: 0, cels };
    }),
  }));
  return next;
}
