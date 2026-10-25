"use strict";
/** Small buffer helpers shared across the core (pure, DOM-free). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cloneBuffer = cloneBuffer;
exports.bufferEquals = bufferEquals;
exports.isZeroBuffer = isZeroBuffer;
function cloneBuffer(buf) {
    return new Uint8ClampedArray(buf);
}
/** Byte-exact equality (same length + same bytes). */
function bufferEquals(a, b) {
    if (a === b)
        return true;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
/** True when every byte is 0 (fully transparent, alpha 0 everywhere). */
function isZeroBuffer(buf) {
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0)
            return false;
    }
    return true;
}
