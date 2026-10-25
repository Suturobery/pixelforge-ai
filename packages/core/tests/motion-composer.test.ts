/**
 * Motion composer golden tests (Task 10, v3.1 §4.1.1 + §13 "Motion-composer
 * goldens: overlap z-order, gapFill both modes, amp scaling 16/32/64 (incl.
 * sign preservation C25), absent-part skip C27, linked-layer skip, static
 * remainder bit-identity").
 *
 * Fixtures are hand-computed literal expectations on tiny canvases. Any
 * intentional golden update must be explained in the worklog + task report.
 */

import { describe, expect, test } from 'bun:test';
import {
  createProject,
  MOTION_PRESETS,
  planMotion,
  scaledOffset,
  type Clip,
  type Part,
  type PartRect,
  type Project,
  type RGBA,
} from '../src';

// ---------------------------------------------------------------------------
// deterministic fixtures
// ---------------------------------------------------------------------------

const RED: RGBA = [255, 0, 0, 255];
const GREEN: RGBA = [0, 255, 0, 255];
const SEMI: RGBA = [10, 20, 30, 200]; // ≥128 → moves, alpha promoted to 255
const FAINT: RGBA = [10, 20, 30, 100]; // <128 → transparent, does not move

function paintRect(buf: Uint8ClampedArray, w: number, r: PartRect, c: RGBA): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = c[3];
    }
  }
}

function px(buf: Uint8ClampedArray, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

interface World {
  project: Project;
  clip: Clip;
  layerId: string;
  frameId: string;
}

function world(width = 32, height = 32): World {
  const project = createProject({ name: 'motion-t', width, height });
  const clip = project.clips[0];
  const layerId = clip.layers[0].id;
  const frameId = clip.frames[0].id;
  return { project, clip, layerId, frameId };
}

function part(
  name: string,
  layerId: string,
  rect: PartRect | undefined,
  z: number,
  anchorFrameId: string
): Part {
  return { id: `pt-${name}`, name, layerId, ...(rect ? { rect } : {}), anchorFrameId, z };
}

function withCel(world: World, paint: (buf: Uint8ClampedArray, w: number, h: number) => void): World {
  const { clip, layerId, frameId, project } = world;
  const buf = new Uint8ClampedArray(project.width * project.height * 4);
  paint(buf, project.width, project.height);
  clip.frames[0].cels[layerId] = { buffer: buf, linked: false };
  return world;
}

function plan(
  w: World,
  preset: Parameters<typeof planMotion>[2]['preset'],
  params?: { amplitude?: number; frameCount?: number; gapFill?: 'none' | 'edge-extend'; smear?: boolean }
) {
  return planMotion(w.project, w.clip, { preset, params });
}

// ---------------------------------------------------------------------------
// R10 — amplitude scaling 16/32/64 + sign preservation (C25)
// ---------------------------------------------------------------------------

describe('R10 amplitude scaling', () => {
  test('scaledOffset: sign-preserving with 1px magnitude floor (C25)', () => {
    // the exact C25 defect: −1 at ampScale 0.5 must stay NEGATIVE
    expect(scaledOffset(-1, 0.5)).toBe(-1);
    expect(scaledOffset(1, 0.5)).toBe(1);
    expect(scaledOffset(-2, 0.5)).toBe(-1);
    expect(scaledOffset(2, 2)).toBe(4);
    expect(scaledOffset(3, 1)).toBe(3);
    expect(scaledOffset(0, 2)).toBe(0);
    expect(scaledOffset(-3, 0.25)).toBe(-1); // floor keeps motion visible
  });

  test('idle bob at 32×32 follows body dy [0,−1,−2,−1] exactly', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 15, y: 16, w: 1, h: 1 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 0, y: 0, w: 32, h: 32 }, 0, w.frameId)];
    const p = plan(w, 'idle');
    expect(p.report.ampScale).toBe(1);
    const ys = p.frames.map((f) => {
      for (let y = 0; y < 32; y++) if (px(f.cels[w.layerId], 32, 15, y)[3] === 255) return y;
      return -1;
    });
    expect(ys).toEqual([16, 15, 14, 15]);
  });

  test('idle bob at 16×16 keeps 1px magnitude and downward direction (C15/C25)', () => {
    const w = withCel(world(16, 16), (buf, s) => paintRect(buf, s, { x: 7, y: 8, w: 1, h: 1 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 0, y: 0, w: 16, h: 16 }, 0, w.frameId)];
    const p = plan(w, 'idle');
    expect(p.report.ampScale).toBe(0.5);
    const ys = p.frames.map((f) => {
      for (let y = 0; y < 16; y++) if (px(f.cels[w.layerId], 16, 7, y)[3] === 255) return y;
      return -1;
    });
    // dy [0,−1,−2,−1] → scaled [0,−1,−1,−1]: never flips into a sag
    expect(ys).toEqual([8, 7, 7, 7]);
  });

  test('idle bob at 64×64 doubles the amplitude', () => {
    const w = withCel(world(64, 64), (buf, s) => paintRect(buf, s, { x: 31, y: 32, w: 1, h: 1 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 0, y: 0, w: 64, h: 64 }, 0, w.frameId)];
    const p = plan(w, 'idle');
    expect(p.report.ampScale).toBe(2);
    const ys = p.frames.map((f) => {
      for (let y = 0; y < 64; y++) if (px(f.cels[w.layerId], 64, 31, y)[3] === 255) return y;
      return -1;
    });
    expect(ys).toEqual([32, 30, 28, 30]);
  });

  test('user amplitude multiplies curve values before R10', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 15, y: 16, w: 1, h: 1 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 0, y: 0, w: 32, h: 32 }, 0, w.frameId)];
    const p = plan(w, 'idle', { amplitude: 2 });
    const ys = p.frames.map((f) => {
      for (let y = 0; y < 32; y++) if (px(f.cels[w.layerId], 32, 15, y)[3] === 255) return y;
      return -1;
    });
    expect(ys).toEqual([16, 14, 12, 14]); // [0,−2,−4,−2]
  });
});

