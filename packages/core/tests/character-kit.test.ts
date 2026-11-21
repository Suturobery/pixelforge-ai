/**
 * Character kit regression tests (Create Character feature).
 *
 * Covers the three guarantees the feature rests on:
 *   1. deterministic kit output (same kit version + selection + palette ⇒
 *      identical pixels; palette-membership + binary alpha + foot baseline);
 *   2. atomic insertion through the CommandBus (one undoable transaction,
 *      failed inserts leave the document intact, undo/redo round-trips);
 *   3. project round-trip (layers, parts, style settings, animations survive
 *      save → reload of a .pixelforgeproj).
 *
 * The kit lives in src/lib/pixelforge (app layer) but is dependency-free
 * TypeScript; tests import it by relative path.
 */

import { describe, expect, test } from 'bun:test';
import { CommandBus } from '../src/bus/bus';
import { DEFAULT_PALETTE, createProject } from '../src/doc/factory';
import { planMotion } from '../src/motion/composer';
import { loadPixelforgeproj, savePixelforgeproj } from '../src/persist/store';
import { MemoryFs } from '../src/persist/memory-fs';
import type { Clip, Project } from '../src/types/document';
import {
  CHARACTER_KIT_VERSION,
  KIT_CANVAS,
  KIT_FOOT_BASELINE_Y,
  KIT_LAYERS,
  KIT_PRESETS,
  composeKitBuffers,
  composeKitPreviewRgba,
  kitSelectionFromPreset,
  matchKitCharacter,
  validateKitSelection,
  type KitSelection,
} from '../src/character/kit';
import { insertCharacter } from '../src/character/insert';

function opaquePixels(buffer: Uint8ClampedArray): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < KIT_CANVAS; y++) {
    for (let x = 0; x < KIT_CANVAS; x++) {
      if (buffer[(y * KIT_CANVAS + x) * 4 + 3] !== 0) out.push({ x, y });
    }
  }
  return out;
}

function buffersEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const KNIGHT: KitSelection = { headId: 'mushroom-cap', outfitId: 'knight-armor', itemId: 'sword' };

// ---------------------------------------------------------------------------
// 1 · deterministic kit output
// ---------------------------------------------------------------------------

