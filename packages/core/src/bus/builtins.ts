/**
 * Built-in structural commands (v3.1 §2.4/§2.7).
 *
 * Structural edits record shallow document snapshots with copy-on-write
 * buffers (prototype mechanism kept — §2.5), so undo/redo are exact.
 * Deletes are trash-backed (C5/C9, cap 20): frame/layer/clip deletion moves
 * the item into project.trash; `trash.restore` puts it back.
 *
 * All commands are pure: (document in) → (new document out).
 */

import type {
  BlendMode,
  Cel,
  Clip,
  ClipTag,
  Frame,
  Layer,
  LayerModifiers,
  LoopMode,
  VectorShape,
} from '../types/document';
import { ONION_MAX } from '../types/document';
import { parseStyleProfile, type StyleProfile } from '../style-profile';
import { applyLayerModifiers, cloneLayerModifiers, validateLayerModifiers } from '../pixels/modifiers';
import {
  cloneVectorShapes,
  renderCelWithVectors,
  shiftVectorShapes,
  validateVectorShapes,
} from '../pixels/vectors';
import type { CommandDefinition } from '../types/commands';
import {
  findClip,
  findFrame,
  findLayer,
  mapClip,
  newLayerId,
  newTrashId,
  pushTrash,
  setCelEverywhere,
  takeTrash,
} from '../doc/access';
import { createClip, createFrame, createLayer, duplicateFrame } from '../doc/factory';
import { cloneBuffer } from '../util/buffers';
import { applyPixelOpsCommand } from './pixel-commands';
import { motionApply, partSet } from './motion-commands';
import { fail, failNotFound } from './errors';
import {
  assertObject,
  getHexColor,
  getInt,
  getLoopMode,
  getOptionalInt,
  getOptionalLoopMode,
  getOptionalString,
  getString,
  HEX_RE,
} from './validate';

// ---------------------------------------------------------------------------
// parse helpers (used by validate AND apply — validate throws, apply trusts)
// ---------------------------------------------------------------------------

function parseRef(p: Record<string, unknown>): { clipId: string } {
  return { clipId: getString(p, 'clipId', 'command payload') };
}

function parseFrameRef(p: Record<string, unknown>): { clipId: string; frameId: string } {
  return {
    clipId: getString(p, 'clipId', 'command payload'),
    frameId: getString(p, 'frameId', 'command payload'),
  };
}

function parseLayerRef(p: Record<string, unknown>): { clipId: string; layerId: string } {
  return {
    clipId: getString(p, 'clipId', 'command payload'),
    layerId: getString(p, 'layerId', 'command payload'),
  };
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

interface RenamePayload {
  name: string;
}

export const projectRename: CommandDefinition<RenamePayload> = {
  type: 'project.rename',
  defaultLabel: 'Rename project',
  validate(payload) {
    const p = assertObject(payload, 'project.rename');
    const name = getString(p, 'name', 'project.rename');
    if (name.length > 120) fail('project.rename: name too long (max 120)');
  },
  apply(payload, ctx) {
    return { project: { ...ctx.project, name: payload.name }, label: 'Rename project' };
  },
};

// ---------------------------------------------------------------------------
// clip
// ---------------------------------------------------------------------------

export const clipAdd: CommandDefinition<{ name?: string; fps?: number }> = {
  type: 'clip.add',
  defaultLabel: 'Add clip',
  validate(payload) {
    const p = assertObject(payload, 'clip.add');
    getOptionalString(p, 'name', 'clip.add');
    getOptionalInt(p, 'fps', 'clip.add', 1, 60);
  },
  apply(payload, ctx) {
    const name = payload.name?.trim() || `clip ${ctx.project.clips.length + 1}`;
    const clip = createClip({
      name,
      width: ctx.project.width,
      height: ctx.project.height,
      fps: payload.fps,
    });
    return {
      project: { ...ctx.project, clips: [...ctx.project.clips, clip] },
      label: 'Add clip',
    };
  },
};

export const clipDelete: CommandDefinition<{ clipId: string }> = {
  type: 'clip.delete',
  defaultLabel: 'Delete clip',
  validate(payload, ctx) {
    const p = assertObject(payload, 'clip.delete');
    const { clipId } = parseRef(p);
    if (ctx.project.clips.length <= 1) {
      fail('clip.delete: a project must keep at least one clip');
    }
    if (!findClip(ctx.project, clipId)) failNotFound(`clip.delete: clip "${clipId}" not found`);
  },
  apply(payload, ctx) {
    const idx = ctx.project.clips.findIndex((c) => c.id === payload.clipId);
    const clip = ctx.project.clips[idx];
    const trashEntry = {
      id: newTrashId(),
      label: `Clip "${clip.name}"`,
      deletedAt: Date.now(),
      item: { kind: 'clip' as const, clipIndex: idx, clip },
    };
    return {
      project: pushTrash(
        { ...ctx.project, clips: ctx.project.clips.filter((c) => c.id !== payload.clipId) },
        trashEntry
      ),
      label: 'Delete clip',
    };
  },
};

interface ClipSetPropsPayload {
  clipId: string;
  patch: { name?: string; fps?: number; loop?: boolean; loopMode?: LoopMode; tags?: ClipTag[] };
}

export const clipSetProps: CommandDefinition<ClipSetPropsPayload> = {
  type: 'clip.setProps',
  defaultLabel: 'Clip properties',
  validate(payload, ctx) {
    const p = assertObject(payload, 'clip.setProps');
    const { clipId } = parseRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`clip.setProps: clip "${clipId}" not found`);
    const patch = assertObject(p.patch, 'clip.setProps patch');
    const name = getOptionalString(patch, 'name', 'clip.setProps');
    if (name !== undefined && name.length > 120) fail('clip.setProps: name too long');
    getOptionalInt(patch, 'fps', 'clip.setProps', 1, 60);
    getOptionalLoopMode(patch, 'loopMode', 'clip.setProps');
    if (patch.tags !== undefined) {
      if (!Array.isArray(patch.tags)) fail('clip.setProps: tags must be an array');
      const maxIndex = Math.max(0, clip.frames.length - 1);
      for (const [i, tag] of patch.tags.entries()) {
        const t = assertObject(tag, `clip.setProps tags[${i}]`);
        const tagName = getString(t, 'name', `clip.setProps tags[${i}]`).trim();
        if (!tagName) fail(`clip.setProps tags[${i}]: name cannot be empty`);
        if (tagName.length > 64) fail(`clip.setProps tags[${i}]: name too long`);
        const from = getInt(t, 'from', `clip.setProps tags[${i}]`, 0, maxIndex);
        getInt(t, 'to', `clip.setProps tags[${i}]`, from, maxIndex);
      }
    }
  },
  apply(payload, ctx) {
    const { clipId, patch } = payload;
    return {
      project: mapClip(ctx.project, clipId, (c) => ({
        ...c,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.fps !== undefined ? { fps: Math.min(60, Math.max(1, Math.round(patch.fps))) } : {}),
        ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
        ...(patch.loopMode !== undefined ? { loopMode: patch.loopMode } : {}),
        ...(patch.tags !== undefined
          ? { tags: patch.tags.map((t) => ({ name: t.name.trim(), from: t.from, to: t.to })) }
          : {}),
      })),
      label: 'Clip properties',
    };
  },
};

