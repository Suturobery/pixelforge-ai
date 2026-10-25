"use strict";
/**
 * Immutable document access & update helpers.
 *
 * Every helper takes a document and returns a NEW document — inputs are
 * never mutated. This is the copy-on-write discipline that lets structural
 * history entries hold cheap shallow snapshots (prototype mechanism, kept)
 * while buffers are only ever replaced wholesale (which is what keeps tile
 * diffs consistent with snapshots).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.newTrashId = exports.newPartId = exports.newClipId = exports.newFrameId = exports.newLayerId = void 0;
exports.findClip = findClip;
exports.findFrame = findFrame;
exports.findLayer = findLayer;
exports.locateCel = locateCel;
exports.mapClip = mapClip;
exports.mapFrames = mapFrames;
exports.setCel = setCel;
exports.setCelEverywhere = setCelEverywhere;
exports.replaceCelBuffer = replaceCelBuffer;
exports.pushTrash = pushTrash;
exports.takeTrash = takeTrash;
const id_1 = require("../id");
const document_1 = require("../types/document");
function findClip(project, clipId) {
    return project.clips.find((c) => c.id === clipId);
}
function findFrame(clip, frameId) {
    return clip.frames.find((f) => f.id === frameId);
}
function findLayer(clip, layerId) {
    const index = clip.layers.findIndex((l) => l.id === layerId);
    return index < 0 ? undefined : { layer: clip.layers[index], index };
}
/** Locate a cel without creating it. Returns null when clip/frame/layer is missing. */
function locateCel(project, clipId, frameId, layerId) {
    const clip = findClip(project, clipId);
    if (!clip)
        return null;
    const frame = findFrame(clip, frameId);
    if (!frame)
        return null;
    const found = findLayer(clip, layerId);
    if (!found)
        return null;
    return { clip, frame, layer: found.layer, cel: frame.cels[layerId] };
}
/** Immutably map a single clip. */
function mapClip(project, clipId, fn) {
    return {
        ...project,
        clips: project.clips.map((c) => (c.id === clipId ? fn(c) : c)),
    };
}
/** Immutably map every frame of a clip (layer ops are clip-wide, C1). */
function mapFrames(project, clipId, fn) {
    return mapClip(project, clipId, (c) => ({ ...c, frames: c.frames.map(fn) }));
}
/** Set (or replace) one cel. Missing frame/layer → document unchanged. */
function setCel(project, clipId, frameId, layerId, cel) {
    return mapFrames(project, clipId, (f) => f.id !== frameId ? f : { ...f, cels: { ...f.cels, [layerId]: cel } });
}
/**
 * Install the same cel object into EVERY frame of the clip for a layer —
 * the linked-cel propagation path (C2: "every frame references the same
 * src"). Frames missing the cel gain it.
 */
function setCelEverywhere(project, clipId, layerId, cel) {
    return mapFrames(project, clipId, (f) => ({ ...f, cels: { ...f.cels, [layerId]: cel } }));
}
/**
 * Replace a cel's buffer, handling linked-cel propagation:
 *  - layer.linked → the new buffer is installed into all frames of the clip;
 *  - otherwise only the target frame's cel is replaced (created if absent).
 * Returns the new document, or null when clip/frame/layer no longer exist.
 */
function replaceCelBuffer(project, clipId, frameId, layerId, buffer, linked) {
    const loc = locateCel(project, clipId, frameId, layerId);
    if (!loc)
        return null;
    const cel = { buffer, linked };
    return loc.layer.linked
        ? setCelEverywhere(project, clipId, layerId, cel)
        : setCel(project, clipId, frameId, layerId, cel);
}
/** Push a trash entry, evicting the oldest beyond the cap (C5/C9, cap 20). */
function pushTrash(project, entry) {
    const trash = [...project.trash, entry];
    while (trash.length > document_1.TRASH_CAP)
        trash.shift();
    return { ...project, trash };
}
/** Remove a trash entry by id. Returns null when not found. */
function takeTrash(project, entryId) {
    const idx = project.trash.findIndex((t) => t.id === entryId);
    if (idx < 0)
        return null;
    const entry = project.trash[idx];
    return { project: { ...project, trash: project.trash.filter((_, i) => i !== idx) }, entry };
}
/** Fresh ids for structural commands. */
const newLayerId = () => (0, id_1.uid)('ly');
exports.newLayerId = newLayerId;
const newFrameId = () => (0, id_1.uid)('fr');
exports.newFrameId = newFrameId;
const newClipId = () => (0, id_1.uid)('cl');
exports.newClipId = newClipId;
const newPartId = () => (0, id_1.uid)('pt');
exports.newPartId = newPartId;
const newTrashId = () => (0, id_1.uid)('tr');
exports.newTrashId = newTrashId;
