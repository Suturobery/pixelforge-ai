"use strict";
/**
 * CRC-32 (IEEE 802.3, reflected) — required by PNG chunks and ZIP entries.
 * Pure, table-driven, allocation-free at call time.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.crc32 = crc32;
const TABLE = /* @__PURE__ */ (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    return t;
})();
/** Compute CRC-32 over a byte range. */
function crc32(data, offset = 0, length = data.length - offset) {
    let c = 0xffffffff;
    const end = offset + length;
    for (let i = offset; i < end; i++) {
        c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