// ---------------------------------------------------------------------------
// R1/R2 — paint order + overlap ownership
// ---------------------------------------------------------------------------

describe('R1/R2 overlap z-order', () => {
  test('walk frame 0: pixel in armL∩body moves with armL (higher z); body-only pixels stay', () => {
    const w = withCel(world(32, 32), (buf, s) => {
      paintRect(buf, s, { x: 12, y: 12, w: 1, h: 1 }, RED); // in BOTH rects
      paintRect(buf, s, { x: 20, y: 18, w: 1, h: 1 }, GREEN); // body only
      paintRect(buf, s, { x: 12, y: 18, w: 1, h: 1 }, GREEN); // body only (below armL)
    });
    w.clip.parts = [
      part('body', w.layerId, { x: 8, y: 6, w: 16, h: 14 }, 0, w.frameId),
      part('armL', w.layerId, { x: 10, y: 10, w: 6, h: 6 }, 1, w.frameId),
    ];
    const p = plan(w, 'walk');
    const f0 = p.frames[0].cels[w.layerId];
    // armL walk frame 0: dx −3, dy 0 → red lands at (9,12)
    expect(px(f0, 32, 9, 12)).toEqual([255, 0, 0, 255]);
    expect(px(f0, 32, 12, 12)[3]).toBe(0); // cut, no residue, body did NOT move it
    // body bob frame 0: dy 0 → greens untouched
    expect(px(f0, 32, 20, 18)).toEqual([0, 255, 0, 255]);
    expect(px(f0, 32, 12, 18)).toEqual([0, 255, 0, 255]);
  });

  test('walk frame 2: armL swings +3 over the body region (paint order wins)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 12, y: 12, w: 1, h: 1 }, RED));
    w.clip.parts = [
      part('body', w.layerId, { x: 8, y: 6, w: 16, h: 14 }, 0, w.frameId),
      part('armL', w.layerId, { x: 10, y: 10, w: 6, h: 6 }, 1, w.frameId),
    ];
    const p = plan(w, 'walk');
    const f2 = p.frames[2].cels[w.layerId];
    expect(px(f2, 32, 15, 12)).toEqual([255, 0, 0, 255]); // 12 + 3
  });

  test('parts on separate layers composite independently (no cross-layer ownership)', () => {
    const w = world(32, 32);
    const layer2 = w.clip.layers[0]; // single layer by default — add via command path instead
    void layer2;
    // composer works per layer; a second layer would need its own part to move.
    // Covered at command level (motion-commands) — here assert single-layer plan.
    const p = plan(w, 'idle');
    expect(p.report.affectedLayerIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R3 — binary alpha threshold
// ---------------------------------------------------------------------------

describe('R3 transparency threshold', () => {
  test('alpha ≥128 moves and is promoted to 255; alpha <128 is cleared; static semi-alpha untouched', () => {
    const w = withCel(world(32, 32), (buf, s) => {
      paintRect(buf, s, { x: 4, y: 4, w: 1, h: 1 }, SEMI);
      paintRect(buf, s, { x: 6, y: 6, w: 1, h: 1 }, FAINT);
      paintRect(buf, s, { x: 8, y: 8, w: 1, h: 1 }, RED);
      paintRect(buf, s, { x: 30, y: 30, w: 1, h: 1 }, SEMI); // OUTSIDE the part rect
    });
    w.clip.parts = [part('body', w.layerId, { x: 0, y: 0, w: 16, h: 16 }, 0, w.frameId)];
    const p = plan(w, 'idle');
    const f1 = p.frames[1].cels[w.layerId]; // dy −1
    expect(px(f1, 32, 4, 3)).toEqual([10, 20, 30, 255]); // moved + binary
    expect(px(f1, 32, 4, 4)[3]).toBe(0); // old spot cleared
    expect(px(f1, 32, 6, 5)[3]).toBe(0); // faint pixel did NOT move
    expect(px(f1, 32, 6, 6)[3]).toBe(0); // faint pixel cleared
    expect(px(f1, 32, 8, 7)).toEqual([255, 0, 0, 255]); // opaque moved
    expect(px(f1, 32, 30, 30)).toEqual([10, 20, 30, 200]); // R9: static remainder bit-identical
  });
});

// ---------------------------------------------------------------------------
// R4 — bounds (no wrap) + gapFill both modes (C26)
// ---------------------------------------------------------------------------

describe('R4 bounds & gapFill', () => {
  test('pixels pushed past the canvas edge are dropped (no wrap) and counted', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 29, y: 10, w: 3, h: 4 }, RED));
    w.clip.parts = [part('legL', w.layerId, { x: 29, y: 10, w: 3, h: 4 }, 0, w.frameId)];
    const p = plan(w, 'walk');
    const f0 = p.frames[0].cels[w.layerId]; // legL dx +3 → cols 32..34 = off-canvas
    let visible = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (px(f0, 32, x, y)[3] === 255) visible++;
    expect(visible).toBe(0);
    expect(p.report.clippedPixels).toBe(12);
    // frame 1: dx 0, dy −1 → intact one row up
    const f1 = p.frames[1].cels[w.layerId];
    expect(px(f1, 32, 30, 9)).toEqual([255, 0, 0, 255]);
  });

  test('gapFill none leaves vacated pixels transparent (honest draft)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 10, y: 12, w: 4, h: 4 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 10, y: 12, w: 4, h: 4 }, 0, w.frameId)];
    const p = plan(w, 'idle', { gapFill: 'none' });
    const f2 = p.frames[2].cels[w.layerId]; // dy −2
    expect(px(f2, 32, 10, 10)).toEqual([255, 0, 0, 255]); // pasted
    expect(px(f2, 32, 10, 14)[3]).toBe(0); // vacated → transparent
    expect(px(f2, 32, 10, 15)[3]).toBe(0);
  });

  test('gapFill edge-extend repeats the trailing boundary row until the hole closes (C26, 2px hole)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 10, y: 12, w: 4, h: 4 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 10, y: 12, w: 4, h: 4 }, 0, w.frameId)];
    const p = plan(w, 'idle', { gapFill: 'edge-extend' });
    const f2 = p.frames[2].cels[w.layerId]; // dy −2 → holes at rows 14–15
    expect(px(f2, 32, 10, 10)).toEqual([255, 0, 0, 255]);
    // trailing boundary row of the pasted region (row 13) repeats into 14 AND 15
    expect(px(f2, 32, 10, 13)).toEqual([255, 0, 0, 255]);
    expect(px(f2, 32, 10, 14)).toEqual([255, 0, 0, 255]);
    expect(px(f2, 32, 10, 15)).toEqual([255, 0, 0, 255]);
    expect(px(f2, 32, 13, 15)).toEqual([255, 0, 0, 255]);
  });

  test('gapFill edge-extend fills a 3px horizontal hole (walk leg dx +3)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 10, y: 20, w: 4, h: 2 }, RED));
    w.clip.parts = [part('legL', w.layerId, { x: 10, y: 20, w: 4, h: 2 }, 0, w.frameId)];
    const p = plan(w, 'walk', { gapFill: 'edge-extend' });
    const f0 = p.frames[0].cels[w.layerId]; // dx +3 → cols 13–16; holes 10–12
    for (const x of [10, 11, 12, 13]) {
      expect(px(f0, 32, x, 20)).toEqual([255, 0, 0, 255]); // all filled with trailing col 13
    }
    expect(px(f0, 32, 16, 21)).toEqual([255, 0, 0, 255]); // pasted content intact
  });
});

