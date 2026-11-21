"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.motionApply = exports.partSet = void 0;
const access_1 = require("../doc/access");
const errors_1 = require("./errors");
const validate_1 = require("./validate");
const types_1 = require("../motion/types");
const presets_1 = require("../motion/presets");
const composer_1 = require("../motion/composer");
exports.partSet = {
    type: 'part.set',
    defaultLabel: 'Set motion parts',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'part.set');
        const clipId = (0, validate_1.getString)(p, 'clipId', 'part.set');
        const clip = (0, access_1.findClip)(ctx.project, clipId);
        if (!clip)
            (0, errors_1.failNotFound)(`part.set: clip "${clipId}" not found`);
        if (!Array.isArray(p.parts))
            (0, errors_1.fail)('part.set: parts must be an array');
        if (p.parts.length > 32)
            (0, errors_1.fail)('part.set: at most 32 parts per clip');
        const names = new Set();
        p.parts.forEach((raw, i) => {
            const part = (0, validate_1.assertObject)(raw, `part.set parts[${i}]`);
            const name = (0, validate_1.getString)(part, 'name', `part.set parts[${i}]`);
            if (name.length > 40)
                (0, errors_1.fail)(`part.set parts[${i}]: name too long (max 40)`);
            const key = name.trim().toLowerCase();
            if (names.has(key)) {
                (0, errors_1.fail)(`part.set: duplicate part name "${name}" (names are role keys, case-insensitive)`);
            }
            names.add(key);
            const layerId = (0, validate_1.getString)(part, 'layerId', `part.set parts[${i}]`);
            if (!clip.layers.some((l) => l.id === layerId)) {
                (0, errors_1.failNotFound)(`part.set parts[${i}]: layer "${layerId}" not found in clip "${clip.name}"`);
            }
            if (part.anchorFrameId !== undefined) {
                const anchorId = (0, validate_1.getOptionalString)(part, 'anchorFrameId', `part.set parts[${i}]`);
                if (anchorId !== undefined && !clip.frames.some((f) => f.id === anchorId)) {
                    (0, errors_1.failNotFound)(`part.set parts[${i}]: anchor frame "${anchorId}" not found`);
                }
            }
            if (part.z !== undefined)
                (0, validate_1.getInt)(part, 'z', `part.set parts[${i}]`, -99, 99);
            if (part.rect !== undefined) {
                const r = (0, validate_1.assertObject)(part.rect, `part.set parts[${i}].rect`);
                const x = (0, validate_1.getInt)(r, 'x', 'part.set rect', 0, ctx.width - 1);
                const y = (0, validate_1.getInt)(r, 'y', 'part.set rect', 0, ctx.height - 1);
                const w = (0, validate_1.getInt)(r, 'w', 'part.set rect', 1, ctx.width);
                const h = (0, validate_1.getInt)(r, 'h', 'part.set rect', 1, ctx.height);
                if (x + w > ctx.width || y + h > ctx.height) {
                    (0, errors_1.fail)(`part.set parts[${i}]: rect extends past the ${ctx.width}×${ctx.height} canvas`);
                }
            }
        });
    },
    apply(payload, ctx) {
        const clip = (0, access_1.findClip)(ctx.project, payload.clipId);
        const parts = payload.parts.map((p, i) => ({
            id: (0, access_1.newPartId)(),
            name: p.name.trim(),
            layerId: p.layerId,
            ...(p.rect ? { rect: { ...p.rect } } : {}),
            anchorFrameId: p.anchorFrameId ?? clip.frames[0].id,
            z: p.z ?? i,
        }));
        return {
            project: (0, access_1.mapClip)(ctx.project, payload.clipId, (c) => ({ ...c, parts })),
            label: parts.length > 0 ? 'Tag motion parts' : 'Clear motion parts',
        };
    },
};
const GAP_FILL_MODES = ['none', 'edge-extend'];
exports.motionApply = {
    type: 'motion.apply',
    defaultLabel: 'Apply motion preset',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'motion.apply');
        const sourceClipId = (0, validate_1.getString)(p, 'sourceClipId', 'motion.apply');
        const source = (0, access_1.findClip)(ctx.project, sourceClipId);
        if (!source)
            (0, errors_1.failNotFound)(`motion.apply: source clip "${sourceClipId}" not found`);
        const presetId = (0, validate_1.getString)(p, 'preset', 'motion.apply');
        const preset = (0, presets_1.getPreset)(presetId);
        if (!preset)
            (0, errors_1.fail)(`motion.apply: preset must be one of ${presets_1.PRESET_IDS.join(' | ')}`);
        if (p.params !== undefined) {
            const params = (0, validate_1.assertObject)(p.params, 'motion.apply params');
            if (params.amplitude !== undefined) {
                const a = (0, validate_1.getNumber)(params, 'amplitude', 'motion.apply params');
                if (a < types_1.AMPLITUDE_MIN || a > types_1.AMPLITUDE_MAX) {
                    (0, errors_1.fail)(`motion.apply params: amplitude must be ${types_1.AMPLITUDE_MIN}–${types_1.AMPLITUDE_MAX}`);
                }
            }
            if (params.frameCount !== undefined) {
                const fc = (0, validate_1.getInt)(params, 'frameCount', 'motion.apply params', 1, 64);
                if (!preset.frameCounts.includes(fc)) {
                    (0, errors_1.fail)(`motion.apply params: "${preset.id}" supports frame counts ${preset.frameCounts.join('/')} (got ${fc})`);
                }
            }
            if (params.gapFill !== undefined) {
                const g = params.gapFill;
                if (typeof g !== 'string' || !GAP_FILL_MODES.includes(g)) {
                    (0, errors_1.fail)('motion.apply params: gapFill must be "none" | "edge-extend"');
                }
            }
            if (params.smear !== undefined)
                (0, validate_1.getBool)(params, 'smear', 'motion.apply params');
        }
        if (p.anchorFrameIndex !== undefined) {
            (0, validate_1.getInt)(p, 'anchorFrameIndex', 'motion.apply', 0, source.frames.length - 1);
        }
        const target = (0, validate_1.assertObject)(p.target, 'motion.apply target');
        const kind = (0, validate_1.getString)(target, 'kind', 'motion.apply target');
        if (kind === 'new') {
            const name = (0, validate_1.getString)(target, 'name', 'motion.apply target');
            if (name.length > 120)
                (0, errors_1.fail)('motion.apply target: name too long (max 120)');
            if (target.fps !== undefined)
                (0, validate_1.getInt)(target, 'fps', 'motion.apply target', 1, 60);
            if (target.loop !== undefined)
                (0, validate_1.getBool)(target, 'loop', 'motion.apply target');
            if (target.loopMode !== undefined)
                (0, validate_1.getOptionalLoopMode)(target, 'loopMode', 'motion.apply target');
        }
        else if (kind === 'existing') {
            const clipId = (0, validate_1.getString)(target, 'clipId', 'motion.apply target');
            if (!(0, access_1.findClip)(ctx.project, clipId))
                (0, errors_1.failNotFound)(`motion.apply target: clip "${clipId}" not found`);
            // v3.1 R6: overwriting an existing clip is only defined with overwrite:true
            if (target.overwrite !== true) {
                (0, errors_1.fail)('motion.apply target: overwriting an existing clip requires overwrite:true (existing frames are never silently replaced)');
            }
        }
        else {
            (0, errors_1.fail)('motion.apply target: kind must be "new" | "existing"');
        }
    },
    apply(payload, ctx) {
        const source = (0, access_1.findClip)(ctx.project, payload.sourceClipId);
        const plan = (0, composer_1.planMotion)(ctx.project, source, {
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
        const targetName = (0, access_1.findClip)(ctx.project, target.clipId)?.name ?? '';
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
function cloneLayerForTarget(layer, unlinked) {
    return {
        id: (0, access_1.newLayerId)(),
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        // R8: layers that parts target are un-linked in the target clip; a
        // pinned background with no part stays linked (must not bob).
        linked: layer.linked && !unlinked.has(layer.id),
    };
}
function applyToNewClip(project, source, plan, target) {
    const unlinked = new Set(plan.report.unlinkedLayerIds);
    const layerMap = new Map(); // source layer id → new layer
    const layers = source.layers.map((l) => {
        const copy = cloneLayerForTarget(l, unlinked);
        layerMap.set(l.id, copy);
        return copy;
    });
    const anchor = source.frames[plan.report.anchorFrameIndex];
    const affected = new Set(plan.report.affectedLayerIds);
    // Still-linked layers share ONE cel object across every frame (C2).
    const sharedCelByLayerId = new Map();
    for (const [srcId, copy] of layerMap) {
        if (!copy.linked)
            continue;
        const src = anchor.cels[srcId];
        if (src) {
            sharedCelByLayerId.set(copy.id, {
                buffer: new Uint8ClampedArray(src.buffer),
                linked: true,
            });
        }
    }
    const frames = plan.frames.map((composed) => {
        const cels = {};
        for (const [srcId, copy] of layerMap) {
            if (affected.has(srcId) && composed.cels[srcId]) {
                cels[copy.id] = { buffer: composed.cels[srcId], linked: false };
            }
            else if (sharedCelByLayerId.has(copy.id)) {
                cels[copy.id] = sharedCelByLayerId.get(copy.id);
            }
            else {
                const src = anchor.cels[srcId];
                // R9: non-affected frames carry bit-identical copies of the anchor
                if (src)
                    cels[copy.id] = { buffer: new Uint8ClampedArray(src.buffer), linked: false };
            }
        }
        return { id: (0, access_1.newFrameId)(), durationMs: 0, cels }; // R7: inherit clip fps
    });
    const clip = {
        id: (0, access_1.newClipId)(),
        name: target.name,
        fps: Math.min(60, Math.max(1, Math.round(target.fps ?? source.fps))),
        loop: target.loop ?? source.loop,
        loopMode: target.loopMode ?? source.loopMode,
        layers,
        // parts carry over (remapped) so presets can be re-applied/re-parameterized
        parts: source.parts
            .map((p) => {
            const copy = layerMap.get(p.layerId);
            if (!copy)
                return null;
            return {
                id: (0, access_1.newPartId)(),
                name: p.name,
                layerId: copy.id,
                ...(p.rect ? { rect: { ...p.rect } } : {}),
                anchorFrameId: frames[0].id,
                z: p.z,
            };
        })
            .filter((p) => p !== null),
        frames,
        tags: [],
    };
    return { ...project, clips: [...project.clips, clip] };
}
function applyToExistingClip(project, source, plan, targetClipId) {
    const affected = new Set(plan.report.affectedLayerIds);
    const unlinked = new Set(plan.report.unlinkedLayerIds);
    // R8: unlink tagged linked layers in the target clip (same undo entry)
    let next = (0, access_1.mapClip)(project, targetClipId, (c) => ({
        ...c,
        layers: c.layers.map((l) => (unlinked.has(l.id) ? { ...l, linked: false } : l)),
    }));
    const target = (0, access_1.findClip)(next, targetClipId);
    const anchor = source.frames[plan.report.anchorFrameIndex];
    const n = plan.report.frameCount;
    // R6: fewer frames → append holds of the reference (exact anchor copies)
    const appended = [];
    for (let i = target.frames.length; i < n; i++) {
        const cels = {};
        for (const layer of target.layers) {
            const src = anchor.cels[layer.id];
            if (!src)
                continue;
            cels[layer.id] = layer.linked
                ? src // stays shared
                : { buffer: new Uint8ClampedArray(src.buffer), linked: false };
        }
        appended.push({ id: (0, access_1.newFrameId)(), durationMs: 0, cels });
    }
    if (appended.length > 0) {
        next = (0, access_1.mapClip)(next, targetClipId, (c) => ({ ...c, frames: [...c.frames, ...appended] }));
    }
    // R5: write composed cels into frames 0..n−1 (affected layers only);
    // frames ≥ n are left untouched; generated frames get durationMs 0 (R7).
    next = (0, access_1.mapClip)(next, targetClipId, (c) => ({
        ...c,
        frames: c.frames.map((frame, i) => {
            if (i >= n)
                return frame;
            const composed = plan.frames[i];
            const cels = { ...frame.cels };
            for (const layerId of affected) {
                const buf = composed.cels[layerId];
                if (buf)
                    cels[layerId] = { buffer: buf, linked: false };
            }
            return { ...frame, durationMs: 0, cels };
        }),
    }));
    return next;
}
