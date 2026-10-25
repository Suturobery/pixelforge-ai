"use strict";
/**
 * v1 compatibility runtime helpers (v3.1 §2.4 "Migration", §6).
 *
 * Boundary for Task 3's importer: v1 documents are read permanently; the
 * conversion matches layer ids across frames to build the v2 cel model, and
 * maps `loop: boolean` per C3. This module provides the loop mapping and the
 * shared conversion scaffolding; the full importer (PNG decode via resolver,
 * per-frame cel grouping, warnings) lands in Task 3.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertV1Loop = exports.mapV1Loop = exports.isSerializedProjectV1 = void 0;
exports.v1ClipSkeleton = v1ClipSkeleton;
exports.v2ProjectShell = v2ProjectShell;
const v1_1 = require("../types/v1");
var v1_2 = require("../types/v1");
Object.defineProperty(exports, "isSerializedProjectV1", { enumerable: true, get: function () { return v1_2.isSerializedProjectV1; } });
Object.defineProperty(exports, "mapV1Loop", { enumerable: true, get: function () { return v1_2.mapV1Loop; } });
/**
 * Convert v1 loop semantics to the v2 pair (C3):
 *   v1 loop:true  → v2 { loop: true,  loopMode: 'forward' }
 *   v1 loop:false → v2 { loop: false, loopMode: 'forward' }  (play once)
 */
exports.convertV1Loop = v1_1.mapV1Loop;
/**
 * Convert a v1 clip's metadata (id/name/fps/loop) to a v2 clip skeleton
 * WITHOUT cels — Task 3 fills frames/cels from decoded PNGs. Kept here so
 * the importer's shape is pinned by tests before its implementation lands.
 */
function v1ClipSkeleton(v1) {
    return {
        id: v1.id,
        name: v1.name,
        fps: Math.min(60, Math.max(1, Math.round(v1.fps))),
        ...(0, v1_1.mapV1Loop)(v1.loop),
        layers: [],
        parts: [],
        frames: [],
        tags: [],
    };
}
/**
 * Build a v2 runtime document shell for an imported project. Task 3 layers
 * converted clips into it (and computes trash from unused material, if any).
 */
function v2ProjectShell(v1, opts = {}) {
    return {
        id: opts.id ?? null,
        schemaVersion: 2,
        name: v1.name,
        width: v1.width,
        height: v1.height,
        palette: [...v1.palette],
        settings: { paletteEnforce: true, onion: { prev: 1, next: 0 } },
        clips: [],
        trash: [],
    };
}
