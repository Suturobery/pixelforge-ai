/**
 * PixelForge AI — Sprite Skin / Palette Variant generator.
 *
 * Pure, DOM-free core helper that clones a clip's pixel buffers and remaps
 * every visible cel onto a target skin palette via OKLab lightness-ramp
 * (default) or nearest-color matching — leaving the original clip untouched
 * so artists can generate and batch-export elemental/enemy variants in 1 click.
 */

import type { Clip } from '../types/document';
import {
  collectUniqueOpaqueColors,
  remapBufferToPalette,
  type PaletteRemapMode,
} from './craft';

export interface SkinVariantPreset {
  id: string;
  name: string;
  suffix: string;
  description: string;
  palette: readonly string[];
}

export const SKIN_VARIANT_PRESETS: readonly SkinVariantPreset[] = [
  {
    id: 'fire',
    name: 'Fire / Lava',
    suffix: 'fire',
    description: 'Obsidian darks into blazing ember & molten gold',
    palette: ['#1a0b0e', '#4d1414', '#9e281b', '#e0531f', '#f79c26', '#fff2a6'],
  },
  {
    id: 'ice',
    name: 'Frost / Ice',
    suffix: 'ice',
    description: 'Deep glacial navy into bright frost cyan & snow',
    palette: ['#0c162b', '#1b3860', '#2d6fa3', '#56b4dc', '#a2e4f5', '#eefbff'],
  },
  {
    id: 'poison',
    name: 'Venom / Poison',
    suffix: 'poison',
    description: 'Swamp violet-black into toxic emerald & acid lime',
    palette: ['#150f24', '#263829', '#316b3b', '#4eb849', '#9be346', '#e6ff9e'],
  },
  {
    id: 'shadow',
    name: 'Shadow / Void',
    suffix: 'shadow',
    description: 'Abyssal indigo into amethyst & spectral lavender',
    palette: ['#0c0814', '#24153b', '#4b2673', '#7c45b0', '#b882eb', '#ebd9ff'],
  },
  {
    id: 'gold',
    name: 'Royal Gold',
    suffix: 'gold',
    description: 'Bronze umber into shining treasure gold & ivory',
    palette: ['#211509', '#573612', '#9c6718', '#dba12a', '#f7d35c', '#fff7d1'],
  },
  {
    id: 'cyber',
    name: 'Cyber Neon',
    suffix: 'cyber',
    description: 'Gunmetal slate into electric magenta & neon cyan',
    palette: ['#0e101c', '#2b1e42', '#7d246e', '#d63384', '#38e4d8', '#e6ffff'],
  },
  {
    id: 'gameboy',
    name: 'Retro GB (4c)',
    suffix: 'gb',
    description: 'Classic 4-shade olive handheld monochrome',
    palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  },
  {
    id: 'stone',
    name: 'Ancient Stone',
    suffix: 'stone',
    description: 'Charcoal slate into weathered sandstone statue',
    palette: ['#17161a', '#3a3840', '#63606b', '#8f8b96', '#bfbbc4', '#ece9f0'],
  },
];

export function listSkinPresets(): readonly SkinVariantPreset[] {
  return SKIN_VARIANT_PRESETS;
}

export function getSkinPreset(id: string): SkinVariantPreset | undefined {
  const key = id.trim().toLowerCase();
  return SKIN_VARIANT_PRESETS.find((p) => p.id === key || p.suffix === key);
}

export interface SkinVariantCelBuffer {
  frameIndex: number;
  layerIndex: number;
  buffer: Uint8ClampedArray;
  remappedPixels: number;
}

export interface SkinVariantPlan {
  name: string;
  palette: string[];
  mode: PaletteRemapMode;
  fps: number;
  loop: boolean;
  loopMode: Clip['loopMode'];
  layers: Array<{
    name: string;
    visible: boolean;
    opacity: number;
    linked: boolean;
    locked?: boolean;
    blend?: Clip['layers'][number]['blend'];
  }>;
  frameDurations: number[];
  cels: SkinVariantCelBuffer[];
  totalRemappedPixels: number;
}

/**
 * Compute all remapped cel buffers for a new skin variant clip derived from
 * `sourceClip`. Never mutates `sourceClip`.
 */
export function buildSkinVariantPlan(
  sourceClip: Clip,
  options: {
    name: string;
    palette: readonly string[];
    mode?: PaletteRemapMode;
  },
): SkinVariantPlan {
  const mode: PaletteRemapMode = options.mode === 'nearest' ? 'nearest' : 'ramp';
  const palette = [...options.palette];
  const uniqueBuffers: Uint8ClampedArray[] = [];
  const seenSrc = new Set<Uint8ClampedArray>();

  for (const frame of sourceClip.frames) {
    for (const layer of sourceClip.layers) {
      const cel = frame.cels[layer.id];
      if (!cel || seenSrc.has(cel.buffer)) continue;
      seenSrc.add(cel.buffer);
      uniqueBuffers.push(cel.buffer);
    }
  }

  const sourceColors = collectUniqueOpaqueColors(uniqueBuffers);
  const remappedBySrc = new Map<Uint8ClampedArray, { buffer: Uint8ClampedArray; count: number }>();

  for (const buf of uniqueBuffers) {
    const working = new Uint8ClampedArray(buf);
    const count = remapBufferToPalette(working, palette, { mode, sourceColors });
    remappedBySrc.set(buf, { buffer: working, count });
  }

  const cels: SkinVariantCelBuffer[] = [];
  let totalRemappedPixels = 0;

  sourceClip.frames.forEach((frame, frameIndex) => {
    sourceClip.layers.forEach((layer, layerIndex) => {
      const cel = frame.cels[layer.id];
      if (!cel) return;
      const mapped = remappedBySrc.get(cel.buffer);
      if (!mapped) return;
      cels.push({
        frameIndex,
        layerIndex,
        buffer: new Uint8ClampedArray(mapped.buffer),
        remappedPixels: mapped.count,
      });
      totalRemappedPixels += mapped.count;
    });
  });

  return {
    name: options.name.trim().slice(0, 60) || `${sourceClip.name}_skin`,
    palette,
    mode,
    fps: sourceClip.fps,
    loop: sourceClip.loop,
    loopMode: sourceClip.loopMode,
    layers: sourceClip.layers.map((l) => ({
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      linked: l.linked,
      ...(l.locked ? { locked: true } : {}),
      ...(l.blend ? { blend: l.blend } : {}),
    })),
    frameDurations: sourceClip.frames.map((f) => f.durationMs),
    cels,
    totalRemappedPixels,
  };
}
