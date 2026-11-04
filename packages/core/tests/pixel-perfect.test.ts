// Pixel-perfect freehand + dither fill — core pixel ops regression tests.
import { describe, expect, test } from 'bun:test'
import {
  beautifyLayer,
  floodFillDither,
  getPixel,
  harvestPalette,
  pixelPerfectStroke,
  type PixelPerfectState,
  stampBrush,
  type RGBA,
} from '../src/index'

const W = 8, H = 8
const A: RGBA = [255, 0, 0, 255]
const B: RGBA = [0, 255, 0, 255]
const CLEAR: RGBA = [0, 0, 0, 0]

function blank(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4)
}

const px = (buf: Uint8ClampedArray, x: number, y: number) => getPixel(buf, W, x, y)
const solid = (c: RGBA) => c[3] > 0

describe('pixel-perfect freehand', () => {
  test('diagonal-then-turn removes the corner pixel', () => {
    const buf = blank()
    const pp: PixelPerfectState = { p2: null, p1: { x: 0, y: 0 }, patch: new Map() }
    // stroke: (0,0) → (1,1) → (2,1) — without pp the corner (1,1) doubles
    pixelPerfectStroke(pp, { x: 1, y: 1 }, buf, W, H, A)
    pixelPerfectStroke(pp, { x: 2, y: 1 }, buf, W, H, A)
    expect(solid(px(buf, 0, 0))).toBe(true)
    expect(solid(px(buf, 1, 1))).toBe(false) // corner removed
    expect(solid(px(buf, 2, 1))).toBe(true)
  })

  test('straight runs paint every pixel', () => {
    const buf = blank()
    const pp: PixelPerfectState = { p2: null, p1: { x: 0, y: 0 }, patch: new Map() }
    pixelPerfectStroke(pp, { x: 3, y: 0 }, buf, W, H, A)
    for (let x = 0; x <= 3; x++) expect(solid(px(buf, x, 0))).toBe(true)
  })

  test('corner restore keeps the pixel the stroke crossed', () => {
    const buf = blank()
    // pre-existing pixel under the corner: white
    stampBrush(buf, W, H, 1, 1, 1, B, false, 'square')
    const pp: PixelPerfectState = { p2: null, p1: { x: 0, y: 0 }, patch: new Map() }
    pixelPerfectStroke(pp, { x: 1, y: 1 }, buf, W, H, A)
    pixelPerfectStroke(pp, { x: 2, y: 1 }, buf, W, H, A)
    expect(px(buf, 1, 1)).toEqual(B) // restored, not cleared
  })
})

describe('floodFillDither', () => {
  test('paints a 2x2 bayer checker between two colors', () => {
    const buf = blank()
    // all-green field, red flood with green dither partner
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) stampBrush(buf, W, H, x, y, 1, B, false, 'square')
    floodFillDither(buf, W, H, 0, 0, A, B)
    // (0,0) bayer 0 → a ; (1,0) bayer 2 → b ; (0,1) bayer 3 → b ; (1,1) bayer 1 → a
    expect(px(buf, 0, 0)).toEqual(A)
    expect(px(buf, 1, 0)).toEqual(B)
    expect(px(buf, 0, 1)).toEqual(B)
    expect(px(buf, 1, 1)).toEqual(A)
  })

  test('covers the whole connected region', () => {
    const buf = blank()
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) stampBrush(buf, W, H, x, y, 1, B, false, 'square')
    floodFillDither(buf, W, H, 4, 4, A, B)
    let a = 0, b = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = px(buf, x, y)
      if (c[0] === 255) a++; else b++
    }
    expect(a).toBe(32)
    expect(b).toBe(32)
  })
})

describe('beautifyLayer', () => {
  test('outlines every edge pixel and shades bottom/right inner edges', () => {
    const buf = blank()
    // 3x3 red square at (2,2)
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) stampBrush(buf, W, H, x, y, 1, A, false, 'square')
    const DARK: RGBA = [26, 28, 44, 255]
    const changed = beautifyLayer(buf, W, H, { outline: DARK, shade: true })
    expect(changed).toBe(true)
    // outline ring present on all 4 sides of the square
    expect(px(buf, 1, 3)).toEqual(DARK)   // left
    expect(px(buf, 5, 3)).toEqual(DARK)   // right
    expect(px(buf, 3, 1)).toEqual(DARK)   // top
    expect(px(buf, 3, 5)).toEqual(DARK)   // bottom
    // center untouched (interior, not edge)
    expect(px(buf, 3, 3)).toEqual(A)
    // shade: (4,4) is the bottom-right corner pixel → darkened 28%
    const shaded = px(buf, 4, 4)
    expect(shaded[0]).toBe(Math.round(255 * 0.72))
  })

  test('outline null skips outline, shade-only still works', () => {
    const buf = blank()
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) stampBrush(buf, W, H, x, y, 1, A, false, 'square')
    beautifyLayer(buf, W, H, { outline: null, shade: true })
    expect(px(buf, 1, 3)).toEqual(CLEAR) // no outline added
    const shaded = px(buf, 4, 4)
    expect(shaded[0]).toBe(Math.round(255 * 0.72))
  })
})

describe('harvestPalette', () => {
  test('extracts distinct colors sorted dark to light', () => {
    const buf = blank()
    // 3 solid blocks: dark red, mid green, light blue
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) stampBrush(buf, W, H, x, y, 1, [120, 10, 10, 255], false, 'square')
    for (let y = 0; y < 3; y++) for (let x = 3; x < 6; x++) stampBrush(buf, W, H, x, y, 1, [10, 200, 60, 255], false, 'square')
    for (let y = 0; y < 3; y++) for (let x = 6; x < 9; x++) stampBrush(buf, W, H, x, y, 1, [180, 220, 255, 255], false, 'square')
    const colors = harvestPalette(buf, 16)
    expect(colors.length).toBe(3)
    expect(colors[0]).toBe('#780a0a')  // darkest first
    expect(colors[2]).toBe('#b4dcff')  // lightest last
  })
})
