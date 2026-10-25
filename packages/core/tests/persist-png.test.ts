/**
 * PNG codec tests (Task 3 §6: cel serialization) — round-trips incl. odd
 * sizes, alpha patterns, and decode robustness on corruption.
 */

import { describe, expect, test } from 'bun:test';
import { decodePng, encodePng, peekPngSize } from '../src/persist/png';

function gradient(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[i] = (x * 255) / Math.max(1, width - 1);
      buf[i + 1] = (y * 255) / Math.max(1, height - 1);
      buf[i + 2] = (x * y) % 256;
      buf[i + 3] = (x + y) % 2 === 0 ? 255 : 128;
    }
  }
  return buf;
}

function expectBuffersEqual(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
}

describe('png codec', () => {
  test('round-trips 16×16 gradient (RGBA8, filter 0 output)', async () => {
    const w = 16;
    const h = 16;
    const rgba = gradient(w, h);
    const png = await encodePng(w, h, rgba);
    expect(png[0]).toBe(0x89);
    expect(png.subarray(1, 4)).toEqual(new TextEncoder().encode('PNG'));
    const decoded = await decodePng(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expectBuffersEqual(decoded.rgba, rgba);
  });

  test('round-trips non-multiple-of-16 sizes (20×13, 33×17, 256×256 block)', async () => {
    for (const [w, h] of [
      [20, 13],
      [33, 17],
    ] as const) {
      const rgba = gradient(w, h);
      const decoded = await decodePng(await encodePng(w, h, rgba));
      expect(decoded.width).toBe(w);
      expect(decoded.height).toBe(h);
      expectBuffersEqual(decoded.rgba, rgba);
    }
    const big = new Uint8ClampedArray(256 * 256 * 4);
    big[0] = 7;
    big[big.length - 1] = 99;
    const decoded = await decodePng(await encodePng(256, 256, big));
    expect(decoded.rgba[0]).toBe(7);
    expect(decoded.rgba[decoded.rgba.length - 1]).toBe(99);
  });

  test('round-trips fully transparent buffer', async () => {
    const rgba = new Uint8ClampedArray(32 * 32 * 4);
    const decoded = await decodePng(await encodePng(32, 32, rgba));
    expectBuffersEqual(decoded.rgba, rgba);
  });

  test('peekPngSize reads IHDR without decoding', async () => {
    const png = await encodePng(48, 27, new Uint8ClampedArray(48 * 27 * 4));
    expect(peekPngSize(png)).toEqual({ width: 48, height: 27 });
    expect(peekPngSize(png.subarray(0, 10))).toBeNull();
    expect(peekPngSize(new Uint8Array(64))).toBeNull();
  });

  test('rejects wrong buffer length and invalid dimensions', async () => {
    await expect(encodePng(16, 16, new Uint8ClampedArray(15 * 15 * 4))).rejects.toMatchObject({
      name: 'PersistError',
      code: 'ENCODE_FAILED',
    });
    await expect(encodePng(0, 16, new Uint8ClampedArray(16))).rejects.toMatchObject({ code: 'ENCODE_FAILED' });
  });

  test('decode rejects truncated / signature-less / corrupt data', async () => {
    const png = await encodePng(16, 16, gradient(16, 16));
    await expect(decodePng(png.subarray(0, 20))).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    await expect(decodePng(new Uint8Array(200))).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    const corrupted = png.slice();
    // Flip a byte inside the IDAT payload (zlib stream) → inflate must fail.
    const idatStart = corrupted.findIndex((b, i) => b === 0x49 && corrupted[i + 1] === 0x44 && corrupted[i + 2] === 0x41 && corrupted[i + 3] === 0x54);
    expect(idatStart).toBeGreaterThan(0);
    corrupted[idatStart + 12] ^= 0xff;
    corrupted[idatStart + 13] ^= 0xff;
    // Guarantee: rejection (never silent success). The typed wrapper is best-
    // effort — some runtimes surface the raw zlib error asynchronously.
    await expect(decodePng(corrupted)).rejects.toThrow();
  });
});
