'use client'

import type { PixelGrid } from './types'
import { getPixel } from './sprite'
import { hexToRgba } from './color'

/** Draw a grid to a canvas with optional checkerboard behind transparency. */
export function gridToCanvas(
  grid: PixelGrid,
  opts: { scale?: number; checker?: boolean; checkerSize?: number } = {}
): HTMLCanvasElement {
  const scale = opts.scale ?? 1
  const canvas = document.createElement('canvas')
  canvas.width = grid.width * scale
  canvas.height = grid.height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const img = ctx.createImageData(canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const c = getPixel(grid, Math.floor(x / scale), Math.floor(y / scale))
      const i = (y * canvas.width + x) * 4
      let r = c.r, g = c.g, b = c.b, a = c.a
      if (opts.checker && a < 255) {
        const size = (opts.checkerSize ?? 4) * scale
        const light = ((Math.floor(x / size) + Math.floor(y / size)) % 2) === 0
        const bg = light ? 235 : 205
        const alpha = a / 255
        r = Math.round(c.r * alpha + bg * (1 - alpha))
        g = Math.round(c.g * alpha + bg * (1 - alpha))
        b = Math.round(c.b * alpha + bg * (1 - alpha))
        a = 255
      }
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = a
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }, 'image/png')
}

export function exportFramePng(
  grid: PixelGrid,
  filename: string,
  opts: { scale?: number; checker?: boolean } = {}
): void {
  downloadCanvas(gridToCanvas(grid, opts), filename)
}

/** Horizontal sprite sheet of all frames. */
export function exportSheetPng(
  frames: PixelGrid[],
  filename: string,
  opts: { scale?: number; checker?: boolean; padding?: number } = {}
): void {
  const scale = opts.scale ?? 4
  const pad = (opts.padding ?? 1) * scale
  const w = frames.reduce((a, f) => a + f.width * scale + pad, pad)
  const h = Math.max(...frames.map((f) => f.height)) * scale + pad * 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (opts.checker) {
    const size = 4 * scale
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        ctx.fillStyle = ((x / size + y / size) % 2) === 0 ? '#ebebeb' : '#cdcdcd'
        ctx.fillRect(x, y, size, size)
      }
    }
  }
  let cursor = pad
  for (const f of frames) {
    const c = gridToCanvas(f, { scale, checker: opts.checker })
    ctx.drawImage(c, cursor, pad)
    cursor += c.width + pad
  }
  downloadCanvas(canvas, filename)
}

/** Animated GIF via gifenc (browser). Returns filename written. */
export async function exportGif(
  frames: PixelGrid[],
  durations: number[],
  filename: string,
  opts: { scale?: number; checker?: boolean; bg?: string } = {}
): Promise<void> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const scale = opts.scale ?? 6
  // GIF has 1-bit alpha only, so semi-transparent pixels can never survive:
  // flatten every frame onto a solid background (same as the agent export_gif
  // tool) — raw semi-transparent pixels otherwise render as opaque mud.
  // bg 'transparent' instead spreads soft alpha as an ordered dither of
  // fully opaque / fully transparent pixels (pixel-art glow stays soft).
  const transparent = opts.bg === 'transparent'
  const bg = hexToRgba(!transparent && opts.bg ? opts.bg : '#101014')
  const canvases = frames.map((f) => gridToCanvas(f, { scale, checker: opts.checker ?? false }))
  const ctxs = canvases.map((c) => c.getContext('2d') as CanvasRenderingContext2D)
  const rgba = ctxs.map((ctx, i) =>
    new Uint8Array(ctx.getImageData(0, 0, canvases[i].width, canvases[i].height).data)
  )
  // 4x4 Bayer matrix for the transparency dither
  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ]
  for (let i = 0; i < rgba.length; i++) {
    const px = rgba[i]
    const w = canvases[i].width
    for (let p = 0, n = 0; p < px.length; p += 4, n++) {
      const a = px[p + 3] / 255
      if (transparent) {
        // floor: sub-dither alpha (faint ambient glow) is invisible over a
        // real background but dithers into uniform dot noise across the frame
        const y = Math.floor(n / w)
        const t = Math.max((BAYER[y & 3][n % w & 3] + 0.5) / 16, 0.04)
        px[p + 3] = a > t ? 255 : 0
      } else {
        px[p] = Math.round(px[p] * a + bg[0] * (1 - a))
        px[p + 1] = Math.round(px[p + 1] * a + bg[1] * (1 - a))
        px[p + 2] = Math.round(px[p + 2] * a + bg[2] * (1 - a))
        px[p + 3] = 255
      }
    }
  }
  const gif = GIFEncoder()
  for (let i = 0; i < rgba.length; i++) {
    // 256 colors PER FRAME (a frame-0 palette smeared later frames of
    // glowing VFX into mud); opaque frames → rgb565 = best color fidelity
    const palette = quantize(rgba[i], transparent ? 255 : 256, { format: 'rgb565' })
    const indexed = applyPalette(rgba[i], palette, 'rgb565')
    // gifenc ships no type declarations
    const frameOpts: {
      palette: number[][]
      delay: number
      dispose: number
      transparent?: boolean
      transparentIndex?: number
    } = { palette, delay: durations[i], dispose: 2 }
    if (transparent) {
      // reserve one hard-transparent slot for dithered-out pixels
      palette.push([0, 0, 0])
      const ti = palette.length - 1
      const px = rgba[i]
      for (let p = 0; p < px.length; p += 4) {
        if (px[p + 3] === 0) indexed[p / 4] = ti
      }
      frameOpts.transparent = true
      frameOpts.transparentIndex = ti
    }
    gif.writeFrame(indexed, canvases[i].width, canvases[i].height, frameOpts)
  }
  gif.finish()
  const blob = new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
