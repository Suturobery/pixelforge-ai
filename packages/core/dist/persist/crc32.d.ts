/**
 * CRC-32 (IEEE 802.3, reflected) — required by PNG chunks and ZIP entries.
 * Pure, table-driven, allocation-free at call time.
 */
/** Compute CRC-32 over a byte range. */
export declare function crc32(data: Uint8Array, offset?: number, length?: number): number;