describe('character kit output', () => {
  test('same selection + palette compose byte-identical buffers', () => {
    const a = composeKitPreviewRgba(KNIGHT, DEFAULT_PALETTE);
    const b = composeKitPreviewRgba(KNIGHT, DEFAULT_PALETTE);
    expect(buffersEqual(a, b)).toBe(true);
    expect(CHARACTER_KIT_VERSION).toBe('kit-1');
  });

  test('every preset selection composes with opaque content on all four layers', () => {
    for (const preset of KIT_PRESETS) {
      const sel = kitSelectionFromPreset(preset.id);
      expect(sel).not.toBeNull();
      const buffers = composeKitBuffers(sel as KitSelection, DEFAULT_PALETTE);
      for (const [, buffer] of Object.entries(buffers)) {
        expect(opaquePixels(buffer).length).toBeGreaterThan(0);
      }
    }
  });

  test('all opaque pixels are members of the active palette (binary alpha)', () => {
    const palette = DEFAULT_PALETTE;
    const rgba = composeKitPreviewRgba(KNIGHT, palette);
    const members = new Set(palette.map((hex) => hex.toLowerCase()));
    let semiTransparent = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a !== 0 && a !== 255) semiTransparent++;
      if (a === 255) {
        const hex = `#${rgba[i].toString(16).padStart(2, '0')}${rgba[i + 1].toString(16).padStart(2, '0')}${rgba[i + 2]
          .toString(16)
          .padStart(2, '0')}`;
        expect(members.has(hex)).toBe(true);
      }
    }
    expect(semiTransparent).toBe(0);
  });

  test('custom palettes snap kit colors deterministically onto the project palette', () => {
    const custom = ['#000000', '#ffffff', '#7f7f7f', '#101010', '#202020', '#c0c0c0', '#404040', '#808080',
      '#909090', '#a0a0a0', '#b0b0b0', '#d0d0d0', '#e0e0e0', '#f0f0f0', '#303030', '#505050'];
    const a = composeKitPreviewRgba(KNIGHT, custom);
    const b = composeKitPreviewRgba(KNIGHT, custom);
    expect(buffersEqual(a, b)).toBe(true);
    const members = new Set(custom);
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] === 255) {
        const hex = `#${a[i].toString(16).padStart(2, '0')}${a[i + 1].toString(16).padStart(2, '0')}${a[i + 2]
          .toString(16)
          .padStart(2, '0')}`;
        expect(members.has(hex)).toBe(true);
      }
    }
  });

  test('foot baseline: feet on row 30, row 31 fully transparent (style margin)', () => {
    for (const preset of KIT_PRESETS) {
      const rgba = composeKitPreviewRgba(kitSelectionFromPreset(preset.id) as KitSelection, DEFAULT_PALETTE);
      let baselinePixels = 0;
      for (let x = 0; x < KIT_CANVAS; x++) {
        if (rgba[(KIT_FOOT_BASELINE_Y * KIT_CANVAS + x) * 4 + 3] === 255) baselinePixels++;
        expect(rgba[((KIT_FOOT_BASELINE_Y + 1) * KIT_CANVAS + x) * 4 + 3]).toBe(0);
        expect(rgba[x * 4 + 3]).toBe(0); // top margin
        expect(rgba[(x * KIT_CANVAS) * 4 + 3]).toBe(0); // left margin
        expect(rgba[(x * KIT_CANVAS + KIT_CANVAS - 1) * 4 + 3]).toBe(0); // right margin
      }
      expect(baselinePixels).toBeGreaterThan(0);
    }
  });

  test('the three presets have distinct silhouettes', () => {
    const hashes = KIT_PRESETS.map((p) => {
      const rgba = composeKitPreviewRgba(kitSelectionFromPreset(p.id) as KitSelection, DEFAULT_PALETTE);
      let h = 0;
      for (const v of rgba) h = (h * 31 + v) | 0;
      return h;
    });
    expect(new Set(hashes).size).toBe(KIT_PRESETS.length);
  });

  test('motion part rects cover every opaque pixel of their body regions', () => {
    const buffers = composeKitBuffers(KNIGHT, DEFAULT_PALETTE);
    const rects = KIT_LAYERS[0].parts.map((p) => p.rect as { x: number; y: number; w: number; h: number });
    for (const { x, y } of opaquePixels(buffers.body)) {
      const covered = rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
      expect(covered).toBe(true);
    }
  });

  test('invalid selections throw with the supported list', () => {
    expect(() => validateKitSelection({ headId: 'wizard-hat', outfitId: 'knight-armor', itemId: 'sword' })).toThrow(/wizard-hat/);
    expect(() => composeKitPreviewRgba({ headId: 'wizard-hat', outfitId: 'knight-armor', itemId: 'sword' }, DEFAULT_PALETTE)).toThrow();
  });
});

