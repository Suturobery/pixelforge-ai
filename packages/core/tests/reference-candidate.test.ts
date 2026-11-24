/**
 * Create-from-Reference regression tests (offline, deterministic).
 *
 * Covers: mock provider determinism, the candidate pipeline (decode →
 * normalize-v2 → checks) on both target sizes, palette enforcement, the
 * extended StyleProfile contract (cameraAngle + embedded-PNG references),
 * and the prompt contract. No network anywhere — the mock provider is the
 * test provider.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_PALETTE, createProject, CommandBus, decodePng } from '../src/index';
import type { Clip, Project } from '../src/types/document';
import { parseStyleProfile, defaultStyleProfile, type StyleProfile } from '../src/style-profile';
import {
  buildReferenceCandidate,
  buildReferencePrompt,
} from '../src/ai/reference-candidate';
import { hashBrief, renderMockReferenceCandidate } from '../src/ai/reference-mock';

/** 8×8 solid-shape reference (a "potion"): opaque center, transparent ring. */
function potionReference(): { buffer: Uint8ClampedArray; width: number; height: number } {
  const w = 8;
  const h = 8;
  const buf = new Uint8ClampedArray(w * h * 4);
  const paletteHex = ['#3b5dc9', '#41a6f6', '#f4f4f4'];
  // rows 2..5, cols 2..5 body; row 1 cork
  const put = (x: number, y: number, hex: string) => {
    const i = (y * w + x) * 4;
    buf[i] = parseInt(hex.slice(1, 3), 16);
    buf[i + 1] = parseInt(hex.slice(3, 5), 16);
    buf[i + 2] = parseInt(hex.slice(5, 7), 16);
    buf[i + 3] = 255;
  };
  put(3, 1, '#5d275d');
  put(4, 1, '#5d275d');
  for (let y = 2; y <= 5; y++) {
    for (let x = 2; x <= 5; x++) {
      put(x, y, y >= 3 ? paletteHex[0] : paletteHex[2]);
    }
  }
  put(2, 3, paletteHex[1]);
  put(2, 4, paletteHex[1]);
  return { buffer: buf, width: w, height: h };
}

const PROFILE: StyleProfile = {
  ...defaultStyleProfile(),
  artDirection: 'cozy RPG items, chunky shapes',
};

function pipelineInput(png: Uint8Array, targetSize: number, profile = PROFILE) {
  return {
    brief: 'a brass key',
    providerId: 'mock',
    model: 'deterministic-mock-1',
    providerPng: png,
    reference: potionReference(),
    palette: DEFAULT_PALETTE,
    profile,
    targetSize,
  };
}

describe('reference mock provider (deterministic test provider)', () => {
  test('same brief + reference ⇒ byte-identical PNG; different brief ⇒ differs', async () => {
    const ref = potionReference();
    const a = await renderMockReferenceCandidate(ref, DEFAULT_PALETTE, 'a brass key');
    const b = await renderMockReferenceCandidate(ref, DEFAULT_PALETTE, 'a brass key');
    const c = await renderMockReferenceCandidate(ref, DEFAULT_PALETTE, 'a mushroom');
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(hashBrief('a brass key')).toBe(hashBrief('a brass key'));
    expect(hashBrief('a brass key')).not.toBe(hashBrief('a brass keyy'));
  });

  test('output is a decodable PNG on an off-palette backdrop', async () => {
    const png = await renderMockReferenceCandidate(potionReference(), DEFAULT_PALETTE, 'a coin');
    const img = await decodePng(png);
    expect(img.width).toBe(16); // 8×8 reference on a 2× backdrop
    expect(img.height).toBe(16);
    // backdrop color present (the pipeline must remove it)
    expect(img.rgba[0]).toBe(0xbc);
    expect(img.rgba[1]).toBe(0xde);
    expect(img.rgba[2]).toBe(0xf0);
    expect(img.rgba[3]).toBe(255);
  });
});

