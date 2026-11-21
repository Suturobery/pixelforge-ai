"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsSetStyleProfile = exports.settingsSetOnion = exports.canvasResize = exports.trashPurge = exports.trashRestore = exports.paletteReplaceAll = exports.paletteRemoveColor = exports.paletteAddColor = exports.layerSetLinked = exports.layerReorder = exports.layerSetProps = exports.layerMove = exports.layerMergeDown = exports.layerDuplicate = exports.layerDelete = exports.layerAdd = exports.frameSetDuration = exports.frameMove = exports.frameDelete = exports.frameAdd = exports.clipSetProps = exports.clipDelete = exports.clipAdd = exports.projectRename = void 0;
exports.blendChannel = blendChannel;
exports.builtinCommands = builtinCommands;
const document_1 = require("../types/document");
const style_profile_1 = require("../style-profile");
const access_1 = require("../doc/access");
const factory_1 = require("../doc/factory");
const buffers_1 = require("../util/buffers");
const pixel_commands_1 = require("./pixel-commands");
const motion_commands_1 = require("./motion-commands");
const errors_1 = require("./errors");
const validate_1 = require("./validate");
// ---------------------------------------------------------------------------
// parse helpers (used by validate AND apply — validate throws, apply trusts)
// ---------------------------------------------------------------------------
function parseRef(p) {
    return { clipId: (0, validate_1.getString)(p, 'clipId', 'command payload') };
}
function parseFrameRef(p) {
    return {
        clipId: (0, validate_1.getString)(p, 'clipId', 'command payload'),
        frameId: (0, validate_1.getString)(p, 'frameId', 'command payload'),
    };
}
function parseLayerRef(p) {
    return {
        clipId: (0, validate_1.getString)(p, 'clipId', 'command payload'),
        layerId: (0, validate_1.getString)(p, 'layerId', 'command payload'),
    };
}
exports.projectRename = {
    type: 'project.rename',
    defaultLabel: 'Rename project',
    validate(payload) {
        const p = (0, validate_1.assertObject)(payload, 'project.rename');
        const name = (0, validate_1.getString)(p, 'name', 'project.rename');
        if (name.length > 120)
            (0, errors_1.fail)('project.rename: name too long (max 120)');
    },
    apply(payload, ctx) {
        return { project: { ...ctx.project, name: payload.name }, label: 'Rename project' };
    },
};
// ---------------------------------------------------------------------------
// clip
// ---------------------------------------------------------------------------
exports.clipAdd = {
    type: 'clip.add',
    defaultLabel: 'Add clip',
    validate(payload) {
        const p = (0, validate_1.assertObject)(payload, 'clip.add');
        (0, validate_1.getOptionalString)(p, 'name', 'clip.add');
        (0, validate_1.getOptionalInt)(p, 'fps', 'clip.add', 1, 60);
    },
    apply(payload, ctx) {
        const name = payload.name?.trim() || `clip ${ctx.project.clips.length + 1}`;
        const clip = (0, factory_1.createClip)({
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
exports.clipDelete = {
    type: 'clip.delete',
    defaultLabel: 'Delete clip',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'clip.delete');
        const { clipId } = parseRef(p);
        if (ctx.project.clips.length <= 1) {
            (0, errors_1.fail)('clip.delete: a project must keep at least one clip');
        }
        if (!(0, access_1.findClip)(ctx.project, clipId))
            (0, errors_1.failNotFound)(`clip.delete: clip "${clipId}" not found`);
    },
    apply(payload, ctx) {
        const idx = ctx.project.clips.findIndex((c) => c.id === payload.clipId);
        const clip = ctx.project.clips[idx];
        const trashEntry = {
            id: (0, access_1.newTrashId)(),
            label: `Clip "${clip.name}"`,
            deletedAt: Date.now(),
            item: { kind: 'clip', clipIndex: idx, clip },
        };
        return {
            project: (0, access_1.pushTrash)({ ...ctx.project, clips: ctx.project.clips.filter((c) => c.id !== payload.clipId) }, trashEntry),
            label: 'Delete clip',
        };
    },
};
exports.clipSetProps = {
    type: 'clip.setProps',
    defaultLabel: 'Clip properties',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'clip.setProps');
        const { clipId } = parseRef(p);
        if (!(0, access_1.findClip)(ctx.project, clipId))
            (0, errors_1.failNotFound)(`clip.setProps: clip "${clipId}" not found`);
        const patch = (0, validate_1.assertObject)(p.patch, 'clip.setProps patch');
        const name = (0, validate_1.getOptionalString)(patch, 'name', 'clip.setProps');
        if (name !== undefined && name.length > 120)
            (0, errors_1.fail)('clip.setProps: name too long');
        (0, validate_1.getOptionalInt)(patch, 'fps', 'clip.setProps', 1, 60);
        (0, validate_1.getOptionalLoopMode)(patch, 'loopMode', 'clip.setProps');
    },
    apply(payload, ctx) {
        const { clipId, patch } = payload;
        return {
            project: (0, access_1.mapClip)(ctx.project, clipId, (c) => ({
                ...c,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.fps !== undefined ? { fps: Math.min(60, Math.max(1, Math.round(patch.fps))) } : {}),
                ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
                ...(patch.loopMode !== undefined ? { loopMode: patch.loopMode } : {}),
            })),
            label: 'Clip properties',
        };
    },
};
// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
exports.frameAdd = {
    type: 'frame.add',
    defaultLabel: 'Add frame',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'frame.add');
        const { clipId } = parseRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`frame.add: clip "${clipId}" not found`);
        const afterIndex = (0, validate_1.getOptionalInt)(p, 'afterIndex', 'frame.add', -1, clip.frames.length - 1);
        if ((0, validate_1.getOptionalInt)(p, 'afterIndex', 'frame.add') !== undefined && afterIndex === undefined) {
            (0, errors_1.fail)('frame.add: bad afterIndex');
        }
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const insertAt = payload.afterIndex !== undefined
            ? Math.min(Math.max(0, payload.afterIndex + 1), clip.frames.length)
            : clip.frames.length;
        const srcIndex = payload.afterIndex !== undefined
            ? Math.min(Math.max(0, payload.afterIndex), clip.frames.length - 1)
            : clip.frames.length - 1;
        const frame = payload.copy && clip.frames[srcIndex]
            ? (0, factory_1.duplicateFrame)(clip.frames[srcIndex], clip.layers) // duplicate preserves cels exactly (§2.7)
            : (0, factory_1.createFrame)(ctx.project.width, ctx.project.height, clip.layers);
        const frames = [...clip.frames.slice(0, insertAt), frame, ...clip.frames.slice(insertAt)];
        return {
            project: (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({ ...c, frames })),
            label: payload.copy ? 'Duplicate frame' : 'Add frame',
        };
    },
};
exports.frameDelete = {
    type: 'frame.delete',
    defaultLabel: 'Delete frame',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'frame.delete');
        const { clipId } = parseRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`frame.delete: clip "${clipId}" not found`);
        const index = (0, validate_1.getInt)(p, 'frameIndex', 'frame.delete', 0, clip.frames.length - 1);
        if (clip.frames.length <= 1)
            (0, errors_1.fail)('frame.delete: a clip must keep at least one frame');
        void index;
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const frame = clip.frames[payload.frameIndex];
        const frames = clip.frames.filter((_, i) => i !== payload.frameIndex);
        return {
            project: (0, access_1.pushTrash)((0, access_1.mapClip)(ctx.project, clip.id, (c) => ({ ...c, frames })), {
                id: (0, access_1.newTrashId)(),
                label: `Frame ${payload.frameIndex + 1} of "${clip.name}"`,
                deletedAt: Date.now(),
                item: { kind: 'frame', clipId: clip.id, frameIndex: payload.frameIndex, frame },
            }),
            label: 'Delete frame',
        };
    },
};
exports.frameMove = {
    type: 'frame.move',
    defaultLabel: 'Reorder frame',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'frame.move');
        const { clipId } = parseRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`frame.move: clip "${clipId}" not found`);
        (0, validate_1.getInt)(p, 'from', 'frame.move', 0, clip.frames.length - 1);
        (0, validate_1.getInt)(p, 'to', 'frame.move', 0, clip.frames.length - 1);
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        if (payload.from === payload.to) {
            return { project: ctx.project, label: 'Reorder frame' };
        }
        const frames = [...clip.frames];
        const [moved] = frames.splice(payload.from, 1);
        frames.splice(payload.to, 0, moved);
        return {
            project: (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({ ...c, frames })),
            label: 'Reorder frame',
        };
    },
};
exports.frameSetDuration = {
    type: 'frame.setDuration',
    defaultLabel: 'Frame duration',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'frame.setDuration');
        const { clipId, frameId } = parseFrameRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`frame.setDuration: clip "${clipId}" not found`);
        if (!(0, access_1.findFrame)(clip, frameId))
            (0, errors_1.failNotFound)(`frame.setDuration: frame "${frameId}" not found`);
        (0, validate_1.getInt)(p, 'durationMs', 'frame.setDuration', 0, 60_000);
    },
    apply(payload, ctx) {
        return {
            project: (0, access_1.mapClip)(ctx.project, payload.clipId, (c) => ({
                ...c,
                frames: c.frames.map((f) => f.id === payload.frameId ? { ...f, durationMs: payload.durationMs } : f),
            })),
            label: 'Frame duration',
        };
    },
};
// ---------------------------------------------------------------------------
// layer (clip-wide stack ops — C1)
// ---------------------------------------------------------------------------
exports.layerAdd = {
    type: 'layer.add',
    defaultLabel: 'Add layer',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.add');
        const { clipId } = parseRef(p);
        if (!(0, access_1.findClip)(ctx.project, clipId))
            (0, errors_1.failNotFound)(`layer.add: clip "${clipId}" not found`);
        (0, validate_1.getOptionalString)(p, 'name', 'layer.add');
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const layer = (0, factory_1.createLayer)(payload.name?.trim() || `Layer ${clip.layers.length + 1}`);
        const layers = [...clip.layers, layer]; // top
        const project = (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({
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
exports.layerDelete = {
    type: 'layer.delete',
    defaultLabel: 'Delete layer',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.delete');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.delete: clip "${clipId}" not found`);
        if (!(0, access_1.findLayer)(clip, layerId))
            (0, errors_1.failNotFound)(`layer.delete: layer "${layerId}" not found`);
        if (clip.layers.length <= 1)
            (0, errors_1.fail)('layer.delete: a clip must keep at least one layer');
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const { layer, index } = (0, access_1.findLayer)(clip, payload.layerId);
        const celsByFrameId = {};
        for (const f of clip.frames) {
            const cel = f.cels[layer.id];
            if (cel)
                celsByFrameId[f.id] = cel; // linked frames keep the shared reference
        }
        const project = (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({
            ...c,
            layers: c.layers.filter((l) => l.id !== layer.id),
            frames: c.frames.map((f) => {
                if (!f.cels[layer.id])
                    return f;
                const cels = { ...f.cels };
                delete cels[layer.id];
                return { ...f, cels };
            }),
        }));
        return {
            project: (0, access_1.pushTrash)(project, {
                id: (0, access_1.newTrashId)(),
                label: `Layer "${layer.name}" of "${clip.name}"`,
                deletedAt: Date.now(),
                item: { kind: 'layer', clipId: clip.id, layerIndex: index, layer, celsByFrameId },
            }),
            label: 'Delete layer',
        };
    },
};
exports.layerDuplicate = {
    type: 'layer.duplicate',
    defaultLabel: 'Duplicate layer',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.duplicate');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.duplicate: clip "${clipId}" not found`);
        if (!(0, access_1.findLayer)(clip, layerId))
            (0, errors_1.failNotFound)(`layer.duplicate: layer "${layerId}" not found`);
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const { layer, index } = (0, access_1.findLayer)(clip, payload.layerId);
        const copy = { ...layer, id: (0, access_1.newLayerId)(), name: `${layer.name} copy`, linked: false };
        const layers = [...clip.layers.slice(0, index + 1), copy, ...clip.layers.slice(index + 1)];
        const project = (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({
            ...c,
            layers,
            frames: c.frames.map((f) => {
                const src = f.cels[layer.id];
                if (!src)
                    return f;
                return {
                    ...f,
                    cels: {
                        ...f.cels,
                        [copy.id]: {
                            // Duplicate of a linked layer → independent per-frame copies.
                            buffer: new Uint8ClampedArray(src.buffer),
                            linked: false,
                        },
                    },
                };
            }),
        }));
        return { project, label: 'Duplicate layer' };
    },
};
/** Separable blend of one color channel: top (source) over bottom (backdrop), 0..255. */
function blendChannel(mode, t, b) {
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
exports.layerMergeDown = {
    type: 'layer.mergeDown',
    defaultLabel: 'Merge down',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.mergeDown');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.mergeDown: clip "${clipId}" not found`);
        const found = (0, access_1.findLayer)(clip, layerId);
        if (!found)
            (0, errors_1.failNotFound)(`layer.mergeDown: layer "${layerId}" not found`);
        if (found.index === 0)
            (0, errors_1.fail)('layer.mergeDown: nothing below the bottom layer');
        if (found.layer.linked) {
            (0, errors_1.fail)('layer.mergeDown: merging a linked layer is not supported (unlink first — C2)');
        }
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const { index } = (0, access_1.findLayer)(clip, payload.layerId);
        const { width, height } = ctx.project;
        const project = (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({
            ...c,
            layers: c.layers.filter((_, i) => i !== index),
            frames: c.frames.map((f) => {
                const top = f.cels[payload.layerId];
                const bottomLayer = c.layers[index - 1];
                if (!bottomLayer)
                    return f;
                const bottom = f.cels[bottomLayer.id];
                if (!top && !bottom)
                    return f;
                // Missing cel = transparent (C2) — merge treats it as empty.
                const merged = bottom
                    ? new Uint8ClampedArray(bottom.buffer)
                    : new Uint8ClampedArray(width * height * 4);
                if (top) {
                    const mode = c.layers[index]?.blend;
                    for (let i = 0; i < width * height; i++) {
                        const ta = (top.buffer[i * 4 + 3] / 255) * (top.linked ? 1 : (c.layers[index]?.opacity ?? 1));
                        if (ta >= 1) {
                            for (let ch = 0; ch < 3; ch++) {
                                merged[i * 4 + ch] = blendChannel(mode, top.buffer[i * 4 + ch], merged[i * 4 + ch]);
                            }
                            merged[i * 4 + 3] = top.buffer[i * 4 + 3];
                        }
                        else if (ta > 0) {
                            const ba = merged[i * 4 + 3] / 255;
                            const outA = ta + ba * (1 - ta);
                            if (outA === 0)
                                continue;
                            for (let ch = 0; ch < 3; ch++) {
                                const blended = blendChannel(mode, top.buffer[i * 4 + ch], merged[i * 4 + ch]);
                                merged[i * 4 + ch] = Math.round((blended * ta + merged[i * 4 + ch] * ba * (1 - ta)) / outA);
                            }
                            merged[i * 4 + 3] = Math.round(outA * 255);
                        }
                    }
                }
                return { ...f, cels: { ...f.cels, [bottomLayer.id]: { buffer: merged, linked: false } } };
            }),
        }));
        // Remove the top layer's cels everywhere.
        const cleaned = (0, access_1.mapClip)(project, clip.id, (c) => ({
            ...c,
            frames: c.frames.map((f) => {
                if (!f.cels[payload.layerId])
                    return f;
                const cels = { ...f.cels };
                delete cels[payload.layerId];
                return { ...f, cels };
            }),
        }));
        return { project: cleaned, label: 'Merge down' };
    },
};
exports.layerMove = {
    type: 'layer.move',
    defaultLabel: 'Reorder layer',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.move');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.move: clip "${clipId}" not found`);
        if (!(0, access_1.findLayer)(clip, layerId))
            (0, errors_1.failNotFound)(`layer.move: layer "${layerId}" not found`);
        const dir = p.dir;
        if (dir !== -1 && dir !== 1)
            (0, errors_1.fail)('layer.move: dir must be -1 or 1');
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const { index } = (0, access_1.findLayer)(clip, payload.layerId);
        const to = index + payload.dir;
        if (to < 0 || to >= clip.layers.length) {
            return { project: ctx.project, label: 'Reorder layer' };
        }
        const layers = [...clip.layers];
        const [moved] = layers.splice(index, 1);
        layers.splice(to, 0, moved);
        // Cel keys are layer ids — reordering the stack needs no cel changes.
        return { project: (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({ ...c, layers })), label: 'Reorder layer' };
    },
};
exports.layerSetProps = {
    type: 'layer.setProps',
    defaultLabel: 'Layer properties',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.setProps');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.setProps: clip "${clipId}" not found`);
        if (!(0, access_1.findLayer)(clip, layerId))
            (0, errors_1.failNotFound)(`layer.setProps: layer "${layerId}" not found`);
        const patch = (0, validate_1.assertObject)(p.patch, 'layer.setProps patch');
        const name = (0, validate_1.getOptionalString)(patch, 'name', 'layer.setProps');
        if (name !== undefined && name.length > 120)
            (0, errors_1.fail)('layer.setProps: name too long');
        const opacity = patch.opacity;
        if (opacity !== undefined && (typeof opacity !== 'number' || opacity < 0 || opacity > 1)) {
            (0, errors_1.fail)('layer.setProps: opacity must be 0..1');
        }
        if (patch.locked !== undefined && typeof patch.locked !== 'boolean') {
            (0, errors_1.fail)('layer.setProps: locked must be boolean');
        }
        if (patch.blend !== undefined &&
            !['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'].includes(patch.blend)) {
            (0, errors_1.fail)('layer.setProps: unknown blend mode');
        }
    },
    apply(payload, ctx) {
        const { clipId, layerId, patch } = payload;
        return {
            project: (0, access_1.mapClip)(ctx.project, clipId, (c) => ({
                ...c,
                layers: c.layers.map((l) => l.id === layerId
                    ? {
                        ...l,
                        ...(patch.name !== undefined ? { name: patch.name } : {}),
                        ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
                        ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
                        ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
                        ...(patch.blend !== undefined ? { blend: patch.blend } : {}),
                    }
                    : l),
            })),
            label: 'Layer properties',
        };
    },
};
exports.layerReorder = {
    type: 'layer.reorder',
    defaultLabel: 'Reorder layer',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.reorder');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.reorder: clip "${clipId}" not found`);
        if (!(0, access_1.findLayer)(clip, layerId))
            (0, errors_1.failNotFound)(`layer.reorder: layer "${layerId}" not found`);
        const to = p.to;
        if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to >= clip.layers.length) {
            (0, errors_1.fail)('layer.reorder: to must be an in-range layer index');
        }
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const { index } = (0, access_1.findLayer)(clip, payload.layerId);
        if (index === payload.to) {
            return { project: ctx.project, label: 'Reorder layer' };
        }
        const layers = [...clip.layers];
        const [moved] = layers.splice(index, 1);
        layers.splice(payload.to, 0, moved);
        // Cel keys are layer ids — reordering the stack needs no cel changes.
        return { project: (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({ ...c, layers })), label: 'Reorder layer' };
    },
};
/**
 * Linked-cel engine switch (C2/C19 — P0 engine support; UI toggle is P2).
 * ON  → pick the anchor frame's cel (first frame holding one) and share it
 *        across ALL frames (content of other frames collapses to the anchor).
 * OFF → break sharing: every frame gets an independent deep copy.
 */