describe('kit brief matching (Second Brain)', () => {
  test('matches bundled characters incl. common typos', () => {
    expect(matchKitCharacter('32×32 mushroom knight')).toEqual({ kind: 'match', presetId: 'mushroom-knight', label: 'Mushroom Knight' });
    expect(matchKitCharacter('make knigth walk no bg')).toEqual({ kind: 'match', presetId: 'mushroom-knight', label: 'Mushroom Knight' });
    expect(matchKitCharacter('a farmer with a straw hat')).toMatchObject({ kind: 'match', presetId: 'farmer' });
    expect(matchKitCharacter('castle gaurd sprite')).toMatchObject({ kind: 'match', presetId: 'guard' });
  });

  test('unsupported characters do not match', () => {
    expect(matchKitCharacter('32×32 wizard with a staff')).toEqual({ kind: 'none' });
    expect(matchKitCharacter('')).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// 2 · atomic insertion + undo
// ---------------------------------------------------------------------------

function freshBus(): { bus: CommandBus; project: Project } {
  const project = createProject({ name: 'kit-test', width: 32, height: 32, palette: DEFAULT_PALETTE });
  return { bus: new CommandBus(project), project };
}

describe('character insertion', () => {
  test('inserts one clip with 4 named layers, 6 motion parts, painted frame — one undoable step', () => {
    const { bus } = freshBus();
    const before = bus.getProject();
    const { clipId, layerIds } = insertCharacter(bus, KNIGHT, { clipName: 'Mushroom Knight' });

    const after = bus.getProject();
    expect(after.clips.length).toBe(before.clips.length + 1);
    const clip = after.clips.find((c) => c.id === clipId) as Clip;
    expect(clip.name).toBe('Mushroom Knight');
    expect(clip.layers.map((l) => l.name)).toEqual(['Body', 'Outfit', 'Head', 'Item']);
    expect(Object.keys(layerIds)).toEqual(['body', 'outfit', 'head', 'item']);
    expect(clip.parts.map((p) => p.name).sort()).toEqual(['armL', 'armR', 'body', 'head', 'legL', 'legR'].sort());
    // frame 1 cels painted (opaque pixels on each layer)
    for (const spec of KIT_LAYERS) {
      const cel = clip.frames[0].cels[layerIds[spec.grid]];
      expect(cel).toBeDefined();
      expect(opaquePixels(cel.buffer).length).toBeGreaterThan(0);
    }
    // exactly ONE undo entry
    expect(bus.canUndo()).toBe(true);
    expect(bus.historyStats().undoDepth).toBe(1);
    // undo removes the clip, redo restores it exactly
    expect(bus.undo().ok).toBe(true);
    expect(bus.getProject().clips.length).toBe(before.clips.length);
    expect(bus.getProject().clips.find((c) => c.id === clipId)).toBeUndefined();
    expect(bus.redo().ok).toBe(true);
    expect(bus.getProject().clips.find((c) => c.id === clipId)).toBeDefined();
  });

  test('insertion pixels match the kit preview exactly', () => {
    const { bus } = freshBus();
    const { clipId, layerIds } = insertCharacter(bus, KNIGHT, {});
    const clip = bus.getProject().clips.find((c) => c.id === clipId) as Clip;
    const buffers = composeKitBuffers(KNIGHT, DEFAULT_PALETTE);
    expect(buffersEqual(clip.frames[0].cels[layerIds.body].buffer, buffers.body)).toBe(true);
    expect(buffersEqual(clip.frames[0].cels[layerIds.outfit].buffer, buffers.outfit)).toBe(true);
    expect(buffersEqual(clip.frames[0].cels[layerIds.head].buffer, buffers.head)).toBe(true);
    expect(buffersEqual(clip.frames[0].cels[layerIds.item].buffer, buffers.item)).toBe(true);
  });

  test('failed insertion leaves the document intact', () => {
    const { bus } = freshBus();
    const before = bus.getProject();
    expect(() => insertCharacter(bus, { headId: 'wizard-hat', outfitId: 'knight-armor', itemId: 'sword' }, {})).toThrow();
    expect(bus.getProject()).toBe(before);
    expect(bus.canUndo()).toBe(false);

    const big = createProject({ name: 'big', width: 48, height: 48, palette: DEFAULT_PALETTE });
    const bigBus = new CommandBus(big);
    const bigBefore = bigBus.getProject();
    expect(() => insertCharacter(bigBus, KNIGHT, {})).toThrow(/32×32/);
    expect(bigBus.getProject()).toBe(bigBefore);
    expect(bigBus.canUndo()).toBe(false);
  });

  test('idle and walk resolve every kit part through the motion composer', () => {
    const { bus } = freshBus();
    const { clipId } = insertCharacter(bus, KNIGHT, {});
    const clip = bus.getProject().clips.find((c) => c.id === clipId) as Clip;

    const idle = planMotion(bus.getProject(), clip, { preset: 'idle', params: { frameCount: 4 } });
    // only `hair` is absent from the kit rig (the cap rides the head part)
    expect(idle.report.skipped.map((s) => s.role)).toEqual(['hair']);
    expect(idle.report.moved.map((m) => m.role).sort()).toEqual(['body', 'head']);
    // idle bob actually moves pixels
    expect(buffersEqual(idle.frames[0].cels[clip.layers[1].id], idle.frames[2].cels[clip.layers[1].id])).toBe(false);

    const walk = planMotion(bus.getProject(), clip, { preset: 'walk', params: { frameCount: 4 } });
    expect(walk.report.skipped).toEqual([]);
    expect(walk.report.moved.map((m) => m.role).sort()).toEqual(['armL', 'armR', 'body', 'head', 'legL', 'legR']);
    // attachments ride their parts: the item layer (armR) shifts ±3 during walk
    const itemLayer = clip.layers[3].id;
    expect(walk.frames[0].cels[itemLayer]).toBeDefined();
    expect(buffersEqual(walk.frames[0].cels[itemLayer], walk.frames[2].cels[itemLayer])).toBe(false);
    // grounded contact: frame 1 keeps the foot baseline row (no vertical drift of legs)
    const legs1 = walk.frames[0].cels[clip.layers[0].id];
    expect(opaquePixels(legs1).some(({ x, y }) => y === KIT_FOOT_BASELINE_Y)).toBe(true);
    // the kit is drawn to fit the walk swing — nothing clips at the canvas edges
    // (run's ×1.5 amplitude may clip at R4 edges by design — info-level, not
    // one of the two presets this feature wires)
    expect(walk.report.clippedPixels).toBe(0);
    const run = planMotion(bus.getProject(), clip, { preset: 'run', params: { frameCount: 6 } });
    expect(run.report.moved.map((m) => m.role).sort()).toEqual(['armL', 'armR', 'body', 'head', 'legL', 'legR']);
  });
});

// ---------------------------------------------------------------------------
// 3 · project round-trip
// ---------------------------------------------------------------------------

describe('character project round-trip', () => {
  test('save → reload preserves layers, parts, style settings, and animation frames', async () => {
    const { bus } = freshBus();
    const styleProfile = {
      ...bus.getProject().settings.styleProfile!,
      name: 'Kit style',
      lighting: 'top' as const,
      references: [],
    };
    bus.execute('settings.setStyleProfile', { profile: styleProfile }, 'ui');
    const { clipId } = insertCharacter(bus, KNIGHT, { clipName: 'Mushroom Knight' });
    const walk = planMotion(bus.getProject(), bus.getProject().clips.find((c) => c.id === clipId)!, {
      preset: 'walk',
      params: { frameCount: 4 },
    });
    bus.execute(
      'motion.apply',
      {
        sourceClipId: clipId,
        preset: 'walk',
        params: { frameCount: 4, gapFill: 'edge-extend' },
        target: { kind: 'new', name: 'walk', fps: 8 },
      },
      'ui',
    );

    const fs = new MemoryFs();
    await savePixelforgeproj(fs, '/kit.pixelforgeproj', bus.getProject(), { noBackup: true });
    const loaded = await loadPixelforgeproj(fs, '/kit.pixelforgeproj');

    expect(loaded.project.name).toBe('kit-test');
    const source = loaded.project.clips.find((c) => c.id === clipId);
    expect(source).toBeDefined();
    expect(source?.layers.map((l) => l.name)).toEqual(['Body', 'Outfit', 'Head', 'Item']);
    expect(source?.parts.map((p) => p.name).sort()).toEqual(['armL', 'armR', 'body', 'head', 'legL', 'legR'].sort());
    expect(loaded.project.settings.styleProfile?.name).toBe('Kit style');
    expect(loaded.project.settings.styleProfile?.lighting).toBe('top');
    const walkClip = loaded.project.clips.find((c) => c.name === 'walk');
    expect(walkClip?.frames.length).toBe(4);
    expect(walkClip?.parts.length).toBe(6); // parts remap into the applied clip
    // the reloaded anchor frame still matches the kit compose byte-for-byte
    const buffers = composeKitBuffers(KNIGHT, DEFAULT_PALETTE);
    const bodyLayer = source?.layers[0].id as string;
    expect(buffersEqual(source?.frames[0].cels[bodyLayer]?.buffer ?? new Uint8ClampedArray(), buffers.body)).toBe(true);
  });
});