export const clipSetTags: CommandDefinition<{ clipId: string; tags: ClipTag[] }> = {
  type: 'clip.setTags',
  defaultLabel: 'Set animation tags',
  validate(payload, ctx) {
    const p = assertObject(payload, 'clip.setTags');
    const { clipId } = parseRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`clip.setTags: clip "${clipId}" not found`);
    if (!Array.isArray(p.tags)) fail('clip.setTags: tags must be an array');
    const maxIndex = Math.max(0, clip.frames.length - 1);
    for (const [i, tag] of p.tags.entries()) {
      const t = assertObject(tag, `clip.setTags tags[${i}]`);
      const name = getString(t, 'name', `clip.setTags tags[${i}]`).trim();
      if (!name) fail(`clip.setTags tags[${i}]: name cannot be empty`);
      if (name.length > 64) fail(`clip.setTags tags[${i}]: name too long`);
      const from = getInt(t, 'from', `clip.setTags tags[${i}]`, 0, maxIndex);
      getInt(t, 'to', `clip.setTags tags[${i}]`, from, maxIndex);
    }
  },
  apply(payload, ctx) {
    const { clipId, tags } = payload;
    return {
      project: mapClip(ctx.project, clipId, (c) => ({
        ...c,
        tags: tags.map((t) => ({ name: t.name.trim(), from: t.from, to: t.to })),
      })),
      label: 'Set animation tags',
    };
  },
};

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------

export const frameAdd: CommandDefinition<{
  clipId: string;
  afterIndex?: number;
  copy?: boolean;
}> = {
  type: 'frame.add',
  defaultLabel: 'Add frame',
  validate(payload, ctx) {
    const p = assertObject(payload, 'frame.add');
    const { clipId } = parseRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`frame.add: clip "${clipId}" not found`);
    const afterIndex = getOptionalInt(p, 'afterIndex', 'frame.add', -1, clip.frames.length - 1);
    if (getOptionalInt(p, 'afterIndex', 'frame.add') !== undefined && afterIndex === undefined) {
      fail('frame.add: bad afterIndex');
    }
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const insertAt =
      payload.afterIndex !== undefined
        ? Math.min(Math.max(0, payload.afterIndex + 1), clip.frames.length)
        : clip.frames.length;
    const srcIndex =
      payload.afterIndex !== undefined
        ? Math.min(Math.max(0, payload.afterIndex), clip.frames.length - 1)
        : clip.frames.length - 1;
    const frame: Frame = payload.copy && clip.frames[srcIndex]
      ? duplicateFrame(clip.frames[srcIndex], clip.layers) // duplicate preserves cels exactly (§2.7)
      : createFrame(ctx.project.width, ctx.project.height, clip.layers);
    const frames = [...clip.frames.slice(0, insertAt), frame, ...clip.frames.slice(insertAt)];
    return {
      project: mapClip(ctx.project, clip.id, (c) => ({ ...c, frames })),
      label: payload.copy ? 'Duplicate frame' : 'Add frame',
    };
  },
};

export const frameDelete: CommandDefinition<{ clipId: string; frameIndex: number }> = {
  type: 'frame.delete',
  defaultLabel: 'Delete frame',
  validate(payload, ctx) {
    const p = assertObject(payload, 'frame.delete');
    const { clipId } = parseRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`frame.delete: clip "${clipId}" not found`);
    const index = getInt(p, 'frameIndex', 'frame.delete', 0, clip.frames.length - 1);
    if (clip.frames.length <= 1) fail('frame.delete: a clip must keep at least one frame');
    void index;
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const frame = clip.frames[payload.frameIndex];
    const frames = clip.frames.filter((_, i) => i !== payload.frameIndex);
    return {
      project: pushTrash(mapClip(ctx.project, clip.id, (c) => ({ ...c, frames })), {
        id: newTrashId(),
        label: `Frame ${payload.frameIndex + 1} of "${clip.name}"`,
        deletedAt: Date.now(),
        item: { kind: 'frame', clipId: clip.id, frameIndex: payload.frameIndex, frame },
      }),
      label: 'Delete frame',
    };
  },
};

