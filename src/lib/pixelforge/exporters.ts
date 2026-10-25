'use client'

import type { PixelGrid } from './types'
import { getPixel } from './sprite'

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
  opts: { scale?: number; checker?: boolean } = {}
): Promise<void> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const scale = opts.scale ?? 6
  const canvases = frames.map((f) => gridToCanvas(f, { scale, checker: opts.checker ?? true }))
  const ctxs = canvases.map((c) => c.getContext('2d') as CanvasRenderingContext2D)
  const rgba = ctxs.map((ctx, i) =>
    new Uint8Array(ctx.getImageData(0, 0, canvases[i].width, canvases[i].height).data)
  )
  const gif = GIFEncoder()
  const palette = quantize(rgba[0], 64)
  for (let i = 0; i < rgba.length; i++) {
    const indexed = applyPalette(rgba[i], palette)
    gif.writeFrame(indexed, canvases[i].width, canvases[i].height, {
      palette,
      delay: durations[i],
      dispose: 2,
    })
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