exports.layerSetLinked = {
    type: 'layer.setLinked',
    defaultLabel: 'Linked cel',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'layer.setLinked');
        const { clipId, layerId } = parseLayerRef(p);
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`layer.setLinked: clip "${clipId}" not found`);
        if (!(0, access_1.findLayer)(clip, layerId))
            (0, errors_1.failNotFound)(`layer.setLinked: layer "${layerId}" not found`);
        if (typeof p.linked !== 'boolean')
            (0, errors_1.fail)('layer.setLinked: "linked" must be a boolean');
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const { layer } = (0, access_1.findLayer)(clip, payload.layerId);
        if (payload.linked === layer.linked) {
            return { project: ctx.project, label: 'Linked cel' };
        }
        if (payload.linked) {
            // Anchor = first frame that has a cel (else first frame → create).
            const anchorFrame = clip.frames.find((f) => f.cels[layer.id]) ?? clip.frames[0];
            if (!anchorFrame)
                (0, errors_1.fail)('layer.setLinked: clip has no frames');
            const existing = anchorFrame.cels[layer.id];
            const shared = existing
                ? { buffer: existing.buffer, linked: true }
                : { buffer: new Uint8ClampedArray(ctx.project.width * ctx.project.height * 4), linked: true };
            const withFlag = (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({
                ...c,
                layers: c.layers.map((l) => (l.id === layer.id ? { ...l, linked: true } : l)),
            }));
            return {
                project: (0, access_1.setCelEverywhere)(withFlag, clip.id, layer.id, shared),
                label: 'Link cel (shared)',
            };
        }
        // Unlink: give every frame its own copy of the current shared buffer.
        const project = (0, access_1.mapClip)(ctx.project, clip.id, (c) => ({
            ...c,
            layers: c.layers.map((l) => (l.id === layer.id ? { ...l, linked: false } : l)),
        }));
        const withCopies = (0, access_1.mapClip)(project, clip.id, (c) => ({
            ...c,
            frames: c.frames.map((f) => {
                const cel = f.cels[layer.id];
                if (!cel)
                    return f;
                return { ...f, cels: { ...f.cels, [layer.id]: { buffer: (0, buffers_1.cloneBuffer)(cel.buffer), linked: false } } };
            }),
        }));
        return { project: withCopies, label: 'Unlink cel' };
    },
};
// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------
exports.paletteAddColor = {
    type: 'palette.addColor',
    defaultLabel: 'Add palette color',
    validate(payload) {
        const p = (0, validate_1.assertObject)(payload, 'palette.addColor');
        (0, validate_1.getHexColor)(p, 'hex', 'palette.addColor');
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
exports.paletteRemoveColor = {
    type: 'palette.removeColor',
    defaultLabel: 'Remove palette color',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'palette.removeColor');
        const hex = (0, validate_1.getHexColor)(p, 'hex', 'palette.removeColor');
        if (!ctx.project.palette.includes(hex)) {
            (0, errors_1.failNotFound)(`palette.removeColor: "${hex}" not in palette`);
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
exports.paletteReplaceAll = {
    type: 'palette.replaceAll',
    defaultLabel: 'Replace palette',
    validate(payload) {
        const p = (0, validate_1.assertObject)(payload, 'palette.replaceAll');
        if (!Array.isArray(p.colors) || p.colors.length === 0) {
            (0, errors_1.fail)(`palette.replaceAll: "colors" must be a non-empty array of hex colors`);
        }
        for (const c of p.colors) {
            if (typeof c !== 'string' || !validate_1.HEX_RE.test(c)) {
                (0, errors_1.fail)(`palette.replaceAll: every color must be a hex string like #rrggbb`);
            }
        }
    },
    apply(payload, ctx) {
        // normalize + dedupe, keep first occurrence order
        const seen = new Set();
        const colors = [];
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
exports.trashRestore = {
    type: 'trash.restore',
    defaultLabel: 'Restore from trash',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'trash.restore');
        const entryId = (0, validate_1.getString)(p, 'entryId', 'trash.restore');
        if (!ctx.project.trash.some((t) => t.id === entryId)) {
            (0, errors_1.failNotFound)(`trash.restore: entry "${entryId}" not found`);
        }
    },
    apply(payload, ctx) {
        const taken = (0, access_1.takeTrash)(ctx.project, payload.entryId);
        if (!taken)
            (0, errors_1.failNotFound)('trash.restore: entry vanished');
        const { entry, project: without } = taken;
        const item = entry.item;
        if (item.kind === 'frame') {
            const clip = (0, access_1.findClip)(without, item.clipId);
            if (!clip)
                (0, errors_1.failNotFound)('trash.restore: owning clip no longer exists');
            const index = Math.min(Math.max(0, item.frameIndex), clip.frames.length);
            return {
                project: (0, access_1.mapClip)(without, clip.id, (c) => ({
                    ...c,
                    frames: [...c.frames.slice(0, index), item.frame, ...c.frames.slice(index)],
                })),
                label: 'Restore frame',
            };
        }
        if (item.kind === 'layer') {
            const clip = (0, access_1.findClip)(without, item.clipId);
            if (!clip)
                (0, errors_1.failNotFound)('trash.restore: owning clip no longer exists');
            const index = Math.min(Math.max(0, item.layerIndex), clip.layers.length);
            const layers = [...clip.layers.slice(0, index), item.layer, ...clip.layers.slice(index)];
            const restored = (0, access_1.mapClip)(without, clip.id, (c) => ({ ...c, layers }));
            // Restore cels to the frames they came from (missing frame ids skipped).
            const withCels = (0, access_1.mapClip)(restored, clip.id, (c) => ({
                ...c,
                frames: c.frames.map((f) => {
                    const cel = item.celsByFrameId[f.id];
                    if (!cel)
                        return f;
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
exports.trashPurge = {
    type: 'trash.purge',
    defaultLabel: 'Empty trash entry',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'trash.purge');
        const entryId = (0, validate_1.getString)(p, 'entryId', 'trash.purge');
        if (!ctx.project.trash.some((t) => t.id === entryId)) {
            (0, errors_1.failNotFound)(`trash.purge: entry "${entryId}" not found`);
        }
    },
    apply(payload, ctx) {
        const taken = (0, access_1.takeTrash)(ctx.project, payload.entryId);
        if (!taken)
            return { project: ctx.project, label: 'Empty trash entry' };
        return { project: taken.project, label: 'Empty trash entry' };
    },
};
exports.canvasResize = {
    type: 'canvas.resize',
    defaultLabel: 'Resize canvas',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'canvas.resize');
        const width = (0, validate_1.getInt)(p, 'width', 'canvas.resize');
        const height = (0, validate_1.getInt)(p, 'height', 'canvas.resize');
        // Core allows 1..512 (tiny sprites are legit); the MCP tool schema keeps
        // the documented 16..256 surface on top of this.
        if (width < 1 || width > 512 || height < 1 || height > 512) {
            (0, errors_1.fail)('canvas.resize: width/height must be 1..512');
        }
        const anchor = p.anchor;
        if (anchor !== undefined && anchor !== 'top-left' && anchor !== 'center') {
            (0, errors_1.fail)('canvas.resize: anchor must be "top-left" or "center"');
        }
        if (width === ctx.project.width && height === ctx.project.height) {
            (0, errors_1.fail)('canvas.resize: canvas is already that size');
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
        const seen = new Map();
        const remap = (buf) => {
            const hit = seen.get(buf);
            if (hit)
                return hit;
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
                cels: Object.fromEntries(Object.entries(frame.cels).map(([layerId, cel]) => [
                    layerId,
                    { ...cel, buffer: remap(cel.buffer) },
                ])),
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
exports.settingsSetOnion = {
    type: 'settings.setOnion',
    defaultLabel: 'Onion skin range',
    validate(payload) {
        const p = (0, validate_1.assertObject)(payload, 'settings.setOnion');
        const prev = (0, validate_1.getOptionalInt)(p, 'prev', 'settings.setOnion', 0, document_1.ONION_MAX);
        const next = (0, validate_1.getOptionalInt)(p, 'next', 'settings.setOnion', 0, document_1.ONION_MAX);
        if (prev === undefined && next === undefined) {
            (0, errors_1.fail)('settings.setOnion: patch is empty');
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
exports.settingsSetStyleProfile = {
    type: 'settings.setStyleProfile',
    defaultLabel: 'Update style profile',
    validate(payload) {
        const p = (0, validate_1.assertObject)(payload, 'settings.setStyleProfile');
        if (!(0, style_profile_1.parseStyleProfile)(p.profile)) {
            (0, errors_1.fail)('settings.setStyleProfile: "profile" must be a valid bounded style profile');
        }
    },
    apply(payload, ctx) {
        const profile = (0, style_profile_1.parseStyleProfile)(payload.profile);
        if (!profile)
            (0, errors_1.fail)('settings.setStyleProfile: invalid profile');
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
// registry
// ---------------------------------------------------------------------------
function builtinCommands() {
    return [
        exports.projectRename,
        exports.clipAdd,
        exports.clipDelete,
        exports.clipSetProps,
        exports.frameAdd,
        exports.frameDelete,
        exports.frameMove,
        exports.frameSetDuration,
        exports.layerAdd,
        exports.layerDelete,
        exports.layerDuplicate,
        exports.layerMergeDown,
        exports.layerMove,
        exports.layerReorder,
        exports.layerSetProps,
        exports.layerSetLinked,
        exports.paletteAddColor,
        exports.paletteRemoveColor,
        exports.paletteReplaceAll,
        exports.settingsSetOnion,
        exports.settingsSetStyleProfile,
        exports.trashRestore,
        exports.trashPurge,
        exports.canvasResize,
        // Pixel-editing path (same tile-diff history as strokes):
        pixel_commands_1.applyPixelOpsCommand,
        // Motion presets (Task 10, v3.1 §4.1): part tagging + deterministic composer
        motion_commands_1.partSet,
        motion_commands_1.motionApply,
    ];
}
