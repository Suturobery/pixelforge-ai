"use strict";
/**
 * Pure base64 encode/decode (RFC 4648, standard alphabet, padded).
 *
 * Keeps the core DOM-free and environment-neutral: data URLs (v1 importer)
 * and JSONL-embedded binary (journal payloads carrying buffers) convert
 * through here instead of Node's Buffer or the browser's atob/btoa.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.base64Encode = base64Encode;
exports.base64Decode = base64Decode;
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = /* @__PURE__ */ (() => {
    const t = new Int16Array(128).fill(-1);
    for (let i = 0; i < ALPHA.length; i++)
        t[ALPHA.charCodeAt(i)] = i;
    return t;
})();
function base64Encode(data) {
    let out = '';
    const len = data.length;
    let i = 0;
    for (; i + 2 < len; i += 3) {
        const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        out += ALPHA[(n >>> 18) & 63] + ALPHA[(n >>> 12) & 63] + ALPHA[(n >>> 6) & 63] + ALPHA[n & 63];
    }
    const rem = len - i;
    if (rem === 1) {
        const n = data[i] << 16;
        out += ALPHA[(n >>> 18) & 63] + ALPHA[(n >>> 12) & 63] + '==';
    }
    else if (rem === 2) {
        const n = (data[i] << 16) | (data[i + 1] << 8);
        out += ALPHA[(n >>> 18) & 63] + ALPHA[(n >>> 12) & 63] + ALPHA[(n >>> 6) & 63] + '=';
    }
    return out;
}
function base64Decode(text) {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
    const len = clean.length;
    if (len === 0)
        return new Uint8Array(0);
    if (len % 4 === 1) {
        throw new Error('Invalid base64 length');
    }
    const pad = (4 - (len % 4)) % 4;
    const outLen = ((len + pad) / 4) * 3 - pad;
    const out = new Uint8Array(outLen);
    const LOOK = LOOKUP;
    let o = 0;
    let i = 0;
    for (; i + 3 < len; i += 4) {
        const a = LOOK[clean.charCodeAt(i)];
        const b = LOOK[clean.charCodeAt(i + 1)];
        const c = LOOK[clean.charCodeAt(i + 2)];
        const d = LOOK[clean.charCodeAt(i + 3)];
        if (a < 0 || b < 0 || c < 0 || d < 0)
            throw new Error('Invalid base64 character');
        const n = (a << 18) | (b << 12) | (c << 6) | d;
        out[o++] = (n >>> 16) & 0xff;
        out[o++] = (n >>> 8) & 0xff;
        out[o++] = n & 0xff;
    }
    if (pad > 0 && i + 1 < len) {
        const a = LOOK[clean.charCodeAt(i)];
        const b = LOOK[clean.charCodeAt(i + 1)];
        if (a < 0 || b < 0)
            throw new Error('Invalid base64 character');
        if (pad === 1) {
            if (i + 2 >= len)
                throw new Error('Invalid base64 padding');
            const c = LOOK[clean.charCodeAt(i + 2)];
            if (c < 0)
                throw new Error('Invalid base64 character');
            const n = (a << 18) | (b << 12) | (c << 6);
            out[o++] = (n >>> 16) & 0xff;
            out[o++] = (n >>> 8) & 0xff;
        }
        else {
            const n = (a << 18) | (b << 12);
            out[o++] = (n >>> 16) & 0xff;
        }
    }
    return out;
}
