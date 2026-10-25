/**
 * Motion command tests (Task 10): part.set + motion.apply through the REAL
 * CommandBus — validation, atomicity, undo/redo exactness (§13 "Undo/redo
 * round-trip: every command type"), R6 frame-count reconciliation, R7
 * timing, R8 linked-layer unlink, determinism through the commit path.
 */

import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  CommandError,
  createProject,
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

function pxAt(clip: Clip, layerId: string, x: number, y: number, frameIndex = 0): RGBA {
  const cel = clip.frames[frameIndex].cels[layerId];
  if (!cel) return [0, 0, 0, 0];
  const i = (y * 32 + x) * 4;
  return [cel.buffer[i], cel.buffer[i + 1], cel.buffer[i + 2], cel.buffer[i + 3]];
}

interface World {
  project: Project;
  bus: CommandBus;
  clip: Clip;
  layerId: string;
  frameId: string;
}

function world(): World {
  const project = createProject({ name: 'motion-cmd', width: 32, height: 32 });
  const bus = new CommandBus(project);
  const clip = bus.getProject().clips[0];
  return { project, bus, clip, layerId: clip.layers[0].id, frameId: clip.frames[0].id };
}

function paint(w: World, r: PartRect, c: RGBA = RED): void {
  const buf = new Uint8ClampedArray(32 * 32 * 4);
  paintRect(buf, 32, r, c);
  // go through the real pixel path so the document stays bus-owned
  w.bus.execute(
    'pixels.applyOp',
    { clipId: w.clip.id, frameId: w.frameId, layerId: w.layerId, ops: [{ op: 'setBuffer', buffer: buf }] },
    'ui'
  );
}

// ---------------------------------------------------------------------------
// part.set
// ---------------------------------------------------------------------------