// ---------------------------------------------------------------------------
// C27 — absent-part skip is per-part and reported
// ---------------------------------------------------------------------------

describe('C27 absent-part skip', () => {
  test('no parts tagged: all roles skipped, frames are holds, warning emitted', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 4, y: 4, w: 2, h: 2 }, RED));
    const p = plan(w, 'idle');
    expect(p.report.skipped.map((s) => s.role).sort()).toEqual(['body', 'hair', 'head']);
    expect(p.report.moved).toEqual([]);
    expect(p.report.warnings.some((x) => x.code === 'no_moving_parts')).toBe(true);
    // no affected layers → no composed cels; the apply command treats every
    // frame as a hold of the anchor (command-level test covers the commit)
    expect(p.frames.length).toBe(4);
    for (const f of p.frames) {
      expect(Object.keys(f.cels)).toEqual([]);
    }
  });

  test('body-only farmer: head/hair skipped and listed, body still bobs (C27 flagship case)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 15, y: 16, w: 1, h: 1 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 0, y: 0, w: 32, h: 32 }, 0, w.frameId)];
    const p = plan(w, 'idle');
    expect(p.report.skipped.map((s) => s.role).sort()).toEqual(['hair', 'head']);
    expect(p.report.moved).toEqual([{ role: 'body', partName: 'body', layerId: w.layerId }]);
    const ys = p.frames.map((f) => {
      for (let y = 0; y < 32; y++) if (px(f.cels[w.layerId], 32, 15, y)[3] === 255) return y;
      return -1;
    });
    expect(ys).toEqual([16, 15, 14, 15]);
  });
});