export const frameMove: CommandDefinition<{ clipId: string; from: number; to: number }> = {
  type: 'frame.move',
  defaultLabel: 'Reorder frame',
  validate(payload, ctx) {
    const p = assertObject(payload, 'frame.move');
    const { clipId } = parseRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`frame.move: clip "${clipId}" not found`);
    getInt(p, 'from', 'frame.move', 0, clip.frames.length - 1);
    getInt(p, 'to', 'frame.move', 0, clip.frames.length - 1);
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    if (payload.from === payload.to) {
      return { project: ctx.project, label: 'Reorder frame' };
    }
    const frames = [...clip.frames];
    const [moved] = frames.splice(payload.from, 1);
    frames.splice(payload.to, 0, moved);
    return {
      project: mapClip(ctx.project, clip.id, (c) => ({ ...c, frames })),
      label: 'Reorder frame',
    };
  },
};

export const frameSetDuration: CommandDefinition<{
  clipId: string;
  frameId: string;
  durationMs: number;
}> = {
  type: 'frame.setDuration',
  defaultLabel: 'Frame duration',
  validate(payload, ctx) {
    const p = assertObject(payload, 'frame.setDuration');
    const { clipId, frameId } = parseFrameRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`frame.setDuration: clip "${clipId}" not found`);
    if (!findFrame(clip, frameId)) failNotFound(`frame.setDuration: frame "${frameId}" not found`);
    getInt(p, 'durationMs', 'frame.setDuration', 0, 60_000);
  },
  apply(payload, ctx) {
    return {
      project: mapClip(ctx.project, payload.clipId, (c) => ({
        ...c,
        frames: c.frames.map((f) =>
          f.id === payload.frameId ? { ...f, durationMs: payload.durationMs } : f
        ),
      })),
      label: 'Frame duration',
    };
  },
};

// ---------------------------------------------------------------------------
// layer (clip-wide stack ops — C1)
// ---------------------------------------------------------------------------

export const layerAdd: CommandDefinition<{ clipId: string; name?: string }> = {
  type: 'layer.add',
  defaultLabel: 'Add layer',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.add');
    const { clipId } = parseRef(p);
    if (!findClip(ctx.project, clipId)) failNotFound(`layer.add: clip "${clipId}" not found`);
    getOptionalString(p, 'name', 'layer.add');
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const layer = createLayer(payload.name?.trim() || `Layer ${clip.layers.length + 1}`);
    const layers = [...clip.layers, layer]; // top
    const project = mapClip(ctx.project, clip.id, (c) => ({
      ...c,
      layers,
      frames: c.frames.map((f) => ({
        ...f,
        cels: {
          ...f.cels,
          [layer.id]: { buffer: new Uint8ClampedArray(ctx.project.width * ctx.project.height * 4), linked: false },
        },
      })),
    }));
    return { project, label: 'Add layer' };
  },
};

export const layerDelete: CommandDefinition<{ clipId: string; layerId: string }> = {
  type: 'layer.delete',
  defaultLabel: 'Delete layer',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.delete');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.delete: clip "${clipId}" not found`);
    if (!findLayer(clip, layerId)) failNotFound(`layer.delete: layer "${layerId}" not found`);
    if (clip.layers.length <= 1) fail('layer.delete: a clip must keep at least one layer');
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const { layer, index } = findLayer(clip, payload.layerId) as { layer: Layer; index: number };
    const celsByFrameId: Record<string, Cel> = {};
    for (const f of clip.frames) {
      const cel = f.cels[layer.id];
      if (cel) celsByFrameId[f.id] = cel; // linked frames keep the shared reference
    }
    const project = mapClip(ctx.project, clip.id, (c) => ({
      ...c,
      layers: c.layers.filter((l) => l.id !== layer.id),
      frames: c.frames.map((f) => {
        if (!f.cels[layer.id]) return f;
        const cels = { ...f.cels };
        delete cels[layer.id];
        return { ...f, cels };
      }),
    }));
    return {
      project: pushTrash(project, {
        id: newTrashId(),
        label: `Layer "${layer.name}" of "${clip.name}"`,
        deletedAt: Date.now(),
        item: { kind: 'layer', clipId: clip.id, layerIndex: index, layer, celsByFrameId },
      }),
      label: 'Delete layer',
    };
  },
};

export const layerDuplicate: CommandDefinition<{ clipId: string; layerId: string }> = {
  type: 'layer.duplicate',
  defaultLabel: 'Duplicate layer',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.duplicate');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.duplicate: clip "${clipId}" not found`);
    if (!findLayer(clip, layerId)) failNotFound(`layer.duplicate: layer "${layerId}" not found`);
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const { layer, index } = findLayer(clip, payload.layerId) as { layer: Layer; index: number };
    const copy: Layer = { ...layer, id: newLayerId(), name: `${layer.name} copy`, linked: false };
    const layers = [...clip.layers.slice(0, index + 1), copy, ...clip.layers.slice(index + 1)];
    const project = mapClip(ctx.project, clip.id, (c) => ({
      ...c,
      layers,
      frames: c.frames.map((f) => {
        const src = f.cels[layer.id];
        if (!src) return f;
        return {
          ...f,
          cels: {
            ...f.cels,
            [copy.id]: {
              // Duplicate of a linked layer → independent per-frame copies.
              buffer: new Uint8ClampedArray(src.buffer),
              linked: false,
              ...(src.vectors && src.vectors.length > 0 ? { vectors: cloneVectorShapes(src.vectors) } : {}),
            },
          },
        };
      }),
    }));
    return { project, label: 'Duplicate layer' };
  },
};