describe('part.set', () => {
  test('sets the whole parts array as ONE undoable step (regions, not cuts)', () => {
    const w = world();
    paint(w, { x: 8, y: 8, w: 4, h: 4 });
    const before = pxAt(w.bus.getProject().clips[0], w.layerId, 8, 8);
    w.bus.execute('part.set', {
      clipId: w.clip.id,
      parts: [
        { name: 'body', layerId: w.layerId, rect: { x: 8, y: 6, w: 16, h: 14 } },
        { name: 'head', layerId: w.layerId, rect: { x: 12, y: 0, w: 8, h: 8 }, z: 1 },
      ],
    }, 'ui');
    const after = w.bus.getProject().clips[0];
    expect(after.parts.length).toBe(2);
    expect(after.parts[0].name).toBe('body');
    expect(after.parts[0].z).toBe(0); // default = array index
    expect(after.parts[1].z).toBe(1);
    expect(after.parts[0].anchorFrameId).toBe(w.frameId); // defaults to frame 1 (R5)
    expect(pxAt(after, w.layerId, 8, 8)).toEqual(before); // pixels untouched
    // undo restores the empty parts array exactly
    w.bus.undo();
    expect(w.bus.getProject().clips[0].parts.length).toBe(0);
    w.bus.redo();
    expect(w.bus.getProject().clips[0].parts.length).toBe(2);
  });

  test('validation: duplicate names, bad rect, bad layer, bad anchor are refused', () => {
    const w = world();
    expect(() =>
      w.bus.execute('part.set', {
        clipId: w.clip.id,
        parts: [
          { name: 'Body', layerId: w.layerId },
          { name: 'body', layerId: w.layerId },
        ],
      }, 'ui')
    ).toThrow(/duplicate part name/i);
    expect(() =>
      w.bus.execute('part.set', {
        clipId: w.clip.id,
        parts: [{ name: 'body', layerId: w.layerId, rect: { x: 30, y: 30, w: 5, h: 5 } }],
      }, 'ui')
    ).toThrow(/past the 32×32 canvas/i);
    expect(() =>
      w.bus.execute('part.set', {
        clipId: w.clip.id,
        parts: [{ name: 'body', layerId: 'ly-nope' }],
      }, 'ui')
    ).toThrow(/not found/i);
    expect(() =>
      w.bus.execute('part.set', {
        clipId: w.clip.id,
        parts: [{ name: 'body', layerId: w.layerId, anchorFrameId: 'fr-nope' }],
      }, 'ui')
    ).toThrow(/anchor frame/i);
    // failed validation leaves the document untouched
    expect(w.bus.getProject().clips[0].parts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// motion.apply — new-clip target
// ---------------------------------------------------------------------------

describe('motion.apply → new clip', () => {
  function ready(): World & { parts: unknown } {
    const w = world();
    paint(w, { x: 10, y: 12, w: 4, h: 4 });
    w.bus.execute('part.set', {
      clipId: w.clip.id,
      parts: [{ name: 'body', layerId: w.layerId, rect: { x: 10, y: 12, w: 4, h: 4 } }],
    }, 'ui');
    return w as World & { parts: unknown };
  }

  test('atomic insertion: new clip sized exactly to the preset (R6), durationMs 0 (R7), source untouched', () => {
    const w = ready();
    const sourceBefore = w.bus.getProject().clips[0];
    const anchorBytes = new Uint8ClampedArray(sourceBefore.frames[0].cels[w.layerId].buffer);
    w.bus.execute('motion.apply', {
      sourceClipId: w.clip.id,
      preset: 'idle',
      target: { kind: 'new', name: 'idle-bob' },
    }, 'mcp');
    const doc = w.bus.getProject();
    expect(doc.clips.length).toBe(2);
    const out = doc.clips[1];
    expect(out.name).toBe('idle-bob');
    expect(out.frames.length).toBe(4); // sized exactly (R6)
    for (const f of out.frames) expect(f.durationMs).toBe(0); // R7
    // composed content matches the composer's golden: px bobs [0,−1,−2,−1]
    const ys = out.frames.map((f) => {
      for (let y = 0; y < 32; y++) if (pxAt(out, out.layers[0].id, 10, y, 0) !== undefined && f.cels[out.layers[0].id] && f.cels[out.layers[0].id].buffer[(y * 32 + 10) * 4 + 3] === 255) return y;
      return -1;
    });
    expect(ys).toEqual([12, 11, 10, 11]);
    // parts carry over (re-parameterizable), remapped to the new layer ids
    expect(out.parts.length).toBe(1);
    expect(out.parts[0].name).toBe('body');
    expect(out.parts[0].layerId).toBe(out.layers[0].id);
    // source clip untouched (never silently overwritten)
    expect(doc.clips[0].frames.length).toBe(1);
    expect(Buffer.from(doc.clips[0].frames[0].cels[w.layerId].buffer).equals(Buffer.from(anchorBytes))).toBe(true);
    // one undoable step
    w.bus.undo();
    expect(w.bus.getProject().clips.length).toBe(1);
    w.bus.redo();
    expect(w.bus.getProject().clips.length).toBe(2);
    // history label mentions the preset
  });

  test('apply is deterministic through the bus: same payload → pixel-identical clips', () => {
    const run = (): Clip => {
      const w = ready();
      w.bus.execute('motion.apply', {
        sourceClipId: w.clip.id,
        preset: 'walk',
        target: { kind: 'new', name: 'walk-out' },
      }, 'ui');
      return w.bus.getProject().clips[1];
    };
    const a = run();
    const b = run();
    expect(a.frames.length).toBe(b.frames.length);
    for (let i = 0; i < a.frames.length; i++) {
      const ba = a.frames[i].cels[a.layers[0].id].buffer;
      const bb = b.frames[i].cels[b.layers[0].id].buffer;
      expect(Buffer.from(ba).equals(Buffer.from(bb))).toBe(true);
    }
  });

  test('overwrite:false on an existing clip is refused (existing frames are never silently replaced)', () => {
    const w = ready();
    expect(() =>
      w.bus.execute('motion.apply', {
        sourceClipId: w.clip.id,
        preset: 'idle',
        target: { kind: 'existing', clipId: w.clip.id, overwrite: false as unknown as true },
      }, 'ui')
    ).toThrow(/overwrite:true/i);
  });
});

// ---------------------------------------------------------------------------
// motion.apply — overwrite target (R6 reconciliation + R8 unlink)
// ---------------------------------------------------------------------------

describe('motion.apply → existing clip (overwrite:true)', () => {
  test('fewer frames → appended as holds of the reference; frames 0..n−1 rewritten once', () => {
    const w = world(); // 1 frame clip
    paint(w, { x: 10, y: 12, w: 4, h: 4 });
    w.bus.execute('part.set', {
      clipId: w.clip.id,
      parts: [{ name: 'body', layerId: w.layerId, rect: { x: 10, y: 12, w: 4, h: 4 } }],
    }, 'ui');
    w.bus.execute('motion.apply', {
      sourceClipId: w.clip.id,
      preset: 'idle',
      target: { kind: 'existing', clipId: w.clip.id, overwrite: true },
    }, 'ui');
    const clip = w.bus.getProject().clips[0];
    expect(clip.frames.length).toBe(4); // 1 existing + 3 appended holds
    const ys = clip.frames.map((f) => {
      for (let y = 0; y < 32; y++) if (f.cels[w.layerId] && f.cels[w.layerId].buffer[(y * 32 + 10) * 4 + 3] === 255) return y;
      return -1;
    });
    expect(ys).toEqual([12, 11, 10, 11]);
    for (const f of clip.frames) expect(f.durationMs).toBe(0);
    // single undoable entry restores the 1-frame document exactly
    w.bus.undo();
    const undone = w.bus.getProject().clips[0];
    expect(undone.frames.length).toBe(1);
    expect(pxAt(undone, w.layerId, 10, 12)).toEqual([255, 0, 0, 255]);
    w.bus.redo();
    expect(w.bus.getProject().clips[0].frames.length).toBe(4);
  });

  test('extra frames are left untouched (R6): 6-frame clip + 4-frame idle keeps frames 5–6', () => {
    const w = world();
    paint(w, { x: 10, y: 12, w: 4, h: 4 });
    // grow to 6 frames with a distinctive extra frame
    w.bus.execute('frame.add', { clipId: w.clip.id, copy: true }, 'ui');
    w.bus.execute('frame.add', { clipId: w.clip.id, copy: true }, 'ui');
    w.bus.execute('frame.add', { clipId: w.clip.id, copy: true }, 'ui');
    w.bus.execute('frame.add', { clipId: w.clip.id, copy: true }, 'ui');
    w.bus.execute('frame.add', { clipId: w.clip.id, copy: true }, 'ui');
    w.bus.execute('frame.setDuration', { clipId: w.clip.id, frameId: w.bus.getProject().clips[0].frames[5].id, durationMs: 250 }, 'ui');
    w.bus.execute('part.set', {
      clipId: w.clip.id,
      parts: [{ name: 'body', layerId: w.layerId, rect: { x: 10, y: 12, w: 4, h: 4 } }],
    }, 'ui');
    w.bus.execute('motion.apply', {
      sourceClipId: w.clip.id,
      preset: 'idle',
      target: { kind: 'existing', clipId: w.clip.id, overwrite: true },
    }, 'ui');
    const clip = w.bus.getProject().clips[0];
    expect(clip.frames.length).toBe(6); // extra frames untouched
    expect(clip.frames[5].durationMs).toBe(250); // preserved
    // frame 6 (index 5) content still holds the reference pose
    expect(pxAt(clip, w.layerId, 10, 12, 5)).toEqual([255, 0, 0, 255]);
    // frames 1..4 were rewritten by the composer (bob poses)
    expect(pxAt(clip, w.layerId, 10, 11, 1)).toEqual([255, 0, 0, 255]);
  });

  test('R8: a part targeting a linked layer unlinks it in the target clip (same undo entry)', () => {
    const w = world();
    paint(w, { x: 10, y: 12, w: 4, h: 4 });
    w.bus.execute('layer.setLinked', { clipId: w.clip.id, layerId: w.layerId, linked: true }, 'ui');
    w.bus.execute('part.set', {
      clipId: w.clip.id,
      parts: [{ name: 'body', layerId: w.layerId, rect: { x: 10, y: 12, w: 4, h: 4 } }],
    }, 'ui');
    w.bus.execute('motion.apply', {
      sourceClipId: w.clip.id,
      preset: 'idle',
      target: { kind: 'existing', clipId: w.clip.id, overwrite: true },
    }, 'ui');
    const clip = w.bus.getProject().clips[0];
    expect(clip.layers[0].linked).toBe(false); // unlinked (R8)
    // per-frame content composed (the bob moved the px on frame 1)
    expect(pxAt(clip, w.layerId, 10, 11, 1)).toEqual([255, 0, 0, 255]);
    // undo restores the LINKED state exactly (same undo entry)
    w.bus.undo();
    const undone = w.bus.getProject().clips[0];
    expect(undone.layers[0].linked).toBe(true);
    expect(undone.frames.length).toBe(1);
  });

  test('R8 new-clip target: linked background with NO part stays linked and pinned', () => {
    const w = world();
    paint(w, { x: 0, y: 0, w: 32, h: 4 }); // "background" band
    w.bus.execute('layer.setLinked', { clipId: w.clip.id, layerId: w.layerId, linked: true }, 'ui');
    w.bus.execute('motion.apply', {
      sourceClipId: w.clip.id,
      preset: 'idle', // no parts tagged — nothing moves
      target: { kind: 'new', name: 'bg-hold' },
    }, 'ui');
    const out = w.bus.getProject().clips[1];
    expect(out.layers[0].linked).toBe(true); // untouched pinned background
    // every frame shares the SAME cel object (linked semantics, C2)
    const cels = out.frames.map((f) => f.cels[out.layers[0].id]);
    for (const cel of cels) expect(cel).toBe(cels[0]);
  });

  test('no moving parts: overwrite produces honest holds and does not crash (C27 report path)', () => {
    const w = world();
    paint(w, { x: 10, y: 12, w: 4, h: 4 });
    w.bus.execute('motion.apply', {
      sourceClipId: w.clip.id,
      preset: 'idle', // no parts at all
      target: { kind: 'existing', clipId: w.clip.id, overwrite: true },
    }, 'ui');
    const clip = w.bus.getProject().clips[0];
    expect(clip.frames.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(pxAt(clip, w.layerId, 10, 12, i)).toEqual([255, 0, 0, 255]); // holds of the reference
    }
  });

  test('validation: unknown preset / bad amplitude / bad frameCount refused, document untouched', () => {
    const w = world();
    expect(() =>
      w.bus.execute('motion.apply', {
        sourceClipId: w.clip.id,
        preset: 'fly' as 'idle',
        target: { kind: 'new', name: 'x' },
      }, 'ui')
    ).toThrow(/preset must be one of/i);
    expect(() =>
      w.bus.execute('motion.apply', {
        sourceClipId: w.clip.id,
        preset: 'idle',
        params: { amplitude: 9 },
        target: { kind: 'new', name: 'x' },
      }, 'ui')
    ).toThrow(/amplitude must be/i);
    expect(() =>
      w.bus.execute('motion.apply', {
        sourceClipId: w.clip.id,
        preset: 'walk',
        params: { frameCount: 5 },
        target: { kind: 'new', name: 'x' },
      }, 'ui')
    ).toThrow(/supports frame counts 4\/6\/8/i);
    expect(() =>
      w.bus.execute('motion.apply', {
        sourceClipId: 'cl-nope',
        preset: 'idle',
        target: { kind: 'new', name: 'x' },
      }, 'ui')
    ).toThrow(CommandError);
  });
});