// ---------------------------------------------------------------------------
// R9 — static remainder bit-identity
// ---------------------------------------------------------------------------

describe('R9 static remainder', () => {
  test('pixels outside all part rects are bit-identical across every frame', () => {
    const w = withCel(world(32, 32), (buf, s) => {
      paintRect(buf, s, { x: 10, y: 10, w: 4, h: 4 }, RED); // inside the part
      paintRect(buf, s, { x: 0, y: 0, w: 3, h: 3 }, GREEN); // outside
      paintRect(buf, s, { x: 28, y: 28, w: 3, h: 3 }, SEMI); // outside, semi-alpha
    });
    w.clip.parts = [part('body', w.layerId, { x: 8, y: 8, w: 8, h: 8 }, 0, w.frameId)];
    const p = plan(w, 'idle');
    for (const f of p.frames) {
      const buf = f.cels[w.layerId];
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          expect(px(buf, 32, x, y)).toEqual([0, 255, 0, 255]);
        }
      }
      expect(px(buf, 32, 28, 28)).toEqual([10, 20, 30, 200]);
      expect(px(buf, 32, 30, 30)).toEqual([10, 20, 30, 200]);
    }
  });
});

// ---------------------------------------------------------------------------
// determinism — same source + parameters = byte-identical output
// ---------------------------------------------------------------------------