/** Separable blend of one color channel: top (source) over bottom (backdrop), 0..255. */
export function blendChannel(mode: BlendMode | undefined, t: number, b: number): number {
  switch (mode) {
    case 'multiply':
      return Math.round((t * b) / 255);
    case 'screen':
      return Math.round(255 - ((255 - t) * (255 - b)) / 255);
    case 'overlay':
      return b < 128
        ? Math.round((2 * t * b) / 255)
        : Math.round(255 - (2 * (255 - t) * (255 - b)) / 255);
    case 'darken':
      return Math.min(t, b);
    case 'lighten':
      return Math.max(t, b);
    default:
      return t;
  }
}

/**
 * Alpha compositing of the top cel onto the one below, per frame (ported
 * from the prototype store's mergeDown). The top layer is removed; the
 * operation is undoable via the structural snapshot, so it is not
 * trash-backed (documented deviation from delete semantics).
 */
export const layerMergeDown: CommandDefinition<{ clipId: string; layerId: string }> = {
  type: 'layer.mergeDown',
  defaultLabel: 'Merge down',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.mergeDown');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.mergeDown: clip "${clipId}" not found`);
    const found = findLayer(clip, layerId);
    if (!found) failNotFound(`layer.mergeDown: layer "${layerId}" not found`);
    if (found.index === 0) fail('layer.mergeDown: nothing below the bottom layer');
    if (found.layer.linked) {
      fail('layer.mergeDown: merging a linked layer is not supported (unlink first — C2)');
    }
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const { index } = findLayer(clip, payload.layerId) as { layer: Layer; index: number };
    const { width, height } = ctx.project;
    const project = mapClip(ctx.project, clip.id, (c) => ({
      ...c,
      layers: c.layers.filter((_, i) => i !== index),
      frames: c.frames.map((f) => {
        const top = f.cels[payload.layerId];
        const bottomLayer = c.layers[index - 1];
        if (!bottomLayer) return f;
        const bottom = f.cels[bottomLayer.id];
        if (!top && !bottom) return f;
        // Missing cel = transparent (C2) — merge treats it as empty.
        const merged = bottom
          ? new Uint8ClampedArray(bottom.buffer)
          : new Uint8ClampedArray(width * height * 4);
        if (top) {
          const topLayer = c.layers[index];
          const mode = topLayer?.blend;
          const topWithVecs = renderCelWithVectors(top, width, height);
          const topBuf = applyLayerModifiers(topWithVecs, width, height, topLayer?.modifiers);
          for (let i = 0; i < width * height; i++) {
            const ta = (topBuf[i * 4 + 3] / 255) * (top.linked ? 1 : (topLayer?.opacity ?? 1));
            if (ta >= 1) {
              for (let ch = 0; ch < 3; ch++) {
                merged[i * 4 + ch] = blendChannel(mode, topBuf[i * 4 + ch], merged[i * 4 + ch]);
              }
              merged[i * 4 + 3] = topBuf[i * 4 + 3];
            } else if (ta > 0) {
              const ba = merged[i * 4 + 3] / 255;
              const outA = ta + ba * (1 - ta);
              if (outA === 0) continue;
              for (let ch = 0; ch < 3; ch++) {
                const blended = blendChannel(mode, topBuf[i * 4 + ch], merged[i * 4 + ch]);
                merged[i * 4 + ch] = Math.round(
                  (blended * ta + merged[i * 4 + ch] * ba * (1 - ta)) / outA
                );
              }
              merged[i * 4 + 3] = Math.round(outA * 255);
            }
          }
        }
        return {
          ...f,
          cels: {
            ...f.cels,
            [bottomLayer.id]: {
              buffer: merged,
              linked: false,
              ...(bottom?.vectors && bottom.vectors.length > 0 ? { vectors: cloneVectorShapes(bottom.vectors) } : {}),
            },
          },
        };
      }),
    }));
    // Remove the top layer's cels everywhere.
    const cleaned = mapClip(project, clip.id, (c) => ({
      ...c,
      frames: c.frames.map((f) => {
        if (!f.cels[payload.layerId]) return f;
        const cels = { ...f.cels };
        delete cels[payload.layerId];
        return { ...f, cels };
      }),
    }));
    return { project: cleaned, label: 'Merge down' };
  },
};

export const layerMove: CommandDefinition<{ clipId: string; layerId: string; dir: -1 | 1 }> = {
  type: 'layer.move',
  defaultLabel: 'Reorder layer',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.move');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.move: clip "${clipId}" not found`);
    if (!findLayer(clip, layerId)) failNotFound(`layer.move: layer "${layerId}" not found`);
    const dir = p.dir;
    if (dir !== -1 && dir !== 1) fail('layer.move: dir must be -1 or 1');
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const { index } = findLayer(clip, payload.layerId) as { layer: Layer; index: number };
    const to = index + payload.dir;
    if (to < 0 || to >= clip.layers.length) {
      return { project: ctx.project, label: 'Reorder layer' };
    }
    const layers = [...clip.layers];
    const [moved] = layers.splice(index, 1);
    layers.splice(to, 0, moved);
    // Cel keys are layer ids — reordering the stack needs no cel changes.
    return { project: mapClip(ctx.project, clip.id, (c) => ({ ...c, layers })), label: 'Reorder layer' };
  },
};

