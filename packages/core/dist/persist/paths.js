"use strict";
/**
 * Cel source path helpers (v3.1 §6 layout):
 *
 *   cels/<clipId>/<frameId>/<layerId>.png        — per-frame cel
 *   cels/<clipId>/shared/<layerId>.png           — linked cel, stored once (C2)
 *   trash/<entryIndex>/…                          — trash payload cels
 *
 * Paths are always forward-slash, always relative, and validated on read —
 * the same traversal rules as ZIP entry names apply (§9.4).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MANIFEST_ENTRY = exports.PROJECT_ENTRY = exports.JOURNAL_ENTRY = void 0;
exports.isSafeId = isSafeId;
exports.celSrc = celSrc;
exports.sharedCelSrc = sharedCelSrc;
exports.trashCelSrc = trashCelSrc;
exports.trashClipCelSrc = trashClipCelSrc;
exports.assertSafeCelSrc = assertSafeCelSrc;
const errors_1 = require("./errors");
const zip_1 = require("./zip");
/** Matches a safe single path segment (ZIP-safe, slug-like). */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** True when the id is safe to embed in a cel path. */
function isSafeId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 80 && SEGMENT.test(id);
}
function celSrc(clipId, frameId, layerId) {
    return `cels/${clipId}/${frameId}/${layerId}.png`;
}
function sharedCelSrc(clipId, layerId) {
    return `cels/${clipId}/shared/${layerId}.png`;
}
function trashCelSrc(entryIndex, frameId, layerId) {
    return `trash/${entryIndex}/cels/${frameId}/${layerId}.png`;
}
function trashClipCelSrc(entryIndex, clipId, frameId, layerId) {
    return `trash/${entryIndex}/cels/${clipId}/${frameId}/${layerId}.png`;
}
exports.JOURNAL_ENTRY = 'history/journal.jsonl';
exports.PROJECT_ENTRY = 'project.json';
exports.MANIFEST_ENTRY = 'manifest.json';
/** Validate a cel src from an untrusted document (read path). */
function assertSafeCelSrc(src) {
    if (typeof src !== 'string' || src.length === 0 || src.length > 400) {
        throw new errors_1.PersistError('UNSAFE_PATH', `cel src "${String(src)}" is not a safe path`);
    }
    if (!src.endsWith('.png')) {
        throw new errors_1.PersistError('UNSAFE_PATH', `cel src "${src}" must point to a .png entry`);
    }
    (0, zip_1.assertSafeEntryName)(src);
    if (!/^(cels|trash)\//.test(src)) {
        throw new errors_1.PersistError('UNSAFE_PATH', `cel src "${src}" must live under cels/ or trash/`);
    }
}
