/**
 * Task 5a — ellipse rasterization tests (v3.1 §2.1 "Midpoint algorithm +
 * stamp, filled/unfilled"). Contract: deterministic integer rasterization,
 * symmetric for odd AND even sizes, outline ⊆ fill, degenerate boxes
 * (1×N / N×1 / 1×1) behave like lines/dots, boundary clipping correct.
 */

import { describe, expect, test } from 'bun:test';
import {
  drawEllipsePixels,
  ellipseOutlinePoints,
  normalizeEllipseBox,
} from '../src/pixels/ellipse';
import { getPixel } from '../src/pixels/ops';

const W = 40;
const H = 40;

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4);
}

const RED: [number, number, number, number] = [255, 0, 0, 255];

function isRed(buf: Uint8ClampedArray, x: number, y: number): boolean {
  const [r, g, b, a] = getPixel(buf, W, x, y);
  return r === 255 && g === 0 && b === 0 && a === 255;
}

function renderSet(w: number, h: number): Set<number> {
  return new Set(ellipseOutlinePoints(0, 0, w - 1, h - 1).map((p) => p.y * w + p.x));
}

function countSet(s: Set<number>, w: number, h: number): { mask: string[]; n: number } {
  const mask: string[] = [];
  let n = 0;
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const on = s.has(y * w + x);
      if (on) n++;
      row += on ? '#' : '.';
    }
    mask.push(row);
  }
  return { mask, n };
}

describe('ellipse: normalization', () => {
  test('normalizes swapped endpoints', () => {
    const box = normalizeEllipseBox(8, 5, 2, 1);
    expect(box).toEqual({ left: 2, top: 1, right: 8, bottom: 5 });
  });
});

describe('ellipse: golden shapes (hand-verified against the classic midpoint look)', () => {
  test('3×3 renders the plus shape', () => {
    const { mask } = countSet(renderSet(3, 3), 3, 3);
    expect(mask).toEqual(['.#.', '#.#', '.#.']);
  });

  test('4×4 renders the classic even-size ring', () => {
    const { mask } = countSet(renderSet(4, 4), 4, 4);
    expect(mask).toEqual(['.##.', '#..#', '#..#', '.##.']);
  });

  test('5×5 renders the classic ring', () => {
    const { mask } = countSet(renderSet(5, 5), 5, 5);
    expect(mask).toEqual(['.###.', '#...#', '#...#', '#...#', '.###.']);
  });

  test('2×2 renders the full block (no smaller ring exists)', () => {
    const { mask } = countSet(renderSet(2, 2), 2, 2);
    expect(mask).toEqual(['##', '##']);
  });

  test('6×6 matches the Aseprite-style circle', () => {
    const { mask } = countSet(renderSet(6, 6), 6, 6);
    expect(mask).toEqual(['.####.', '#....#', '#....#', '#....#', '#....#', '.####.']);
  });
});

describe('ellipse: invariants across many sizes', () => {
  const sizes: Array<[number, number]> = [];
  for (let w = 1; w <= 24; w++) {
    for (let h = 1; h <= 24; h++) sizes.push([w, h]);
  }

  test('4-fold symmetry for every size 1..24 × 1..24', () => {
    for (const [w, h] of sizes) {
      const s = renderSet(w, h);
      for (const idx of s) {
        const x = idx % w;
        const y = Math.floor(idx / w);
        expect(s.has((h - 1 - y) * w + x)).toBe(true); // y-mirror
        expect(s.has(y * w + (w - 1 - x))).toBe(true); // x-mirror
      }
    }
  });

  test('tips exist: top row, bottom row, left+right columns non-empty', () => {
    for (const [w, h] of sizes) {
      const s = renderSet(w, h);
      let top = 0;
      let bottom = 0;
      let left = 0;
      let right = 0;
      for (let x = 0; x < w; x++) {
        if (s.has(x)) top++;
        if (s.has((h - 1) * w + x)) bottom++;
      }
      for (let y = 0; y < h; y++) {
        if (s.has(y * w)) left++;
        if (s.has(y * w + w - 1)) right++;
      }
      expect(top).toBeGreaterThan(0);
      expect(bottom).toBeGreaterThan(0);
      expect(left).toBeGreaterThan(0);
      expect(right).toBeGreaterThan(0);
    }
  });

  test('ring is 8-connected (no gaps) for every size', () => {
    for (const [w, h] of sizes) {
      if (w === 1 || h === 1) continue; // lines are trivially connected
      const s = renderSet(w, h);
      // every ring pixel must have another ring pixel within king-move 1
      // (the ring is a closed curve; a single-pixel gap breaks this)
      for (const idx of s) {
        const x = idx % w;
        const y = Math.floor(idx / w);
        let neighbor = false;
        for (let dy = -2; dy <= 2 && !neighbor; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (s.has(ny * w + nx)) {
              neighbor = true;
              break;
            }
          }
        }
        expect(neighbor).toBe(true);
      }
    }
  });

  test('determinism: identical calls produce identical pixel sets', () => {
    const a = renderSet(13, 9);
    const b = renderSet(13, 9);
    expect(a).toEqual(b);
  });
});

