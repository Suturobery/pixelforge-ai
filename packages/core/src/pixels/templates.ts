/**
 * PixelForge AI — deterministic Starter Sprite Templates & Style Anchor measurement.
 *
 * Pure, DOM-free starter silhouettes that scale cleanly to any canvas size
 * (16×16..128×128), lock strictly to the project palette, polish with OKLab
 * sel-out + double cleanup, and emit ready-to-animate Motion PartRects.
 */

import { parseHexColor, rgbToOklab } from '../ai/oklab';
import type { StyleAnchor, StyleAnchorOutline } from '../style-profile';
import type { PartRect, RGBA } from '../types/document';
import {
  analyzePixelCraft,
  collectUniqueOpaqueColors,
  computeTrimBounds,
  polishLayerPixelArt,
} from './craft';
import { drawEllipsePixels } from './ellipse';
import { drawLinePixels, drawRectPixels } from './ops';

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
    description: 'Balanced RPG chibi character base with auto-tagged head, body, arms, and legs for Motion.',
    hasMotionParts: true,
  },
  {
    id: 'slime',
    name: 'RPG Slime',
    category: 'creature',
    description: 'Smooth organic jelly dome with shoulder highlight, lower belly glow, and ground shadow.',
    hasMotionParts: true,
  },
  {
    id: 'rpg-sword',
    name: 'Runic Sword',
    category: 'item',
    description: 'Upright two-tone forged blade with fuller channel, winged crossguard, grip, and pommel.',
    hasMotionParts: false,
  },
  {
    id: 'potion-flask',
    name: 'Potion Flask',
    category: 'item',
    description: 'Corked glass RPG potion bottle with glowing liquid fill and specular shine.',
    hasMotionParts: false,
  },
  {
    id: 'treasure-chest',
    name: 'Treasure Chest',
    category: 'prop',
    description: 'Classic RPG chest with arched lid, shaded trim bands, and bright center lock clasp.',
    hasMotionParts: false,
  },
  {
    id: 'stone-pedestal',
    name: 'Stone Pedestal',
    category: 'prop',
    description: 'Stepped carved altar block with beveled top stone and chiseled shadow face.',
    hasMotionParts: false,
  },
  {
    id: 'topdown-tree',
    name: 'RPG Tree',
    category: 'prop',
    description: 'Layered rounded canopy foliage crown with shaded trunk and grounded shadow.',
    hasMotionParts: false,
  },
  {
    id: 'dungeon-tile',
    name: 'Dungeon Brick Tile',
    category: 'tile',
    description: 'Seamless edge-to-edge beveled stone floor tile ready for 3×3 Tiled Wrap editing.',
    hasMotionParts: false,
  },
] as const;

export function listSpriteTemplates(): SpriteTemplateInfo[] {
  return [...SPRITE_TEMPLATES];
}

export function isSpriteTemplateId(value: string): value is SpriteTemplateId {
  return SPRITE_TEMPLATES.some((t) => t.id === value);
}

interface PaletteRoles {
  ink: RGBA;
  shadow: RGBA;
  mid: RGBA;
  light: RGBA;
  highlight: RGBA;
  accent: RGBA;
  accentBright: RGBA;
  warm: RGBA;
}

