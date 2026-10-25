/**
 * v1 → v2 importer tests (v3.1 §2.4 Migration, §13 golden checks incl. loop
 * mapping C3, per-frame layer matching, forward rejection, warnings).
 */

import { describe, expect, test } from 'bun:test';
import { V1ProjectImporter, pngDataUrlResolver } from '../src/compat/import-v1';
import { isSerializedProjectV1 } from '../src/types/v1';
import { encodePng } from '../src/persist/png';
import { base64Encode } from '../src/persist/base64';
import { serializeProjectV2, projectFromSerialized, validateSerializedProjectV2 } from '../src/persist';
import { createProject } from '../src/doc/factory';
import type { V1SerializedProject } from '../src/types/v1';

const W = 32;
const H = 32;

/** Async data URL builder (encodePng is async). */
async function pngDataUrl(width: number, height: number, paint?: (buf: Uint8ClampedArray) => void): Promise<string> {
  const buf = new Uint8ClampedArray(width * height * 4);
  paint?.(buf);
  const png = await encodePng(width, height, buf);
  return `data:image/png;base64,${base64Encode(png)}`;
}

function px(buf: Uint8ClampedArray, w: number, x: number, y: number, rgba: [number, number, number, number]) {
  const i = (y * w + x) * 4;
  buf[i] = rgba[0];
  buf[i + 1] = rgba[1];
  buf[i + 2] = rgba[2];
  buf[i + 3] = rgba[3];
}

async function makeV1(loop: boolean): Promise<V1SerializedProject> {
  const frame0Png = await pngDataUrl(W, H, (b) => {
    px(b, W, 1, 1, [255, 0, 0, 255]);
    px(b, W, 2, 1, [0, 255, 0, 255]);
  });
  const frame1Png = await pngDataUrl(W, H, (b) => {
    px(b, W, 5, 5, [0, 0, 255, 255]);
  });
  return {
    version: 1,
    name: 'legacy-hero',
    width: W,
    height: H,
    palette: ['#1a1c2c', '#f4f4f4'],
    clips: [
      {
        id: 'cl1',
        name: 'idle',
        fps: 10,
        loop,
        frames: [
          {
            id: 'fr1',
            layers: [
              { id: 'ly-a1', name: 'body', visible: true, opacity: 1, png: frame0Png },
              { id: 'ly-b1', name: 'fx', visible: false, opacity: 0.8, png: frame0Png },
            ],
          },
          {
            id: 'fr2',
            layers: [
              { id: 'ly-a2', name: 'body', visible: true, opacity: 1, png: frame1Png },
              // 'fx' absent in frame 2 (v1 stacks could diverge) + a ghost layer
              { id: 'ly-c2', name: 'temp', visible: true, opacity: 1, png: frame1Png },
            ],
          },
        ],
      },
    ],
  };
}

