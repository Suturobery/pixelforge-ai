// Palette share codes — round-trip tests (encode → decode, corruption, sizes).
import { describe, expect, test } from 'bun:test';

import { encodePaletteCode, decodePaletteCode } from '../../../src/lib/pixelforge/palette-share';

describe('palette share codes', () => {
  const PICO8 = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'];

  test('round-trip: 16-color palette survives encode→decode', () => {
    const code = encodePaletteCode(PICO8);
    expect(code.startsWith('PF1-')).toBe(true);
    expect(decodePaletteCode(code)).toEqual(PICO8);
  });

  test('round-trip: single color and 256 colors', () => {
    expect(decodePaletteCode(encodePaletteCode(['#123456']))).toEqual(['#123456']);
    const big = Array.from({ length: 256 }, (_, i) => {
      const h = ((i * 7) % 256).toString(16).padStart(2, '0');
      return `#${h}${h}${h}`;
    });
    expect(decodePaletteCode(encodePaletteCode(big)).length).toBe(256);
  });

  test('lowercase normalization: mixed-case hexes round-trip', () => {
    const code = encodePaletteCode(['#ABCDEF', '#123456']);
    expect(decodePaletteCode(code)).toEqual(['#abcdef', '#123456']);
  });

  test('rejects garbage and corrupted payloads', () => {
    expect(() => decodePaletteCode('hello')).toThrow();
    expect(() => decodePaletteCode('PF1-!!!')).toThrow();
    expect(() => decodePaletteCode('PF1-')).toThrow();
    // valid base64 but odd hex length → corrupted
    expect(() => decodePaletteCode('PF1-YWJj')).toThrow();
  });

  test('encode rejects palettes with no valid colors', () => {
    expect(() => encodePaletteCode([])).toThrow();
    expect(() => encodePaletteCode(['nope', 'zzz'])).toThrow();
  });
});
