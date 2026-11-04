/**
 * Command bus — validation, execution, origin tracking, error handling,
 * change notifications, dirty tracking.
 */

import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  CommandError,
  createProject,
  findClip,
  locateCel,
  type ChangeEvent,
  type CommandContext,
} from '../src';
import { pixelAt } from './helpers';

function makeBus() {
  const project = createProject({ width: 16, height: 16 });
  return { bus: new CommandBus(project), project };
}

describe('command validation', () => {
  test('unknown command type throws UNKNOWN_COMMAND and leaves the doc untouched', () => {
    const { bus, project } = makeBus();
    expect(() => bus.execute('no.such.command', {}, 'ui')).toThrow(CommandError);
    try {
      bus.execute('no.such.command', {}, 'ui');
    } catch (err) {
      expect((err as CommandError).code).toBe('UNKNOWN_COMMAND');
    }
    expect(bus.getProject()).toBe(project);
    expect(bus.canUndo()).toBeFalse();
  });

  test('payload validation failures throw VALIDATION_FAILED', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    // bad fps
    expect(() => bus.execute('clip.setProps', { clipId: clip.id, patch: { fps: 0 } }, 'ui')).toThrow(CommandError);
    expect(() => bus.execute('clip.setProps', { clipId: clip.id, patch: { fps: 61 } }, 'ui')).toThrow(CommandError);
    // bad loopMode
    expect(() =>
      bus.execute('clip.setProps', { clipId: clip.id, patch: { loopMode: 'sideways' } }, 'ui')
    ).toThrow(CommandError);
    // bad hex
    expect(() => bus.execute('palette.addColor', { hex: 'teal' }, 'ui')).toThrow(CommandError);
    // bad RGBA
    expect(() =>
      bus.execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id, color: [1, 2, 3], ops: [{ op: 'stamp', x: 0, y: 0 }] },
        'ui'
      )
    ).toThrow(CommandError);
    // color missing for a color op
    expect(() =>
      bus.execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id, ops: [{ op: 'stamp', x: 0, y: 0 }] },
        'ui'
      )
    ).toThrow(CommandError);
    // empty ops array
    expect(() =>
      bus.execute(
        'pixels.applyOp',
        { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id, ops: [] },
        'ui'
      )
    ).toThrow(CommandError);
    expect(bus.canUndo()).toBeFalse();
  });

  test('missing targets throw NOT_FOUND (frames/layers/trash)', () => {
    const { bus } = makeBus();
    expect(() => bus.execute('frame.setDuration', { clipId: 'nope', frameId: 'x', durationMs: 100 }, 'ui')).toThrow(CommandError);
    const clip = bus.getProject().clips[0];
    expect(() => bus.execute('frame.setDuration', { clipId: clip.id, frameId: 'nope', durationMs: 100 }, 'ui')).toThrow(CommandError);
    expect(() => bus.execute('trash.restore', { entryId: 'nope' }, 'ui')).toThrow(CommandError);
  });

  test('last frame / last layer / last clip are protected', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    expect(() => bus.execute('frame.delete', { clipId: clip.id, frameIndex: 0 }, 'ui')).toThrow(CommandError);
    expect(() => bus.execute('layer.delete', { clipId: clip.id, layerId: clip.layers[0].id }, 'ui')).toThrow(CommandError);
    expect(() => bus.execute('clip.delete', { clipId: clip.id }, 'ui')).toThrow(CommandError);
  });

  test('validation failure leaves the document bit-identical (rollback guarantee)', () => {
    const { bus, project } = makeBus();
    const clip = project.clips[0];
    bus.execute(
      'pixels.applyOp',
      { clipId: clip.id, frameId: clip.frames[0].id, layerId: clip.layers[0].id, color: [9, 9, 9, 255], ops: [{ op: 'stamp', x: 1, y: 1 }] },
      'ui'
    );
    const before = bus.getProject();
    expect(() =>
      bus.execute('frame.add', { clipId: clip.id, afterIndex: 99 }, 'ui')
    ).toThrow(CommandError);
    expect(bus.getProject()).toBe(before);
  });
});