describe('v1→v2 importer', () => {
  test('isSerializedProjectV1 gates unknown shapes', () => {
    expect(isSerializedProjectV1({ version: 1, name: 'x', width: 32, height: 32, palette: [], clips: [] })).toBe(true);
    expect(isSerializedProjectV1({ version: 2 })).toBe(false);
    expect(isSerializedProjectV1(null)).toBe(false);
    expect(isSerializedProjectV1({ version: 1, name: 5 })).toBe(false);
  });

  test('importer rejects non-v1 input without half-converting', async () => {
    const importer = new V1ProjectImporter();
    await expect(importer.import({ version: 2, name: 'x' }, pngDataUrlResolver)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA',
    });
    await expect(importer.import('nope', pngDataUrlResolver)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  test('C3 loop mapping: true → {true, forward}; false → {false, forward}', async () => {
    const importer = new V1ProjectImporter();
    const looping = await importer.import(await makeV1(true), pngDataUrlResolver);
    expect(looping.project.clips[0].loop).toBe(true);
    expect(looping.project.clips[0].loopMode).toBe('forward');

    const once = await importer.import(await makeV1(false), pngDataUrlResolver);
    expect(once.project.clips[0].loop).toBe(false);
    expect(once.project.clips[0].loopMode).toBe('forward'); // play once
  });

  test('per-frame layers match by NAME into one stack; absent layer → transparent cel; ghost layer warns', async () => {
    const importer = new V1ProjectImporter();
    const { project, warnings } = await importer.import(await makeV1(true), pngDataUrlResolver, { id: 'row-1' });

    expect(project.id).toBe('row-1');
    expect(project.schemaVersion).toBe(2);
    expect(project.name).toBe('legacy-hero');
    expect(project.palette).toEqual(['#1a1c2c', '#f4f4f4']);

    const clip = project.clips[0];
    expect(clip.layers.map((l) => l.name)).toEqual(['body', 'fx', 'temp']);
    expect(clip.layers.every((l) => l.linked === false)).toBe(true);
    expect(clip.fps).toBe(10);
    expect(clip.frames.length).toBe(2);
    expect(clip.parts).toEqual([]);
    expect(clip.tags).toEqual([]);

    const body = clip.layers.find((l) => l.name === 'body')!;
    const fx = clip.layers.find((l) => l.name === 'fx')!;
    const temp = clip.layers.find((l) => l.name === 'temp')!;

    // Frame 1: body + fx present; frame 2: body + temp present, fx absent.
    expect(clip.frames[0].cels[body.id]).toBeDefined();
    expect(clip.frames[0].cels[fx.id]).toBeDefined();
    expect(clip.frames[1].cels[fx.id]).toBeUndefined(); // absent = transparent (C2)
    expect(clip.frames[0].cels[temp.id]).toBeUndefined();
    expect(clip.frames[1].cels[temp.id]).toBeDefined();

    // Pixel fidelity through decode.
    expect(clip.frames[0].cels[body.id].buffer[(1 * W + 1) * 4]).toBe(255);
    expect(clip.frames[1].cels[body.id].buffer[(5 * W + 5) * 4 + 2]).toBe(255);

    // Warnings: per-frame id note, absent fx in frame 2, ghost temp in frame 1.
    expect(warnings.some((w) => w.includes('fx') && w.includes('transparent'))).toBe(true);
    expect(warnings.some((w) => w.includes('temp') && w.includes('transparent'))).toBe(true);
  });

  test('layer property mismatch adopts first occurrence and warns', async () => {
    const v1 = await makeV1(true);
    // Make 'fx' opacity differ in frame 2.
    v1.clips[0].frames[1].layers.unshift({
      id: 'ly-b2',
      name: 'fx',
      visible: true,
      opacity: 0.2,
      png: v1.clips[0].frames[1].layers[0].png,
    });
    const importer = new V1ProjectImporter();
    const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
    const fx = project.clips[0].layers.find((l) => l.name === 'fx')!;
    expect(fx.opacity).toBe(0.8); // first frame wins
    expect(warnings.some((w) => w.includes('differing visibility/opacity'))).toBe(true);
  });

  test('dimension mismatch warns and top-left pads/crops', async () => {
    const v1 = await makeV1(true);
    const small = await pngDataUrl(16, 16, (b) => px(b, 16, 0, 0, [250, 0, 0, 255]));
    v1.clips[0].frames[0].layers[0].png = small;
    const importer = new V1ProjectImporter();
    const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
    const body = project.clips[0].layers.find((l) => l.name === 'body')!;
    const cel = project.clips[0].frames[0].cels[body.id];
    expect(cel.buffer.length).toBe(W * H * 4);
    expect(cel.buffer[0]).toBe(250); // top-left kept
    expect(cel.buffer[((10 * W) + 10) * 4 + 3]).toBe(0); // padded area transparent
    expect(warnings.some((w) => w.includes('16×16') && w.includes('crop/pad'))).toBe(true);
  });

  test('corrupt PNG data URL → warning + cel dropped (never throws)', async () => {
    const v1 = await makeV1(true);
    v1.clips[0].frames[0].layers[0].png = `data:image/png;base64,${base64Encode(new TextEncoder().encode('not a png'))}`;
    const importer = new V1ProjectImporter();
    const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
    const body = project.clips[0].layers.find((l) => l.name === 'body')!;
    expect(project.clips[0].frames[0].cels[body.id]).toBeUndefined();
    expect(warnings.some((w) => w.includes('PNG decode failed'))).toBe(true);
  });

  test('imported v1 project re-serializes as valid v2 and round-trips', async () => {
    const importer = new V1ProjectImporter();
    const { project } = await importer.import(await makeV1(false), pngDataUrlResolver);
    const { projectJson, celPngs } = await serializeProjectV2(project);
    expect(validateSerializedProjectV2(projectJson)).toEqual([]);
    const restored = await projectFromSerialized(projectJson, (src) => celPngs.get(src));
    expect(restored.clips[0].frames[0].cels[restored.clips[0].layers[0].id].buffer[(1 * W + 1) * 4]).toBe(255);
    expect(restored.name).toBe('legacy-hero');
  });

  test('golden: prototype-realistic v1 document (one clip, per-frame stacks) imports cleanly', async () => {
    // Build a v1 doc the same way the web prototype's serializeProject would:
    // ONE clip whose frames each carry their own layer stack (v1 model).
    const p = createProject({ name: 'sample', width: 32, height: 32, fps: 8 });
    const clip = p.clips[0];
    clip.loop = false; // play-once → C3 maps to { loop: false, loopMode: 'forward' }
    const frame0 = await pngDataUrl(32, 32, (b) => px(b, 32, 0, 0, [20, 184, 166, 255]));
    const frame1 = await pngDataUrl(32, 32, (b) => px(b, 32, 1, 1, [244, 244, 244, 255]));
    const v1: V1SerializedProject = {
      version: 1,
      name: p.name,
      width: p.width,
      height: p.height,
      palette: [...p.palette],
      clips: [
        {
          id: clip.id,
          name: clip.name,
          fps: clip.fps,
          loop: clip.loop,
          frames: [
            {
              id: 'fr-g0',
              layers: [{ id: 'ly-g0', name: 'layer 1', visible: true, opacity: 1, png: frame0 }],
            },
            {
              id: 'fr-g1',
              layers: [{ id: 'ly-g1', name: 'layer 1', visible: true, opacity: 1, png: frame1 }],
            },
          ],
        },
      ],
    };
    const importer = new V1ProjectImporter();
    const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
    expect(project.clips.length).toBe(1);
    expect(project.clips[0].loop).toBe(false);
    expect(project.clips[0].loopMode).toBe('forward');
    expect(project.clips[0].frames.length).toBe(2);
    const layer = project.clips[0].layers[0];
    expect(layer.name).toBe('layer 1');
    expect(project.clips[0].frames[0].cels[layer.id].buffer[1]).toBe(184); // teal G channel
    expect(project.clips[0].frames[1].cels[layer.id].buffer[(1 * 32 + 1) * 4]).toBe(244);
    expect(warnings.length).toBe(1); // per-frame layer ids → matched by name (v1 model note)
    expect(warnings[0]).toContain('per-frame ids');
  });

  // -------------------------------------------------- Task 6 optional fields
  describe('Task 6 optional metadata (durationMs / loopMode / onion)', () => {
    test('durationMs, loopMode and onion range round-trip through the optional fields', async () => {
      const v1 = await makeV1(true);
      v1.clips[0].loopMode = 'pingpong';
      v1.clips[0].frames[0].durationMs = 250;
      v1.clips[0].frames[1].durationMs = 0; // explicit inherit → stays 0
      v1.settings = { onion: { prev: 3, next: 2 } };
      const importer = new V1ProjectImporter();
      const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
      // makeV1 itself yields the per-frame-ids note; no metadata warnings on top.
      expect(warnings.every((w) => !w.includes('durationMs') && !w.includes('loopMode') && !w.includes('onion'))).toBe(true);
      expect(project.clips[0].loopMode).toBe('pingpong');
      expect(project.clips[0].frames[0].durationMs).toBe(250);
      expect(project.clips[0].frames[1].durationMs).toBe(0);
      expect(project.settings.onion).toEqual({ prev: 3, next: 2 });
    });

    test('classic v1 documents (no optional fields) import exactly as before', async () => {
      const v1 = await makeV1(false);
      const importer = new V1ProjectImporter();
      const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
      expect(warnings.every((w) => !/durationMs|loopMode|onion/i.test(w))).toBe(true); // only legacy notes
      expect(project.clips[0].loopMode).toBe('forward');
      expect(project.clips[0].frames.map((f) => f.durationMs)).toEqual([0, 0]);
      expect(project.settings.onion).toEqual({ prev: 1, next: 0 });
    });

    test('invalid optional values fall back safely with warnings (never zero-length intervals)', async () => {
      const v1 = await makeV1(true);
      v1.clips[0].loopMode = 'spiral' as unknown as V1SerializedProject['clips'][number]['loopMode'];
      (v1.clips[0].frames[0] as { durationMs?: unknown }).durationMs = -50;
      (v1.clips[0].frames[1] as { durationMs?: unknown }).durationMs = 1.5;
      v1.settings = { onion: { prev: 9, next: -1 } };
      const importer = new V1ProjectImporter();
      const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
      expect(project.clips[0].loopMode).toBe('forward');
      expect(project.clips[0].frames.map((f) => f.durationMs)).toEqual([0, 0]);
      expect(project.settings.onion).toEqual({ prev: 1, next: 0 }); // all-invalid → untouched
      expect(warnings.some((w) => w.includes('unknown loopMode'))).toBe(true);
      expect(warnings.some((w) => w.includes('invalid durationMs'))).toBe(true);
      expect(warnings.some((w) => w.includes('onion'))).toBe(true);
    });
  });

  describe('Task 10 optional motion parts (v3.1 §4.1)', () => {
    test('well-formed parts round-trip with layer/anchor resolution', async () => {
      const v1 = await makeV1(true);
      v1.clips[0].parts = [
        { name: 'body', layerId: 'ly-a1', rect: { x: 0, y: 0, w: 4, h: 4 }, anchorFrameId: 'fr2', z: 0 },
        { name: 'head', layerId: 'ly-a1', rect: { x: 1, y: 1, w: 2, h: 2 }, z: 1 },
      ];
      const importer = new V1ProjectImporter();
      const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
      const clip = project.clips[0];
      expect(clip.parts.length).toBe(2);
      expect(clip.parts[0].name).toBe('body');
      expect(clip.parts[0].layerId).toBe('ly-a1');
      expect(clip.parts[0].rect).toEqual({ x: 0, y: 0, w: 4, h: 4 });
      expect(clip.parts[0].anchorFrameId).toBe('fr2'); // explicit anchor preserved
      expect(clip.parts[1].anchorFrameId).toBe('fr1'); // default = frame 1
      expect(clip.parts[1].z).toBe(1);
      expect(warnings.some((w) => w.includes('parts'))).toBe(false);
    });

    test('invalid parts warn and skip — never a half-usable composer state', async () => {
      const v1 = await makeV1(true);
      v1.clips[0].parts = [
        { name: 'body', layerId: 'ly-nope' }, // unknown layer
        { name: '', layerId: 'ly-a1' }, // empty name
        { name: 'body', layerId: 'ly-a1' }, // VALID — first admissible 'body' wins
        { name: 'legL', layerId: 'ly-a1', rect: { x: 30, y: 0, w: 4, h: 2 } }, // past the 32px canvas
        { name: 'armL', layerId: 'ly-a1', z: 3 }, // valid
      ];
      const importer = new V1ProjectImporter();
      const { project, warnings } = await importer.import(v1, pngDataUrlResolver);
      const clip = project.clips[0];
      expect(clip.parts.map((p) => p.name)).toEqual(['body', 'armL']);
      expect(warnings.some((w) => w.includes('layerId not found'))).toBe(true);
      expect(warnings.some((w) => w.includes('invalid name'))).toBe(true);
      expect(warnings.some((w) => w.includes('rect out of bounds'))).toBe(true);
    });

    test('classic v1 files without parts import unchanged (no parts field)', async () => {
      const v1 = await makeV1(true);
      const importer = new V1ProjectImporter();
      const { project } = await importer.import(v1, pngDataUrlResolver);
      expect(project.clips[0].parts).toEqual([]);
    });
  });
});
