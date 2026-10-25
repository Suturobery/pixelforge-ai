/**
 * History engine (v3.1 §2.5 / §9.1):
 *  - stroke grouping (begin/end/cancel → ONE tile-diff entry per stroke)
 *  - transaction grouping
 *  - memory budget: ≥ 250 typical strokes within the 64 MB default (C21)
 *  - safe eviction of the oldest entries (past first, then future front)
 *  - budget clamping to the 16–512 MB setting range
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HISTORY_BUDGET_BYTES,
  MAX_HISTORY_BUDGET_BYTES,
  MIN_HISTORY_BUDGET_BYTES,
  CommandBus,
  HistoryEngine,
  TILE_BYTES,
  TILE_SIZE,
  applyTileDiff,
  clampHistoryBudget,
  createProject,
  extractTileDiff,
  makePixelEntry,
  type HistoryEntry,
} from '../src';

function makeBus(w = 32, h = 32, budgetBytes?: number) {
  const project = createProject({ width: w, height: h });
  return { bus: new CommandBus(project, budgetBytes !== undefined ? { budgetBytes } : {}), project };
}

/** A pixels history entry whose cel RESOLVES against `project` (1 tile). */
function oneTileEntry(project: ReturnType<typeof createProject>): HistoryEntry {
  const clip = project.clips[0];
  return makePixelEntry('s', 'ui', {
    clipId: clip.id,
    frameId: clip.frames[0].id,
    layerId: clip.layers[0].id,
    tiles: [
      { index: 0, before: new Uint8ClampedArray(TILE_BYTES), after: new Uint8ClampedArray(TILE_BYTES) },
    ],
  });
}

describe('tile diff extraction & application', () => {
  test('only dirty tiles are recorded, with exact before/after bytes', () => {
    const w = 32, h = 32;
    const before = new Uint8ClampedArray(w * h * 4);
    const after = new Uint8ClampedArray(before);
    const setPx = (buf: Uint8ClampedArray, x: number, y: number, v: number) => {
      const i = (y * w + x) * 4;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    };
    setPx(after, 0, 0, 200);       // tile (0,0)
    setPx(after, 31, 31, 100);     // tile (1,1)
    setPx(after, 17, 3, 50);       // tile (1,0)
    const tiles = extractTileDiff(before, after, w, h);
    expect(tiles).toHaveLength(3);
    const indices = tiles.map((t) => t.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 3]); // (0,0)=0 · (1,0)=1 · (1,1)=3
    for (const t of tiles) {
      expect(t.before.length).toBe(TILE_BYTES);
      expect(t.after.length).toBe(TILE_BYTES);
    }
    // round-trip: apply 'after' → equal to after; apply 'before' → back
    const appliedAfter = applyTileDiff(before, w, h, tiles, 'after');
    expect(Array.from(appliedAfter)).toEqual(Array.from(after));
    const appliedBack = applyTileDiff(appliedAfter, w, h, tiles, 'before');
    expect(Array.from(appliedBack)).toEqual(Array.from(before));
  });

  test('partial edge tiles work on non-multiple-of-16 canvases (20×20)', () => {
    const w = 20, h = 20;
    const before = new Uint8ClampedArray(w * h * 4);
    const after = new Uint8ClampedArray(before);
    const i = (19 * w + 19) * 4; // bottom-right corner, tile (1,1) is 4×4
    after[i] = 250; after[i + 1] = 10; after[i + 2] = 10; after[i + 3] = 255;
    const tiles = extractTileDiff(before, after, w, h);
    expect(tiles).toHaveLength(1);
    const back = applyTileDiff(after, w, h, tiles, 'before');
    expect(Array.from(back)).toEqual(Array.from(before));
    const fwd = applyTileDiff(before, w, h, tiles, 'after');
    expect(Array.from(fwd)).toEqual(Array.from(after));
  });

  test('identical buffers produce zero tiles', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    expect(extractTileDiff(buf, new Uint8ClampedArray(buf), 16, 16)).toHaveLength(0);
  });
});

