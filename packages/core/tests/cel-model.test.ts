/**
 * Types v2 — cel model semantics (v3.1 §2.4):
 *  - per-clip layer isolation (C1)
 *  - cel editing + missing-cel transparency (C2)
 *  - linked-cel reference behavior (C2, C19 engine support)
 *  - duplicate frame preserves cels exactly (§2.7)
 */

import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  createProject,
  duplicateFrame,
  locateCel,
} from '../src';
import { pixelAt } from './helpers';

describe('cel model: per-clip layer isolation (C1)', () => {
  test('adding a layer to clip A leaves clip B untouched', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clipA = bus.getProject().clips[0];
    bus.execute(
      'clip.add',
      { name: 'second' },
      'ui'
    );
    const after = bus.getProject();
    const clipB = after.clips.find((c) => c.id !== clipA.id) as typeof clipA;

    expect(after.clips).toHaveLength(2);
    expect(clipA.layers).toHaveLength(1);

    bus.execute('layer.add', { clipId: clipA.id, name: 'extra' }, 'ui');
    const final = bus.getProject();
    const a = final.clips.find((c) => c.id === clipA.id) as typeof clipA;
    const b = final.clips.find((c) => c.id === clipB.id) as typeof clipB;
    expect(a.layers).toHaveLength(2);
    expect(a.layers.map((l) => l.name)).toEqual(['Layer 1', 'extra']);
    // ISOLATION: clip B still has exactly its own single layer
    expect(b.layers).toHaveLength(1);
    expect(b.layers[0].id).not.toBe(a.layers[0].id);
    expect(b.layers[0].id).not.toBe(a.layers[1].id);
    // and clip B's frames have no cel keys for clip A's new layer
    expect(Object.keys(b.frames[0].cels)).toHaveLength(1);
  });

  test('layer ops on one clip never touch frames of another clip', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clipA = bus.getProject().clips[0];
    bus.execute('clip.add', { name: 'b' }, 'ui');
    const clipB = bus.getProject().clips.find((c) => c.id !== clipA.id) as typeof clipA;
    bus.execute('layer.add', { clipId: clipA.id }, 'ui');
    bus.execute('frame.add', { clipId: clipA.id, copy: true }, 'ui');
    const final = bus.getProject();
    const a = final.clips.find((c) => c.id === clipA.id) as typeof clipA;
    const b = final.clips.find((c) => c.id === clipB.id) as typeof clipB;
    expect(a.frames).toHaveLength(2);
    expect(b.frames).toHaveLength(1);
    for (const f of a.frames) expect(Object.keys(f.cels)).toHaveLength(2);
    expect(Object.keys(b.frames[0].cels)).toHaveLength(1);
  });
});

describe('cel model: editing & missing-cel transparency (C2)', () => {
  test('absent cel resolves as transparent; pixels.applyOp creates the cel', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const layer = clip.layers[0];
    const frame = clip.frames[0];

    // Simulate a missing cel by removing it via an intermediate project —
    // the model contract: locateCel returns cel === undefined.
    const noCelProject = {
      ...project,
      clips: project.clips.map((c) =>
        c.id === clip.id
          ? {
              ...c,
              frames: c.frames.map((f) =>
                f.id === frame.id ? { ...f, cels: {} } : f
              ),
            }
          : c
      ),
    };
    const loc = locateCel(noCelProject, clip.id, frame.id, layer.id);
    expect(loc).not.toBeNull();
    expect(loc?.cel).toBeUndefined(); // missing cel = fully transparent

    // Painting on the missing cel creates it (engine path via a fresh bus).
    const bus2 = new CommandBus(noCelProject);
    bus2.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: frame.id,
        layerId: layer.id,
        color: [255, 0, 0, 255],
        ops: [{ op: 'stamp', x: 3, y: 4 }],
      },
      'ui'
    );
    const painted = bus2.getProject();
    const paintedFrame = painted.clips[0].frames[0];
    expect(paintedFrame.cels[layer.id]).toBeDefined();
    expect(pixelAt(paintedFrame, layer.id, 16, 3, 4)).toEqual([255, 0, 0, 255]);
    // everything else stays transparent
    expect(pixelAt(paintedFrame, layer.id, 16, 5, 5)).toEqual([0, 0, 0, 0]);
  });

  test('cel edit only affects the targeted (clip, frame, layer) triple', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const layer = clip.layers[0];
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    bus.execute('layer.add', { clipId: clip.id, name: 'top' }, 'ui');
    const doc = bus.getProject();
    const c = doc.clips[0];
    const frame1 = c.frames[0];
    const frame2 = c.frames[1];
    const bottom = c.layers[0];
    const top = c.layers[1];

    bus.execute(
      'pixels.applyOp',
      {
        clipId: c.id,
        frameId: frame2.id,
        layerId: top.id,
        color: [0, 255, 0, 255],
        ops: [{ op: 'stamp', x: 1, y: 1 }],
      },
      'ui'
    );

    const after = bus.getProject().clips[0];
    expect(pixelAt(after.frames[1], top.id, 16, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(after.frames[0], top.id, 16, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(after.frames[1], bottom.id, 16, 1, 1)).toEqual([0, 0, 0, 0]);
    void frame1;
    void layer;
  });
});

