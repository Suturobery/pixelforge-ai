"use strict";
/**
 * Runtime ⇄ serialized v2 conversion (v3.1 §6 "project.json" + cel PNGs).
 *
 * serializeProjectV2: runtime Project → { projectJson, celPngs }.
 *   - Linked layers (C2) encode ONE shared PNG per layer
 *     (cels/<clipId>/shared/<layerId>.png); every frame references it.
 *   - Trash payloads (C5/C9) serialize under trash/<entryIndex>/….
 *   - Buffer identity is deduped (same Uint8ClampedArray object encodes once).
 *
 * projectFromSerialized: { projectJson, celBytes } → runtime Project.
 *   - Decodes each PNG once per unique src (cache).
 *   - RE-SHARES linked cels: every frame of a linked layer receives the SAME
 *     buffer object, restoring "edit once applies everywhere" exactly.
 *
 * Both directions are lossless: save → load deep-equals the original
 * (verified by persist-format tests), including trash and linked identity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeProjectV2 = serializeProjectV2;
exports.projectFromSerialized = projectFromSerialized;
const png_1 = require("./png");
const errors_1 = require("./errors");
const paths_1 = require("./paths");
const style_profile_1 = require("../style-profile");
// ---------------------------------------------------------------------------
// runtime → serialized
// ---------------------------------------------------------------------------
async function serializeProjectV2(project) {
    const celPngs = new Map();
    /** Encode-once cache keyed by buffer object identity. */
    const encodeCache = new Map();
    const encodeOnce = async (buffer) => {
        const hit = encodeCache.get(buffer);
        if (hit)
            return hit;
        const png = await (0, png_1.encodePng)(project.width, project.height, buffer);
        encodeCache.set(buffer, png);
        return png;
    };
    const put = async (src, buffer) => {
        // First-wins: a linked layer's shared path takes the FIRST frame's buffer
        // (runtime linked cels share one object; per-frame duplicates from
        // hand-built documents must not have the last frame overwrite the data).
        if (!celPngs.has(src)) {
            celPngs.set(src, await encodeOnce(buffer));
        }
        return { src };
    };
    const serializeCelMap = async (clip, frames, pathFor) => {
        const out = [];
        for (const frame of frames) {
            const cels = {};
            for (const layer of clip.layers) {
                const cel = frame.cels[layer.id];
                if (!cel)
                    continue; // absent = transparent (C2)
                const src = layer.linked
                    ? (0, paths_1.sharedCelSrc)(clip.id, layer.id)
                    : pathFor(clip.id, frame.id, layer.id);
                const entry = await put(src, cel.buffer);
                cels[layer.id] = layer.linked ? { ...entry, linked: true } : entry;
            }
            out.push(cels);
        }
        return out;
    };
    const serializeLayer = (l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        linked: l.linked,
        ...(l.locked !== undefined ? { locked: l.locked } : {}),
        ...(l.blend !== undefined ? { blend: l.blend } : {}),
    });
    const serializeClip = async (clip, pathFor) => ({
        id: clip.id,
        name: clip.name,
        fps: clip.fps,
        loop: clip.loop,
        loopMode: clip.loopMode,
        layers: clip.layers.map(serializeLayer),
        parts: clip.parts.map((part) => ({
            id: part.id,
            name: part.name,
            layerId: part.layerId,
            ...(part.rect ? { rect: { ...part.rect } } : {}),
            anchorFrameId: part.anchorFrameId,
            z: part.z,
        })),
        frames: await (async () => {
            const celMaps = await serializeCelMap(clip, clip.frames, pathFor);
            return clip.frames.map((f, i) => ({
                id: f.id,
                durationMs: f.durationMs,
                cels: celMaps[i],
            }));
        })(),
        tags: clip.tags.map((t) => ({ name: t.name, from: t.from, to: t.to })),
    });
    const clips = [];
    for (const clip of project.clips) {
        clips.push(await serializeClip(clip, (clipId, frameId, layerId) => (0, paths_1.celSrc)(clipId, frameId, layerId)));
    }
    const trash = [];
    for (let ti = 0; ti < project.trash.length; ti++) {
        trash.push(await serializeTrashEntry(project.trash[ti], ti, { serializeClip, serializeLayer, put }));
    }
    return {
        projectJson: {
            schemaVersion: 2,
            name: project.name,
            width: project.width,
            height: project.height,
            palette: [...project.palette],
            trash,
            clips,
            settings: {
                paletteEnforce: project.settings.paletteEnforce,
                ...(project.settings.styleProfile ? { styleProfile: (0, style_profile_1.cloneStyleProfile)(project.settings.styleProfile) } : {}),
                onion: { prev: project.settings.onion.prev, next: project.settings.onion.next },
            },
        },
        celPngs,
    };
}
async function serializeTrashEntry(entry, index, ctx) {
    const item = entry.item;
    if (item.kind === 'frame') {
        const cels = {};
        for (const layer of Object.keys(item.frame.cels)) {
            const cel = item.frame.cels[layer];
            cels[layer] = await ctx.put((0, paths_1.trashCelSrc)(index, item.frame.id, layer), cel.buffer);
        }
        const frame = {
            id: item.frame.id,
            durationMs: item.frame.durationMs,
            cels,
        };
        return {
            id: entry.id,
            label: entry.label,
            deletedAt: entry.deletedAt,
            item: { kind: 'frame', clipId: item.clipId, frameIndex: item.frameIndex, frame },
        };
    }
    if (item.kind === 'layer') {
        const celsByFrameId = {};
        for (const [frameId, cel] of Object.entries(item.celsByFrameId)) {
            celsByFrameId[frameId] = await ctx.put((0, paths_1.trashCelSrc)(index, frameId, item.layer.id), cel.buffer);
        }
        return {
            id: entry.id,
            label: entry.label,
            deletedAt: entry.deletedAt,
            item: {
                kind: 'layer',
                clipId: item.clipId,
                layerIndex: item.layerIndex,
                layer: ctx.serializeLayer(item.layer),
                celsByFrameId,
            },
        };
    }
    // kind === 'clip' — serialize as a self-contained clip under trash/<i>/.
    const pseudo = { ...item.clip };
    const clipJson = await ctx.serializeClip(pseudo, (_clipId, frameId, layerId) => (0, paths_1.trashClipCelSrc)(index, item.clip.id, frameId, layerId));
    const trashItem = { kind: 'clip', clipIndex: item.clipIndex, clip: clipJson };
    return { id: entry.id, label: entry.label, deletedAt: entry.deletedAt, item: trashItem };
}
async function projectFromSerialized(doc, celBytes, opts = {}) {
    const decodeCache = new Map();
    const decode = async (src, expectedCel) => {
        const cached = decodeCache.get(src);
        if (cached)
            return cached;
        const bytes = celBytes(src);
        if (!bytes) {
            throw new errors_1.PersistError('MISSING_ENTRY', `cel "${src}" referenced by project.json is absent from the archive`, {
                entry: src,
            });
        }
        const png = await (0, png_1.decodePng)(bytes, src);
        if (png.width !== doc.width || png.height !== doc.height) {
            throw new errors_1.PersistError('DECODE_FAILED', `cel "${src}" is ${png.width}×${png.height} but the project is ${doc.width}×${doc.height}`, { entry: src });
        }
        const buffer = expectedCel && expectedCel.linked ? png.rgba : png.rgba;
        decodeCache.set(src, buffer);
        return buffer;
    };
    const restoreCelMap = async (clipId, layers, frame, frameIndex) => {
        const cels = {};
        for (const layer of layers) {
            const entry = frame.cels[layer.id];
            if (!entry)
                continue;
            const buffer = await decode(entry.src, { buffer: new Uint8ClampedArray(0), linked: layer.linked });
            cels[layer.id] = { buffer, linked: entry.linked === true };
        }
        void clipId;
        void frameIndex;
        return cels;
    };
    const clips = [];
    for (const clipJson of doc.clips) {
        // Decode pass 1: materialize every frame's cels (unique srcs decoded once).
        const frames = [];
        for (let fi = 0; fi < clipJson.frames.length; fi++) {
            const frameJson = clipJson.frames[fi];
            frames.push({
                id: frameJson.id,
                durationMs: frameJson.durationMs,
                cels: await restoreCelMap(clipJson.id, clipJson.layers, frameJson, fi),
            });
        }
        // Linked re-share (C2): all frames of a linked layer must reference ONE
        // shared src — decode it once and assign the SAME buffer object.
        for (const layer of clipJson.layers) {
            if (!layer.linked)
                continue;
            const sharedSrc = (0, paths_1.sharedCelSrc)(clipJson.id, layer.id);
            const bytes = celBytes(sharedSrc);
            if (!bytes) {
                throw new errors_1.PersistError('MISSING_ENTRY', `linked layer "${layer.id}" of clip "${clipJson.id}" expects "${sharedSrc}" which is absent`, { entry: sharedSrc });
            }
            const png = await (0, png_1.decodePng)(bytes, sharedSrc);
            if (png.width !== doc.width || png.height !== doc.height) {
                throw new errors_1.PersistError('DECODE_FAILED', `shared cel "${sharedSrc}" dimensions mismatch`, {
                    entry: sharedSrc,
                });
            }
            const sharedBuffer = png.rgba;
            for (const frame of frames) {
                const cel = frame.cels[layer.id];
                if (cel) {
                    cel.buffer = sharedBuffer;
                    cel.linked = true;
                }
                else {
                    frame.cels[layer.id] = { buffer: sharedBuffer, linked: true };
                }
            }
        }
        clips.push({
            id: clipJson.id,
            name: clipJson.name,
            fps: clipJson.fps,
            loop: clipJson.loop,
            loopMode: clipJson.loopMode,
            layers: clipJson.layers.map((l) => ({ ...l })),
            parts: clipJson.parts.map((p) => ({ ...p, ...(p.rect ? { rect: { ...p.rect } } : {}) })),
            frames,
            tags: clipJson.tags.map((t) => ({ ...t })),
        });
    }
    const trash = [];
    for (let ti = 0; ti < doc.trash.length; ti++) {
        trash.push(await trashEntryFromSerialized(doc.trash[ti], ti, celBytes, decodeCache, doc));
    }
    const styleProfile = (0, style_profile_1.parseStyleProfile)(doc.settings.styleProfile);
    return {
        id: opts.id ?? null,
        schemaVersion: 2,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        palette: [...doc.palette],
        settings: {
            paletteEnforce: doc.settings.paletteEnforce,
            ...(styleProfile ? { styleProfile } : {}),
            onion: { prev: doc.settings.onion.prev, next: doc.settings.onion.next },
        },
        clips,
        trash,
    };
}
async function trashEntryFromSerialized(entry, index, celBytes, _decodeCache, doc) {
    const decodeTrash = async (src) => {
        const bytes = celBytes(src);
        if (!bytes) {
            throw new errors_1.PersistError('MISSING_ENTRY', `trash cel "${src}" is absent from the archive`, { entry: src });
        }
        const png = await (0, png_1.decodePng)(bytes, src);
        if (png.width !== doc.width || png.height !== doc.height) {
            throw new errors_1.PersistError('DECODE_FAILED', `trash cel "${src}" dimensions mismatch`, { entry: src });
        }
        return png.rgba;
    };
    const item = entry.item;
    if (item.kind === 'frame') {
        const cels = {};
        for (const [layerId, celJson] of Object.entries(item.frame.cels)) {
            cels[layerId] = { buffer: await decodeTrash(celJson.src), linked: celJson.linked === true };
        }
        return {
            id: entry.id,
            label: entry.label,
            deletedAt: entry.deletedAt,
            item: {
                kind: 'frame',
                clipId: item.clipId,
                frameIndex: item.frameIndex,
                frame: { id: item.frame.id, durationMs: item.frame.durationMs, cels },
            },
        };
    }
    if (item.kind === 'layer') {
        const celsByFrameId = {};
        for (const [frameId, celJson] of Object.entries(item.celsByFrameId)) {
            celsByFrameId[frameId] = { buffer: await decodeTrash(celJson.src), linked: celJson.linked === true };
        }
        return {
            id: entry.id,
            label: entry.label,
            deletedAt: entry.deletedAt,
            item: {
                kind: 'layer',
                clipId: item.clipId,
                layerIndex: item.layerIndex,
                layer: { ...item.layer },
                celsByFrameId,
            },
        };
    }
    // kind === 'clip' — materialize the self-contained trash clip.
    const clipJson = item.clip;
    const frames = [];
    for (const frameJson of clipJson.frames) {
        const cels = {};
        for (const [layerId, celJson] of Object.entries(frameJson.cels)) {
            cels[layerId] = { buffer: await decodeTrash(celJson.src), linked: celJson.linked === true };
        }
        frames.push({ id: frameJson.id, durationMs: frameJson.durationMs, cels });
    }
    // Re-share linked layers within the trash clip.
    for (const layer of clipJson.layers) {
        if (!layer.linked)
            continue;
        let shared = null;
        for (const frame of frames) {
            const cel = frame.cels[layer.id];
            if (cel) {
                if (!shared)
                    shared = cel.buffer;
                cel.buffer = shared;
                cel.linked = true;
            }
        }
    }
    return {
        id: entry.id,
        label: entry.label,
        deletedAt: entry.deletedAt,
        item: {
            kind: 'clip',
            clipIndex: item.clipIndex,
            clip: {
                id: clipJson.id,
                name: clipJson.name,
                fps: clipJson.fps,
                loop: clipJson.loop,
                loopMode: clipJson.loopMode,
                layers: clipJson.layers.map((l) => ({ ...l })),
                parts: clipJson.parts.map((p) => ({ ...p, ...(p.rect ? { rect: { ...p.rect } } : {}) })),
                frames,
                tags: clipJson.tags.map((t) => ({ ...t })),
            },
        },
    };
}