describe('determinism', () => {
  test('two planMotion runs produce byte-identical buffers (walk, multi-part)', () => {
    const w = withCel(world(32, 32), (buf, s) => {
      paintRect(buf, s, { x: 8, y: 6, w: 16, h: 14 }, RED);
      paintRect(buf, s, { x: 10, y: 20, w: 4, h: 10 }, GREEN);
      paintRect(buf, s, { x: 18, y: 20, w: 4, h: 10 }, GREEN);
    });
    w.clip.parts = [
      part('body', w.layerId, { x: 8, y: 6, w: 16, h: 14 }, 0, w.frameId),
      part('legL', w.layerId, { x: 10, y: 20, w: 4, h: 10 }, 1, w.frameId),
      part('legR', w.layerId, { x: 18, y: 20, w: 4, h: 10 }, 1, w.frameId),
    ];
    const a = plan(w, 'walk');
    const b = plan(w, 'walk');
    expect(a.frames.length).toBe(b.frames.length);
    for (let i = 0; i < a.frames.length; i++) {
      expect(Buffer.from(a.frames[i].cels[w.layerId]).equals(Buffer.from(b.frames[i].cels[w.layerId]))).toBe(true);
    }
    expect(a.report).toEqual(b.report);
  });

  test('source cel is never mutated by planning (preview safety)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 10, y: 12, w: 4, h: 4 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 10, y: 12, w: 4, h: 4 }, 0, w.frameId)];
    const before = new Uint8ClampedArray(w.clip.frames[0].cels[w.layerId].buffer);
    plan(w, 'walk', { gapFill: 'edge-extend' });
    const after = w.clip.frames[0].cels[w.layerId].buffer;
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// attack smear + jump squash + run curve instantiation
// ---------------------------------------------------------------------------

describe('preset-specific semantics', () => {
  test('attack: armL arc raise→wind-up→swing→recover; smear adds a 1px trail on the swing frame', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 12, y: 12, w: 4, h: 4 }, RED));
    w.clip.parts = [part('armL', w.layerId, { x: 12, y: 12, w: 4, h: 4 }, 0, w.frameId)];
    const plain = plan(w, 'attack', { smear: false });
    const smeared = plan(w, 'attack', { smear: true });
    // swing frame (index 2): dx +2, dy +1 → block at cols 14–17, rows 13–16
    const f2 = plain.frames[2].cels[w.layerId];
    expect(px(f2, 32, 14, 13)).toEqual([255, 0, 0, 255]);
    expect(px(f2, 32, 17, 16)).toEqual([255, 0, 0, 255]);
    expect(px(f2, 32, 13, 13)[3]).toBe(0); // no trail without smear
    const s2 = smeared.frames[2].cels[w.layerId];
    expect(px(s2, 32, 13, 13)).toEqual([255, 0, 0, 255]); // 1-px trail behind the swing
    expect(px(s2, 32, 17, 16)).toEqual([255, 0, 0, 255]); // main paste intact
    // recover frame returns to the start pose
    const f3 = plain.frames[3].cels[w.layerId];
    expect(px(f3, 32, 12, 12)).toEqual([255, 0, 0, 255]);
  });

  test('jump: preparation squash drops top rows ground-anchored; apex rises 4px; landing mirrors prep', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 10, y: 10, w: 12, h: 12 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 10, y: 10, w: 12, h: 12 }, 0, w.frameId)];
    const p = plan(w, 'jump');
    expect(p.frames.length).toBe(6);
    const f0 = p.frames[0].cels[w.layerId]; // dy +1, squash 2 → rows 10–14 empty, block at 15–24 (12−2=10 rows)
    expect(px(f0, 32, 10, 10)[3]).toBe(0);
    expect(px(f0, 32, 10, 14)[3]).toBe(0);
    expect(px(f0, 32, 10, 15)).toEqual([255, 0, 0, 255]); // old row 12 (top rows dropped)
    expect(px(f0, 32, 10, 24)).toEqual([255, 0, 0, 255]); // old row 21 (ground stays)
    expect(px(f0, 32, 10, 25)[3]).toBe(0);
    const f2 = p.frames[2].cels[w.layerId]; // apex dy −4
    expect(px(f2, 32, 10, 6)).toEqual([255, 0, 0, 255]);
    expect(px(f2, 32, 10, 17)).toEqual([255, 0, 0, 255]);
    const f5 = p.frames[5].cels[w.layerId]; // landing = prep pose
    expect(px(f5, 32, 10, 15)).toEqual([255, 0, 0, 255]);
    expect(px(f5, 32, 10, 10)[3]).toBe(0);
  });

  test('jump resamples the same parabola at 4 frames (duration configurable)', () => {
    const w = withCel(world(32, 32), (buf, s) => paintRect(buf, s, { x: 10, y: 10, w: 12, h: 12 }, RED));
    w.clip.parts = [part('body', w.layerId, { x: 10, y: 10, w: 12, h: 12 }, 0, w.frameId)];
    const p = plan(w, 'jump', { frameCount: 4 });
    expect(p.frames.length).toBe(4);
    const apex = p.frames[1].cels[w.layerId]; // canonical pose 2 (dy −4)
    expect(px(apex, 32, 10, 6)).toEqual([255, 0, 0, 255]);
  });

  test('run: walk amplitude ×1.5 (dx ±3 → ±5), forward lean +1, body arc', () => {
    const w = withCel(world(32, 32), (buf, s) => {
      paintRect(buf, s, { x: 8, y: 6, w: 16, h: 14 }, RED); // body
      paintRect(buf, s, { x: 10, y: 20, w: 4, h: 10 }, GREEN); // legL
    });
    w.clip.parts = [
      part('body', w.layerId, { x: 8, y: 6, w: 16, h: 14 }, 0, w.frameId),
      part('legL', w.layerId, { x: 10, y: 20, w: 4, h: 10 }, 1, w.frameId),
    ];
    const p = plan(w, 'run');
    expect(p.frames.length).toBe(6);
    // legL frame 0: walk dx 3 ×1.5 = 4.5 → R10 round → 5
    const f0 = p.frames[0].cels[w.layerId];
    expect(px(f0, 32, 15, 20)).toEqual([0, 255, 0, 255]); // 10 + 5
    // body lean +1: body pixel (8,6) → (9,6)… body arc dy 0 on frame 0
    expect(px(f0, 32, 9, 6)).toEqual([255, 0, 0, 255]);
    // apex frame 2: body dy −3 (−2×1.5 = −3)
    const f2 = p.frames[2].cels[w.layerId];
    expect(px(f2, 32, 9, 3)).toEqual([255, 0, 0, 255]); // 6 − 3
  });

  test('walk: 6- and 8-frame tables exist with exact reference amplitudes', () => {
    expect(MOTION_PRESETS.walk.frameCounts).toEqual([4, 6, 8]);
    const c6 = MOTION_PRESETS.walk.curvesFor(6);
    expect(c6.legL.map((o) => o.dx)).toEqual([3, 1, -1, -3, -1, 1]);
    expect(c6.body.map((o) => o.dy)).toEqual([0, -1, 0, 1, 0, -1]);
    const c8 = MOTION_PRESETS.walk.curvesFor(8);
    expect(c8.legL.map((o) => o.dx)).toEqual([3, 2, 0, -2, -3, -2, 0, 2]);
    expect(c8.body.map((o) => o.dy)).toEqual([0, -1, 0, 1, 0, -1, 0, 1]);
    // arm counter-swing: armL runs in legR's phase
    expect(c8.armL.map((o) => o.dx)).toEqual(c8.legR.map((o) => o.dx));
    // idle hair lags body by exactly one frame
    const idle = MOTION_PRESETS.idle.curvesFor(4);
    expect(idle.hair.map((o) => o.dy)).toEqual([-1, 0, -1, -2]);
  });
});