describe('reference candidate pipeline', () => {
  test('32×32: cleans, maps to the project palette, binary alpha, checks pass', async () => {
    const png = await renderMockReferenceCandidate(potionReference(), DEFAULT_PALETTE, 'a brass key');
    const candidate = await buildReferenceCandidate(pipelineInput(png, 32));
    expect(candidate.cleaned.width).toBe(32);
    expect(candidate.cleaned.height).toBe(32);
    expect(candidate.original.width).toBe(16);
    expect(candidate.stats.paletteUsed).toBe('project');
    expect(candidate.stats.bgRemoved).toBeGreaterThan(0);
    const members = new Set(DEFAULT_PALETTE.map((c) => c.toLowerCase()));
    let semi = 0;
    for (let i = 0; i < candidate.cleaned.buffer.length; i += 4) {
      const a = candidate.cleaned.buffer[i + 3];
      if (a !== 0 && a !== 255) semi++;
      if (a === 255) {
        const hex = '#'.concat(
          candidate.cleaned.buffer[i].toString(16).padStart(2, '0'),
          candidate.cleaned.buffer[i + 1].toString(16).padStart(2, '0'),
          candidate.cleaned.buffer[i + 2].toString(16).padStart(2, '0'),
        );
        expect(members.has(hex)).toBe(true);
      }
    }
    expect(semi).toBe(0);
    expect(candidate.checks.find((c) => c.id === 'palette')?.status).toBe('pass');
    expect(candidate.checks.find((c) => c.id === 'alpha')?.status).toBe('pass');
    expect(candidate.prompt).toContain('a brass key');
    expect(candidate.prompt).toContain('camera angle: side view');
  });

  test('16×16 target downsizes the reference-derived candidate', async () => {
    const png = await renderMockReferenceCandidate(potionReference(), DEFAULT_PALETTE, 'a coin');
    const candidate = await buildReferenceCandidate(pipelineInput(png, 16));
    expect(candidate.cleaned.width).toBe(16);
    expect(candidate.cleaned.height).toBe(16);
    let opaque = 0;
    for (let i = 3; i < candidate.cleaned.buffer.length; i += 4) if (candidate.cleaned.buffer[i] === 255) opaque++;
    expect(opaque).toBeGreaterThan(0);
  });

  test('non-16/32 targets are rejected', async () => {
    const png = await renderMockReferenceCandidate(potionReference(), DEFAULT_PALETTE, 'a key');
    await expect(buildReferenceCandidate(pipelineInput(png, 48))).rejects.toThrow(/16 or 32/);
  });
});

describe('style profile: cameraAngle + embedded reference', () => {
  test('cameraAngle round-trips through parse and lands in prompt tags', () => {
    const profile: StyleProfile = { ...defaultStyleProfile(), cameraAngle: '3/4 view' };
    const parsed = parseStyleProfile(profile);
    expect(parsed?.cameraAngle).toBe('3/4 view');
    expect(buildReferencePrompt('a key', parsed as StyleProfile, 32)).toContain('camera angle: 3/4 view');
    expect(parseStyleProfile({ ...profile, cameraAngle: 'from below' })).toBeNull();
  });

  test('embedded-PNG reference round-trips; invalid payloads are rejected', () => {
    const base = { ...defaultStyleProfile() };
    const good = parseStyleProfile({
      ...base,
      references: [{ clipId: '', frameId: '', label: 'potion', pngBase64: 'aGVsbG8=', width: 32, height: 32 }],
    });
    expect(good?.references?.[0]).toMatchObject({ clipId: '', width: 32, height: 32, pngBase64: 'aGVsbG8=' });
    expect(
      parseStyleProfile({ ...base, references: [{ clipId: '', frameId: '', label: 'x', pngBase64: '!!!', width: 32, height: 32 }] }),
    ).toBeNull();
    expect(
      parseStyleProfile({ ...base, references: [{ clipId: '', frameId: '', label: 'x', pngBase64: 'aGVsbG8=', width: 24, height: 24 }] }),
    ).toBeNull();
    expect(
      parseStyleProfile({ ...base, references: [{ clipId: '', frameId: '', label: 'x', pngBase64: 'aGVsbG8='.repeat(4000), width: 32, height: 32 }] }),
    ).toBeNull();
    // frame-pointer references keep the strict id rules
    expect(parseStyleProfile({ ...base, references: [{ clipId: 'cl_1', frameId: 'fr_1', label: 'ok' }] })).not.toBeNull();
    expect(parseStyleProfile({ ...base, references: [{ clipId: '', frameId: '', label: 'no payload' }] })).toBeNull();
  });

  test('project save/load round-trip keeps the cameraAngle + embedded reference', async () => {
    const bus = new CommandBus(createProject({ name: 'ref-rt', width: 32, height: 32, palette: DEFAULT_PALETTE }));
    const profile = parseStyleProfile({
      ...defaultStyleProfile(),
      cameraAngle: 'front',
      references: [{ clipId: '', frameId: '', label: 'potion', pngBase64: 'aGVsbG8=', width: 32, height: 32 }],
    }) as StyleProfile;
    bus.execute('settings.setStyleProfile', { profile }, 'ui');
    const stored = bus.getProject().settings.styleProfile as StyleProfile;
    expect(stored.cameraAngle).toBe('front');
    expect(stored.references[0].pngBase64).toBe('aGVsbG8=');
  });
});