interface LayerSetPropsPayload {
  clipId: string;
  layerId: string;
  patch: {
    name?: string;
    visible?: boolean;
    opacity?: number;
    locked?: boolean;
    blend?: BlendMode;
    modifiers?: LayerModifiers | null;
  };
}

export const layerSetProps: CommandDefinition<LayerSetPropsPayload> = {
  type: 'layer.setProps',
  defaultLabel: 'Layer properties',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.setProps');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.setProps: clip "${clipId}" not found`);
    if (!findLayer(clip, layerId)) failNotFound(`layer.setProps: layer "${layerId}" not found`);
    const patch = assertObject(p.patch, 'layer.setProps patch');
    const name = getOptionalString(patch, 'name', 'layer.setProps');
    if (name !== undefined && name.length > 120) fail('layer.setProps: name too long');
    const opacity = patch.opacity;
    if (opacity !== undefined && (typeof opacity !== 'number' || opacity < 0 || opacity > 1)) {
      fail('layer.setProps: opacity must be 0..1');
    }
    if (patch.locked !== undefined && typeof patch.locked !== 'boolean') {
      fail('layer.setProps: locked must be boolean');
    }
    if (
      patch.blend !== undefined &&
      !(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'] as string[]).includes(patch.blend as string)
    ) {
      fail('layer.setProps: unknown blend mode');
    }
    if (patch.modifiers !== undefined && patch.modifiers !== null) {
      const modErr = validateLayerModifiers(patch.modifiers);
      if (modErr) fail(`layer.setProps: invalid modifiers (${modErr})`);
    }
  },
  apply(payload, ctx) {
    const { clipId, layerId, patch } = payload;
    return {
      project: mapClip(ctx.project, clipId, (c) => ({
        ...c,
        layers: c.layers.map((l) => {
          if (l.id !== layerId) return l;
          const next: Layer = {
            ...l,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
            ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
            ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
            ...(patch.blend !== undefined ? { blend: patch.blend } : {}),
          };
          if (patch.modifiers === null) {
            delete next.modifiers;
          } else if (patch.modifiers !== undefined) {
            next.modifiers = cloneLayerModifiers(patch.modifiers);
          }
          return next;
        }),
      })),
      label: 'Layer properties',
    };
  },
};

export const layerReorder: CommandDefinition<{ clipId: string; layerId: string; to: number }> = {
  type: 'layer.reorder',
  defaultLabel: 'Reorder layer',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.reorder');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.reorder: clip "${clipId}" not found`);
    if (!findLayer(clip, layerId)) failNotFound(`layer.reorder: layer "${layerId}" not found`);
    const to = p.to;
    if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to >= clip.layers.length) {
      fail('layer.reorder: to must be an in-range layer index');
    }
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const { index } = findLayer(clip, payload.layerId) as { layer: Layer; index: number };
    if (index === payload.to) {
      return { project: ctx.project, label: 'Reorder layer' };
    }
    const layers = [...clip.layers];
    const [moved] = layers.splice(index, 1);
    layers.splice(payload.to, 0, moved);
    // Cel keys are layer ids — reordering the stack needs no cel changes.
    return { project: mapClip(ctx.project, clip.id, (c) => ({ ...c, layers })), label: 'Reorder layer' };
  },
};

/**
 * Linked-cel engine switch (C2/C19 — P0 engine support; UI toggle is P2).
 * ON  → pick the anchor frame's cel (first frame holding one) and share it
 *        across ALL frames (content of other frames collapses to the anchor).
 * OFF → break sharing: every frame gets an independent deep copy.
 */
export const layerSetLinked: CommandDefinition<{ clipId: string; layerId: string; linked: boolean }> = {
  type: 'layer.setLinked',
  defaultLabel: 'Linked cel',
  validate(payload, ctx) {
    const p = assertObject(payload, 'layer.setLinked');
    const { clipId, layerId } = parseLayerRef(p);
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`layer.setLinked: clip "${clipId}" not found`);
    if (!findLayer(clip, layerId)) failNotFound(`layer.setLinked: layer "${layerId}" not found`);
    if (typeof p.linked !== 'boolean') fail('layer.setLinked: "linked" must be a boolean');
  },
  apply(payload, ctx) {
    const clip = findClip(ctx.project, payload.clipId) as Clip;
    const { layer } = findLayer(clip, payload.layerId) as { layer: Layer; index: number };
    if (payload.linked === layer.linked) {
      return { project: ctx.project, label: 'Linked cel' };
    }
    if (payload.linked) {
      // Anchor = first frame that has a cel (else first frame → create).
      const anchorFrame = clip.frames.find((f) => f.cels[layer.id]) ?? clip.frames[0];
      if (!anchorFrame) fail('layer.setLinked: clip has no frames');
      const existing = anchorFrame.cels[layer.id];
      const shared: Cel = existing
        ? { buffer: existing.buffer, linked: true }
        : { buffer: new Uint8ClampedArray(ctx.project.width * ctx.project.height * 4), linked: true };
      const withFlag = mapClip(ctx.project, clip.id, (c) => ({
        ...c,
        layers: c.layers.map((l) => (l.id === layer.id ? { ...l, linked: true } : l)),
      }));
      return {
        project: setCelEverywhere(withFlag, clip.id, layer.id, shared),
        label: 'Link cel (shared)',
      };
    }
    // Unlink: give every frame its own copy of the current shared buffer.
    const project = mapClip(ctx.project, clip.id, (c) => ({
      ...c,
      layers: c.layers.map((l) => (l.id === layer.id ? { ...l, linked: false } : l)),
    }));
    const withCopies = mapClip(project, clip.id, (c) => ({
      ...c,
      frames: c.frames.map((f) => {
        const cel = f.cels[layer.id];
        if (!cel) return f;
        return { ...f, cels: { ...f.cels, [layer.id]: { buffer: cloneBuffer(cel.buffer), linked: false } } };
      }),
    }));
    return { project: withCopies, label: 'Unlink cel' };
  },
};

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

