/**
 * Command bus — execute/undo/redo round trips, deterministic state after
 * undo/redo, failed-command rollback (single + transaction), stale-entry
 * unwinding, document replacement.
 */

import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  CommandError,
  HistoryEngine,
  cloneProject,
  createProject,
  makePixelEntry,
  type ChangeEvent,
} from '../src';
import { pixelAt, projectEquals } from './helpers';

function makeBus(w = 16, h = 16) {
  const project = createProject({ width: w, height: h });
  return { bus: new CommandBus(project), project };
}

function stamp(bus: CommandBus, clipId: string, frameId: string, layerId: string, x: number, y: number, origin: 'ui' | 'mcp' | 'ai' = 'ui') {
  return bus.execute(
    'pixels.applyOp',
    { clipId, frameId, layerId, color: [255, 128, 0, 255], ops: [{ op: 'stamp', x, y }] },
    origin
  );
}

describe('undo/redo round trips', () => {
  test('structural + pixel commands undo/redo exactly', () => {
    const { bus, project } = makeBus();
    const initial = cloneProject(project);
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;

    bus.execute('project.rename', { name: 'renamed' }, 'ui');
    bus.execute('frame.add', { clipId, copy: false }, 'ui');
    const frame2 = bus.getProject().clips[0].frames[1];
    stamp(bus, clipId, frame2.id, layerId, 4, 4);

    // undo pixel → undo frame add → undo rename
    expect(bus.undo().ok).toBeTrue();
    expect(bus.undo().ok).toBeTrue();
    expect(bus.undo().ok).toBeTrue();
    expect(projectEquals(bus.getProject(), initial)).toBeTrue();

    // redo all three
    expect(bus.redo().ok).toBeTrue();
    expect(bus.redo().ok).toBeTrue();
    expect(bus.redo().ok).toBeTrue();
    const redone = bus.getProject();
    expect(redone.name).toBe('renamed');
    expect(redone.clips[0].frames).toHaveLength(2);
    expect(pixelAt(redone.clips[0].frames[1], layerId, 16, 4, 4)).toEqual([255, 128, 0, 255]);
  });

  test('editor state is DETERMINISTIC after undo/redo (deep equality incl. buffers)', () => {
    const { bus, project } = makeBus(32, 32);
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;

    bus.execute('clip.add', { name: 'extra' }, 'ui');
    const clip2 = bus.getProject().clips[1];
    stamp(bus, clip2.id, clip2.frames[0].id, clip2.layers[0].id, 1, 1);
    stamp(bus, clipId, project.clips[0].frames[0].id, layerId, 30, 30, 'ai');
    bus.execute('palette.addColor', { hex: '#abcdef' }, 'ui');
    const snapshot = cloneProject(bus.getProject());

    for (let i = 0; i < 4; i++) expect(bus.undo().ok).toBeTrue();
    expect(projectEquals(bus.getProject(), project)).toBeTrue();
    for (let i = 0; i < 4; i++) expect(bus.redo().ok).toBeTrue();
    expect(projectEquals(bus.getProject(), snapshot)).toBeTrue();
  });

  test('undo with nothing to undo returns { ok: false } (and throws nothing)', () => {
    const { bus } = makeBus();
    expect(bus.undo().ok).toBeFalse();
    expect(bus.redo().ok).toBeFalse();
  });

  test('new commits clear the redo stack (prototype semantics)', () => {
    const { bus, project } = makeBus();
    bus.execute('project.rename', { name: 'one' }, 'ui');
    bus.execute('project.rename', { name: 'two' }, 'ui');
    expect(bus.undo().ok).toBeTrue();
    expect(bus.canRedo()).toBeTrue();
    bus.execute('project.rename', { name: 'three' }, 'ui');
    expect(bus.canRedo()).toBeFalse();
    expect(bus.getProject().name).toBe('three');
    void project;
  });

  test('stale pixel entries are skipped during undo (structure changed underneath)', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const layer = clip.layers[0];

    // 0. second frame so the later delete is legal
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    // 1. pixel edit on frame 1
    stamp(bus, clip.id, bus.getProject().clips[0].frames[0].id, layer.id, 2, 2);
    // 2. delete frame 1 (trash-backed structural) — the cel of entry 1 vanishes
    bus.execute('frame.delete', { clipId: clip.id, frameIndex: 0 }, 'ui');
    // 3. add another frame
    bus.execute('frame.add', { clipId: clip.id }, 'ui');
    // 4. pixel edit on the (new) frame 1
    stamp(bus, clip.id, bus.getProject().clips[0].frames[1].id, layer.id, 5, 5);

    // Undo all 5 entries; every one must resolve (structure entries restore
    // their targets) and land back on the exact initial document.
    let steps = 0;
    while (bus.canUndo() && steps < 10) {
      const r = bus.undo();
      expect(r.ok).toBeTrue();
      steps += 1;
    }
    expect(steps).toBe(5);
    expect(projectEquals(bus.getProject(), project)).toBeTrue();
  });

  test('engine drops a stale pixel entry instead of corrupting the document', () => {
    // Direct engine-level test of the skip path: hand-build a pixels entry
    // whose cel does not exist, then undo → null → entry discarded.
    const project = createProject({ width: 16, height: 16 });
    const engine = new HistoryEngine();
    engine.push(
      makePixelEntry('stale', 'ui', {
        clipId: 'ghost-clip',
        frameId: 'ghost-frame',
        layerId: 'ghost-layer',
        tiles: [
          {
            index: 0,
            before: new Uint8ClampedArray(1024),
            after: new Uint8ClampedArray(1024).fill(9),
          },
        ],
      })
    );
    expect(engine.canUndo()).toBeTrue();
    expect(engine.undo(project)).toBeNull(); // stale → skipped
    expect(engine.canUndo()).toBeFalse(); // entry dropped both ways
  });
});

