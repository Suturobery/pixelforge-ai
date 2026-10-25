import type { PixelGrid, Rig } from './types'
import { createGrid, hexToRgba, setPixel } from './sprite'
import { DEFAULT_Z, PART_LABELS } from './rig'
import type { PartRole } from './types'

function part(id: PartRole, rect: { x: number; y: number; w: number; h: number }) {
  return { id, role: id, label: PART_LABELS[id], rect, zOrder: DEFAULT_Z[id] }
}

function px(grid: PixelGrid, x: number, y: number, hex: string): void {
  setPixel(grid, x, y, hexToRgba(hex))
}

/**
 * Simple humanoid, 32x32, side-facing right.
 * 4px headroom (apex -3 fits), feet rest on row 27, static ground line at y=28.
 * Rect ownership rule: each rect contains its own pixels + 1-2 joint
 * columns/rows shared with the torso; no rect claims another limb's pixels.
 */
export function simpleHumanoid(): { grid: PixelGrid; rig: Rig } {
  const g = createGrid(32, 32)
  const skin = '#e8b796'
  const hair = '#4a3123'
  const shirt = '#3f7d4e'
  const shirtDark = '#2f5f3b'
  const pants = '#5a4a68'
  const boot = '#3a2f26'
  const eye = '#22242a'

  // head (x12..19, y4..10)
  for (let y = 4; y <= 10; y++) for (let x = 12; x <= 19; x++) px(g, x, y, skin)
  for (let x = 12; x <= 19; x++) { px(g, x, 4, hair); px(g, x, 5, hair) }
  px(g, 12, 6, hair); px(g, 19, 6, hair)
  px(g, 18, 7, eye) // facing right
  // torso (x11..20, y11..19)
  for (let y = 11; y <= 19; y++) for (let x = 11; x <= 20; x++) px(g, x, y, shirt)
  for (let x = 11; x <= 20; x++) px(g, x, 19, shirtDark)
  // far arm (x8..10, y11..18)
  for (let y = 11; y <= 18; y++) for (let x = 8; x <= 10; x++) px(g, x, y, shirtDark)
  // near arm (x21..23, y11..18)
  for (let y = 11; y <= 18; y++) for (let x = 21; x <= 23; x++) px(g, x, y, shirt)
  // far leg (x11..14, y18..27)
  for (let y = 18; y <= 27; y++) for (let x = 11; x <= 14; x++) px(g, x, y, pants)
  // near leg (x16..19, y18..27)
  for (let y = 18; y <= 27; y++) for (let x = 16; x <= 19; x++) px(g, x, y, pants)
  // boots
  for (let x = 11; x <= 14; x++) px(g, x, 27, boot)
  for (let x = 16; x <= 19; x++) px(g, x, 27, boot)
  // static ground line (never moves; R4 preservation check)
  for (let x = 3; x <= 28; x++) px(g, x, 28, '#3b4a36')

  const rig: Rig = {
    parts: [
      // far arm: own pixels x8..10 + joint col x11 (torso pixels)
      part('armR', { x: 8, y: 11, w: 4, h: 9 }),
      // far leg: own pixels x11..14 + joint rows y17..19 (torso pixels); does NOT claim arm col x10
      part('legR', { x: 11, y: 17, w: 4, h: 11 }),
      part('torso', { x: 11, y: 10, w: 10, h: 10 }),
      part('head', { x: 11, y: 4, w: 9, h: 7 }),
      // near leg: own pixels x16..19 + joint rows y17..19 (torso pixels; width matches far leg)
      part('legL', { x: 16, y: 17, w: 4, h: 11 }),
      // near arm: own pixels x21..23 + joint cols x19..20 (torso pixels; 2-col overlap enables strikes)
      part('armL', { x: 19, y: 10, w: 5, h: 9 }),
    ],
  }
  return { grid: g, rig }
}

/**
 * Detailed humanoid, 48x48, side-facing right: outline, shading, belt, sword,
 * static cape, hair. 9px headroom; feet on row 41; ground line y=42.
 * Sword is inside the near-arm rect so it moves with the hand.
 */