export const paletteAddColor: CommandDefinition<{ hex: string }> = {
  type: 'palette.addColor',
  defaultLabel: 'Add palette color',
  validate(payload) {
    const p = assertObject(payload, 'palette.addColor');
    getHexColor(p, 'hex', 'palette.addColor');
  },
  apply(payload, ctx) {
    const hex = payload.hex.toLowerCase();
    if (ctx.project.palette.includes(hex)) {
      return { project: ctx.project, label: 'Add palette color' };
    }
    return {
      project: { ...ctx.project, palette: [...ctx.project.palette, hex] },
      label: 'Add palette color',
    };
  },
};

export const paletteRemoveColor: CommandDefinition<{ hex: string }> = {
  type: 'palette.removeColor',
  defaultLabel: 'Remove palette color',
  validate(payload, ctx) {
    const p = assertObject(payload, 'palette.removeColor');
    const hex = getHexColor(p, 'hex', 'palette.removeColor');
    if (!ctx.project.palette.includes(hex)) {
      failNotFound(`palette.removeColor: "${hex}" not in palette`);
    }
  },
  apply(payload, ctx) {
    const hex = payload.hex.toLowerCase();
    return {
      project: { ...ctx.project, palette: ctx.project.palette.filter((c) => c !== hex) },
      label: 'Remove palette color',
    };
  },
};

/** Replace the whole document palette in one undoable step (preset apply). */
export const paletteReplaceAll: CommandDefinition<{ colors: string[] }> = {
  type: 'palette.replaceAll',
  defaultLabel: 'Replace palette',
  validate(payload) {
    const p = assertObject(payload, 'palette.replaceAll');
    if (!Array.isArray(p.colors) || p.colors.length === 0) {
      fail(`palette.replaceAll: "colors" must be a non-empty array of hex colors`);
    }
    for (const c of p.colors as unknown[]) {
      if (typeof c !== 'string' || !HEX_RE.test(c)) {
        fail(`palette.replaceAll: every color must be a hex string like #rrggbb`);
      }
    }
  },
  apply(payload, ctx) {
    // normalize + dedupe, keep first occurrence order
    const seen = new Set<string>();
    const colors: string[] = [];
    for (const c of payload.colors) {
      const hex = c.toLowerCase();
      if (!seen.has(hex)) {
        seen.add(hex);
        colors.push(hex);
      }
    }
    return {
      project: { ...ctx.project, palette: colors },
      label: 'Replace palette',
    };
  },
};

// ---------------------------------------------------------------------------
// trash
// ---------------------------------------------------------------------------

export const trashRestore: CommandDefinition<{ entryId: string }> = {
  type: 'trash.restore',
  defaultLabel: 'Restore from trash',
  validate(payload, ctx) {
    const p = assertObject(payload, 'trash.restore');
    const entryId = getString(p, 'entryId', 'trash.restore');
    if (!ctx.project.trash.some((t) => t.id === entryId)) {
      failNotFound(`trash.restore: entry "${entryId}" not found`);
    }
  },
  apply(payload, ctx) {
    const taken = takeTrash(ctx.project, payload.entryId);
    if (!taken) failNotFound('trash.restore: entry vanished');
    const { entry, project: without } = taken;
    const item = entry.item;
    if (item.kind === 'frame') {
      const clip = findClip(without, item.clipId);
      if (!clip) failNotFound('trash.restore: owning clip no longer exists');
      const index = Math.min(Math.max(0, item.frameIndex), clip.frames.length);
      return {
        project: mapClip(without, clip.id, (c) => ({
          ...c,
          frames: [...c.frames.slice(0, index), item.frame, ...c.frames.slice(index)],
        })),
        label: 'Restore frame',
      };
    }
    if (item.kind === 'layer') {
      const clip = findClip(without, item.clipId);
      if (!clip) failNotFound('trash.restore: owning clip no longer exists');
      const index = Math.min(Math.max(0, item.layerIndex), clip.layers.length);
      const layers = [...clip.layers.slice(0, index), item.layer, ...clip.layers.slice(index)];
      const restored = mapClip(without, clip.id, (c) => ({ ...c, layers }));
      // Restore cels to the frames they came from (missing frame ids skipped).
      const withCels = mapClip(restored, clip.id, (c) => ({
        ...c,
        frames: c.frames.map((f) => {
          const cel = item.celsByFrameId[f.id];
          if (!cel) return f;
          return { ...f, cels: { ...f.cels, [item.layer.id]: cel } };
        }),
      }));
      return { project: withCels, label: 'Restore layer' };
    }
    const index = Math.min(Math.max(0, item.clipIndex), without.clips.length);
    const clips = [...without.clips.slice(0, index), item.clip, ...without.clips.slice(index)];
    return { project: { ...without, clips }, label: 'Restore clip' };
  },
};

