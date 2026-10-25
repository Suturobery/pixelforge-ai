// PixelForge AI — AI candidate normalization pipeline (client side)
// Specify → Generate → Normalize → Pixel review → Animate → QA/export
// Normalization keeps exact dimensions + alpha channel via nearest-neighbor
// scaling, optional background removal and color quantization.

import { removeBackground, quantizeBuffer } from './color'

export interface NormalizeOptions {
  removeBg: boolean
  bgTolerance: number // 0..128
  quantize: boolean
  maxColors: number // 2..64
}

export const DEFAULT_NORMALIZE: NormalizeOptions = {
  removeBg: true,
  bgTolerance: 48,
  quantize: true,
  maxColors: 16,
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = src
  })
}

/**
 * Contain-fit an image into a w×h buffer using nearest-neighbor scaling,
 * then apply the normalization pipeline. Returns the editable RGBA buffer.
 */
export async function normalizeToBuffer(
  src: string,
  w: number,
  h: number,
  opts: NormalizeOptions
): Promise<Uint8ClampedArray> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D context unavailable')

  // Transparent letterbox, nearest-neighbor scaling (contain fit)
  ctx.imageSmoothingEnabled = false
  const scale = Math.min(w / img.width, h / img.height)
  const dw = Math.max(1, Math.round(img.width * scale))
  const dh = Math.max(1, Math.round(img.height * scale))
  const dx = Math.floor((w - dw) / 2)
  const dy = Math.floor((h - dh) / 2)
  ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh)

  const data = ctx.getImageData(0, 0, w, h)
  const buf = data.data

  if (opts.removeBg) {
    removeBackground(buf, w, h, opts.bgTolerance)
  }
  if (opts.quantize) {
    quantizeBuffer(buf, Math.max(2, Math.min(64, opts.maxColors)))
  }
  return new Uint8ClampedArray(buf)
}
