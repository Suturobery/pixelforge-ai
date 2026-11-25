/**
 * PixelForge AI — hand-crafted Starter Sprite Templates & Style Anchor measurement.
 *
 * Pure, DOM-free 16-bit pixel-art starter masters (strictly locked to the active
 * project palette via hue-matched OKLab semantic ramps) that place cleanly at
 * native 1:1 on 32×32, crisp 2× on 64×64, and clean downscale on 16×16, with
 * ready-to-animate Motion PartRects.
 */

import { parseHexColor, rgbToOklab } from '../ai/oklab';
import type { StyleAnchor, StyleAnchorOutline } from '../style-profile';
import type { PartRect, RGBA } from '../types/document';
import {
  analyzePixelCraft,
  collectUniqueOpaqueColors,
  computeTrimBounds,
} from './craft';

export type SpriteTemplateId =
  | 'chibi-humanoid'
  | 'slime'
  | 'rpg-sword'
  | 'potion-flask'
  | 'treasure-chest'
  | 'stone-pedestal'
  | 'topdown-tree'
  | 'dungeon-tile';

export interface SpriteTemplateInfo {
  id: SpriteTemplateId;
  name: string;
  category: 'character' | 'creature' | 'item' | 'prop' | 'tile';
  description: string;
  hasMotionParts: boolean;
}

export interface SpriteTemplatePart {
  name: string;
  rect: PartRect;
}

export interface RenderedSpriteTemplate {
  id: SpriteTemplateId;
  name: string;
  width: number;
  height: number;
  buffer: Uint8ClampedArray;
  parts: SpriteTemplatePart[];
  bounds: { x: number; y: number; w: number; h: number } | null;
  craftScore: number;
}

export const SPRITE_TEMPLATES: readonly SpriteTemplateInfo[] = [
  {
    id: 'chibi-humanoid',
    name: 'Chibi Hero',
    category: 'character',
    description: '16-bit RPG chibi adventurer with shaded hair, expressive eyes, tunic, gold belt, boots, and 6 Motion parts.',
    hasMotionParts: true,
  },
  {
    id: 'slime',
    name: 'RPG Slime',
    category: 'creature',
    description: 'Glossy 16-bit jelly slime with soft top-left specular crescent, kawaii catchlight eyes, and contact shadow.',
    hasMotionParts: true,
  },
  {
    id: 'rpg-sword',
    name: 'Runic Sword',
    category: 'item',
    description: 'Beveled 16-bit broadsword with split steel edge lighting, glowing rune spine, winged gold guard, and pommel gem.',
    hasMotionParts: false,
  },
  {
    id: 'potion-flask',
    name: 'Potion Flask',
    category: 'item',
    description: 'Corked alchemist bottle with glowing liquid meniscus, floating bubbles, and crisp curved glass highlight.',
    hasMotionParts: false,
  },
  {
    id: 'treasure-chest',
    name: 'Treasure Chest',
    category: 'prop',
    description: 'Arched RPG wooden chest with shaded planks, riveted iron bands, recessed lid shadow, and golden lock clasp.',
    hasMotionParts: false,
  },
  {
    id: 'stone-pedestal',
    name: 'Stone Pedestal',
    category: 'prop',
    description: 'Carved temple altar pedestal with beveled stone slab, glowing recessed rune, weathered cracks, and stepped plinth.',
    hasMotionParts: false,
  },
  {
    id: 'topdown-tree',
    name: 'RPG Tree',
    category: 'prop',
    description: 'Layered 16-bit foliage canopy with scalloped leaf clusters, sunlit crown highlights, bark trunk, and roots.',
    hasMotionParts: false,
  },
  {
    id: 'dungeon-tile',
    name: 'Dungeon Brick Tile',
    category: 'tile',
    description: 'Seamless beveled stone flagstones with mortar grooves, subtle cracks, and highlights ready for 3×3 Tiled Wrap.',
    hasMotionParts: false,
  },
] as const;

export function listSpriteTemplates(): SpriteTemplateInfo[] {
  return [...SPRITE_TEMPLATES];
}

export function isSpriteTemplateId(value: string): value is SpriteTemplateId {
  return SPRITE_TEMPLATES.some((t) => t.id === value);
}

// ---------------------------------------------------------------------------
// Hue-aware OKLab semantic palette matcher (strictly within project palette)
// ---------------------------------------------------------------------------

interface LabSwatch {
  rgba: RGBA;
  L: number;
  a: number;
  b: number;
  chroma: number;
}