describe('execute + notifications + dirty', () => {
  test('execute applies the command, fires one change event, marks dirty', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    const events: ChangeEvent[] = [];
    const off = bus.onChange((e) => events.push(e));

    expect(bus.isDirty()).toBeFalse();
    const outcome = bus.execute('project.rename', { name: 'farmer' }, 'ui');
    expect(bus.getProject().name).toBe('farmer');
    expect(outcome.project.name).toBe('farmer');
    expect(bus.isDirty()).toBeTrue();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('executed');
    expect(events[0].label).toBe('Rename project');
    expect(events[0].origin).toBe('ui');
    expect(events[0].commandType).toBe('project.rename');
    off();
    bus.execute('project.rename', { name: 'x' }, 'ui');
    expect(events).toHaveLength(1); // unsubscribed
  });

  test('custom commands can be registered; duplicates are rejected', () => {
    const { bus } = makeBus();
    expect(() =>
      bus.register({
        type: 'project.rename',
        defaultLabel: 'dup',
        validate: (_payload: unknown, _ctx: CommandContext) => {},
        apply: (_payload: unknown, ctx: CommandContext) => ({ project: ctx.project }),
      })
    ).toThrow(CommandError);
    bus.register({
      type: 'test.noop',
      defaultLabel: 'noop',
      validate: (_payload: unknown, _ctx: CommandContext) => {},
      apply: (_payload: unknown, ctx: CommandContext) => ({ project: ctx.project }),
    });
    expect(bus.has('test.noop')).toBeTrue();
  });

  test('listener errors do not corrupt the bus', () => {
    const { bus } = makeBus();
    bus.onChange(() => {
      throw new Error('listener boom');
    });
    expect(() => bus.execute('project.rename', { name: 'still-works' }, 'ui')).not.toThrow();
    expect(bus.getProject().name).toBe('still-works');
  });
});

describe('origin tracking (ui | mcp | ai)', () => {
  test('history stats record the origin of each entry', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    bus.execute('project.rename', { name: 'a' }, 'ui');
    bus.execute('project.rename', { name: 'b' }, 'mcp');
    bus.execute('project.rename', { name: 'c' }, 'ai');
    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: clip.frames[0].id,
        layerId: clip.layers[0].id,
        color: [1, 1, 1, 255],
        ops: [{ op: 'stamp', x: 0, y: 0 }],
      },
      'mcp'
    );
    const stats = bus.historyStats();
    expect(stats.undoDepth).toBe(4);
    expect(stats.byOrigin).toEqual({ ui: 1, mcp: 2, ai: 1 });
  });

  test('undo/redo results carry the originating origin + label', () => {
    const { bus } = makeBus();
    bus.execute('project.rename', { name: 'from-mcp' }, 'mcp');
    const undone = bus.undo();
    expect(undone.ok).toBeTrue();
    expect(undone.origin).toBe('mcp');
    expect(undone.label).toBe('Rename project');
    const redone = bus.redo();
    expect(redone.origin).toBe('mcp');
  });
});

