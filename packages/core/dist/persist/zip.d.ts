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
import { base64Decode, base64Encode } from './base64';
export interface ZipEntry {
    name: string;
    data: Uint8Array;
}
/** Reject absolute paths, `..` segments, backslashes, and drive letters. */
export declare function assertSafeEntryName(name: string): void;
export declare function zipWrite(entries: ZipEntry[]): Uint8Array;
export interface ZipArchive {
    /** Entry names in central-directory order. */
    names: string[];
    get(name: string): Uint8Array | undefined;
    has(name: string): boolean;
}
export declare function zipRead(bytes: Uint8Array): Promise<ZipArchive>;
/** Encode arbitrary bytes as a reference string for JSON transport (base64). */
export declare const bytesToRef: typeof base64Encode;
/** Decode a base64 reference produced by bytesToRef. */
export declare const refToBytes: typeof base64Decode;