export const trashPurge: CommandDefinition<{ entryId: string }> = {
  type: 'trash.purge',
  defaultLabel: 'Empty trash entry',
  validate(payload, ctx) {
    const p = assertObject(payload, 'trash.purge');
    const entryId = getString(p, 'entryId', 'trash.purge');
    if (!ctx.project.trash.some((t) => t.id === entryId)) {
      failNotFound(`trash.purge: entry "${entryId}" not found`);
    }
  },
  apply(payload, ctx) {
    const taken = takeTrash(ctx.project, payload.entryId);
    if (!taken) return { project: ctx.project, label: 'Empty trash entry' };
    return { project: taken.project, label: 'Empty trash entry' };
  },
};

export const canvasResize: CommandDefinition<{
  width: number;
  height: number;
  anchor?: 'top-left' | 'center';
}> = {
  type: 'canvas.resize',
  defaultLabel: 'Resize canvas',
  validate(payload, ctx) {
    const p = assertObject(payload, 'canvas.resize');
    const width = getInt(p, 'width', 'canvas.resize');
    const height = getInt(p, 'height', 'canvas.resize');
    // Core allows 1..512 (tiny sprites are legit); the MCP tool schema keeps
    // the documented 16..256 surface on top of this.
    if (width < 1 || width > 512 || height < 1 || height > 512) {
      fail('canvas.resize: width/height must be 1..512');
    }
    const anchor = p.anchor;
    if (anchor !== undefined && anchor !== 'top-left' && anchor !== 'center') {
      fail('canvas.resize: anchor must be "top-left" or "center"');
    }
    if (width === ctx.project.width && height === ctx.project.height) {
      fail('canvas.resize: canvas is already that size');
    }
  },
  apply(payload, ctx) {
    const from = ctx.project;
    const { width, height } = payload;
    const anchor = payload.anchor ?? 'top-left';
    if (width === from.width && height === from.height) {
      return { project: from, label: 'Resize canvas' };
    }
    const offsetX = anchor === 'center' ? Math.floor((width - from.width) / 2) : 0;
    const offsetY = anchor === 'center' ? Math.floor((height - from.height) / 2) : 0;
    // Linked cels share one buffer — remap each unique buffer once so linked
    // layers stay linked after the resize.
    const seen = new Map<Uint8ClampedArray, Uint8ClampedArray>();
    const remap = (buf: Uint8ClampedArray): Uint8ClampedArray => {
      const hit = seen.get(buf);
      if (hit) return hit;
      const out = new Uint8ClampedArray(width * height * 4);
      const sy0 = Math.max(0, -offsetY);
      const sy1 = Math.min(from.height, height - offsetY);
      const sx0 = Math.max(0, -offsetX);
      const sx1 = Math.min(from.width, width - offsetX);
      for (let y = sy0; y < sy1; y++) {
        const srcRow = y * from.width;
        const dstRow = (y + offsetY) * width;
        for (let x = sx0; x < sx1; x++) {
          const si = (srcRow + x) * 4;
          const di = (dstRow + x + offsetX) * 4;
          out[di] = buf[si];
          out[di + 1] = buf[si + 1];
          out[di + 2] = buf[si + 2];
          out[di + 3] = buf[si + 3];
        }
      }
      seen.set(buf, out);
      return out;
    };
    const clips = from.clips.map((clip) => ({
      ...clip,
      frames: clip.frames.map((frame) => ({
        ...frame,
        cels: Object.fromEntries(
          Object.entries(frame.cels).map(([layerId, cel]) => {
            const shiftedVecs = shiftVectorShapes(cel.vectors, offsetX, offsetY);
            return [
              layerId,
              {
                ...cel,
                buffer: remap(cel.buffer),
                ...(shiftedVecs ? { vectors: shiftedVecs } : {}),
              },
            ];
          }),
        ),
      })),
    }));
    return {
      project: { ...from, width, height, clips },
      label: `Resize canvas to ${width}×${height} (${anchor})`,
    };
  },
};

// ---------------------------------------------------------------------------
// document settings (Task 6: onion-skin range is document data — persisted
// in project.json, undoable like every other structural change)
// ---------------------------------------------------------------------------

export const settingsSetOnion: CommandDefinition<{
  prev?: number;
  next?: number;
}> = {
  type: 'settings.setOnion',
  defaultLabel: 'Onion skin range',
  validate(payload) {
    const p = assertObject(payload, 'settings.setOnion');
    const prev = getOptionalInt(p, 'prev', 'settings.setOnion', 0, ONION_MAX);
    const next = getOptionalInt(p, 'next', 'settings.setOnion', 0, ONION_MAX);
    if (prev === undefined && next === undefined) {
      fail('settings.setOnion: patch is empty');
    }
  },
  apply(payload, ctx) {
    const onion = ctx.project.settings.onion;
    const prev = payload.prev ?? onion.prev;
    const next = payload.next ?? onion.next;
    return {
      project: {
        ...ctx.project,
        settings: { ...ctx.project.settings, onion: { prev, next } },
      },
      label: 'Onion skin range',
    };
  },
};

/** Persist the shared AI/style contract as an undoable document setting. */
export const settingsSetStyleProfile: CommandDefinition<{ profile: StyleProfile }> = {
  type: 'settings.setStyleProfile',
  defaultLabel: 'Update style profile',
  validate(payload) {
    const p = assertObject(payload, 'settings.setStyleProfile');
    if (!parseStyleProfile(p.profile)) {
      fail('settings.setStyleProfile: "profile" must be a valid bounded style profile');
    }
  },
  apply(payload, ctx) {
    const profile = parseStyleProfile(payload.profile);
    if (!profile) fail('settings.setStyleProfile: invalid profile');
    return {
      project: {
        ...ctx.project,
        settings: { ...ctx.project.settings, styleProfile: profile },
      },
      label: 'Update style profile',
    };
  },
};

