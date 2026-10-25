/**
 * Task 5a — CommandBus integration for the new pixel tools: ellipse and
 * region transform ops through `pixels.applyOp`. Contract (mandate §5):
 * every committed edit produces a history entry, undo/redo restores EXACT
 * pixel data, linked cels stay consistent, invalid payloads mutate nothing,
 * deterministic ops survive journal replay.
 */

import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  JournalRecorder,
  createProject,
  createFrame,
  replayJournal,
  type Project,
} from '../src/index';
import { getPixel } from '../src/pixels/ops';
import { projectEquals } from './helpers';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

function makeProject(): { project: Project; clipId: string; frameId: string; layerId: string } {
  const project = createProject({ name: 'tools', width: 24, height: 24 });
  const clipId = project.clips[0].id;
  const frameId = project.clips[0].frames[0].id;
  const layerId = project.clips[0].layers[0].id;
  return { project, clipId, frameId, layerId };
}

function celBuffer(bus: CommandBus, clipId: string, frameId: string, layerId: string): Uint8ClampedArray {
  const frame = bus.getProject().clips.find((c) => c.id === clipId)!.frames.find((f) => f.id === frameId)!;
  return frame.cels[layerId]?.buffer ?? new Uint8ClampedArray(24 * 24 * 4);
}

function countColor(buf: Uint8ClampedArray, match: (p: [number, number, number, number]) => boolean): number {
  let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (match([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]])) n++;
  }
  return n;
}

const isRed = (p: [number, number, number, number]) => p[0] === 255 && p[3] === 255;

describe('pixels.applyOp: ellipse op', () => {
  test('outline + filled produce tile diffs and undoable entries', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, color: RED, ops: [{ op: 'ellipse', from: { x: 2, y: 2 }, to: { x: 12, y: 8 } }] },
      'ui'
    );
    expect(bus.historyStats().undoDepth).toBe(1);
    const outlineRed = countColor(celBuffer(bus, clipId, frameId, layerId), isRed);
    expect(outlineRed).toBeGreaterThan(0);

    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, color: BLUE, ops: [{ op: 'ellipse', from: { x: 2, y: 2 }, to: { x: 12, y: 8 }, filled: true }] },
      'ui'
    );
    const filled = celBuffer(bus, clipId, frameId, layerId);
    expect(countColor(filled, isRed)).toBe(0); // filled overwrote with blue
    expect(countColor(filled, (p) => p[2] === 255)).toBeGreaterThanOrEqual(outlineRed);

    // undo lands back on the exact outline state
    const afterFill = new Uint8ClampedArray(filled);
    bus.undo();
    expect(Array.from(celBuffer(bus, clipId, frameId, layerId))).not.toEqual(Array.from(afterFill));
    expect(countColor(celBuffer(bus, clipId, frameId, layerId), isRed)).toBe(outlineRed);
    bus.undo();
    expect(countColor(celBuffer(bus, clipId, frameId, layerId), isRed)).toBe(0);
    bus.redo();
    bus.redo();
    expect(Array.from(celBuffer(bus, clipId, frameId, layerId))).toEqual(Array.from(afterFill));
  });

  test('label describes the operation', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    let label = '';
    bus.onChange((e) => {
      if (e.reason === 'executed') label = e.label ?? '';
    });
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, color: RED, ops: [{ op: 'ellipse', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, filled: true }] },
      'ui'
    );
    expect(label).toBe('Filled ellipse');
  });

  test('ellipse without color is rejected and the document is untouched', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    const before = bus.getProject();
    expect(() =>
      bus.execute(
        'pixels.applyOp',
        { clipId, frameId, layerId, ops: [{ op: 'ellipse', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }] },
        'ui'
      )
    ).toThrow();
    expect(projectEquals(bus.getProject(), before)).toBe(true);
  });
});

