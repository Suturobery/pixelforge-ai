"use strict";
/**
 * v1 compatibility boundary (v3.1 §2.4 "Migration" + §6).
 *
 * The web prototype's SerializedProject v1 shape is mirrored here so the
 * core can speak about v1 data without importing from the Next.js app.
 * v1 read support is permanent (v3.1 §2.4). The actual v1→v2 importer is
 * implemented in Task 3 against the V1ToV2Importer interface below.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSerializedProjectV1 = isSerializedProjectV1;
exports.mapV1Loop = mapV1Loop;
function isSerializedProjectV1(v) {
    if (!v || typeof v !== 'object')
        return false;
    const p = v;
    return (p.version === 1 &&
        typeof p.name === 'string' &&
        typeof p.width === 'number' &&
        typeof p.height === 'number' &&
        Array.isArray(p.palette) &&
        Array.isArray(p.clips));
}
/**
 * C3 loop mapping (v3.1): `loop: false` = play once through. loopMode only
 * gains meaning in v2, so every v1 clip maps to mode "forward".
 */
function mapV1Loop(loop) {
    return { loop, loopMode: 'forward' };
}