// ---------------------------------------------------------------------------
// non-destructive cel vectors (pixel-perfect editable lines/curves/shapes)
// ---------------------------------------------------------------------------

export const celSetVectors: CommandDefinition<{
  clipId: string;
  frameId: string;
  layerId: string;
  vectors: VectorShape[];
}> = {
  type: 'cel.setVectors',
  defaultLabel: 'Edit vectors',
  validate(payload, ctx) {
    const p = assertObject(payload, 'cel.setVectors');
    const clipId = getString(p, 'clipId', 'cel.setVectors');
    const frameId = getString(p, 'frameId', 'cel.setVectors');
    const layerId = getString(p, 'layerId', 'cel.setVectors');
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`cel.setVectors: clip "${clipId}" not found`);
    if (!findFrame(clip, frameId)) failNotFound(`cel.setVectors: frame "${frameId}" not found`);
    const found = findLayer(clip, layerId);
    if (!found) failNotFound(`cel.setVectors: layer "${layerId}" not found`);
    if (found.layer.locked) fail('cel.setVectors: layer is locked');
    const err = validateVectorShapes(p.vectors);
    if (err) fail(`cel.setVectors: ${err}`);
  },
  apply(payload, ctx) {
    const { clipId, frameId, layerId, vectors } = payload;
    const clip = findClip(ctx.project, clipId) as Clip;
    const found = findLayer(clip, layerId) as { layer: Layer; index: number };
    const frame = findFrame(clip, frameId) as Frame;
    const existing = frame.cels[layerId];
    const cloned = cloneVectorShapes(vectors);
    const nextCel: Cel = {
      buffer: existing ? existing.buffer : new Uint8ClampedArray(ctx.project.width * ctx.project.height * 4),
      linked: found.layer.linked,
      ...(cloned ? { vectors: cloned } : {}),
    };
    const project = found.layer.linked
      ? setCelEverywhere(ctx.project, clipId, layerId, nextCel)
      : mapClip(ctx.project, clipId, (c) => ({
          ...c,
          frames: c.frames.map((f) =>
            f.id === frameId ? { ...f, cels: { ...f.cels, [layerId]: nextCel } } : f,
          ),
        }));
    return { project, label: 'Edit vectors' };
  },
};

export const celBakeVectors: CommandDefinition<{
  clipId: string;
  frameId: string;
  layerId: string;
}> = {
  type: 'cel.bakeVectors',
  defaultLabel: 'Bake vectors to pixels',
  validate(payload, ctx) {
    const p = assertObject(payload, 'cel.bakeVectors');
    const clipId = getString(p, 'clipId', 'cel.bakeVectors');
    const frameId = getString(p, 'frameId', 'cel.bakeVectors');
    const layerId = getString(p, 'layerId', 'cel.bakeVectors');
    const clip = findClip(ctx.project, clipId);
    if (!clip) failNotFound(`cel.bakeVectors: clip "${clipId}" not found`);
    if (!findFrame(clip, frameId)) failNotFound(`cel.bakeVectors: frame "${frameId}" not found`);
    const found = findLayer(clip, layerId);
    if (!found) failNotFound(`cel.bakeVectors: layer "${layerId}" not found`);
    if (found.layer.locked) fail('cel.bakeVectors: layer is locked');
  },
  apply(payload, ctx) {
    const { clipId, frameId, layerId } = payload;
    const clip = findClip(ctx.project, clipId) as Clip;
    const found = findLayer(clip, layerId) as { layer: Layer; index: number };
    const frame = findFrame(clip, frameId) as Frame;
    const existing = frame.cels[layerId];
    if (!existing || !existing.vectors || existing.vectors.length === 0) {
      return { project: ctx.project, label: 'Bake vectors to pixels' };
    }
    const baked = new Uint8ClampedArray(renderCelWithVectors(existing, ctx.project.width, ctx.project.height));
    const nextCel: Cel = { buffer: baked, linked: found.layer.linked };
    const project = found.layer.linked
      ? setCelEverywhere(ctx.project, clipId, layerId, nextCel)
      : mapClip(ctx.project, clipId, (c) => ({
          ...c,
          frames: c.frames.map((f) =>
            f.id === frameId ? { ...f, cels: { ...f.cels, [layerId]: nextCel } } : f,
          ),
        }));
    return { project, label: 'Bake vectors to pixels' };
  },
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export function builtinCommands(): CommandDefinition<never>[] {
  return [
    projectRename,
    clipAdd,
    clipDelete,
    clipSetProps,
    clipSetTags,
    frameAdd,
    frameDelete,
    frameMove,
    frameSetDuration,
    layerAdd,
    layerDelete,
    layerDuplicate,
    layerMergeDown,
    layerMove,
    layerReorder,
    layerSetProps,
    layerSetLinked,
    celSetVectors,
    celBakeVectors,
    paletteAddColor,
    paletteRemoveColor,
    paletteReplaceAll,
    settingsSetOnion,
    settingsSetStyleProfile,
    trashRestore,
    trashPurge,
    canvasResize,
    // Pixel-editing path (same tile-diff history as strokes):
    applyPixelOpsCommand,
    // Motion presets (Task 10, v3.1 §4.1): part tagging + deterministic composer
    partSet,
    motionApply,
  ] as unknown as CommandDefinition<never>[];
}