type SymbolKey =
  | 'k' | 's' | '0' | '1' | '2' | 'w'
  | 'a' | 'b' | 'c'
  | 'd' | 'e' | 'f'
  | 'g' | 'y' | 'Y'
  | 'p' | 'q' | 'r'
  | 'm' | 'n' | 'o'
  | 'u' | 'v' | 'x';

type SemanticPalette = Record<SymbolKey, RGBA>;

const FALLBACK_PALETTE: readonly string[] = [
  '#141013', '#2c2137', '#4b3d44', '#76428a',
  '#ac3232', '#d95763', '#df7126', '#eec39a',
  '#fbf236', '#6abe30', '#37946e', '#306082',
  '#5b6ee1', '#639bff', '#cbdbfc', '#ffffff',
];

function hexToLab(hex: string): LabSwatch | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  const lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
  return {
    rgba: [rgb[0], rgb[1], rgb[2], 255],
    L: lab.L,
    a: lab.a,
    b: lab.b,
    chroma: Math.hypot(lab.a, lab.b),
  };
}

function closestSwatch(
  swatches: readonly LabSwatch[],
  targetHex: string,
  opts?: { minL?: number; maxL?: number; weightL?: number; neutralPenalty?: number },
): LabSwatch {
  const target = hexToLab(targetHex)!;
  const wL = opts?.weightL ?? 1.25;
  const nPen = opts?.neutralPenalty ?? 0;
  let best = swatches[0]!;
  let bestDist = Infinity;
  for (const s of swatches) {
    let penalty = nPen > 0 ? s.chroma * nPen : 0;
    if (opts?.minL !== undefined && s.L < opts.minL) penalty += (opts.minL - s.L) * 4;
    if (opts?.maxL !== undefined && s.L > opts.maxL) penalty += (s.L - opts.maxL) * 4;
    const dL = (s.L - target.L) * wL;
    const da = s.a - target.a;
    const db = s.b - target.b;
    const d = Math.hypot(dL, da, db) + penalty;
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

function buildSemanticPalette(palette: readonly string[]): SemanticPalette {
  const source = palette.length > 0 ? palette : FALLBACK_PALETTE;
  const swatches = source
    .map(hexToLab)
    .filter((s): s is LabSwatch => s !== null)
    .sort((x, y) => x.L - y.L);

  if (swatches.length === 0) {
    return buildSemanticPalette(FALLBACK_PALETTE);
  }

  const at = (frac: number) =>
    swatches[Math.min(swatches.length - 1, Math.max(0, Math.round(frac * (swatches.length - 1))))]!.rgba;

  // For tiny palettes (<= 5 colors like GameBoy 4-shade), map cleanly by luminance ramp
  if (swatches.length <= 5) {
    const c0 = at(0);
    const c1 = at(0.33);
    const c2 = at(0.67);
    const c3 = at(1);
    return {
      k: c0, s: c0,
      0: c1, 1: c2, 2: c3, w: c3,
      a: c1, b: c2, c: c3,
      d: c1, e: c2, f: c3,
      g: c1, y: c2, Y: c3,
      p: c1, q: c2, r: c3,
      m: c1, n: c2, o: c3,
      u: c1, v: c2, x: c3,
    };
  }

  const ink = swatches[0]!.rgba;
  const shadow = swatches[Math.min(1, swatches.length - 1)]!.rgba;
  const highlight = swatches[swatches.length - 1]!.rgba;

  const pick = (hex: string, minL?: number, maxL?: number, neutralPenalty?: number) =>
    closestSwatch(swatches, hex, { minL, maxL, neutralPenalty }).rgba;

  return {
    k: ink,
    s: shadow,
    // Steel / Stone neutral ramp (prefer low-chroma grays/slates over greens)
    0: pick('#363240', 0.18, 0.42, 0.9),
    1: pick('#5b5e73', 0.34, 0.62, 1.2),
    2: pick('#c4d3e8', 0.66, 0.94, 0.8),
    w: highlight,
    // Warm skin ramp
    a: pick('#c4805c', 0.45, 0.72),
    b: pick('#eec39a', 0.68, 0.90),
    c: pick('#fde4c8', 0.80, 1.0),
    // Chestnut wood / hair / leather ramp
    d: pick('#4d2b24', 0.16, 0.42),
    e: pick('#8f4c2c', 0.34, 0.62),
    f: pick('#d17c3a', 0.52, 0.82),
    // Gold / warm brass ramp
    g: pick('#a8601c', 0.38, 0.66),
    y: pick('#e5a92e', 0.62, 0.88),
    Y: pick('#fff266', 0.78, 1.0),
    // Hero cobalt / teal accent ramp
    p: pick('#284b7a', 0.24, 0.52),
    q: pick('#4d7be0', 0.42, 0.72),
    r: pick('#74b8ff', 0.60, 0.92),
    // Ruby / crimson magic ramp (potion, cloak, jewel)
    m: pick('#7d1e32', 0.22, 0.48),
    n: pick('#cf3848', 0.40, 0.68),
    o: pick('#ff7585', 0.58, 0.90),
    // Emerald foliage / slime green ramp (keep leaf-green, avoid pure yellow)
    u: pick('#245c44', 0.24, 0.50),
    v: pick('#37946e', 0.42, 0.66),
    x: pick('#6abe30', 0.54, 0.82),
  };
}

// ---------------------------------------------------------------------------
// Hand-crafted 16-bit pixel-art masters
// ---------------------------------------------------------------------------

interface PixelMaster {
  grid: readonly string[];
  /** Optional relative Motion part rects in master grid coordinates. */
  parts?: ReadonlyArray<{ name: string; rect: PartRect }>;
  /** True for edge-to-edge seamless tiles. */
  tileable?: boolean;
}

const MASTERS: Record<SpriteTemplateId, PixelMaster> = {
  // 22×26 16-bit RPG Chibi Adventurer (spiky hair, bright eyes, cobalt tunic, red scarf, gold belt, boots)
  'chibi-humanoid': {
    grid: [
      '.......kkkkkkkk.......',
      '.....kkfeffffffkk.....',
      '....kffeeefffffefk....',
      '....kfeeeffffffeek....',
      '...kdfeeddeeefffdek...',
      '...kddedkddkddfeddk...',
      '...kddekbbcbkkkeddk...',
      '...kddkbbbbbbbbkddk...',
      '....kkbbkwbbwkbbkk....',
      '....kkbbkkbbkkbbkk....',
      '....kkabbbbbbbbaak....',
      '.....kkabbbbbbakk.....',
      '......kkmmnnmmkk......',
      '.....kppqnnnnqppk.....',
      '....kpqqqqrrqqqqpk....',
      '...kbbkpqrrrrqpkbbk...',
      '...kabkpqqrrqqpkbak...',
      '....kkkpqqqqqqpkkk....',
      '.....kkdggYYggdkk.....',
      '.....kkppppppppkk.....',
      '.....kpppk..kpppk.....',
      '.....kddk....kddk.....',
      '....kdeek....keedk....',
      '....kdddk....kdddk....',
      '....kkkkk....kkkkk....',
      '.....ssssssssssss.....',
    ],
    parts: [
      { name: 'head', rect: { x: 3, y: 0, w: 16, h: 13 } },
      { name: 'body', rect: { x: 5, y: 12, w: 12, h: 9 } },
      { name: 'armL', rect: { x: 3, y: 13, w: 4, h: 6 } },
      { name: 'armR', rect: { x: 15, y: 13, w: 4, h: 6 } },
      { name: 'legL', rect: { x: 4, y: 20, w: 5, h: 5 } },
      { name: 'legR', rect: { x: 13, y: 20, w: 5, h: 5 } },
    ],
  },

  // 22×19 Glossy 16-bit RPG Jelly Slime
  slime: {
    grid: [
      '........kkkkkk........',
      '......kkxxxxxxkk......',
      '.....kxxxwwxxxxvk.....',
      '....kxxwwxxxvvvvvk....',
      '...kxwwxxxvvvvvvvvk...',
      '...kxxwxxvvvvvvvvvk...',
      '..kxxvvvvvvvvvvvvvvk..',
      '..kxvvvvvvvvvvvvvvuk..',
      '.kxvvvvvvvvvvvvvvvvuk.',
      '.kvvvvvvkwvvvvkwvvvuk.',
      '.kvvvvvvkkvvvvkkvvvuk.',
      '.kvvvvvvvvvvvvvvvvuuk.',
      '.kvvvvvvvvvvvvvvvuuuk.',
      '.kuvvvvvvvvvvvvvuuuuk.',
      '..kuuvvvvvvvvvuuuuuk..',
      '...kuuuuuuuuuuuuuuk...',
      '....kkkkkkkkkkkkkk....',
      '...ssssssssssssssss...',
      '.....ssssssssssss.....',
    ],
    parts: [{ name: 'body', rect: { x: 1, y: 0, w: 20, h: 17 } }],
  },

  // 20×26 Forged 16-bit Runic Broadsword
  'rpg-sword': {
    grid: [
      '.........kk.........',
      '........kw2k........',
      '........kw1k........',
      '.......kw210k.......',
      '.......kw210k.......',
      '.......kw2r0k.......',
      '.......kw2q0k.......',
      '.......kw2r0k.......',
      '.......kw210k.......',
      '.......kw2r0k.......',
      '.......kw2q0k.......',
      '.......kw2r0k.......',
      '.......kw210k.......',
      '.......kw210k.......',
      '.......kw210k.......',
      '..kk...kw210k...kk..',
      '.kYYkkkkw210kkkkggk.',
      '.kYyyYYYYoYYYYyyggk.',
      '..kggyyyynyyyygggk..',
      '....kkkkkmmkkkkk....',
      '........kdek........',
      '........kedk........',
      '........kdek........',
      '.......kYyygk.......',
      '.......kyogk........',
      '........kkkk........',
    ],
  },

  // 20×24 Corked Alchemist Potion Flask with Liquid Meniscus & Specular Arc
  'potion-flask': {
    grid: [
      '.......kkkkkk.......',
      '.......kfeefk.......',
      '.......kfeedk.......',
      '......kkddddkk......',
      '.....k2ww22110k.....',
      '......kk2210kk......',
      '.......k2w10k.......',
      '.......k2w10k.......',
      '......k222110k......',
      '.....k2w222110k.....',
      '....k2w22222110k....',
      '...k2w2oooooonn0k...',
      '..k2w2ooowoonnnm0k..',
      '..k2w2oonnnnnnnm0k..',
      '..k22oonnnnnonnm0k..',
      '..k2onnnnnnnnnmm0k..',
      '..k2onnnnnnnnnmm0k..',
      '..k2wnnnnnnnnmmm0k..',
      '...k1onnnnnnmmm0k...',
      '....k1mmmmmmmm0k....',
      '.....kk000000kk.....',
      '.......kkkkkk.......',
      '.....ssssssssss.....',
      '.......ssssss.......',
    ],
  },

  // 24×21 Classic Arched 16-bit RPG Treasure Chest (exact 24-col symmetry)
  'treasure-chest': {
    grid: [
      '....kkkkkkkkkkkkkkkk....',
      '..kk22kffffeeeeffk22kk..',
      '.k122kfffefffffeffk221k.',
      '.k12kffeeeeeeeeeefk221k.',
      'k012kddddddddddddddk210k',
      'k012kffffeeeeeeeefkk210k',
      'k012keeeeeeeeeeeeedk210k',
      'k012kddddddddddddddk210k',
      'k0122kkYyyyyyyyYkk22210k',
      'k01222kYyykkyyyYk222110k',
      'k00111kYyykkyyyYk111000k',
      'k012kddkggyyyyggkddk210k',
      'k012keedkkggggkkdeek210k',
      'k012keeeeeeddeeeeeek210k',
      'k012kddddddddddddddk210k',
      'k012keeeeeeddeeeeeek210k',
      'k012kddddddddddddddk210k',
      'k001kddddddddddddddk100k',
      '.kkkkkkkkkkkkkkkkkkkkkk.',
      '..ssssssssssssssssssss..',
      '....ssssssssssssssss....',
    ],
  },

  // 22×24 Carved Temple Stone Pedestal with Glowing Rune
  'stone-pedestal': {
    grid: [
      '....kkkkkkkkkkkkkk....',
      '...kww222222222211k...',
      '..kw222222222221110k..',
      '..k2221111111111100k..',
      '..k1111000000000000k..',
      '...kk110000000000kk...',
      '....k211111111100k....',
      '....k21111kk11100k....',
      '....k2111krrk1100k....',
      '....k211krwwrk100k....',
      '....k2111kqqk1100k....',
      '....k21111kp11100k....',
      '....k211111111100k....',
      '....k211k11111100k....',
      '....k2111k1111100k....',
      '....k111111111000k....',
      '...k22211111111000k...',
      '..kw222222222111000k..',
      '..k2211111111111000k..',
      '..k1111111111100000k..',
      '..k0000000000000000k..',
      '...kkkkkkkkkkkkkkkk...',
      '..ssssssssssssssssss..',
      '....ssssssssssssss....',
    ],
  },

  // 26×26 Lush 16-bit RPG Tree with Scalloped Leaf Clusters & Bark Trunk
  'topdown-tree': {
    grid: [
      '........kkkkkkkkkk........',
      '......kkxxxvxvxxxxkk......',
      '.....kxxxxwwxxxxvvvvk.....',
      '....kxxxwxxxxxvvvvvvvk....',
      '...kxxxxxxxxxvvvvvvvvuk...',
      '..kxxxxvxvvxvvvvvvvvvuuk..',
      '..kxxxvvvvvvvvvvvvvvvuuk..',
      '.kxxxvvvvvvvvvvvxvvvuuuuk.',
      '.kxxvvxvvvvvvvvvvvvvuuuuk.',
      '.kxxvvvvvvvvvvvvvvvvuuuuk.',
      '.kvvvvvvvvxvvvvvvvuuuuuuk.',
      '.kvvvvvvvvvvvvvvvuuuuuuuk.',
      '..kuvvvvvvvvvvvvuuuuuuuk..',
      '..kuuvvvvvvvvvvuuuuuuuk...',
      '...kuuuuvvvvvuuuuuuuuk....',
      '....kkuuuuuuuuuuuuukk.....',
      '......kkkkuuuuuukkk.......',
      '.........kfeefdk..........',
      '.........kfeeddk..........',
      '.........kfeefdk..........',
      '.........kfedddk..........',
      '........kfeeddddk.........',
      '.......kfeedddeddk........',
      '......kkdddddddddkk.......',
      '.....sssssssssssssss......',
      '.......sssssssssss........',
    ],
  },

  // 16×16 Seamless Running-Bond Beveled Dungeon Flagstone Brick Tile
  'dungeon-tile': {
    grid: [
      'kkkkkkkkkkkkkkkk',
      'k2222221k2222221',
      'k2111110k2111110',
      'k2112110k2111110',
      'k2111110k2101110',
      'k2111110k2110110',
      'k1000000k1000000',
      'kkkkkkkkkkkkkkkk',
      '2221k2222221k222',
      '1110k2111110k211',
      '1110k2112110k211',
      '1010k2111110k211',
      '1100k2111110k211',
      '1110k2111110k211',
      '0000k1000000k100',
      'kkkkkkkkkkkkkkkk',
    ],
    tileable: true,
  },
};

function setPx(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
}

function clampPartRect(r: PartRect, w: number, h: number): PartRect {
  const x = Math.max(0, Math.min(w - 1, Math.round(r.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(r.y)));
  const rw = Math.max(1, Math.min(w - x, Math.round(r.w)));
  const rh = Math.max(1, Math.min(h - y, Math.round(r.h)));
  return { x, y, w: rw, h: rh };
}

/**
 * Deterministically render a crisp 16-bit pixel-art starter template fitted to
 * `width × height` strictly within `palette`, with ready-to-animate Motion parts.
 */
export function renderSpriteTemplate(
  id: SpriteTemplateId,
  width: number,
  height: number,
  palette: readonly string[],
  _opts: { polish?: boolean } = {},
): RenderedSpriteTemplate {
  const info = SPRITE_TEMPLATES.find((t) => t.id === id) ?? SPRITE_TEMPLATES[0]!;
  const master = MASTERS[info.id];
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round(height));
  const buf = new Uint8ClampedArray(w * h * 4);
  const sem = buildSemanticPalette(palette);

  const mw = Math.max(...master.grid.map((row) => row.length));
  const mh = master.grid.length;

  const parts: SpriteTemplatePart[] = [];

  if (master.tileable) {
    // Seamless edge-to-edge tiling across any canvas dimensions
    for (let y = 0; y < h; y++) {
      const row = master.grid[y % mh]!;
      for (let x = 0; x < w; x++) {
        const ch = row[x % row.length] as SymbolKey | '.';
        if (ch && ch !== '.' && ch in sem) {
          setPx(buf, w, h, x, y, sem[ch]);
        }
      }
    }
  } else {
    // Choose crisp integer scale when master fits (e.g. 1× on 32×32, 2× on 64×64),
    // otherwise scale proportionally to fit ~92% of smaller canvases (e.g. 16×16).
    const intScale = Math.min(Math.floor(w / mw), Math.floor(h / mh));
    let drawW: number;
    let drawH: number;
    if (intScale >= 1) {
      drawW = mw * intScale;
      drawH = mh * intScale;
    } else {
      const fit = Math.min((w - 1) / mw, (h - 1) / mh);
      drawW = Math.max(4, Math.round(mw * fit));
      drawH = Math.max(4, Math.round(mh * fit));
    }

    const ox = Math.floor((w - drawW) / 2);
    // Grounded near bottom with a clean 1–3px margin
    const bottomPad = h >= 24 ? Math.max(2, Math.floor((h - drawH) / 2)) : Math.floor((h - drawH) / 2);
    const oy = Math.max(0, h - drawH - bottomPad);

    for (let dy = 0; dy < drawH; dy++) {
      const sy = Math.min(mh - 1, Math.floor((dy * mh) / drawH));
      const row = master.grid[sy]!;
      for (let dx = 0; dx < drawW; dx++) {
        const sx = Math.min(row.length - 1, Math.floor((dx * mw) / drawW));
        const ch = row[sx] as SymbolKey | '.';
        if (ch && ch !== '.' && ch in sem) {
          setPx(buf, w, h, ox + dx, oy + dy, sem[ch]);
        }
      }
    }

    if (master.parts) {
      const sx = drawW / mw;
      const sy = drawH / mh;
      for (const p of master.parts) {
        parts.push({
          name: p.name,
          rect: clampPartRect(
            {
              x: ox + p.rect.x * sx,
              y: oy + p.rect.y * sy,
              w: p.rect.w * sx,
              h: p.rect.h * sy,
            },
            w,
            h,
          ),
        });
      }
    }
  }

  const trim = computeTrimBounds([buf], w, h, 0);
  const craft = analyzePixelCraft({ buffer: buf, width: w, height: h, lighting: 'top-left' });

  return {
    id: info.id,
    name: info.name,
    width: w,
    height: h,
    buffer: buf,
    parts,
    bounds: trim ? { x: trim.bbox.x, y: trim.bbox.y, w: trim.bbox.w, h: trim.bbox.h } : null,
    craftScore: craft.score,
  };
}

function rgbaToHex(c: RGBA): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/**
 * Measure a finished Hero sprite frame into a compact, serializable StyleAnchor
 * so every AI IDE / Asset Brief can match exact proportions, ground line,
 * outline style, and palette colors.
 */
export function measureStyleAnchor(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  meta: { label: string; clipId: string; frameIndex: number },
): StyleAnchor | null {
  const trim = computeTrimBounds([buffer], width, height, 0);
  if (!trim) return null;

  const paletteUsed = collectUniqueOpaqueColors([buffer]).slice(0, 24).map(rgbaToHex);
  const craft = analyzePixelCraft({ buffer, width, height, lighting: 'top-left' });

  // Detect outline style by measuring luminance distribution of perimeter pixels
  let perimeterCount = 0;
  let darkPerimeter = 0;
  const perimeterColors = new Set<string>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (buffer[i + 3]! === 0) continue;
      const onEdge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        buffer[((y - 1) * width + x) * 4 + 3]! === 0 ||
        buffer[((y + 1) * width + x) * 4 + 3]! === 0 ||
        buffer[(y * width + (x - 1)) * 4 + 3]! === 0 ||
        buffer[(y * width + (x + 1)) * 4 + 3]! === 0;
      if (!onEdge) continue;
      perimeterCount++;
      const lab = rgbToOklab(buffer[i]!, buffer[i + 1]!, buffer[i + 2]!);
      if (lab.L < 0.34) darkPerimeter++;
      perimeterColors.add(`${buffer[i]},${buffer[i + 1]},${buffer[i + 2]}`);
    }
  }

  let outlineStyle: StyleAnchorOutline = 'lineless';
  const darkRatio = perimeterCount > 0 ? darkPerimeter / perimeterCount : 0;
  if (darkRatio >= 0.65) {
    outlineStyle = perimeterColors.size <= 2 ? 'dark-ink' : 'sel-out';
  } else if (darkRatio >= 0.3) {
    outlineStyle = 'sel-out';
  }

  const bottomMargin = Math.max(0, height - (trim.bbox.y + trim.bbox.h));
  return {
    label: meta.label.trim().slice(0, 64) || 'Hero anchor',
    clipId: meta.clipId,
    frameIndex: Math.max(0, Math.round(meta.frameIndex)),
    canvasWidth: width,
    canvasHeight: height,
    spriteWidth: trim.bbox.w,
    spriteHeight: trim.bbox.h,
    heightRatio: Number((trim.bbox.h / Math.max(1, height)).toFixed(3)),
    bottomMargin,
    outlineStyle,
    paletteUsed,
    craftScore: craft.score,
    pinnedAt: Date.now(),
  };
}
