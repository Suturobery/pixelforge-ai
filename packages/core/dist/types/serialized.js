"use strict";
/**
 * Serialized project v2 (v3.1 §6 "project.json") — the JSON form of the
 * document. Cel `src` ⇄ in-memory cel 1:1; encoding/decoding of PNG bytes
 * and the .pixelforgeproj ZIP container belong to Task 3; this module defines
 * the contract + structural validation only (pure, DOM-free).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSerializedProjectV2 = isSerializedProjectV2;
const document_1 = require("./document");
function isSerializedProjectV2(v) {
    if (!v || typeof v !== 'object')
        return false;
    const p = v;
    return (p.schemaVersion === 2 &&
        typeof p.name === 'string' &&
        typeof p.width === 'number' &&
        p.width >= document_1.CANVAS_MIN &&
        p.width <= document_1.CANVAS_MAX &&
        typeof p.height === 'number' &&
        p.height >= document_1.CANVAS_MIN &&
        p.height <= document_1.CANVAS_MAX &&
        Array.isArray(p.palette) &&
        Array.isArray(p.clips) &&
        Array.isArray(p.trash) &&
        !!p.settings &&
        typeof p.settings === 'object' &&
        Array.isArray(p.clips));
}