describe('reference candidate → canvas (undoable layer add)', () => {
  test('cleaned candidate lands as an editable layer; undo restores the document', async () => {
    const project: Project = createProject({ name: 'ref-flow', width: 32, height: 32, palette: DEFAULT_PALETTE });
    const bus = new CommandBus(project);
    const baseClip = bus.getProject().clips[0] as Clip;
    const baseLayerId = baseClip.layers[0].id;
    const baseFrameId = baseClip.frames[0].id;
    // Paint existing artwork on the base layer that must survive
    const existing = new Uint8ClampedArray(32 * 32 * 4);
    existing[0] = 255;
    existing[3] = 255;
    bus.execute(
      'pixels.applyOp',
      { clipId: baseClip.id, frameId: baseFrameId, layerId: baseLayerId, ops: [{ op: 'setBuffer', buffer: existing }] },
      'ui',
    );
    const png = await renderMockReferenceCandidate(potionReference(), DEFAULT_PALETTE, 'a brass key');
    const candidate = await buildReferenceCandidate(pipelineInput(png, 32));
    const undoDepthBefore = bus.historyStats().undoDepth;
    // same path the panel takes: one transaction (layer.add + setBuffer)
    bus.transaction('Add candidate: a brass key', 'ui', () => {
      bus.execute('layer.add', { clipId: baseClip.id, name: 'brass-key' }, 'ui');
      const layerId = bus.getProject().clips.find((c) => c.id === baseClip.id)!.layers.at(-1)!.id;
      const frameId = bus.getProject().clips.find((c) => c.id === baseClip.id)!.frames[0].id;
      bus.execute(
        'pixels.applyOp',
        { clipId: baseClip.id, frameId, layerId, ops: [{ op: 'setBuffer', buffer: candidate.cleaned.buffer }] },
        'ui',
      );
    });
    expect(bus.historyStats().undoDepth).toBe(undoDepthBefore + 1);
    const clip = bus.getProject().clips.find((c) => c.id === baseClip.id) as Clip;
    expect(clip.layers.map((l) => l.name)).toEqual(['Layer 1', 'brass-key']);
    // source artwork preserved: the base layer still has pixels
    expect(clip.frames[0].cels[baseLayerId].buffer.some((v) => v !== 0)).toBe(true);
    expect(bus.undo().ok).toBe(true);
    expect(bus.getProject().clips.find((c) => c.id === baseClip.id)!.layers.length).toBe(1);
    expect(bus.getProject().clips.find((c) => c.id === baseClip.id)!.layers.at(-1)!.name).toBe('Layer 1');
    expect(bus.redo().ok).toBe(true);
    expect(bus.getProject().clips.find((c) => c.id === baseClip.id)!.layers.length).toBe(2);
  });
});