export function detailedHumanoid(): { grid: PixelGrid; rig: Rig } {
  const g = createGrid(48, 48)
  const outline = '#1a1622'
  const skin = '#f0c8a0'
  const skinShade = '#d8a878'
  const hair = '#7a3020'
  const hairLight = '#9a4830'
  const tunic = '#2e6f9e'
  const tunicDark = '#1f5075'
  const belt = '#6b4a2b'
  const buckle = '#d8b84a'
  const pants = '#4a3a58'
  const pantsDark = '#372a42'
  const boot = '#2f2620'
  const blade = '#c8ccd8'
  const bladeEdge = '#eef1f8'
  const hilt = '#8a5a2b'
  const cape = '#7a2430'
  const capeDark = '#5c1a24'

  // static cape (outside every part rect — preserved unchanged, R4)
  for (let y = 15; y <= 33; y++) for (let x = 8; x <= 11; x++) px(g, x, y, y % 3 === 0 ? capeDark : cape)

  // far leg (x18..22, y33..41) + boot
  for (let y = 33; y <= 41; y++) for (let x = 18; x <= 22; x++) px(g, x, y, y >= 41 ? boot : pantsDark)
  // near leg (x26..32, y33..41) + boot
  for (let y = 33; y <= 41; y++) for (let x = 26; x <= 32; x++) px(g, x, y, y >= 41 ? boot : pants)
  // torso (x16..34, y22..33)
  for (let y = 22; y <= 33; y++) for (let x = 16; x <= 34; x++) {
    px(g, x, y, y >= 31 ? tunicDark : tunic)
  }
  for (let x = 16; x <= 34; x++) { px(g, x, 22, outline); px(g, x, 33, outline) }
  for (let y = 22; y <= 33; y++) { px(g, 16, y, outline); px(g, 34, y, outline) }
  for (let x = 16; x <= 34; x++) { px(g, x, 30, belt); if (x === 25 || x === 26) px(g, x, 30, buckle) }
  // head (x19..32, y9..21)
  for (let y = 9; y <= 21; y++) for (let x = 19; x <= 32; x++) {
    px(g, x, y, x <= 20 ? skinShade : skin)
  }
  for (let x = 19; x <= 32; x++) { px(g, x, 9, outline); px(g, x, 10, hair); px(g, x, 11, hair) }
  for (let y = 12; y <= 14; y++) { px(g, 19, y, hair); px(g, 20, y, hair) }
  px(g, 32, 12, hairLight); px(g, 32, 13, hairLight)
  px(g, 31, 14, outline) // eye
  px(g, 30, 18, skinShade) // jaw shade
  // far arm (x13..15, y23..31) + far hand — drawn over the cape
  for (let y = 23; y <= 31; y++) for (let x = 13; x <= 15; x++) px(g, x, y, tunicDark)
  for (let x = 13; x <= 15; x++) px(g, x, 32, skinShade)
  // near arm (x35..39, y23..31) + near hand
  for (let y = 23; y <= 31; y++) for (let x = 35; x <= 39; x++) px(g, x, y, tunic)
  for (let x = 35; x <= 39; x++) { px(g, x, 32, skin); px(g, x, 23, outline) }
  // sword in near hand: hilt x38..40 y30, blade x41..45 rows 29(edge)/30
  px(g, 38, 30, hilt); px(g, 39, 30, hilt); px(g, 40, 30, hilt)
  for (let x = 41; x <= 45; x++) { px(g, x, 30, blade); px(g, x, 29, bladeEdge) }
  // ground
  for (let x = 4; x <= 43; x++) px(g, x, 42, '#3b4a36')

  const rig: Rig = {
    parts: [
      // far arm: own pixels x13..15 + joint col x16 (torso); cape x9..12 excluded
      part('armR', { x: 13, y: 22, w: 4, h: 11 }),
      // far leg: own pixels x18..22 + joint rows y31..33 (torso)
      part('legR', { x: 17, y: 31, w: 6, h: 11 }),
      part('torso', { x: 16, y: 21, w: 19, h: 13 }),
      part('head', { x: 19, y: 9, w: 14, h: 13 }),
      // near leg: own pixels x26..32 + joint cols x25..27 (torso)
      part('legL', { x: 25, y: 31, w: 8, h: 11 }),
      // near arm + hand + sword: joint cols x33..35 (2+ torso cols keep ±2 swings attached)
      part('armL', { x: 33, y: 22, w: 15, h: 11 }),
    ],
  }
  return { grid: g, rig }
}

/**
 * Non-humanoid: slime, 24x24. Only a body part (custom) + static ground.
 * Used to verify graceful degradation and honest "preset doesn't fit" QA.
 */
export function slime(): { grid: PixelGrid; rig: Rig } {
  const g = createGrid(24, 24)
  const body = '#59b359'
  const bodyDark = '#3d8a3d'
  const shine = '#a8e0a0'
  const eye = '#1d2b1d'

  // dome (y10..19)
  for (let y = 10; y <= 19; y++) {
    const inset = y <= 12 ? 6 : y <= 14 ? 4 : y <= 16 ? 2 : 0
    for (let x = 2 + inset; x <= 21 - inset; x++) {
      px(g, x, y, x % 5 === 0 ? bodyDark : body)
    }
  }
  px(g, 7, 12, shine); px(g, 8, 12, shine); px(g, 8, 13, shine)
  px(g, 9, 16, eye); px(g, 14, 16, eye)
  // static ground
  for (let x = 1; x <= 22; x++) px(g, x, 20, '#3b4a36')

  const rig: Rig = {
    parts: [
      // body mapped to the torso role so torso-driven presets (idle) work;
      // ground row y20 intentionally excluded from the rect
      { id: 'torso', role: 'torso', label: 'Body', rect: { x: 1, y: 9, w: 22, h: 11 }, zOrder: 2 },
    ],
  }
  return { grid: g, rig }
}

export type FixtureId = 'simple' | 'detailed' | 'slime'

export function getFixture(id: FixtureId): { grid: PixelGrid; rig: Rig; label: string } {
  switch (id) {
    case 'simple':
      return { ...simpleHumanoid(), label: 'Simple humanoid 32×32' }
    case 'detailed':
      return { ...detailedHumanoid(), label: 'Detailed humanoid 48×48' }
    case 'slime':
      return { ...slime(), label: 'Slime 24×24 (non-humanoid)' }
  }
}

export { px as fixturePx }