describe('stroke grouping', () => {
  test('each committed stroke = exactly ONE history entry; undo restores bytes', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };

    for (let i = 0; i < 5; i++) {
      const handle = bus.beginStroke(params);
      handle.buffer[(i * 32 + 0) * 4 + 0] = 255; // one pixel per stroke
      handle.buffer[(i * 32 + 0) * 4 + 3] = 255;
      const result = bus.endStroke(`stroke ${i}`, true);
      expect(result.committed).toBeTrue();
    }
    const stats = bus.historyStats();
    expect(stats.undoDepth).toBe(5);
    expect(stats.redoDepth).toBe(0);
    // every entry is a pixels entry costing ≤ 1 tile
    expect(stats.bytes).toBeLessThanOrEqual(5 * (TILE_BYTES * 2 + 256));

    // undo all → document back to fully transparent
    while (bus.canUndo()) expect(bus.undo().ok).toBeTrue();
    const doc = bus.getProject();
    const buf = doc.clips[0].frames[0].cels[clip.layers[0].id].buffer;
    expect(buf.every((b) => b === 0)).toBeTrue();
  });

  test('cancelStroke commits nothing and restores the exact pre-stroke buffer', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };
    const bufferBefore = bus.getProject().clips[0].frames[0].cels[clip.layers[0].id].buffer;

    const handle = bus.beginStroke(params);
    handle.buffer[0] = 99;
    bus.cancelStroke();
    expect(bus.historyStats().undoDepth).toBe(0);
    const cel = bus.getProject().clips[0].frames[0].cels[clip.layers[0].id];
    expect(cel.buffer).toBe(bufferBefore); // original object restored
    expect(cel.buffer[0]).toBe(0);
  });

  test('endStroke(changed=false) keeps the document clean (no entry, no dirty)', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };
    const before = bus.getProject().clips[0].frames[0].cels[clip.layers[0].id].buffer;
    bus.beginStroke(params);
    const r = bus.endStroke('nothing', false);
    expect(r.committed).toBeFalse();
    expect(bus.historyStats().undoDepth).toBe(0);
    expect(bus.isDirty()).toBeFalse();
    expect(bus.getProject().clips[0].frames[0].cels[clip.layers[0].id].buffer).toBe(before);
  });

  test('stroke that draws and erases back (zero diff) commits nothing', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };
    const handle = bus.beginStroke(params);
    handle.buffer[(5 * 32 + 5) * 4 + 3] = 255;
    handle.buffer[(5 * 32 + 5) * 4 + 3] = 0; // erase back
    const r = bus.endStroke('net-zero', true);
    expect(r.committed).toBeFalse();
    expect(bus.historyStats().undoDepth).toBe(0);
  });

  test('structural edit mid-stroke is fine; deleting the target mid-stroke discards', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };

    // structural edit mid-stroke → stroke still commits on the relocated cel
    const h1 = bus.beginStroke(params);
    h1.buffer[(6 * 32 + 6) * 4 + 3] = 255;
    bus.execute('palette.addColor', { hex: '#0a0b0c' }, 'ui');
    const r1 = bus.endStroke('survivor', true);
    expect(r1.committed).toBeTrue();
    expect(bus.historyStats().undoDepth).toBe(2); // palette + stroke

    // deleting the layer mid-stroke → stroke discarded
    bus.execute('layer.add', { clipId: clip.id, name: 'doomed' }, 'ui');
    const doomed = bus.getProject().clips[0].layers[1];
    bus.beginStroke({ clipId: clip.id, frameId: clip.frames[0].id, layerId: doomed.id });
    bus.execute('layer.delete', { clipId: clip.id, layerId: doomed.id }, 'ui');
    const r2 = bus.endStroke('lost', true);
    expect(r2.committed).toBeFalse();
    expect(r2.discarded).toBeTrue();
  });

  test('second beginStroke without ending is rejected; undo during stroke is rejected', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };
    bus.beginStroke(params);
    expect(() => bus.beginStroke(params)).toThrow();
    expect(() => bus.undo()).toThrow();
    expect(() => bus.redo()).toThrow();
    bus.cancelStroke();
  });
});

