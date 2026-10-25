/**
 * Pure base64 encode/decode (RFC 4648, standard alphabet, padded).
 *
 * Keeps the core DOM-free and environment-neutral: data URLs (v1 importer)
 * and JSONL-embedded binary (journal payloads carrying buffers) convert
 * through here instead of Node's Buffer or the browser's atob/btoa.
 */
export declare function base64Encode(data: Uint8Array | Uint8ClampedArray): string;
export declare function base64Decode(text: string): Uint8Array;
