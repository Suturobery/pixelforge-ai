/**
 * Motion QA + suggest tests (Task 10, v3.1 §4.4): flicker detector, loop
 * transitions, consistency/artifact checks, part sanity — and the L0
 * suggest_motion_preset helper (deterministic keyword mapping).
 */

import { describe, expect, test } from 'bun:test';
import {
  analyzeClipMotion,
  analyzeMotionPlan,
  createProject,
  diffChangedPixels,
  planMotion,
  suggestMotionPreset,
  type Clip,
  type PartRect,
  type Project,
  type RGBA,
} from '../src';

const RED: RGBA = [255, 0, 0, 255];

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

function px(buf: Uint8ClampedArray, w: number, x: number, y: number): number {
  return buf[(y * w + x) * 4 + 3];
}

function withSprite(width = 32, height = 32) {
  const project = createProject({ name: 'qa', width, height });
  const clip = project.clips[0];
  const layerId = clip.layers[0].id;
  const frameId = clip.frames[0].id;
  const buf = new Uint8ClampedArray(width * height * 4);
  paintRect(buf, width, { x: 10, y: 12, w: 4, h: 4 }, RED);
  clip.frames[0].cels[layerId] = { buffer: buf, linked: false };
  clip.parts = [{ id: 'pt1', name: 'body', layerId, rect: { x: 10, y: 12, w: 4, h: 4 }, anchorFrameId: frameId, z: 0 }];
  return { project, clip, layerId, frameId };
}

// ---------------------------------------------------------------------------
// diffChangedPixels
// ---------------------------------------------------------------------------

