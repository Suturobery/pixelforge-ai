"use strict";
/**
 * SHA-256 digests for manifest checksums (v3.1 §6, C5: "sha256 for EVERY
 * entry"). Uses the WebCrypto SubtleCrypto digest — available in Electron,
 * Node ≥ 15, Bun, and browsers, so the core stays dependency-free.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256Hex = sha256Hex;
const errors_1 = require("./errors");
const HEX = '0123456789abcdef';
async function sha256Hex(data) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new errors_1.PersistError('ENCODE_FAILED', 'WebCrypto subtle digest is unavailable in this runtime');
    }
    // Copy into a fresh ArrayBuffer to satisfy strict SharedArrayBuffer typing.
    const copy = new Uint8Array(data.length);
    copy.set(data);
    const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) {
        hex += HEX[(b >>> 4) & 0xf] + HEX[b & 0xf];
    }
    return hex;
}