describe('transaction grouping', () => {
  test('transaction with mixed pixel + structural children undoes atomically', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const layerId = clip.layers[0].id;
    bus.transaction('rename+paint', 'mcp', () => {
      bus.execute('project.rename', { name: 'tx' }, 'mcp');
      bus.execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: clip.frames[0].id, layerId, color: [1, 2, 3, 255], ops: [{ op: 'stamp', x: 1, y: 1 }] },
        'mcp'
      );
      bus.execute('frame.add', { clipId: clip.id }, 'mcp');
    });
    expect(bus.historyStats().undoDepth).toBe(1);
    expect(bus.undo().ok).toBeTrue();
    expect(bus.getProject().name).toBe(project.name);
    expect(bus.getProject().clips[0].frames).toHaveLength(1);
    expect(
      bus.getProject().clips[0].frames[0].cels[layerId].buffer.every((b) => b === 0)
    ).toBeTrue();
  });
});

describe('memory budget & eviction', () => {
  test('budget clamps to the 16–512 MB settings range (§2.5)', () => {
    expect(clampHistoryBudget(1)).toBe(MIN_HISTORY_BUDGET_BYTES);
    expect(clampHistoryBudget(64 * 1024 * 1024)).toBe(DEFAULT_HISTORY_BUDGET_BYTES);
    expect(clampHistoryBudget(999 * 1024 * 1024)).toBe(MAX_HISTORY_BUDGET_BYTES);
    expect(MIN_HISTORY_BUDGET_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_HISTORY_BUDGET_BYTES).toBe(512 * 1024 * 1024);
    expect(DEFAULT_HISTORY_BUDGET_BYTES).toBe(64 * 1024 * 1024);
  });

  test('≥250 typical strokes fit in the default 64 MB budget (C21)', () => {
    const { bus, project } = makeBus(32, 32); // "typical" 32×32 sprite
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };

    const STROKES = 250;
    for (let i = 0; i < STROKES; i++) {
      const handle = bus.beginStroke(params);
      // deterministic UNIQUE pixel per stroke → every stroke dirties 1 tile
      const px = i % 32;
      const py = Math.floor(i / 32);
      const pi = (py * 32 + px) * 4;
      handle.buffer[pi] = 200;
      handle.buffer[pi + 1] = 120;
      handle.buffer[pi + 2] = 40;
      handle.buffer[pi + 3] = 255;
      bus.endStroke(`stroke ${i}`, true);
    }

    const stats = bus.historyStats();
    expect(stats.undoDepth).toBe(STROKES); // nothing evicted
    expect(stats.bytes).toBeLessThanOrEqual(DEFAULT_HISTORY_BUDGET_BYTES);
    expect(stats.usage).toBeLessThan(1);
    // ~2 KB per one-tile stroke → 250 strokes stay far below 64 MB
    expect(stats.bytes).toBeLessThan(4 * 1024 * 1024);
    // and the full 250-deep undo actually walks back
    let undos = 0;
    while (bus.canUndo()) {
      expect(bus.undo().ok).toBeTrue();
      undos += 1;
    }
    expect(undos).toBe(STROKES);
    const finalBuf = bus.getProject().clips[0].frames[0].cels[clip.layers[0].id].buffer;
    expect(finalBuf.every((b) => b === 0)).toBeTrue();
  });

  test('oldest entries are evicted first when over budget; newest always kept', () => {
    // Engine-level mechanics with a small budget (the bus clamps settings to
    // 16–512 MB; engine accepts raw budgets — see engine docs).
    const project = createProject({ width: 16, height: 16 });
    const engine = new HistoryEngine(24 * 1024);
    for (let i = 0; i < 50; i++) engine.push(oneTileEntry(project));
    const stats = engine.stats();
    // each entry ≈ 2.2 KB → ~11 fit in 24 KB; the rest evicted oldest-first
    expect(stats.evictedCount).toBeGreaterThan(0);
    expect(stats.undoDepth).toBeLessThan(50);
    expect(stats.undoDepth).toBeGreaterThanOrEqual(1); // newest always kept
    expect(stats.bytes).toBeLessThanOrEqual(stats.budgetBytes + TILE_BYTES * 2 + 512);
    // undo still works coherently after eviction (entries resolve)
    const step = engine.undo(project);
    expect(step).not.toBeNull();
  });

  test('bus-level eviction: heavy 256×256 edits exceed the 16 MB settings floor', () => {
    const project = createProject({ width: 256, height: 256 });
    // 16 MB budget (the settings floor) — 40 full-canvas floods ≈ 21 MB
    const bus = new CommandBus(project, { budgetBytes: MIN_HISTORY_BUDGET_BYTES });
    const clip = project.clips[0];
    const layerId = clip.layers[0].id;
    const frameId = clip.frames[0].id;
    // each flood dirties all 256 tiles ≈ 530 KB per entry
    for (let i = 0; i < 40; i++) {
      bus.execute(
        'pixels.applyOp',
        {
          clipId: clip.id,
          frameId,
          layerId,
          color: i % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0],
          ops: [{ op: 'fill', x: 0, y: 0 }],
        },
        'ui'
      );
    }
    const stats = bus.historyStats();
    expect(stats.evictedCount).toBeGreaterThan(0);
    expect(stats.undoDepth).toBeLessThan(40);
    expect(stats.usage).toBeLessThanOrEqual(1.01); // newest entry may exceed
    expect(bus.undo().ok).toBeTrue();
  });

  test('redo stack is evicted from the FRONT when a budget crunch hits', () => {
    const project = createProject({ width: 16, height: 16 });
    const engine = new HistoryEngine(20 * 1024);
    for (let i = 0; i < 30; i++) engine.push(oneTileEntry(project));
    // undo everything → future holds the redo chain
    while (engine.canUndo()) engine.undo(project);
    const beforeRedo = engine.stats();
    expect(beforeRedo.redoDepth).toBeGreaterThan(0);
    expect(beforeRedo.redoDepth).toBeLessThan(30); // front-evicted
    // redo chain remains coherent: repeated redo succeeds until exhausted
    let redos = 0;
    while (engine.canRedo()) {
      const r = engine.redo(project);
      expect(r).not.toBeNull();
      redos += 1;
    }
    expect(redos).toBe(beforeRedo.redoDepth);
  });

  test('setHistoryBudget shrinks memory live (Settings integration point)', () => {
    const project = createProject({ width: 16, height: 16 });
    const engine = new HistoryEngine();
    for (let i = 0; i < 20; i++) engine.push(oneTileEntry(project));
    expect(engine.stats().undoDepth).toBe(20);
    engine.setBudget(16 * 1024);
    const stats = engine.stats();
    expect(stats.undoDepth).toBeLessThan(20);
    expect(stats.budgetBytes).toBe(16 * 1024);
    expect(stats.evictedCount).toBeGreaterThan(0);
  });

  test('history stats expose usage for the status bar (§2.5)', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    const params = { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id };
    const handle = bus.beginStroke(params);
    handle.buffer[0] = 1;
    bus.endStroke('s', true);
    const stats = bus.historyStats();
    expect(stats.usage).toBeGreaterThan(0);
    expect(stats.usage).toBeLessThan(0.001); // one tile-diff entry vs 64 MB
    expect(stats.byOrigin.ui).toBe(1);
  });
});
