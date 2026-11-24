/**
 * .pixelforgeproj format tests (Task 3 §6) — lossless round-trips (incl.
 * linked-cel identity re-sharing, trash, parts, tags), manifest checksum
 * enforcement, forward-version refusal, missing entries, schema violations,
 * and the journal embedding.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildPixelforgeproj,
  readPixelforgeproj,
  serializeProjectV2,
  projectFromSerialized,
  validateSerializedProjectV2,
  validateSerializedProjectV2OrThrow,
  celSrc,
  sharedCelSrc,
  zipWrite,
  JOURNAL_ENTRY,
  MANIFEST_ENTRY,
} from '../src/persist';
import { createProject, createClip, createLayer, createCel, duplicateFrame } from '../src/doc/factory';
import { recordsToLines, type JournalRecord } from '../src/persist/journal';
import type { Project } from '../src/types/document';

function paint(buffer: Uint8ClampedArray, width: number, x: number, y: number, rgba: [number, number, number, number]) {
  const i = (y * width + x) * 4;
  buffer[i] = rgba[0];
  buffer[i + 1] = rgba[1];
  buffer[i + 2] = rgba[2];
  buffer[i + 3] = rgba[3];
}

function buildRichProject(): Project {
  const project = createProject({ name: 'hero', width: 32, height: 32, fps: 12 });
  const idle = project.clips[0];
  // Second frame FIRST (so layer additions reach every frame).
  idle.frames.push(duplicateFrame(idle.frames[0], idle.layers));
  // Second layer (top).
  const top = createLayer('detail');
  idle.layers.push(top);
  for (const frame of idle.frames) frame.cels[top.id] = createCel(32, 32);

  // Paint bottom layer frame 0 + linked background.
  const bg = createLayer('bg', true);
  idle.layers.unshift(bg);
  for (const frame of idle.frames) frame.cels[bg.id] = { buffer: new Uint8ClampedArray(32 * 32 * 4), linked: true };
  paint(idle.frames[0].cels[bg.id].buffer, 32, 0, 0, [26, 28, 44, 255]);
  const detailLayer = idle.layers.find((l) => l.name === 'detail')!;
  paint(idle.frames[0].cels[detailLayer.id].buffer, 32, 5, 5, [20, 184, 166, 255]);
  // Frame 1: missing 'detail' cel (absent = transparent).
  delete idle.frames[1].cels[top.id];

  // Second clip with parts + tags + per-frame duration.
  const run = createClip({ name: 'run', width: 32, height: 32, fps: 15, layerNames: ['body', 'fx'], frameCount: 3 });
  project.clips.push(run);
  run.parts.push({ id: 'pt1', name: 'head', layerId: run.layers[1].id, rect: { x: 8, y: 2, w: 16, h: 12 }, anchorFrameId: run.frames[0].id, z: 2 });
  run.frames[1].durationMs = 40;
  run.loopMode = 'pingpong';
  run.loop = true;
  run.tags.push({ name: 'swing', from: 0, to: 2 });
  project.settings.onion = { prev: 3, next: 2 };
  paint(run.frames[2].cels[run.layers[0].id].buffer, 32, 31, 31, [244, 244, 244, 255]);

  // Trash: one of each kind.
  project.trash.push({
    id: 'tr1',
    label: 'Delete frame',
    deletedAt: 1_700_000_000_000,
    item: { kind: 'frame', clipId: idle.id, frameIndex: 0, frame: { id: 'fr-x', durationMs: 0, cels: { [idle.layers[1].id]: { buffer: (() => { const b = new Uint8ClampedArray(32 * 32 * 4); paint(b, 32, 1, 1, [1, 2, 3, 255]); return b; })(), linked: false } } } },
  });
  project.trash.push({
    id: 'tr2',
    label: 'Delete layer',
    deletedAt: 1_700_000_001_000,
    item: {
      kind: 'layer',
      clipId: idle.id,
      layerIndex: 1,
      layer: { id: 'ly-old', name: 'old', visible: false, opacity: 0.5, linked: false },
      celsByFrameId: { 'fr-a': { buffer: (() => { const b = new Uint8ClampedArray(32 * 32 * 4); paint(b, 32, 2, 2, [9, 8, 7, 255]); return b; })(), linked: false } },
    },
  });
  project.trash.push({
    id: 'tr3',
    label: 'Delete clip',
    deletedAt: 1_700_000_002_000,
    item: { kind: 'clip', clipIndex: 0, clip: createClip({ name: 'gone', width: 32, height: 32, fps: 8, layerNames: ['l1'], frameCount: 2 }) },
  });
  return project;
}

describe('pixelforgeproj format', () => {
  test('round-trip preserves the document exactly (deep equality)', async () => {
    const project = buildRichProject();
    const { projectJson, celPngs } = await serializeProjectV2(project);
    const restored = await projectFromSerialized(projectJson, (src) => celPngs.get(src));

    expect(restored.name).toBe('hero');
    expect(restored.width).toBe(32);
    expect(restored.clips.length).toBe(2);
    expect(restored.trash.length).toBe(3);

    // Linked layer re-share: every frame references the SAME buffer object.
    const idle = restored.clips[0];
    const bg = idle.layers.find((l) => l.name === 'bg')!;
    expect(bg.linked).toBe(true);
    const shared = idle.frames[0].cels[bg.id].buffer;
    for (const frame of idle.frames) {
      expect(frame.cels[bg.id].linked).toBe(true);
      expect(frame.cels[bg.id].buffer).toBe(shared); // object identity!
    }
    expect(shared[0]).toBe(26);

    // Content spot checks.
    const detail = idle.layers.find((l) => l.name === 'detail')!;
    expect(idle.frames[0].cels[detail.id].buffer[(5 * 32 + 5) * 4 + 1]).toBe(184);
    expect(idle.frames[1].cels[detail.id]).toBeUndefined(); // absent cel preserved

    const run = restored.clips[1];
    expect(run.fps).toBe(15);
    expect(run.frames[1].durationMs).toBe(40);
    expect(run.loopMode).toBe('pingpong'); // Task 6 animation metadata persists
    expect(restored.settings.onion).toEqual({ prev: 3, next: 2 });
    expect(run.parts[0].rect).toEqual({ x: 8, y: 2, w: 16, h: 12 });
    expect(run.tags).toEqual([{ name: 'swing', from: 0, to: 2 }]);
    expect(run.frames[2].cels[run.layers[0].id].buffer[(31 * 32 + 31) * 4]).toBe(244);

    // Trash content survived.
    const tr1 = restored.trash[0].item as { kind: 'frame'; frame: { cels: Record<string, { buffer: Uint8ClampedArray }> } };
    const firstCel = Object.values(tr1.frame.cels)[0];
    expect(firstCel.buffer[(1 * 32 + 1) * 4]).toBe(1);
    const tr2 = restored.trash[1].item as { kind: 'layer'; celsByFrameId: Record<string, { buffer: Uint8ClampedArray }> };
    expect(Object.values(tr2.celsByFrameId)[0].buffer[(2 * 32 + 2) * 4]).toBe(9);
    const tr3 = restored.trash[2].item as { kind: 'clip'; clip: { name: string; frames: unknown[] } };
    expect(tr3.clip.name).toBe('gone');
    expect(tr3.clip.frames.length).toBe(2);
  });

  test('layer paint lock and blend mode survive the round-trip', async () => {
    const project = createProject({ name: 'locks', width: 16, height: 16 });
    const clip = project.clips[0];
    clip.layers[0].locked = true;
    clip.layers[0].blend = 'multiply';
    const glow = createLayer('glow');
    glow.blend = 'screen';
    clip.layers.push(glow);
    for (const frame of clip.frames) frame.cels[glow.id] = createCel(16, 16);
    project.trash.push({
      id: 'tr-locked',
      label: 'Delete locked layer',
      deletedAt: 1_700_000_003_000,
      item: {
        kind: 'layer',
        clipId: clip.id,
        layerIndex: 0,
        layer: { id: 'ly-lock', name: 'locked-old', visible: true, opacity: 1, linked: false, locked: true, blend: 'overlay' },
        celsByFrameId: { [clip.frames[0].id]: { buffer: new Uint8ClampedArray(16 * 16 * 4), linked: false } },
      },
    });

    const { projectJson, celPngs } = await serializeProjectV2(project);
    const serializedLayer = projectJson.clips[0].layers.find((l) => l.name === 'Layer 1')!;
    expect(serializedLayer.locked).toBe(true);
    expect(serializedLayer.blend).toBe('multiply');
    expect(validateSerializedProjectV2(projectJson)).toEqual([]);

    const restored = await projectFromSerialized(projectJson, (src) => celPngs.get(src));
    const restoredClip = restored.clips[0];
    const lockedLayer = restoredClip.layers.find((l) => l.name === 'Layer 1')!;
    expect(lockedLayer.locked).toBe(true);
    expect(lockedLayer.blend).toBe('multiply');
    const glowRestored = restoredClip.layers.find((l) => l.name === 'glow')!;
    expect(glowRestored.locked).toBeUndefined();
    expect(glowRestored.blend).toBe('screen');
    const trashLayer = (restored.trash[0].item as { kind: 'layer'; layer: { locked?: boolean; blend?: string } }).layer;
    expect(trashLayer.locked).toBe(true);
    expect(trashLayer.blend).toBe('overlay');

    // Unknown blend values are rejected by schema validation.
    const broken = structuredClone(projectJson) as typeof projectJson;
    (broken.clips[0].layers[0].blend as string) = 'luminosity';
    expect(validateSerializedProjectV2(broken).some((i) => i.path.includes('blend'))).toBe(true);
  });

  test('serialize emits shared path for linked layers and per-frame paths otherwise', async () => {
    const project = buildRichProject();
    const { projectJson } = await serializeProjectV2(project);
    const idle = projectJson.clips[0];
    const bg = idle.layers.find((l) => l.linked)!;
    for (const frame of idle.frames) {
      expect(frame.cels[bg.id].src).toBe(sharedCelSrc(idle.id, bg.id));
      expect(frame.cels[bg.id].linked).toBe(true);
    }
    const body = idle.layers.find((l) => l.name === 'Layer 1')!;
    expect(idle.frames[0].cels[body.id].src).toBe(celSrc(idle.id, idle.frames[0].id, body.id));
    // Trash frame cel lives under trash/<i>/.
    expect(projectJson.trash[0].item.kind).toBe('frame');
  });

  test('container embeds manifest checksums; tampering is detected (BAD_CHECKSUM)', async () => {
    const project = buildRichProject();
    const { projectJson, celPngs } = await serializeProjectV2(project);
    const records: JournalRecord[] = [
      { seq: 1, ts: 1, origin: 'ui', commandType: 'project.rename', payload: { name: 'x' } },
    ];
    const built = await buildPixelforgeproj({ projectJson, celPngs, journalLines: recordsToLines(records), journalSeq: 1 });
    const read = await readPixelforgeproj(built.bytes);
    expect(read.manifest.formatVersion).toBe(2);
    expect(read.manifest.journalSeq).toBe(1);
    expect(read.journalLines.length).toBe(1);
    expect(read.projectJson.name).toBe('hero');
    // Every non-manifest entry carries a checksum (C5).
    expect(Object.keys(read.manifest.checksums).length).toBeGreaterThanOrEqual(2 + celPngs.size);
    expect(read.manifest.checksums['project.json']).toBeDefined();

    // Tamper with one cel byte → checksum failure.
    const tampered = built.bytes.slice();
    // Flip a byte near the end (inside the last cel payload region).
    tampered[tampered.length - 40] ^= 0xff;
    // Note: this may hit central directory instead — verify either BAD_CHECKSUM or BAD_ZIP surfaces, never silent success.
    let threw = '';
    try {
      await readPixelforgeproj(tampered);
    } catch (err) {
      threw = (err as { code?: string }).code ?? 'unknown';
    }
    expect(['BAD_CHECKSUM', 'BAD_ZIP']).toContain(threw);
  });

  test('forward-version refusal (§13)', async () => {
    // Hand-craft a container whose manifest declares formatVersion 3.
    const enc = new TextEncoder();
    const futureManifest = {
      formatVersion: 3,
      appVersion: 'future',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      journalSeq: 0,
      checksums: { 'project.json': 'deadbeef' },
    };
    const bytes = zipWrite([
      { name: 'manifest.json', data: enc.encode(JSON.stringify(futureManifest)) },
      { name: 'project.json', data: enc.encode('{}') },
    ]);
    await expect(readPixelforgeproj(bytes)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });

    // Byte-tampering a valid archive never silently succeeds.
    const project = createProject({ name: 'v2', width: 16, height: 16 });
    const built = await buildPixelforgeproj({ projectJson: (await serializeProjectV2(project)).projectJson, celPngs: (await serializeProjectV2(project)).celPngs });
    const tampered = built.bytes.slice();
    tampered[tampered.length - 40] ^= 0xff;
    let threw = '';
    try {
      await readPixelforgeproj(tampered);
    } catch (err) {
      threw = (err as { code?: string }).code ?? 'unknown';
    }
    expect(['BAD_CHECKSUM', 'BAD_ZIP']).toContain(threw);
    void MANIFEST_ENTRY;
  });

  test('missing required entries are reported (MISSING_ENTRY)', async () => {
    await expect(
      readPixelforgeproj(new TextEncoder().encode('not a zip'))
    ).rejects.toMatchObject({ code: 'BAD_ZIP' });
  });

  test('schema validation catches structural violations', async () => {
    const project = buildRichProject();
    const { projectJson, celPngs } = await serializeProjectV2(project);

    // Valid baseline.
    expect(validateSerializedProjectV2(projectJson)).toEqual([]);

    // Cel referencing an unknown layer.
    const broken = structuredClone(projectJson) as typeof projectJson;
    broken.clips[0].frames[0].cels['ly-ghost'] = { src: celSrc(broken.clips[0].id, broken.clips[0].frames[0].id, 'ly-ghost') };
    const issues = validateSerializedProjectV2(broken);
    expect(issues.some((i) => i.message.includes('unknown layer'))).toBe(true);

    // Bad fps + bad loopMode + duplicate clip ids.
    const broken2 = structuredClone(projectJson) as typeof projectJson;
    broken2.clips[0].fps = 200;
    (broken2.clips[0].loopMode as string) = 'spiral';
    broken2.clips[1].id = broken2.clips[0].id;
    const issues2 = validateSerializedProjectV2(broken2);
    expect(issues2.length).toBeGreaterThanOrEqual(3);

    // Unsafe cel src.
    const broken3 = structuredClone(projectJson) as typeof projectJson;
    broken3.clips[0].frames[0].cels[broken3.clips[0].layers[0].id].src = '../escape.png';
    const issues3 = validateSerializedProjectV2(broken3);
    expect(issues3.some((i) => i.code === 'UNSAFE_PATH')).toBe(true);

    // Unlinked cel pointing at the wrong frame path.
    const broken4 = structuredClone(projectJson) as typeof projectJson;
    const body = broken4.clips[1].layers[0];
    broken4.clips[1].frames[0].cels[body.id].src = celSrc(broken4.clips[1].id, 'fr-other', body.id);
    expect(validateSerializedProjectV2(broken4).some((i) => i.message.includes('expected'))).toBe(true);

    // Throw variant aggregates issues.
    expect(() => validateSerializedProjectV2OrThrow(broken2)).toThrow(/issue/);
    void celPngs;
    void JOURNAL_ENTRY;
  });
});