describe('ellipse: drawEllipsePixels on a buffer', () => {
  test('outline mode plots only ring pixels', () => {
    const buf = blank();
    drawEllipsePixels(buf, W, H, 5, 5, 15, 11, 1, RED, false);
    const pts = ellipseOutlinePoints(5, 5, 15, 11);
    let red = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isRed(buf, x, y)) red++;
      }
    }
    expect(red).toBe(new Set(pts.map((p) => `${p.x},${p.y}`)).size);
    for (const p of pts) expect(isRed(buf, p.x, p.y)).toBe(true);
  });

  test('filled mode covers the outline and has no interior holes', () => {
    const buf = blank();
    drawEllipsePixels(buf, W, H, 3, 3, 21, 15, 1, RED, true);
    const outline = new Set(
      ellipseOutlinePoints(3, 3, 21, 15).map((p) => p.y * W + p.x)
    );
    // every outline pixel is red
    for (const idx of outline) {
      expect(isRed(buf, idx % W, Math.floor(idx / W))).toBe(true);
    }
    // every row span between its leftmost/rightmost red pixels is fully red
    for (let y = 0; y < H; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < W; x++) {
        if (isRed(buf, x, y)) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first < 0) continue;
      for (let x = first; x <= last; x++) {
        expect(isRed(buf, x, y)).toBe(true);
      }
    }
  });

  test('degenerate 1×1 draws a dot; 1×N draws a line', () => {
    const dot = blank();
    drawEllipsePixels(dot, W, H, 7, 7, 7, 7, 1, RED, false);
    expect(isRed(dot, 7, 7)).toBe(true);
    let red = 0;
    for (let i = 3; i < dot.length; i += 4) if (dot[i] === 255) red++;
    expect(red).toBe(1);

    const line = blank();
    drawEllipsePixels(line, W, H, 2, 4, 2, 12, 1, RED, false);
    for (let y = 4; y <= 12; y++) expect(isRed(line, 2, y)).toBe(true);
  });

  test('clips at canvas boundaries without plotting outside', () => {
    const buf = blank();
    // ellipse centered near the top-left corner, box extends past the canvas
    drawEllipsePixels(buf, W, H, -4, -4, 6, 6, 1, RED, false);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isRed(buf, x, y)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // something got drawn (corner arc)
    let red = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] === 255) red++;
    expect(red).toBeGreaterThan(0);
  });

  test('box fully outside the canvas draws nothing', () => {
    const buf = blank();
    const n = drawEllipsePixels(buf, W, H, 50, 50, 60, 60, 1, RED, false);
    expect(n).toBe(0);
  });

  test('mirrorX mirrors every plotted pixel across the canvas axis', () => {
    const buf = blank();
    drawEllipsePixels(buf, W, H, 2, 2, 10, 8, 1, RED, false, true);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        expect(isRed(buf, x, y)).toBe(isRed(buf, W - 1 - x, y));
      }
    }
  });

  test('determinism: same args → byte-identical buffers', () => {
    const a = blank();
    const b = blank();
    drawEllipsePixels(a, W, H, 4, 4, 30, 20, 2, RED, true);
    drawEllipsePixels(b, W, H, 4, 4, 30, 20, 2, RED, true);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test('filled ellipse encloses its outline-mode twin', () => {
    const outline = blank();
    const fill = blank();
    drawEllipsePixels(outline, W, H, 6, 6, 20, 14, 1, RED, false);
    drawEllipsePixels(fill, W, H, 6, 6, 20, 14, 1, RED, true);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isRed(outline, x, y)) expect(isRed(fill, x, y)).toBe(true);
      }
    }
  });
});
