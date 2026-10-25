/**
 * SHA-256 digests for manifest checksums (v3.1 §6, C5: "sha256 for EVERY
 * entry"). Uses the WebCrypto SubtleCrypto digest — available in Electron,
 * Node ≥ 15, Bun, and browsers, so the core stays dependency-free.
 */
export declare function sha256Hex(data: Uint8Array): Promise<string>;