describe('pixels.applyOp: transform ops', () => {
  test('whole-cel flipH mirrors the buffer', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, color: RED, ops: [{ op: 'stamp', x: 2, y: 4 }] }, 'ui');
    const before = celBuffer(bus, clipId, frameId, layerId);
    const mirrored = new Uint8ClampedArray(before);
    // expected: stamp re-plotted at (W-1-2, 4)
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, ops: [{ op: 'flipH' }] }, 'ui');
    const after = celBuffer(bus, clipId, frameId, layerId);
    expect(getPixel(after, 24, 21, 4)).toEqual(RED);
    expect(getPixel(after, 24, 2, 4)).toEqual([0, 0, 0, 0]);
    void mirrored;
  });

  test('selection-scoped flipH only touches the rect', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    // red at (3,3) inside the rect, blue at (20,20) outside
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, color: RED, ops: [{ op: 'stamp', x: 3, y: 3 }] }, 'ui');
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, color: BLUE, ops: [{ op: 'stamp', x: 20, y: 20 }] }, 'ui');
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, ops: [{ op: 'flipH', rect: { x: 0, y: 0, w: 8, h: 8 } }] },
      'ui'
    );
    expect(getPixel(celBuffer(bus, clipId, frameId, layerId), 24, 4, 3)).toEqual(RED); // 3 → 8-1-3 = 4
    expect(getPixel(celBuffer(bus, clipId, frameId, layerId), 24, 20, 20)).toEqual(BLUE); // untouched
  });

  test('rotateCW 4× round-trips exactly; label carries the scope', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, color: RED, ops: [{ op: 'rect', from: { x: 4, y: 4 }, to: { x: 9, y: 7 }, filled: true }] },
      'ui'
    );
    const original = new Uint8ClampedArray(celBuffer(bus, clipId, frameId, layerId));
    let label = '';
    bus.onChange((e) => {
      if (e.reason === 'executed') label = e.label ?? '';
    });
    for (let i = 0; i < 4; i++) {
      bus.execute('pixels.applyOp', { clipId, frameId, layerId, ops: [{ op: 'rotateCW' }] }, 'ui');
    }
    expect(Array.from(celBuffer(bus, clipId, frameId, layerId))).toEqual(Array.from(original));
    expect(bus.historyStats().undoDepth).toBe(5); // rect + 4 rotations
    expect(label).toBe('Rotate 90° CW');

    bus.undo();
    expect(bus.historyStats().redoDepth).toBe(1);
  });

  test('non-square selection rotation re-anchors and stays undoable', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, color: RED, ops: [{ op: 'rect', from: { x: 2, y: 2 }, to: { x: 3, y: 4 }, filled: true }] },
      'ui'
    ); // 2×3 red block at (2,2)
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, ops: [{ op: 'rotateCW', rect: { x: 2, y: 2, w: 2, h: 3 } }] },
      'ui'
    );
    const buf = celBuffer(bus, clipId, frameId, layerId);
    // new footprint 3×2 at (2,2): rows 2-3, cols 2-4 red; row 4 cleared
    expect(getPixel(buf, 24, 4, 2)).toEqual(RED);
    expect(getPixel(buf, 24, 4, 3)).toEqual(RED);
    expect(getPixel(buf, 24, 2, 4)).toEqual([0, 0, 0, 0]);
    bus.undo();
    expect(getPixel(celBuffer(bus, clipId, frameId, layerId), 24, 2, 4)).toEqual(RED); // restored
    expect(getPixel(celBuffer(bus, clipId, frameId, layerId), 24, 4, 3)).toEqual([0, 0, 0, 0]);
  });

  test('rect fully outside the canvas is a visual no-op (no history entry)', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, color: RED, ops: [{ op: 'stamp', x: 1, y: 1 }] }, 'ui');
    const depth = bus.historyStats().undoDepth;
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, ops: [{ op: 'flipH', rect: { x: 100, y: 100, w: 4, h: 4 } }] },
      'ui'
    );
    expect(bus.historyStats().undoDepth).toBe(depth);
  });

  test('invalid transform payloads mutate nothing', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    const before = bus.getProject();
    expect(() =>
      bus.execute(
        'pixels.applyOp',
        { clipId, frameId, layerId, ops: [{ op: 'flipH', rect: { x: 0, y: 0, w: 0, h: 0 } }] },
        'ui'
      )
    ).toThrow();
    expect(() =>
      bus.execute(
        'pixels.applyOp',
        { clipId, frameId, layerId, ops: [{ op: 'rotateCW', rect: { x: 0.5, y: 0, w: 4, h: 4 } }] },
        'ui'
      )
    ).toThrow();
    expect(projectEquals(bus.getProject(), before)).toBe(true);
  });
});

describe('transforms keep linked cels consistent', () => {
  test('selection transform on a linked layer propagates to every frame', () => {
    const project = createProject({ name: 'linked', width: 16, height: 16 });
    const clip = project.clips[0];
    // second frame
    const withFrames: Project = {
      ...project,
      clips: [{ ...clip, frames: [clip.frames[0], createFrame(16, 16, clip.layers)] }],
    };
    const clipId = withFrames.clips[0].id;
    const layerId = withFrames.clips[0].layers[0].id;
    const bus = new CommandBus(withFrames);
    bus.execute('layer.setLinked', { clipId, layerId, linked: true }, 'ui');
    const frame0 = bus.getProject().clips[0].frames[0].id;
    bus.execute('pixels.applyOp', { clipId, frameId: frame0, layerId, color: RED, ops: [{ op: 'stamp', x: 3, y: 3 }] }, 'ui');
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId: frame0, layerId, ops: [{ op: 'flipH', rect: { x: 0, y: 0, w: 8, h: 8 } }] },
      'ui'
    );
    const frames = bus.getProject().clips[0].frames;
    expect(frames.length).toBe(2);
    const buf0 = frames[0].cels[layerId].buffer;
    const buf1 = frames[1].cels[layerId].buffer;
    expect(frames[0].cels[layerId].linked).toBe(true);
    expect(frames[1].cels[layerId].linked).toBe(true);
    expect(Array.from(buf0)).toEqual(Array.from(buf1)); // shared buffer
    expect(getPixel(buf0, 16, 4, 3)).toEqual(RED); // mirrored inside the rect
  });
});

describe('new ops survive journal replay', () => {
  test('ellipse + transform command records replay onto a fresh bus deterministically', () => {
    const { project, clipId, frameId, layerId } = makeProject();
    const bus = new CommandBus(project);
    const recorder = new JournalRecorder(bus);
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, color: RED, ops: [{ op: 'ellipse', from: { x: 1, y: 1 }, to: { x: 10, y: 6 }, filled: true }] },
      'ui'
    );
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, ops: [{ op: 'flipH', rect: { x: 0, y: 0, w: 12, h: 8 } }] },
      'ui'
    );
    bus.execute(
      'pixels.applyOp',
      { clipId, frameId, layerId, ops: [{ op: 'rotateCW', rect: { x: 0, y: 0, w: 12, h: 8 } }] },
      'ui'
    );
    const expected = celBuffer(bus, clipId, frameId, layerId);

    const records = recorder.all();
    recorder.detach();
    expect(records.length).toBe(3);

    // replay the captured journal through a FRESH bus onto the initial doc
    const result = replayJournal(project, records);
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(0);
    const replayedFrame = result.project.clips[0].frames[0];
    expect(Array.from(replayedFrame.cels[layerId].buffer)).toEqual(Array.from(expected));
  });
});
