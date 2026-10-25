/**
 * PNG codec for RGBA8 pixel buffers (v3.1 §6: cels stored as PNG entries).
 *
 * Encoder output: 8-bit RGBA (color type 6), filter type 0 per scanline,
 * non-interlaced — the simplest correct profile for sprite-sized images.
 * Decoder accepts the standard 8-bit profiles (color types 0/2/4/6, all five
 * filter types, non-interlaced) so canvas-exported PNGs and third-party
 * files decode as well.
 *
 * Compression uses CompressionStream('deflate') (zlib RFC 1950, exactly what
 * PNG IDAT requires) — available in Electron, Node ≥ 18, Bun, and browsers,
 * keeping this module dependency-free and DOM-free (§8.3).
 */
/** Encode an RGBA buffer as PNG. Buffer length must equal width*height*4. */
export declare function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Promise<Uint8Array>;
export interface DecodedPng {
    width: number;
    height: number;
    /** RGBA, length width*height*4. */
    rgba: Uint8ClampedArray;
}
/** Read width/height from the IHDR chunk without inflating pixel data. */
export declare function peekPngSize(bytes: Uint8Array): {
    width: number;
    height: number;
} | null;
/** Decode a PNG to RGBA. Supports 8-bit color types 0/2/4/6, filters 0–4, non-interlaced. */
export declare function decodePng(bytes: Uint8Array, entry?: string): Promise<DecodedPng>;
