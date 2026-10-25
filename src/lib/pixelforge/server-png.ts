// PixelForge AI — server-side PNG utilities (pngjs)
// Used by the MCP tool API to decode/encode layers and composite sprite sheets
// without a browser canvas.

import { PNG } from 'pngjs'
import type { SerializedFrame, SerializedLayer } from './types'

export interface RawImage {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export function decodePngDataUrl(dataUrl: string): RawImage {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const buf = Buffer.from(b64, 'base64')
  const png = PNG.sync.read(buf)
  return { width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data) }
}

export function encodePngDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string {
  const png = new PNG({ width, height })
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  const out = PNG.sync.write(png)
  return `data:image/png;base64,${out.toString('base64')}`
}

export function emptyBuffer(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4)
}

/** Composite a serialized frame (visible layers, bottom → top) into an RGBA buffer. */
export function compositeFrameServer(
  frame: SerializedFrame,
  w: number,
  h: number,
  layerCache?: Map<string, RawImage>
): Uint8ClampedArray {
  const out = emptyBuffer(w, h)
  for (const layer of frame.layers) {
    compositeLayerServer(out, layer, w, h, layerCache)
  }
  return out
}

function compositeLayerServer(
  dst: Uint8ClampedArray,
  layer: SerializedLayer,
  w: number,
  h: number,
  cache?: Map<string, RawImage>
): void {
  if (!layer.visible || layer.opacity <= 0) return
  let img = cache?.get(layer.id)
  if (!img) {
    img = decodePngDataUrl(layer.png)
    cache?.set(layer.id, img)
  }
  const src = img.rgba
  const sw = Math.min(img.width, w)
  const sh = Math.min(img.height, h)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = (y * img.width + x) * 4
      const sa = (src[si + 3] / 255) * layer.opacity
      if (sa <= 0) continue
      const di = (y * w + x) * 4
      const da = dst[di + 3] / 255
      const oa = sa + da * (1 - sa)
      if (oa <= 0) continue
      for (let ch = 0; ch < 3; ch++) {
        dst[di + ch] = Math.round((src[si + ch] * sa + dst[di + ch] * da * (1 - sa)) / oa)
      }
      dst[di + 3] = Math.round(oa * 255)
    }
  }
}

/** Build a sprite sheet (grid layout) from serialized frames. */
export function buildSheetServer(
  frames: SerializedFrame[],
  w: number,
  h: number,
  columns: number,
  padding: number
): { dataUrl: string; columns: number; rows: number } {
  const n = frames.length
  const cols = Math.max(1, Math.min(columns > 0 ? columns : n, n))
  const rows = Math.ceil(n / cols)
  const pad = Math.max(0, padding)
  const sheetW = cols * w + (cols + 1) * pad
  const sheetH = rows * h + (rows + 1) * pad
  const out = emptyBuffer(sheetW, sheetH)
  const cache = new Map<string, RawImage>()
  frames.forEach((frame, i) => {
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const ox = pad + cx * (w + pad)
    const oy = pad + cy * (h + pad)
    const composite = compositeFrameServer(frame, w, h, cache)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4
        const di = ((oy + y) * sheetW + (ox + x)) * 4
        out[di] = composite[si]
        out[di + 1] = composite[si + 1]
        out[di + 2] = composite[si + 2]
        out[di + 3] = composite[si + 3]
      }
    }
  })
  return { dataUrl: encodePngDataUrl(sheetW, sheetH, out), columns: cols, rows }
}
