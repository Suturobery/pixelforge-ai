/** Small buffer helpers shared across the core (pure, DOM-free). */
export declare function cloneBuffer(buf: Uint8ClampedArray): Uint8ClampedArray;
/** Byte-exact equality (same length + same bytes). */
export declare function bufferEquals(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean;
/** True when every byte is 0 (fully transparent, alpha 0 everywhere). */
export declare function isZeroBuffer(buf: Uint8ClampedArray): boolean;
