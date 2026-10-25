// PixelForge AI — server-side image transforms (pure TS, no DOM/canvas)
// Used by the MCP tool API to normalize generated images before they become layers.

import { decodePngDataUrl, type RawImage } from './server-png'

/**
 * Decode an AI-generated base64 image payload into raw RGBA.
 *
 * The image service usually answers with JPEG bytes even though the data URL is
 * labeled "image/png", which pngjs cannot parse — so the format is sniffed from
 * the magic bytes: PNG goes through pngjs (fast path), everything else (JPEG,
 * WebP, …) through sharp (already a project dependency). Alpha is ensured so
 * downstream quantization/background removal see a uniform RGBA buffer.
 */
export async function decodeGeneratedImage(dataUrl: string): Promise<RawImage> {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const buf = Buffer.from(b64, 'base64')
  if (buf.length > 1 && buf[0] === 0x89 && buf[1] === 0x50) {
    return decodePngDataUrl(dataUrl) // PNG magic: \x89PNG
  }
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) }
}

/**
 * Nearest-neighbor "contain fit" resize with transparent letterbox.
 *
 * The source is scaled by the largest ratio that fits inside targetW × targetH
 * (no cropping), centered, and sampled with nearest-neighbor to keep pixel
 * edges crisp. Pixels not covered by the scaled source remain transparent.
 * Returns a fresh targetW × targetH RGBA buffer; the source is not mutated.
 */
export function resizeContainNN(src: RawImage, targetW: number, targetH: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(targetW * targetH * 4)
  if (src.width <= 0 || src.height <= 0 || targetW <= 0 || targetH <= 0) return out

  const scale = Math.min(targetW / src.width, targetH / src.height)
  const dw = Math.max(1, Math.min(targetW, Math.round(src.width * scale)))
  const dh = Math.max(1, Math.min(targetH, Math.round(src.height * scale)))
  const ox = Math.floor((targetW - dw) / 2)
  const oy = Math.floor((targetH - dh) / 2)

  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw))
      const si = (sy * src.width + sx) * 4
      const di = ((oy + y) * targetW + (ox + x)) * 4
      out[di] = src.rgba[si]
      out[di + 1] = src.rgba[si + 1]
      out[di + 2] = src.rgba[si + 2]
      out[di + 3] = src.rgba[si + 3]
    }
  }
  return out
}
