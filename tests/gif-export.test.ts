import { describe, expect, test } from 'bun:test'
import { encodeGifBytes } from '@/lib/pixelforge/export'

function containsRgbTriple(bytes: Uint8Array, r: number, g: number, b: number): boolean {
  for (let i = 0; i <= bytes.length - 3; i++) {
    if (bytes[i] === r && bytes[i + 1] === g && bytes[i + 2] === b) return true
  }
  return false
}

describe('Lossless Crisp Pixel-Art GIF Encoder', () => {
  test('preserves exact RGB888 pixel-art colors without rgb565 truncation and scales crisply via nearest-neighbor', async () => {
    // 4x4 sprite with exact Sweetie 16 colors that rgb565 would corrupt:
    // #1a1c2c (26,28,44), #38b764 (56,183,100), #73eff7 (115,239,247), #ffcd75 (255,205,117)
    const w = 4
    const h = 4
    const data = new Uint8ClampedArray(w * h * 4)
    const swatches: [number, number, number][] = [
      [26, 28, 44],
      [56, 183, 100],
      [115, 239, 247],
      [255, 205, 117],
    ]
    for (let i = 0; i < w * h; i++) {
      const [r, g, b] = swatches[i % swatches.length]!
      data[i * 4] = r
      data[i * 4 + 1] = g
      data[i * 4 + 2] = b
      data[i * 4 + 3] = 255
    }

    const bytes = await encodeGifBytes([{ width: w, height: h, data }], [100], { scale: 8, bg: '#101014' })

    // Verify GIF89a header + exact nearest-neighbor scaled dimensions (4*8 = 32 × 32)
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a')
    const gifW = bytes[6]! | (bytes[7]! << 8)
    const gifH = bytes[8]! | (bytes[9]! << 8)
    expect(gifW).toBe(32)
    expect(gifH).toBe(32)

    // Every single exact 8-bit RGB triple must appear verbatim in the GIF color table (zero rgb565 shift!)
    for (const [r, g, b] of swatches) {
      expect(containsRgbTriple(bytes, r, g, b)).toBe(true)
    }
  })

  test('supports 16x nearest-neighbor scaling and transparent background cleanly', async () => {
    const data = new Uint8ClampedArray(2 * 2 * 4)
    // Top-left solid pixel, rest transparent
    data[0] = 239
    data[1] = 125
    data[2] = 87
    data[3] = 255

    const bytes = await encodeGifBytes([{ width: 2, height: 2, data }], [83], { scale: 16, bg: 'transparent' })
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a')
    const gifW = bytes[6]! | (bytes[7]! << 8)
    const gifH = bytes[8]! | (bytes[9]! << 8)
    expect(gifW).toBe(32)
    expect(gifH).toBe(32)
    expect(containsRgbTriple(bytes, 239, 125, 87)).toBe(true)
  })
})
