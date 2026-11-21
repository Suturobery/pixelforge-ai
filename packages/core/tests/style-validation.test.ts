import { describe, expect, test } from 'bun:test';
import { defaultStyleProfile, validateStyleCandidate } from '../src';

function pixels(rows: Array<Array<[number, number, number, number]>>): Uint8ClampedArray {
  return new Uint8ClampedArray(rows.flat(2));
}

describe('style candidate validation', () => {
  test('reports the technical constraints that are actually met', () => {
    const profile = { ...defaultStyleProfile(), enabled: true };
    const result = validateStyleCandidate({
      buffer: pixels([
        [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        [[0, 0, 0, 0], [255, 0, 0, 255], [0, 0, 0, 0]],
        [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      ]),
      width: 3,
      height: 3,
      targetWidth: 3,
      targetHeight: 3,
      palette: ['#ff0000'],
      profile,
    });
    expect(result.every((check) => check.status === 'pass')).toBe(true);
  });

  test('flags out-of-palette, semi-transparent, and edge-touching output', () => {
    const profile = { ...defaultStyleProfile(), enabled: true };
    const result = validateStyleCandidate({
      buffer: pixels([
        [[0, 255, 0, 128], [0, 0, 0, 255]],
        [[0, 0, 0, 255], [0, 0, 0, 255]],
      ]),
      width: 2,
      height: 2,
      targetWidth: 2,
      targetHeight: 2,
      palette: ['#ff0000'],
      profile,
    });
    expect(result.find((check) => check.id === 'alpha')?.status).toBe('warning');
    expect(result.find((check) => check.id === 'palette')?.status).toBe('warning');
    expect(result.find((check) => check.id === 'background')?.status).toBe('warning');
    expect(result.find((check) => check.id === 'margin')?.status).toBe('warning');
  });
});