describe('diffChangedPixels', () => {
  test('counts pixels with any differing byte; identical buffers count zero', () => {
    const a = new Uint8ClampedArray(4 * 4 * 4);
    const b = new Uint8ClampedArray(a);
    expect(diffChangedPixels(a, b)).toBe(0);
    b[0] = 9; // same pixel
    expect(diffChangedPixels(a, b)).toBe(1);
    b[(1 * 4 + 2) * 4 + 3] = 255; // alpha change counts
    expect(diffChangedPixels(a, b)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// analyzeMotionPlan — plan-level QA
// ---------------------------------------------------------------------------

describe('analyzeMotionPlan', () => {
  test('reports overlapping same-layer regions with the z-winner named', () => {
    const { project, clip, layerId, frameId } = withSprite();
    clip.parts = [
      { id: 'p1', name: 'body', layerId, rect: { x: 8, y: 6, w: 16, h: 14 }, anchorFrameId: frameId, z: 0 },
      { id: 'p2', name: 'head', layerId, rect: { x: 12, y: 2, w: 8, h: 8 }, anchorFrameId: frameId, z: 1 },
    ];
    const p = planMotion(project, clip, { preset: 'idle' });
    const issues = analyzeMotionPlan(project, clip, p);
    const overlap = issues.find((i) => i.code === 'overlap');
    expect(overlap).toBeDefined();
    expect(overlap?.level).toBe('warning');
    expect(overlap?.message).toContain('"head"');
    expect(overlap?.message).toContain('owns the shared pixels');
  });

  test('reports detached parts (empty regions) and invalid anchors/rects', () => {
    const { project, clip, layerId } = withSprite();
    clip.parts = [
      clip.parts[0],
      { id: 'p2', name: 'head', layerId, rect: { x: 0, y: 0, w: 4, h: 4 }, anchorFrameId: 'fr-gone', z: 1 }, // empty region + bad anchor
      { id: 'p3', name: 'armL', layerId, rect: { x: 30, y: 30, w: 8, h: 8 }, anchorFrameId: clip.frames[0].id, z: 2 }, // out of bounds
    ];
    const p = planMotion(project, clip, { preset: 'idle' });
    const issues = analyzeMotionPlan(project, clip, p);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('detached_part');
    expect(codes).toContain('invalid_anchor');
    expect(codes).toContain('invalid_rect');
    const detached = issues.find((i) => i.code === 'detached_part');
    expect(detached?.message).toContain('"head"');
  });

  test('clean idle plan on a normal sprite: no warnings beyond the absent-role skips', () => {
    const { project, clip } = withSprite();
    const p = planMotion(project, clip, { preset: 'idle' });
    const issues = analyzeMotionPlan(project, clip, p);
    expect(issues.filter((i) => i.level === 'warning')).toEqual([]);
  });

  test('edge clipping is surfaced as information (R4 behavior, not an error)', () => {
    const project = createProject({ name: 'qa-edge', width: 32, height: 32 });
    const clip = project.clips[0];
    const layerId = clip.layers[0].id;
    const frameId = clip.frames[0].id;
    const buf = new Uint8ClampedArray(32 * 32 * 4);
    paintRect(buf, 32, { x: 29, y: 10, w: 3, h: 4 }, RED);
    clip.frames[0].cels[layerId] = { buffer: buf, linked: false };
    clip.parts = [{ id: 'p1', name: 'legL', layerId, rect: { x: 29, y: 10, w: 3, h: 4 }, anchorFrameId: frameId, z: 0 }];
    const p = planMotion(project, clip, { preset: 'walk' });
    const issues = analyzeMotionPlan(project, clip, p);
    const oob = issues.find((i) => i.code === 'out_of_bounds');
    expect(oob?.level).toBe('info');
    expect(oob?.message).toContain('12');
  });

  test('transparency artifacts (static semi-alpha) are reported, not silently cleaned', () => {
    const { project, clip, layerId, frameId } = withSprite();
    const buf = clip.frames[0].cels[layerId].buffer;
    buf[(28 * 32 + 28) * 4 + 3] = 140; // semi-alpha outside the part rect
    const p = planMotion(project, clip, { preset: 'idle' });
    const issues = analyzeMotionPlan(project, clip, p);
    const art = issues.find((i) => i.code === 'transparency_artifact');
    expect(art?.level).toBe('warning');
    expect(art?.message).toContain('semi-transparent');
  });

  test('loop jump: a big last→first seam diff is reported for looping presets', () => {
    const { project, clip, layerId } = withSprite();
    // hand-built frames: quiet ×3, LOUD pop (explicit thresholds keep the
    // 4-frame fixture deterministic — the option exists for fixed budgets)
    const mk = (loud: boolean) => {
      const b = new Uint8ClampedArray(32 * 32 * 4);
      paintRect(b, 32, { x: 2, y: 2, w: loud ? 12 : 2, h: loud ? 12 : 2 }, RED);
      return { id: `fr-${loud}`, durationMs: 0, cels: { [layerId]: { buffer: b, linked: false } } };
    };
    clip.frames = [mk(false), mk(false), mk(true), mk(true)];
    clip.parts = [];
    const issues = analyzeClipMotion(project, clip, { flickerThreshold: 40, loopJumpFactor: 1 });
    const flicker = issues.find((i) => i.code === 'flicker');
    expect(flicker).toBeDefined();
    expect(flicker?.frameIndexes).toContain(2);
    const loop = issues.find((i) => i.code === 'loop_jump');
    // seam = diff(LOUD → quiet) = 140 ≫ mean(46.7) × 1 → visible pop
    expect(loop).toBeDefined();
  });

  test('auto threshold: a flicker spike among steady frames fires without explicit options', () => {
    const { project, clip, layerId } = withSprite();
    const mk = (loud: boolean) => {
      const b = new Uint8ClampedArray(32 * 32 * 4);
      paintRect(b, 32, { x: 2, y: 2, w: loud ? 12 : 2, h: loud ? 12 : 2 }, RED);
      return { id: `fr-${loud}`, durationMs: 0, cels: { [layerId]: { buffer: b, linked: false } } };
    };
    // 7 steady frames + one spike + steady tail: mean ≈ 39 → threshold ≈ 86
    clip.frames = [mk(false), mk(false), mk(false), mk(false), mk(false), mk(false), mk(false), mk(true), mk(false)];
    clip.parts = [];
    const issues = analyzeClipMotion(project, clip);
    const flicker = issues.find((i) => i.code === 'flicker');
    expect(flicker).toBeDefined();
    expect(flicker?.frameIndexes).toContain(7); // the spike frame (0-based)
    // and no false loop-jump on a clean seam
    expect(issues.some((i) => i.code === 'loop_jump')).toBe(false);
  });

  test('attack/jump are play-once aware: loop-seam skipped with an info note', () => {
    const { project, clip } = withSprite();
    const p = planMotion(project, clip, { preset: 'attack' });
    const issues = analyzeMotionPlan(project, clip, p);
    const note = issues.find((i) => i.code === 'play_once');
    expect(note?.level).toBe('info');
    expect(issues.some((i) => i.code === 'loop_jump')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeClipMotion — committed clip QA (§4.4 flicker detector)
// ---------------------------------------------------------------------------

describe('analyzeClipMotion', () => {
  test('flags frame-consistency problems (wrong buffer size)', () => {
    const { project, clip, layerId } = withSprite();
    clip.frames.push({
      id: 'fr-bad',
      durationMs: 0,
      cels: { [layerId]: { buffer: new Uint8ClampedArray(8), linked: false } },
    });
    const issues = analyzeClipMotion(project, clip);
    expect(issues.some((i) => i.code === 'frame_consistency')).toBe(true);
  });

  test('steady 2-frame animation stays quiet', () => {
    const { project, clip, layerId } = withSprite();
    clip.frames.push({ id: 'fr-2', durationMs: 0, cels: { [layerId]: clip.frames[0].cels[layerId] } });
    const issues = analyzeClipMotion(project, clip);
    expect(issues.filter((i) => i.level === 'warning')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suggest_motion_preset (L0 helper)
// ---------------------------------------------------------------------------

describe('suggestMotionPreset', () => {
  test('maps action verbs to presets deterministically ($0, no model)', () => {
    expect(suggestMotionPreset('make the hero attack with a sword')?.preset).toBe('attack');
    expect(suggestMotionPreset('a quick slash')?.preset).toBe('attack');
    expect(suggestMotionPreset('jumping over a gap')?.preset).toBe('jump');
    expect(suggestMotionPreset('running animation')?.preset).toBe('run');
    expect(suggestMotionPreset('walk cycle please')?.preset).toBe('walk');
    expect(suggestMotionPreset('idle breathing loop')?.preset).toBe('idle');
  });

  test('specific action verbs win over generic locomotion (documented priority)', () => {
    expect(suggestMotionPreset('run up and attack')?.preset).toBe('attack');
    expect(suggestMotionPreset('walk then jump')?.preset).toBe('jump');
  });

  test('no match → null; empty → null; same input → same output', () => {
    expect(suggestMotionPreset('a cozy tavern')).toBeNull();
    expect(suggestMotionPreset('   ')).toBeNull();
    const a = suggestMotionPreset('sprint dash');
    const b = suggestMotionPreset('sprint dash');
    expect(a).toEqual(b);
    expect(a?.preset).toBe('run');
    expect(a?.params.frameCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// determinism guard for the whole Task 10 QA surface
// ---------------------------------------------------------------------------

describe('QA determinism', () => {
  test('two analyzeMotionPlan runs agree exactly', () => {
    const { project, clip, layerId } = withSprite();
    clip.parts.push({ id: 'p2', name: 'head', layerId, rect: { x: 9, y: 9, w: 6, h: 6 }, anchorFrameId: clip.frames[0].id, z: 1 });
    const p = planMotion(project, clip, { preset: 'walk' });
    expect(analyzeMotionPlan(project, clip, p)).toEqual(analyzeMotionPlan(project, clip, p));
  });
});
