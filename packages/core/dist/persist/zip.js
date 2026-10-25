"use strict";
/**
 * Minimal ZIP container reader/writer for `.pixelforgeproj` (v3.1 §6).
 *
 * Writer: STORE method only (cel PNGs are already deflate-compressed; nested
 * compression buys ~nothing and costs determinism). Deterministic entry order
 * = the order given by the caller. Fixed DOS timestamp keeps archives
 * byte-reproducible for golden tests (real mtimes live in manifest.json).
 *
 * Reader: STORE + DEFLATE (third-party tools may compress entries), strict
 * signature/length/CRC checks, duplicate-name rejection, and unsafe-path
 * rejection (traversal guard per §9.4 security tests).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.refToBytes = exports.bytesToRef = void 0;
exports.assertSafeEntryName = assertSafeEntryName;
exports.zipWrite = zipWrite;
exports.zipRead = zipRead;
const crc32_1 = require("./crc32");
const base64_1 = require("./base64");
const errors_1 = require("./errors");
const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------
/** Reject absolute paths, `..` segments, backslashes, and drive letters. */
function assertSafeEntryName(name) {
    if (name.length === 0)
        throw new errors_1.PersistError('UNSAFE_PATH', 'empty entry name');
    if (name.includes('\\'))
        throw new errors_1.PersistError('UNSAFE_PATH', `backslash in entry name "${name}"`);
    if (name.startsWith('/'))
        throw new errors_1.PersistError('UNSAFE_PATH', `absolute entry name "${name}"`);
    if (/^[a-zA-Z]:/.test(name))
        throw new errors_1.PersistError('UNSAFE_PATH', `drive-prefixed entry name "${name}"`);
    for (const seg of name.split('/')) {
        if (seg === '..')
            throw new errors_1.PersistError('UNSAFE_PATH', `".." segment in entry name "${name}"`);
    }
}
// ---------------------------------------------------------------------------
// writer
// ---------------------------------------------------------------------------
function zipWrite(entries) {
    const enc = new TextEncoder();
    const seen = new Set();
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        assertSafeEntryName(entry.name);
        if (seen.has(entry.name)) {
            throw new errors_1.PersistError('DUPLICATE_ENTRY', entry.name);
        }
        seen.add(entry.name);
        const nameBytes = enc.encode(entry.name);
        const crc = (0, crc32_1.crc32)(entry.data);
        const size = entry.data.length;
        const lfh = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(lfh.buffer);
        lv.setUint32(0, LFH_SIG, true);
        lv.setUint16(4, 20, true); // version needed
        lv.setUint16(6, UTF8_FLAG, true);
        lv.setUint16(8, METHOD_STORE, true);
        lv.setUint16(10, 0, true); // time
        lv.setUint16(12, 0x21, true); // date (1980-01-01, fixed for determinism)
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true); // compressed
        lv.setUint32(22, size, true); // uncompressed
        lv.setUint16(26, nameBytes.length, true);
        lfh.set(nameBytes, 30);
        locals.push(lfh, entry.data);
        const cdh = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cdh.buffer);
        cv.setUint32(0, CDH_SIG, true);
        cv.setUint16(4, 20, true); // version made by
        cv.setUint16(6, 20, true); // version needed
        cv.setUint16(8, UTF8_FLAG, true);
        cv.setUint16(10, METHOD_STORE, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0x21, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        cdh.set(nameBytes, 46);
        centrals.push(cdh);
        offset += lfh.length + size;
    }
    const centralSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, EOCD_SIG, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true); // central dir offset
    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of [...locals, ...centrals, eocd]) {
        out.set(part, off);
        off += part.length;
    }
    return out;
}
async function zipRead(bytes) {
    if (bytes.length < 22) {
        throw new errors_1.PersistError('BAD_ZIP', `file too small (${bytes.length} bytes)`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Locate the EOCD (scan back over a possible comment).
    let eocd = -1;
    const minEocd = bytes.length - 22;
    const scanFloor = Math.max(0, minEocd - 65535);
    for (let i = bytes.length - 22; i >= scanFloor; i--) {
        if (view.getUint32(i, true) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new errors_1.PersistError('BAD_ZIP', 'end-of-central-directory signature not found');
    }
    const entryCount = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOff = view.getUint32(eocd + 16, true);
    if (centralOff === 0xffffffff || entryCount === 0xffff) {
        throw new errors_1.PersistError('BAD_ZIP', 'ZIP64 archives are not supported');
    }
    if (centralOff + centralSize > eocd) {
        throw new errors_1.PersistError('BAD_ZIP', 'central directory extends past end-of-central-directory');
    }
    const dec = new TextDecoder();
    const names = [];
    const map = new Map();
    const seen = new Set();
    let p = centralOff;
    for (let i = 0; i < entryCount; i++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== CDH_SIG) {
            throw new errors_1.PersistError('BAD_ZIP', `central directory entry ${i} corrupt`);
        }
        const method = view.getUint16(p + 10, true);
        const crc = view.getUint32(p + 16, true);
        const compSize = view.getUint32(p + 20, true);
        const uncompSize = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const localOff = view.getUint32(p + 42, true);
        const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        assertSafeEntryName(name);
        if (seen.has(name)) {
            throw new errors_1.PersistError('DUPLICATE_ENTRY', name);
        }
        seen.add(name);
        if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
            throw new errors_1.PersistError('BAD_ZIP', `entry "${name}" uses unsupported method ${method}`);
        }
        // Local header: verify consistency, then take the payload.
        if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== LFH_SIG) {
            throw new errors_1.PersistError('BAD_ZIP', `local header for "${name}" corrupt`);
        }
        const lfNameLen = view.getUint16(localOff + 26, true);
        const lfExtraLen = view.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lfNameLen + lfExtraLen;
        const dataEnd = dataStart + compSize;
        if (dataEnd > bytes.length) {
            throw new errors_1.PersistError('BAD_ZIP', `entry "${name}" data truncated`);
        }
        const raw = bytes.subarray(dataStart, dataEnd);
        let data;
        if (method === METHOD_STORE) {
            data = raw.slice();
        }
        else {
            data = await inflateRaw(raw, name);
        }
        if (data.length !== uncompSize) {
            throw new errors_1.PersistError('BAD_ZIP', `entry "${name}" size mismatch (${data.length} != ${uncompSize})`);
        }
        const actualCrc = (0, crc32_1.crc32)(data);
        if (actualCrc !== crc) {
            throw new errors_1.PersistError('BAD_CHECKSUM', `ZIP CRC mismatch for "${name}"`, { entry: name });
        }
        names.push(name);
        map.set(name, data);
    }
    return {
        names,
        get: (name) => map.get(name),
        has: (name) => map.has(name),
    };
}
async function inflateRaw(data, entry) {
    if (typeof DecompressionStream !== 'function') {
        throw new errors_1.PersistError('BAD_ZIP', 'DecompressionStream is unavailable in this runtime', { entry });
    }
    try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const copy = new Uint8Array(new ArrayBuffer(data.length));
        copy.set(data);
        void writer.write(copy).catch(() => { });
        void writer.close().catch(() => { });
        const buf = await new Response(ds.readable).arrayBuffer();
        return new Uint8Array(buf);
    }
    catch (err) {
        throw new errors_1.PersistError('BAD_ZIP', `deflate stream for "${entry}" is corrupt`, { entry, cause: err });
    }
}
// ---------------------------------------------------------------------------
// binary helpers shared with the journal codec
// ---------------------------------------------------------------------------
/** Encode arbitrary bytes as a reference string for JSON transport (base64). */
exports.bytesToRef = base64_1.base64Encode;
/** Decode a base64 reference produced by bytesToRef. */
exports.refToBytes = base64_1.base64Decode;