describe('cel model: linked cels (C2, C19 engine support)', () => {
  test('layer.setLinked ON shares one buffer object across all frames', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const layer = clip.layers[0];
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: bus.getProject().clips[0].frames[0].id,
        layerId: layer.id,
        color: [10, 20, 30, 255],
        ops: [{ op: 'stamp', x: 0, y: 0 }],
      },
      'ui'
    );

    bus.execute('layer.setLinked', { clipId: clip.id, layerId: layer.id, linked: true }, 'ui');
    const linked = bus.getProject().clips[0];
    expect(linked.layers[0].linked).toBeTrue();
    const bufs = linked.frames.map((f) => f.cels[layer.id].buffer);
    expect(bufs).toHaveLength(3);
    expect(bufs[0]).toBe(bufs[1]);
    expect(bufs[1]).toBe(bufs[2]); // same object — shared cel
    for (const f of linked.frames) {
      expect(f.cels[layer.id].linked).toBeTrue();
    }
  });

  test('editing a linked cel on frame 3 is visible on frame 1 (edit once applies everywhere)', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const layer = clip.layers[0];
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    bus.execute('layer.setLinked', { clipId: clip.id, layerId: layer.id, linked: true }, 'ui');
    const frame3 = bus.getProject().clips[0].frames[1];

    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: frame3.id,
        layerId: layer.id,
        color: [255, 255, 0, 255],
        ops: [{ op: 'stamp', x: 5, y: 5 }],
      },
      'ui'
    );
    const after = bus.getProject().clips[0];
    // every frame sees the edit through the shared buffer
    for (const f of after.frames) {
      expect(pixelAt(f, layer.id, 16, 5, 5)).toEqual([255, 255, 0, 255]);
    }
  });

  test('undo of a linked-cel edit propagates to every frame', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const layer = clip.layers[0];
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    bus.execute('layer.setLinked', { clipId: clip.id, layerId: layer.id, linked: true }, 'ui');
    const frame2 = bus.getProject().clips[0].frames[1];
    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: frame2.id,
        layerId: layer.id,
        color: [255, 255, 0, 255],
        ops: [{ op: 'stamp', x: 5, y: 5 }],
      },
      'ui'
    );
    expect(bus.undo().ok).toBeTrue();
    const undone = bus.getProject().clips[0];
    for (const f of undone.frames) {
      expect(pixelAt(f, layer.id, 16, 5, 5)).toEqual([0, 0, 0, 0]);
    }
    expect(bus.redo().ok).toBeTrue();
    const redone = bus.getProject().clips[0];
    for (const f of redone.frames) {
      expect(pixelAt(f, layer.id, 16, 5, 5)).toEqual([255, 255, 0, 255]);
    }
  });

  test('layer.setLinked OFF breaks sharing into independent copies', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const layer = clip.layers[0];
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    bus.execute('layer.setLinked', { clipId: clip.id, layerId: layer.id, linked: true }, 'ui');
    bus.execute('layer.setLinked', { clipId: clip.id, layerId: layer.id, linked: false }, 'ui');
    const unlinked = bus.getProject().clips[0];
    expect(unlinked.layers[0].linked).toBeFalse();
    const bufs = unlinked.frames.map((f) => f.cels[layer.id].buffer);
    expect(bufs[0]).not.toBe(bufs[1]); // independent objects
    // content still equal right after unlink
    expect(pixelAt(unlinked.frames[0], layer.id, 16, 0, 0)).toEqual(
      pixelAt(unlinked.frames[1], layer.id, 16, 0, 0)
    );
  });
});

describe('cel model: duplicate frame preserves cels exactly (§2.7)', () => {
  test('normal layers → equal content, independent buffers; linked layers → same object', () => {
    const project = createProject({ width: 16, height: 16 });
    const bus = new CommandBus(project);
    const clip = bus.getProject().clips[0];
    const normal = clip.layers[0];
    bus.execute('layer.add', { clipId: clip.id, name: 'bg' }, 'ui');
    const bg = bus.getProject().clips[0].layers[1];
    bus.execute('layer.setLinked', { clipId: clip.id, layerId: bg.id, linked: true }, 'ui');
    const c = bus.getProject().clips[0];
    bus.execute(
      'pixels.applyOp',
      {
        clipId: c.id,
        frameId: c.frames[0].id,
        layerId: normal.id,
        color: [1, 2, 3, 255],
        ops: [{ op: 'stamp', x: 2, y: 2 }],
      },
      'ui'
    );
    const srcFrame = bus.getProject().clips[0].frames[0];
    const dup = duplicateFrame(srcFrame, bus.getProject().clips[0].layers);

    // normal cel: deep copy (equal content, different object)
    expect(dup.cels[normal.id].buffer).not.toBe(srcFrame.cels[normal.id].buffer);
    expect(pixelAt(dup, normal.id, 16, 2, 2)).toEqual([1, 2, 3, 255]);
    // linked cel: the SAME shared object (that is what linked means)
    expect(dup.cels[bg.id]).toBe(srcFrame.cels[bg.id]);
    expect(dup.id).not.toBe(srcFrame.id);
    expect(dup.durationMs).toBe(srcFrame.durationMs);
  });
});