describe('pixels.applyOp behaviors', () => {
  test('zero-diff ops produce no history entry but still execute', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    const events: ChangeEvent[] = [];
    bus.onChange((e) => events.push(e));
    // stamping transparent-on-transparent → zero tiles
    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: clip.frames[0].id,
        layerId: clip.layers[0].id,
        color: [0, 0, 0, 0],
        ops: [{ op: 'stamp', x: 0, y: 0 }],
      },
      'ui'
    );
    expect(bus.historyStats().undoDepth).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].historyChanged).toBeFalse();
  });

  test('a typical stroke-worth of tiles lands as a tile-diff entry', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: clip.frames[0].id,
        layerId: clip.layers[0].id,
        color: [255, 255, 255, 255],
        ops: [{ op: 'line', from: { x: 3, y: 3 }, to: { x: 9, y: 9 } }],
      },
      'ui'
    );
    const stats = bus.historyStats();
    expect(stats.undoDepth).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
    const frame = bus.getProject().clips[0].frames[0];
    expect(pixelAt(frame, clip.layers[0].id, 16, 3, 3)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(frame, clip.layers[0].id, 16, 9, 9)).toEqual([255, 255, 255, 255]);
  });

  test('shift + clear + setBuffer ops work and stay undoable', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    const layerId = clip.layers[0].id;
    bus.execute(
      'pixels.applyOp',
      {
        clipId: clip.id,
        frameId: clip.frames[0].id,
        layerId,
        color: [255, 0, 0, 255],
        ops: [{ op: 'stamp', x: 0, y: 0 }, { op: 'shift', dx: 2, dy: 1 }],
      },
      'ui'
    );
    let frame = bus.getProject().clips[0].frames[0];
    expect(pixelAt(frame, layerId, 16, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(frame, layerId, 16, 0, 0)).toEqual([0, 0, 0, 0]);

    bus.execute(
      'pixels.applyOp',
      { clipId: clip.id, frameId: clip.frames[0].id, layerId, ops: [{ op: 'clear' }] },
      'ui'
    );
    frame = bus.getProject().clips[0].frames[0];
    expect(pixelAt(frame, layerId, 16, 2, 1)).toEqual([0, 0, 0, 0]);

    expect(bus.undo().ok).toBeTrue(); // clear undone
    expect(bus.undo().ok).toBeTrue(); // stamp+shift undone
    frame = bus.getProject().clips[0].frames[0];
    expect(pixelAt(frame, layerId, 16, 2, 1)).toEqual([0, 0, 0, 0]);
  });

  test('locateCel finds cel or reports transparent-missing', () => {
    const { bus } = makeBus();
    const clip = bus.getProject().clips[0];
    const loc = locateCel(bus.getProject(), clip.id, clip.frames[0].id, clip.layers[0].id);
    expect(loc).not.toBeNull();
    expect(loc?.cel?.linked).toBeFalse();
    expect(locateCel(bus.getProject(), 'nope', clip.frames[0].id, clip.layers[0].id)).toBeNull();
    expect(findClip(bus.getProject(), clip.id)?.id).toBe(clip.id);
  });

  test('canvas.resize shifts pixels, crops out-of-bounds, undoes exactly', () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;
    const frameId = project.clips[0].frames[0].id;
    // stamp at (2,2) on 16×16
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, color: [255, 128, 0, 255], ops: [{ op: 'stamp', x: 2, y: 2 }] }, 'ui');

    // grow to 24×24 anchored top-left → pixel stays at (2,2)
    bus.execute('canvas.resize', { width: 24, height: 24, anchor: 'top-left' }, 'ui');
    const grown = bus.getProject();
    expect(grown.width).toBe(24);
    expect(grown.height).toBe(24);
    expect(pixelAt(grown.clips[0].frames[0], layerId, 24, 2, 2)).toEqual([255, 128, 0, 255]);
    expect(pixelAt(grown.clips[0].frames[0], layerId, 24, 20, 20)).toEqual([0, 0, 0, 0]);

    // one undo restores exact 16×16 document
    expect(bus.undo().ok).toBeTrue();
    expect(bus.getProject().width).toBe(16);
    expect(pixelAt(bus.getProject().clips[0].frames[0], layerId, 16, 2, 2)).toEqual([255, 128, 0, 255]);
    expect(bus.redo().ok).toBeTrue();
    expect(bus.getProject().width).toBe(24);
  });

  test('canvas.resize center anchor offsets content and same-size is rejected', () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;
    const frameId = project.clips[0].frames[0].id;
    bus.execute('pixels.applyOp', { clipId, frameId, layerId, color: [255, 0, 0, 255], ops: [{ op: 'stamp', x: 6, y: 6 }] }, 'ui');

    // shrink 16→8 centered → offset −4; source (6,6) lands at (2,2), source (0,0) is cropped
    bus.execute('canvas.resize', { width: 8, height: 8, anchor: 'center' }, 'ui');
    const shrunk = bus.getProject();
    expect(shrunk.width).toBe(8);
    expect(pixelAt(shrunk.clips[0].frames[0], layerId, 8, 2, 2)).toEqual([255, 0, 0, 255]);

    // same-size resize rejected
    expect(() => bus.execute('canvas.resize', { width: 8, height: 8 }, 'ui')).toThrow(CommandError);
  });

  test('canvas.resize keeps linked cels linked with identical buffers', () => {
    const { bus, project } = makeBus();
    const clipId = project.clips[0].id;
    const layerId = project.clips[0].layers[0].id;
    bus.execute('layer.setLinked', { clipId, layerId, linked: true }, 'ui');
    bus.execute('frame.add', { clipId, copy: false }, 'ui');

    bus.execute('canvas.resize', { width: 32, height: 32 }, 'ui');
    const after = bus.getProject();
    const cel0 = after.clips[0].frames[0].cels[layerId];
    const cel1 = after.clips[0].frames[1].cels[layerId];
    expect(cel0?.linked).toBeTrue();
    expect(cel1?.linked).toBeTrue();
    expect(cel0?.buffer.length).toBe(32 * 32 * 4);
    // both linked cels carry identical (empty) content
    expect(Buffer.from(cel0?.buffer ?? []).equals(Buffer.from(cel1?.buffer ?? []))).toBeTrue();
  });
});
