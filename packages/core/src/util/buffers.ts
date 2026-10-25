/** Small buffer helpers shared across the core (pure, DOM-free). */

export function cloneBuffer(buf: Uint8ClampedArray): Uint8ClampedArray {
  return new Uint8ClampedArray(buf);
}

/** Byte-exact equality (same length + same bytes). */
export function bufferEquals(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True when every byte is 0 (fully transparent, alpha 0 everywhere). */
export function isZeroBuffer(buf: Uint8ClampedArray): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}