function pickPaletteRoles(palette: readonly string[]): PaletteRoles {
  const entries = palette
    .map((hex) => {
      const rgb = parseHexColor(hex);
      if (!rgb) return null;
      const lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
      const chroma = Math.hypot(lab.a, lab.b);
      return { hex, rgba: [rgb[0], rgb[1], rgb[2], 255] as RGBA, L: lab.L, a: lab.a, b: lab.b, chroma };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((x, y) => x.L - y.L);

  if (entries.length === 0) {
    return {
      ink: [26, 28, 44, 255],
      shadow: [51, 60, 87, 255],
      mid: [86, 108, 134, 255],
      light: [148, 176, 194, 255],
      highlight: [244, 244, 244, 255],
      accent: [56, 183, 100, 255],
      accentBright: [167, 240, 112, 255],
      warm: [255, 205, 117, 255],
    };
  }

  const at = (frac: number) => entries[Math.min(entries.length - 1, Math.max(0, Math.round(frac * (entries.length - 1))))]!.rgba;
  const chromatic = [...entries].sort((x, y) => y.chroma - x.chroma);
  const accentEntry = chromatic[0] ?? entries[Math.floor(entries.length / 2)]!;
  const accentBrightEntry =
    entries.find((e) => e.L > accentEntry.L + 0.08 && e.chroma > 0.04) ??
    entries[entries.length - 1]!;
  const warmEntry =
    entries
      .filter((e) => e.b > 0.04 && e.L > 0.35 && e.L < 0.9)
      .sort((x, y) => y.chroma - x.chroma)[0] ??
    accentBrightEntry;

  return {
    ink: at(0),
    shadow: at(0.22),
    mid: at(0.48),
    light: at(0.75),
    highlight: at(1.0),
    accent: accentEntry.rgba,
    accentBright: accentBrightEntry.rgba,
    warm: warmEntry.rgba,
  };
}

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
 * Deterministically render a crisp pixel-art starter template fitted to `width × height`
 * using the project's palette, complete with sel-out polish and Motion part regions.
 */
export function renderSpriteTemplate(
  id: SpriteTemplateId,
  width: number,
  height: number,
  palette: readonly string[],
  opts: { polish?: boolean } = {},
): RenderedSpriteTemplate {
  const info = SPRITE_TEMPLATES.find((t) => t.id === id) ?? SPRITE_TEMPLATES[0]!;
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round(height));
  const buf = new Uint8ClampedArray(w * h * 4);
  const c = pickPaletteRoles(palette);
  const parts: SpriteTemplatePart[] = [];
  const shouldPolish = opts.polish !== false && id !== 'dungeon-tile';

  const cx = (w - 1) / 2;
  const px = (fx: number) => Math.round(fx * (w - 1));
  const py = (fy: number) => Math.round(fy * (h - 1));

  if (id === 'chibi-humanoid') {
    // Ground shadow
    drawEllipsePixels(buf, w, h, px(0.28), py(0.84), px(0.72), py(0.92), 1, c.shadow, true, false);

    // Legs (two separate feet so Walk/Run presets animate cleanly)
    const legTop = py(0.67);
    const legBot = py(0.86);
    const lLegL = px(0.32);
    const lLegR = px(0.46);
    const rLegL = px(0.54);
    const rLegR = px(0.68);
    drawRectPixels(buf, w, h, lLegL, legTop, lLegR, legBot, 1, c.shadow, true, false);
    drawRectPixels(buf, w, h, lLegL, legTop, Math.max(lLegL, lLegR - 1), Math.max(legTop, legBot - 1), 1, c.mid, true, false);
    drawRectPixels(buf, w, h, rLegL, legTop, rLegR, legBot, 1, c.shadow, true, false);
    drawRectPixels(buf, w, h, rLegL, legTop, Math.max(rLegL, rLegR - 1), Math.max(legTop, legBot - 1), 1, c.mid, true, false);

    // Arms
    const armTop = py(0.49);
    const armBot = py(0.67);
    const lArmL = px(0.20);
    const lArmR = px(0.31);
    const rArmL = px(0.69);
    const rArmR = px(0.80);
    drawRectPixels(buf, w, h, lArmL, armTop, lArmR, armBot, 1, c.accent, true, false);
    drawRectPixels(buf, w, h, lArmL, armTop, lArmR, Math.max(armTop, Math.round((armTop + armBot) / 2)), 1, c.accentBright, true, false);
    drawRectPixels(buf, w, h, rArmL, armTop, rArmR, armBot, 1, c.shadow, true, false);
    drawRectPixels(buf, w, h, rArmL, armTop, rArmR, Math.max(armTop, Math.round((armTop + armBot) / 2)), 1, c.accent, true, false);

    // Torso tunic
    const bodyL = px(0.31);
    const bodyR = px(0.69);
    const bodyTop = py(0.46);
    const bodyBot = py(0.69);
    drawRectPixels(buf, w, h, bodyL, bodyTop, bodyR, bodyBot, 1, c.accent, true, false);
    drawRectPixels(buf, w, h, bodyL, bodyTop, Math.round((bodyL + bodyR) / 2), Math.max(bodyTop, bodyBot - 2), 1, c.accentBright, true, false);
    // Belt accent
    const beltY = py(0.63);
    drawLinePixels(buf, w, h, bodyL, beltY, bodyR, beltY, 1, c.shadow, false);
    setPx(buf, w, h, Math.round(cx), beltY, c.warm);

    // Oversized chibi head (expressive RPG silhouette)
    const headL = px(0.24);
    const headR = px(0.76);
    const headTop = py(0.14);
    const headBot = py(0.49);
    drawEllipsePixels(buf, w, h, headL, headTop, headR, headBot, 1, c.warm, true, false);
    // Top-left forehead highlight
    drawEllipsePixels(buf, w, h, px(0.30), py(0.18), px(0.56), py(0.32), 1, c.highlight, true, false);
    // Simple hair cap
    drawEllipsePixels(buf, w, h, headL, headTop, headR, py(0.28), 1, c.mid, true, false);
    drawEllipsePixels(buf, w, h, px(0.28), py(0.15), px(0.54), py(0.23), 1, c.light, true, false);
    // Crisp eye anchors
    const eyeY = py(0.36);
    const eyeOff = Math.max(2, Math.round(w * 0.1));
    setPx(buf, w, h, Math.round(cx - eyeOff), eyeY, c.ink);
    setPx(buf, w, h, Math.round(cx + eyeOff), eyeY, c.ink);
    if (h >= 28) {
      setPx(buf, w, h, Math.round(cx - eyeOff), eyeY + 1, c.ink);
      setPx(buf, w, h, Math.round(cx + eyeOff), eyeY + 1, c.ink);
    }

    parts.push(
      { name: 'head', rect: clampPartRect({ x: headL - 1, y: headTop - 1, w: headR - headL + 3, h: headBot - headTop + 2 }, w, h) },
      { name: 'body', rect: clampPartRect({ x: bodyL, y: bodyTop, w: bodyR - bodyL + 1, h: bodyBot - bodyTop + 1 }, w, h) },
      { name: 'armL', rect: clampPartRect({ x: lArmL - 1, y: armTop - 1, w: lArmR - lArmL + 2, h: armBot - armTop + 3 }, w, h) },
      { name: 'armR', rect: clampPartRect({ x: rArmL, y: armTop - 1, w: rArmR - rArmL + 2, h: armBot - armTop + 3 }, w, h) },
      { name: 'legL', rect: clampPartRect({ x: lLegL - 1, y: legTop, w: lLegR - lLegL + 2, h: legBot - legTop + 2 }, w, h) },
      { name: 'legR', rect: clampPartRect({ x: rLegL, y: legTop, w: rLegR - rLegL + 2, h: legBot - legTop + 2 }, w, h) },
    );
  } else if (id === 'slime') {
    const rx = Math.max(4, w * 0.30);
    const ry = Math.max(4, h * 0.26);
    const groundY = py(0.80);
    const cy = groundY - ry * 0.78;

    drawEllipsePixels(buf, w, h, Math.round(cx - rx * 0.92), groundY - 1, Math.round(cx + rx * 0.92), Math.min(h - 2, groundY + Math.max(1, Math.round(h * 0.05))), 1, c.shadow, true, false);

    for (let y = 1; y < h - 1; y++) {
      const ny = (y - cy) / ry;
      if (ny < -1.02 || ny > 0.96 || y > groundY) continue;
      const effRx = rx * (1 + 0.14 * Math.max(-0.6, ny));
      for (let x = 1; x < w - 1; x++) {
        const nx = (x - cx) / effRx;
        const pwr = ny > 0 ? 2.5 : 2.0;
        if (Math.pow(Math.abs(nx), pwr) + Math.pow(Math.abs(ny), pwr) <= 1.0) {
          const lightDot = -nx * 0.52 - ny * 0.85;
          if (lightDot > 0.35) setPx(buf, w, h, x, y, c.accentBright);
          else if (lightDot < -0.25 || ny > 0.58) setPx(buf, w, h, x, y, c.shadow);
          else setPx(buf, w, h, x, y, c.accent);
        }
      }
    }
    // Glossy shoulder highlight
    const sx = Math.round(cx - rx * 0.42);
    const sy = Math.round(cy - ry * 0.44);
    drawEllipsePixels(buf, w, h, sx - Math.max(1, Math.round(w * 0.04)), sy - 1, sx + Math.max(1, Math.round(w * 0.04)), sy + 1, 1, c.highlight, true, false);
    // Cute eyes
    const ex = Math.max(2, Math.round(rx * 0.36));
    const ey = Math.round(cy + ry * 0.12);
    setPx(buf, w, h, Math.round(cx - ex), ey, c.ink);
    setPx(buf, w, h, Math.round(cx + ex), ey, c.ink);
    if (h >= 28) {
      setPx(buf, w, h, Math.round(cx - ex), ey + 1, c.ink);
      setPx(buf, w, h, Math.round(cx + ex), ey + 1, c.ink);
    }

    parts.push({
      name: 'body',
      rect: clampPartRect({ x: Math.round(cx - rx - 1), y: Math.round(cy - ry - 1), w: Math.round(rx * 2 + 3), h: Math.round(groundY - (cy - ry) + 3) }, w, h),
    });
  } else if (id === 'rpg-sword') {
    const bladeHalf = Math.max(1, Math.round(w * 0.08));
    const midX = Math.round(cx);
    const tipY = py(0.12);
    const guardY = py(0.66);
    // Pointed blade tip
    for (let dy = 0; dy <= bladeHalf; dy++) {
      const y = tipY + dy;
      drawLinePixels(buf, w, h, midX - dy, y, midX, y, 1, c.highlight, false);
      drawLinePixels(buf, w, h, midX, y, midX + dy, y, 1, c.mid, false);
    }
    // Two-tone forged steel blade
    drawRectPixels(buf, w, h, midX - bladeHalf, tipY + bladeHalf, midX, guardY, 1, c.light, true, false);
    drawRectPixels(buf, w, h, midX + 1, tipY + bladeHalf, midX + bladeHalf, guardY, 1, c.shadow, true, false);
    drawLinePixels(buf, w, h, midX - bladeHalf, tipY + bladeHalf + 1, midX - bladeHalf, guardY - 1, 1, c.highlight, false);
    // Glowing fuller channel
    drawLinePixels(buf, w, h, midX, tipY + bladeHalf + 2, midX, guardY - 2, 1, c.accentBright, false);
    // Winged crossguard
    const guardHalf = Math.max(3, Math.round(w * 0.24));
    const guardH = Math.max(2, Math.round(h * 0.08));
    drawRectPixels(buf, w, h, midX - guardHalf, guardY, midX + guardHalf, guardY + guardH, 1, c.warm, true, false);
    drawLinePixels(buf, w, h, midX - guardHalf, guardY, midX + guardHalf, guardY, 1, c.highlight, false);
    // Wrapped grip
    const gripHalf = Math.max(1, Math.round(w * 0.05));
    const pommelY = py(0.84);
    drawRectPixels(buf, w, h, midX - gripHalf, guardY + guardH + 1, midX + gripHalf, pommelY, 1, c.shadow, true, false);
    // Pommel jewel
    const pomR = Math.max(2, Math.round(w * 0.08));
    drawEllipsePixels(buf, w, h, midX - pomR, pommelY, midX + pomR, Math.min(h - 2, pommelY + pomR * 2), 1, c.warm, true, false);
    setPx(buf, w, h, midX, pommelY + Math.max(1, Math.floor(pomR)), c.accentBright);
  } else if (id === 'potion-flask') {
    const midX = Math.round(cx);
    // Cork stopper
    drawRectPixels(buf, w, h, px(0.41), py(0.14), px(0.59), py(0.24), 1, c.warm, true, false);
    // Glass neck + rim
    drawRectPixels(buf, w, h, px(0.36), py(0.24), px(0.64), py(0.30), 1, c.light, true, false);
    drawRectPixels(buf, w, h, px(0.41), py(0.30), px(0.59), py(0.42), 1, c.mid, true, false);
    // Round glass body
    drawEllipsePixels(buf, w, h, px(0.22), py(0.38), px(0.78), py(0.86), 1, c.mid, true, false);
    // Glowing liquid lower 65%
    drawEllipsePixels(buf, w, h, px(0.26), py(0.50), px(0.74), py(0.83), 1, c.accent, true, false);
    drawEllipsePixels(buf, w, h, px(0.30), py(0.51), px(0.68), py(0.60), 1, c.accentBright, true, false);
    // Specular glass streak
    drawLinePixels(buf, w, h, px(0.31), py(0.48), px(0.31), py(0.66), 1, c.highlight, false);
    setPx(buf, w, h, midX - Math.max(2, Math.round(w * 0.14)), py(0.71), c.highlight);
  } else if (id === 'treasure-chest') {
    // Shadow
    drawEllipsePixels(buf, w, h, px(0.16), py(0.79), px(0.84), py(0.89), 1, c.shadow, true, false);
    // Base wooden box
    drawRectPixels(buf, w, h, px(0.18), py(0.48), px(0.82), py(0.82), 1, c.shadow, true, false);
    drawRectPixels(buf, w, h, px(0.20), py(0.50), px(0.76), py(0.79), 1, c.mid, true, false);
    // Arched lid
    drawEllipsePixels(buf, w, h, px(0.18), py(0.24), px(0.82), py(0.56), 1, c.warm, true, false);
    drawRectPixels(buf, w, h, px(0.18), py(0.44), px(0.82), py(0.52), 1, c.shadow, true, false);
    // Vertical metal trim straps
    const strapW = Math.max(1, Math.round(w * 0.06));
    drawRectPixels(buf, w, h, px(0.26), py(0.28), px(0.26) + strapW, py(0.81), 1, c.light, true, false);
    drawRectPixels(buf, w, h, px(0.74) - strapW, py(0.28), px(0.74), py(0.81), 1, c.light, true, false);
    // Bright gold lock clasp
    drawRectPixels(buf, w, h, px(0.44), py(0.45), px(0.56), py(0.60), 1, c.highlight, true, false);
    setPx(buf, w, h, Math.round(cx), py(0.53), c.ink);
  } else if (id === 'stone-pedestal') {
    drawEllipsePixels(buf, w, h, px(0.14), py(0.82), px(0.86), py(0.92), 1, c.ink, true, false);
    // Wide plinth
    drawRectPixels(buf, w, h, px(0.18), py(0.70), px(0.82), py(0.85), 1, c.shadow, true, false);
    drawRectPixels(buf, w, h, px(0.18), py(0.70), px(0.70), py(0.76), 1, c.mid, true, false);
    // Center altar pillar
    drawRectPixels(buf, w, h, px(0.26), py(0.42), px(0.74), py(0.71), 1, c.shadow, true, false);
    drawRectPixels(buf, w, h, px(0.26), py(0.42), px(0.62), py(0.69), 1, c.mid, true, false);
    // Stepped crown + beveled highlight
    drawRectPixels(buf, w, h, px(0.20), py(0.32), px(0.80), py(0.43), 1, c.mid, true, false);
    drawRectPixels(buf, w, h, px(0.20), py(0.32), px(0.72), py(0.37), 1, c.light, true, false);
    drawLinePixels(buf, w, h, px(0.21), py(0.32), px(0.70), py(0.32), 1, c.highlight, false);
  } else if (id === 'topdown-tree') {
    // Ground shadow
    drawEllipsePixels(buf, w, h, px(0.22), py(0.76), px(0.78), py(0.90), 1, c.shadow, true, false);
    // Trunk
    drawRectPixels(buf, w, h, px(0.41), py(0.54), px(0.59), py(0.82), 1, c.warm, true, false);
    drawRectPixels(buf, w, h, px(0.51), py(0.54), px(0.59), py(0.82), 1, c.shadow, true, false);
    // Layered foliage blobs
    drawEllipsePixels(buf, w, h, px(0.18), py(0.22), px(0.82), py(0.66), 1, c.shadow, true, false);
    drawEllipsePixels(buf, w, h, px(0.20), py(0.16), px(0.78), py(0.58), 1, c.accent, true, false);
    drawEllipsePixels(buf, w, h, px(0.24), py(0.14), px(0.62), py(0.42), 1, c.accentBright, true, false);
    drawEllipsePixels(buf, w, h, px(0.28), py(0.16), px(0.46), py(0.28), 1, c.highlight, true, false);
  } else {
    // dungeon-tile: seamless edge-to-edge beveled stone bricks
    drawRectPixels(buf, w, h, 0, 0, w - 1, h - 1, 1, c.mid, true, false);
    const halfY = Math.floor(h / 2);
    const halfX = Math.floor(w / 2);
    // Mortar grooves
    drawLinePixels(buf, w, h, 0, 0, w - 1, 0, 1, c.ink, false);
    drawLinePixels(buf, w, h, 0, halfY, w - 1, halfY, 1, c.ink, false);
    drawLinePixels(buf, w, h, 0, 0, 0, halfY, 1, c.ink, false);
    drawLinePixels(buf, w, h, halfX, halfY, halfX, h - 1, 1, c.ink, false);
    // Top-left stone bevel highlights
    drawLinePixels(buf, w, h, 1, 1, w - 2, 1, 1, c.light, false);
    drawLinePixels(buf, w, h, 1, halfY + 1, w - 2, halfY + 1, 1, c.light, false);
    // Bottom-right shadow bevels
    drawLinePixels(buf, w, h, 1, halfY - 1, w - 2, halfY - 1, 1, c.shadow, false);
    drawLinePixels(buf, w, h, 1, h - 1, w - 2, h - 1, 1, c.shadow, false);
  }

  if (shouldPolish) {
    polishLayerPixelArt(buf, w, h, {
      palette: palette.length > 0 ? [...palette] : undefined,
      selOut: true,
      shade: false,
      highlight: false,
      cleanDoubles: true,
    });
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
