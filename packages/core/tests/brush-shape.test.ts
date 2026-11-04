/**
 * Brush shapes — square (default) vs Aseprite-style circle disc.
 */

import { describe, expect, test } from 'bun:test';
import { createProject, CommandBus, stampBrush, inBrushDisc } from '../src';

function makeBus() {
  const project = createProject({ width: 16, height: 16 });
  return new CommandBus(project);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

function countPixels(buf: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++;
  return n;
}

describe('inBrushDisc', () => {
  test('size 3 = plus (corners out)', () => {
    expect(inBrushDisc(0, 0, 3)).toBe(false); // corner
    expect(inBrushDisc(1, 0, 3)).toBe(true); // edge mid
    expect(inBrushDisc(1, 1, 3)).toBe(true); // center
    expect(inBrushDisc(2, 2, 3)).toBe(false); // corner
  });
  test('size 2 = full 2×2', () => {
    expect(inBrushDisc(0, 0, 2)).toBe(true);
    expect(inBrushDisc(1, 1, 2)).toBe(true);
  });
  test('size 5 circle cuts corners', () => {
    expect(inBrushDisc(0, 0, 5)).toBe(false); // corner
    expect(inBrushDisc(2, 2, 5)).toBe(true); // center
    expect(inBrushDisc(0, 2, 5)).toBe(true); // edge mid
  });
});

describe('stampBrush shapes', () => {
  test('default square paints size² pixels', () => {
    const bus = makeBus();
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    stampBrush(buf, 16, 16, 8, 8, 5, RED);
    expect(countPixels(buf)).toBe(25);
  });
  test('circle size 3 paints plus (5 px)', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    stampBrush(buf, 16, 16, 8, 8, 3, RED, false, 'circle');
    expect(countPixels(buf)).toBe(5);
  });
  test('circle size 5 paints disc (21 px), corners empty', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    stampBrush(buf, 16, 16, 8, 8, 5, RED, false, 'circle');
    expect(countPixels(buf)).toBe(21);
    // corner pixels (6,6) and (10,10) stay empty
    expect(buf[(6 * 16 + 6) * 4 + 3]).toBe(0);
    expect(buf[(10 * 16 + 10) * 4 + 3]).toBe(0);
  });
  test('circle size 2 paints full 2×2', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    stampBrush(buf, 16, 16, 8, 8, 2, RED, false, 'circle');
    expect(countPixels(buf)).toBe(4);
  });
});