describe('failed-command rollback', () => {
  test('single failing command leaves document + history untouched', () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    bus.execute('frame.add', { clipId }, 'ui');
    const before = bus.getProject();
    const statsBefore = bus.historyStats();
    expect(() => bus.execute('clip.delete', { clipId: 'missing' }, 'ui')).toThrow(CommandError);
    expect(bus.getProject()).toBe(before);
    expect(bus.historyStats()).toEqual(statsBefore);
  });

  test('transaction rolls back ALL children when any step fails', () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;
    const startDoc = bus.getProject();
    const startSnapshot = cloneProject(startDoc);

    expect(() =>
      bus.transaction('batch edit', 'mcp', () => {
        bus.execute('frame.add', { clipId, copy: true }, 'mcp');
        bus.execute('palette.addColor', { hex: '#112233' }, 'mcp');
        stamp(bus, clipId, bus.getProject().clips[0].frames[0].id, layerId, 7, 7, 'mcp');
        throw new Error('simulated mid-transaction failure');
      })
    ).toThrow('simulated mid-transaction failure');

    expect(projectEquals(bus.getProject(), startSnapshot)).toBeTrue();
    expect(bus.historyStats().undoDepth).toBe(0);
    expect(bus.canUndo()).toBeFalse();
    expect(bus.getProject()).toBe(startDoc); // exact rollback to start object
  });

  test('successful transaction groups children into ONE undoable entry', () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;

    bus.transaction('batch edit', 'ai', () => {
      bus.execute('frame.add', { clipId, copy: true }, 'ai');
      bus.execute('palette.addColor', { hex: '#112233' }, 'ai');
      stamp(bus, clipId, bus.getProject().clips[0].frames[0].id, layerId, 7, 7, 'ai');
    });

    expect(bus.historyStats().undoDepth).toBe(1); // grouped!
    const batched = bus.getProject();
    expect(batched.clips[0].frames).toHaveLength(2);
    expect(batched.palette).toContain('#112233');
    expect(pixelAt(batched.clips[0].frames[0], layerId, 16, 7, 7)).toEqual([255, 128, 0, 255]);

    // one undo reverts all three
    expect(bus.undo().ok).toBeTrue();
    expect(projectEquals(bus.getProject(), project)).toBeTrue();
    // one redo reapplies all three
    expect(bus.redo().ok).toBeTrue();
    expect(bus.getProject().clips[0].frames).toHaveLength(2);
    expect(bus.getProject().palette).toContain('#112233');
  });

  test('nested transactions fold into the parent (single entry)', () => {
    const { bus, project } = makeBus();
    bus.transaction('outer', 'ui', () => {
      bus.execute('project.rename', { name: 'in-tx' }, 'ui');
      bus.transaction('inner', 'ui', () => {
        bus.execute('palette.addColor', { hex: '#445566' }, 'ui');
      });
    });
    expect(bus.historyStats().undoDepth).toBe(1);
    expect(bus.undo().ok).toBeTrue();
    expect(bus.getProject().name).toBe(project.name);
    expect(bus.getProject().palette).not.toContain('#445566');
  });

  test('strokes are rejected inside transactions and transactions during strokes', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    bus.beginStroke({ clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id });
    expect(() => bus.transaction('t', 'ui', () => {})).toThrow(CommandError);
    bus.endStroke('stroke', false);
    bus.transaction('t', 'ui', () => {
      expect(() =>
        bus.beginStroke({ clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id })
      ).toThrow(CommandError);
    });
  });

  test('async transaction groups children into ONE undoable entry', async () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;

    const out = await bus.transaction('async batch', 'mcp', async () => {
      bus.execute('frame.add', { clipId, copy: true }, 'mcp');
      bus.execute('palette.addColor', { hex: '#112233' }, 'mcp');
      await Promise.resolve(); // async boundary inside the transaction
      bus.execute('palette.addColor', { hex: '#445566' }, 'mcp');
      return 'done';
    });
    expect(out).toBe('done');
    expect(bus.historyStats().undoDepth).toBe(1);
    expect(bus.getProject().palette).toContain('#112233');
    expect(bus.undo().ok).toBeTrue();
    expect(bus.getProject().clips[0].frames).toHaveLength(1);
    expect(bus.getProject().palette).not.toContain('#112233');
  });

  test('async transaction rolls back ALL children on rejection', async () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    const startDoc = bus.getProject();
    const startSnapshot = cloneProject(startDoc);

    await expect(
      bus.transaction('async batch', 'mcp', async () => {
        bus.execute('frame.add', { clipId, copy: true }, 'mcp');
        bus.execute('palette.addColor', { hex: '#112233' }, 'mcp');
        await Promise.resolve();
        throw new Error('async failure');
      }),
    ).rejects.toThrow('async failure');

    expect(projectEquals(bus.getProject(), startSnapshot)).toBeTrue();
    expect(bus.historyStats().undoDepth).toBe(0);
    expect(bus.getProject()).toBe(startDoc);
    // bus usable again after rollback
    bus.transaction('after', 'ui', () => {
      bus.execute('palette.addColor', { hex: '#010203' }, 'ui');
    });
    expect(bus.getProject().palette).toContain('#010203');
  });
});

describe('document replacement', () => {
  test('setProject clears history + dirty and notifies', () => {
    const { bus, project } = makeBus();
    bus.execute('project.rename', { name: 'x' }, 'ui');
    expect(bus.canUndo()).toBeTrue();
    const events: ChangeEvent[] = [];
    bus.onChange((e) => events.push(e));
    const fresh = createProject({ name: 'fresh', width: 24, height: 24 });
    bus.setProject(fresh);
    expect(bus.canUndo()).toBeFalse();
    expect(bus.isDirty()).toBeFalse();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('document-replaced');
  });

  test('markSaved clears dirty; further edits re-dirty', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    bus.execute('project.rename', { name: 'y' }, 'ui');
    expect(bus.isDirty()).toBeTrue();
    bus.markSaved();
    expect(bus.isDirty()).toBeFalse();
    stamp(bus, clip.id, clip.frames[0].id, clip.layers[0].id, 0, 0);
    expect(bus.isDirty()).toBeTrue();
  });
});
