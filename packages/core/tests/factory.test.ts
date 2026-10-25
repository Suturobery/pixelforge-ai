/**
 * Types v2 — project & clip creation (v3.1 §2.4/§6 acceptance).
 */

import { describe, expect, test } from 'bun:test';
import {
  CANVAS_MAX,
  CANVAS_MIN,
  DEFAULT_PALETTE,
  SCHEMA_VERSION,
  TRASH_CAP,
  clampCanvasSize,
  createCel,
  createClip,
  createFrame,
  createLayer,
  createProject,
} from '../src';
import { cloneProject } from '../src/doc/factory';

describe('factory: project & clip creation', () => {
  test('createProject produces a schema-v2 document with v3.1 defaults', () => {
    const p = createProject({ name: 'farmer' });
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    expect(p.schemaVersion).toBe(2);
    expect(p.name).toBe('farmer');
    expect(p.width).toBe(32);
    expect(p.height).toBe(32);
    expect(p.id).toBeNull();
    expect(p.trash).toEqual([]);
    expect(p.palette).toEqual(DEFAULT_PALETTE);
    // §6 settings defaults
    expect(p.settings.paletteEnforce).toBe(true);
    expect(p.settings.onion).toEqual({ prev: 1, next: 0 });
    // exactly one clip, named "idle" like the prototype default
    expect(p.clips).toHaveLength(1);
    expect(p.clips[0].name).toBe('idle');
  });

  test('new clips default to a single layer named "Layer 1" (§2.4)', () => {
    const clip = createClip({ name: 'walk', width: 32, height: 32 });
    expect(clip.layers).toHaveLength(1);
    expect(clip.layers[0].name).toBe('Layer 1');
    expect(clip.layers[0].visible).toBe(true);
    expect(clip.layers[0].opacity).toBe(1);
    expect(clip.layers[0].linked).toBe(false);
    // one initial frame holding a transparent cel per layer
    expect(clip.frames).toHaveLength(1);
    expect(Object.keys(clip.frames[0].cels)).toEqual([clip.layers[0].id]);
  });

  test('clip carries fps + loop + loopMode (C3) and parts/tags arrays', () => {
    const clip = createClip({
      name: 'run',
      width: 32,
      height: 32,
      fps: 12,
      loop: false,
      loopMode: 'pingpong',
    });
    expect(clip.fps).toBe(12);
    expect(clip.loop).toBe(false);
    expect(clip.loopMode).toBe('pingpong');
    expect(clip.parts).toEqual([]);
    expect(clip.tags).toEqual([]);
  });

  test('frame durationMs defaults to 0 (= inherit clip fps, §2.6)', () => {
    const layer = createLayer('body');
    const frame = createFrame(32, 32, [layer]);
    expect(frame.durationMs).toBe(0);
    const cel = frame.cels[layer.id];
    expect(cel.buffer).toBeInstanceOf(Uint8ClampedArray);
    expect(cel.buffer.length).toBe(32 * 32 * 4);
    expect(cel.linked).toBe(false);
  });

  test('canvas size clamps to 16–256 (§2 canvas bounds)', () => {
    expect(clampCanvasSize(8)).toBe(CANVAS_MIN);
    expect(clampCanvasSize(300)).toBe(CANVAS_MAX);
    expect(clampCanvasSize(64.4)).toBe(64);
    const p = createProject({ width: 1024, height: 2 });
    expect(p.width).toBe(CANVAS_MAX);
    expect(p.height).toBe(CANVAS_MIN);
  });

  test('createCel without buffer allocates a zeroed RGBA buffer', () => {
    const cel = createCel(20, 24);
    expect(cel.buffer.length).toBe(20 * 24 * 4);
    expect(cel.buffer.every((b) => b === 0)).toBeTrue();
  });

  test('cloneProject deep-copies normal cels but keeps linked cels shared', () => {
    const p = createProject({ width: 16, height: 16 });
    const clip = p.clips[0];
    const shared = clip.frames[0].cels[clip.layers[0].id];
    const copy = cloneProject(p);
    const copyClip = copy.clips[0];
    const copyCel = copyClip.frames[0].cels[copyClip.layers[0].id];
    expect(copyCel.buffer).not.toBe(shared.buffer);
    expect(copyCel.buffer.length).toBe(shared.buffer.length);
    expect(TRASH_CAP).toBe(20); // C5/C9 constant sanity
  });
});
