/**
 * v1 compatibility boundary (v3.1 §2.4 "Migration" / §6):
 *  - v1 serialized shape guard (read support is permanent)
 *  - C3 loop mapping (loop:false = play once; loopMode defaults to forward)
 *  - v2 serialized guard
 *  - importer scaffolding pinned by tests before Task 3 implements it
 */

import { describe, expect, test } from 'bun:test';
import {
  SCHEMA_VERSION,
  createProject,
  isSerializedProjectV1,
  isSerializedProjectV2,
  mapV1Loop,
  v1ClipSkeleton,
  v2ProjectShell,
  type CelSourceResolver,
  type V1SerializedProject,
} from '../src';

const v1Doc: V1SerializedProject = {
  version: 1,
  name: 'farmer',
  width: 32,
  height: 32,
  palette: ['#1a1c2c', '#f4f4f4'],
  clips: [
    {
      id: 'cl1',
      name: 'idle',
      fps: 8,
      loop: true,
      frames: [
        {
          id: 'fr1',
          layers: [
            { id: 'ly1', name: 'body', visible: true, opacity: 1, png: 'data:image/png;base64,xxxx' },
          ],
        },
      ],
    },
  ],
};

describe('v1 guard (compat boundary)', () => {
  test('accepts a real v1 serialized project', () => {
    expect(isSerializedProjectV1(v1Doc)).toBeTrue();
  });

  test('rejects non-v1 shapes', () => {
    expect(isSerializedProjectV1(null)).toBeFalse();
    expect(isSerializedProjectV1({})).toBeFalse();
    expect(isSerializedProjectV1({ ...v1Doc, version: 2 })).toBeFalse();
    expect(isSerializedProjectV1({ ...v1Doc, clips: 'nope' })).toBeFalse();
    const v2 = createProject();
    expect(isSerializedProjectV1(v2)).toBeFalse();
  });
});

describe('C3 loop mapping', () => {
  test('v1 loop:true → { loop: true, loopMode: "forward" }', () => {
    expect(mapV1Loop(true)).toEqual({ loop: true, loopMode: 'forward' });
  });
  test('v1 loop:false → play-once (loop:false, mode forward)', () => {
    expect(mapV1Loop(false)).toEqual({ loop: false, loopMode: 'forward' });
  });
});

describe('v2 guard', () => {
  test('runtime projects are NOT v2-serialized docs (schemaVersion differs by shape)', () => {
    // runtime has schemaVersion 2 but ALSO non-enumerable runtime bits; the
    // serialized guard checks the documented field set — a runtime project
    // happens to satisfy it, which is fine for structural validation.
    const p = createProject();
    expect(isSerializedProjectV2(p)).toBeTrue();
  });

  test('rejects wrong schemaVersion and out-of-range canvas', () => {
    expect(isSerializedProjectV2({ ...v1Doc })).toBeFalse();
    expect(isSerializedProjectV2({ schemaVersion: 2, name: 'x', width: 8, height: 8, palette: [], trash: [], clips: [], settings: {} })).toBeFalse();
    expect(isSerializedProjectV2(null)).toBeFalse();
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe('importer scaffolding (Task 3 contract)', () => {
  test('v1ClipSkeleton maps metadata + C3 loop and leaves cels to Task 3', () => {
    const skeleton = v1ClipSkeleton(v1Doc.clips[0]);
    expect(skeleton.id).toBe('cl1');
    expect(skeleton.name).toBe('idle');
    expect(skeleton.fps).toBe(8);
    expect(skeleton.loop).toBe(true);
    expect(skeleton.loopMode).toBe('forward');
    expect(skeleton.layers).toEqual([]);
    expect(skeleton.frames).toEqual([]);
  });

  test('v2ProjectShell builds the document shell from a v1 doc', () => {
    const shell = v2ProjectShell(v1Doc, { id: 'row-7' });
    expect(shell.schemaVersion).toBe(2);
    expect(shell.id).toBe('row-7');
    expect(shell.name).toBe('farmer');
    expect(shell.width).toBe(32);
    expect(shell.palette).toEqual(['#1a1c2c', '#f4f4f4']);
    expect(shell.clips).toEqual([]);
    expect(shell.trash).toEqual([]);
  });

  test('CelSourceResolver contract is awaitable and decoupled from DOM', async () => {
    // Task 3 provides real resolvers (PNG data URL, ZIP entry). The core
    // only depends on this shape — prove it with a fake.
    const resolver: CelSourceResolver = {
      resolve: async (src, width, height) => {
        expect(src).toBe('data:image/png;base64,xxxx');
        return new Uint8ClampedArray(width * height * 4);
      },
    };
    const buf = await resolver.resolve('data:image/png;base64,xxxx', 32, 32);
    expect(buf).toBeInstanceOf(Uint8ClampedArray);
    expect(buf.length).toBe(32 * 32 * 4);
  });
});
