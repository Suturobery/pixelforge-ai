/**
 * Layer blend modes — blendChannel math, setProps validation, mergeDown baking.
 */

import { describe, expect, test } from 'bun:test';
import { blendChannel, CommandBus, createProject } from '../src';

function makeBus() {
  const project = createProject({ width: 4, height: 4 });
  return { bus: new CommandBus(project), project };
}

function twoLayerBus() {
  const { bus, project } = makeBus();
  bus.execute('layer.add', { clipId: project.clips[0].id }, 'ui');
  const clip = bus.getProject().clips[0];
  return { bus, clip, bottomId: clip.layers[0].id, topId: clip.layers[1].id, frameId: clip.frames[0].id };
}

function solidBuffer(rgba: [number, number, number, number]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) buf.set(rgba, i * 4);
  return buf;
}

function setBuffer(bus: CommandBus, clipId: string, frameId: string, layerId: string, rgba: [number, number, number, number]) {
  bus.execute(
    'pixels.applyOp',
    { clipId, frameId, layerId, ops: [{ op: 'setBuffer', buffer: solidBuffer(rgba) }] },
    'ui',
  );
}

describe('blendChannel', () => {
  test('normal returns source', () => {
    expect(blendChannel(undefined, 200, 50)).toBe(200);
    expect(blendChannel('normal', 200, 50)).toBe(200);
  });
  test('multiply clamps dark', () => {
    expect(blendChannel('multiply', 255, 128)).toBe(128);
    expect(blendChannel('multiply', 0, 255)).toBe(0);
  });
  test('screen lightens', () => {
    expect(blendChannel('screen', 0, 128)).toBe(128);
    expect(blendChannel('screen', 255, 10)).toBe(255);
  });
  test('overlay switches on backdrop', () => {
    expect(blendChannel('overlay', 255, 64)).toBe(128); // dark backdrop → multiply-ish
    expect(blendChannel('overlay', 255, 200)).toBe(255); // light backdrop → screen-ish
  });
  test('darken / lighten pick min / max', () => {
    expect(blendChannel('darken', 30, 200)).toBe(30);
    expect(blendChannel('lighten', 30, 200)).toBe(200);
  });
});

describe('mergeDown with blend mode', () => {
  test('multiply bakes: white top × mid-grey bottom = mid grey', () => {
    const { bus, clip, bottomId, topId, frameId } = twoLayerBus();
    setBuffer(bus, clip.id, frameId, bottomId, [128, 128, 128, 255]);
    setBuffer(bus, clip.id, frameId, topId, [255, 255, 255, 255]);
    bus.execute('layer.setProps', { clipId: clip.id, layerId: topId, patch: { blend: 'multiply' } }, 'ui');
    bus.execute('layer.mergeDown', { clipId: clip.id, layerId: topId }, 'ui');

    const after = bus.getProject().clips[0];
    expect(after.layers.map((l) => l.id)).toEqual([bottomId]);
    const merged = after.frames[0].cels[bottomId].buffer;
    expect(merged[0]).toBe(128); // 255 multiply 128 = 128
    expect(merged[1]).toBe(128);
    expect(merged[3]).toBe(255);
  });

  test('normal merge keeps old semantics', () => {
    const { bus, clip, bottomId, topId, frameId } = twoLayerBus();
    setBuffer(bus, clip.id, frameId, bottomId, [128, 128, 128, 255]);
    setBuffer(bus, clip.id, frameId, topId, [255, 255, 255, 255]);
    bus.execute('layer.mergeDown', { clipId: clip.id, layerId: topId }, 'ui');
    const merged = bus.getProject().clips[0].frames[0].cels[bottomId].buffer;
    expect(merged[0]).toBe(255); // normal: opaque top wins
  });

  test('setProps accepts blend and rejects unknown', () => {
    const { bus, clip, topId } = twoLayerBus();
    bus.execute('layer.setProps', { clipId: clip.id, layerId: topId, patch: { blend: 'screen' } }, 'ui');
    expect(bus.getProject().clips[0].layers[1].blend).toBe('screen');
    expect(() =>
      bus.execute('layer.setProps', { clipId: clip.id, layerId: topId, patch: { blend: 'burn' } }, 'ui'),
    ).toThrow();
  });
});
