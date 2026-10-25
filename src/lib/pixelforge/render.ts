// PixelForge AI — canvas rendering helpers (client side).
// Task 4: composites read the v2 model — a clip's layer stack (bottom → top)
// + the frame's cel per layer. An absent cel renders as fully transparent
// (C2), and linked layers naturally share their buffer object.

import type { Cel, Clip, Frame, Layer, Project } from './types'

let scratchCanvas: HTMLCanvasElement | null = null
// Second scratch for onion-skin ghosts: drawFrame's per-layer pass uses the
// FIRST scratch as staging, so ghost compositing needs its own buffer.
let ghostCanvas: HTMLCanvasElement | null = null

function getScratch(w: number, h: number): CanvasRenderingContext2D {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas')
  if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
    scratchCanvas.width = w
    scratchCanvas.height = h
  }
  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D context unavailable')
  return ctx
}

function getGhostScratch(w: number, h: number): HTMLCanvasElement {
  if (!ghostCanvas) ghostCanvas = document.createElement('canvas')
  if (ghostCanvas.width !== w || ghostCanvas.height !== h) {
    ghostCanvas.width = w
    ghostCanvas.height = h
  }
  return ghostCanvas
}

/** Draw one cel (of a clip layer) into a native-size 2D context (no clear). */
export function drawCelBuffer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  cel: Cel | undefined,
  w: number,
  h: number,
  alpha = 1
): void {
  if (!cel) return // absent cel = fully transparent (C2)
  const img = new ImageData(new Uint8ClampedArray(cel.buffer), w, h)
  const prev = ctx.globalAlpha
  ctx.globalAlpha = layer.visible ? layer.opacity * alpha : 0
  if (ctx.globalAlpha > 0) {
    const scratch = getScratch(w, h)
    scratch.clearRect(0, 0, w, h)
    scratch.putImageData(img, 0, 0)
    ctx.drawImage(scratchCanvas as HTMLCanvasElement, 0, 0)
  }
  ctx.globalAlpha = prev
}

/** One onion-skin ghost to draw beneath the active frame (Task 6 §4). */
export interface OnionGhost {
  frame: Frame
  /** 0 = immediate neighbor, growing for farther frames (fades alpha). */
  depth: number
  /** Which side of the playhead — picks the tint color. */
  dir: 'prev' | 'next'
  /** Tint color (css) applied uniformly to the ghost's opaque pixels. */
  tint: string
  /** Base opacity 0..1 before the per-depth fade. */
  opacity: number
}

/**
 * Onion ghost alpha: base opacity fading per depth (immediate neighbor at
 * full base, each farther step × 0.72, floored so ghosts stay visible).
 */
export function onionGhostAlpha(base: number, depth: number): number {
  return Math.max(0.06, base * Math.pow(0.72, depth))
}

/**
 * Composite a frame (visible layers of the clip stack, bottom → top) into a
 * native-size 2D context. Clears first. Optionally draws onion-skin ghosts
 * (same clip's prev/next frames, uniformly tinted, alpha-faded per depth).
 * Ghosts are drawn ONLY here — exports/thumbnails never pass them, so
 * onion-skin previews can never leak into exported artwork (Task 6 §4).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  frame: Frame,
  w: number,
  h: number,
  opts: { ghosts?: OnionGhost[] } = {}
): void {
  ctx.clearRect(0, 0, w, h)
  if (opts.ghosts) {
    for (const ghost of opts.ghosts) {
      const alpha = onionGhostAlpha(ghost.opacity, ghost.depth)
      if (alpha <= 0.01) continue
      // Composite the ghost frame on its own buffer, then flat-tint the
      // pixels it actually covers (source-atop keeps transparency intact).
      const gcanvas = getGhostScratch(w, h)
      const gctx = gcanvas.getContext('2d')
      if (!gctx) continue
      gctx.clearRect(0, 0, w, h)
      for (const layer of clip.layers) drawCelBuffer(gctx, layer, ghost.frame.cels[layer.id], w, h, 1)
      gctx.globalCompositeOperation = 'source-atop'
      gctx.globalAlpha = 1
      gctx.fillStyle = ghost.tint
      gctx.fillRect(0, 0, w, h)
      gctx.globalCompositeOperation = 'source-over'
      const prev = ctx.globalAlpha
      ctx.globalAlpha = alpha
      ctx.drawImage(gcanvas, 0, 0)
      ctx.globalAlpha = prev
    }
  }
  for (const layer of clip.layers) drawCelBuffer(ctx, layer, frame.cels[layer.id], w, h, 1)
}

/** Render a frame into a fresh private canvas at native size (nearest neighbor). */
function compositeToCanvas(clip: Clip, frame: Frame, w: number, h: number): HTMLCanvasElement {
  // Must be a PRIVATE canvas: drawFrame → drawCelBuffer reuses the shared
  // getScratch() as its per-layer staging buffer and clears it each layer, so
  // compositing INTO that scratch would keep only the top layer's pixels
  // (multi-layer frames rendered blank in thumbnails/preview/exports).
  const local = document.createElement('canvas')
  local.width = w
  local.height = h
  const ctx = local.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  drawFrame(ctx, clip, frame, w, h)
  return local
}

/** Render a frame into a destination canvas at an arbitrary square-ish size (nearest neighbor). */
export function renderFrameScaled(
  dest: HTMLCanvasElement,
  clip: Clip,
  frame: Frame,
  w: number,
  h: number
): void {
  const ctx = dest.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, dest.width, dest.height)
  const local = compositeToCanvas(clip, frame, w, h)
  ctx.drawImage(local, 0, 0, w, h, 0, 0, dest.width, dest.height)
}

/** Encode a frame composite as a PNG data URL. */
export function frameToPng(clip: Clip, frame: Frame, w: number, h: number): string {
  return compositeToCanvas(clip, frame, w, h).toDataURL('image/png')
}

/** Encode a single RGBA buffer as a PNG data URL (cel/DB-adapter helper). */
export function celToPngDataUrl(buffer: Uint8ClampedArray, w: number, h: number): string {
  const scratch = getScratch(w, h)
  scratch.clearRect(0, 0, w, h)
  const img = new ImageData(new Uint8ClampedArray(buffer), w, h)
  scratch.putImageData(img, 0, 0)
  return (scratchCanvas as HTMLCanvasElement).toDataURL('image/png')
}

/**
 * Decode a PNG data URL into an RGBA buffer at the requested size.
 * (Still used by AI normalize flows; the project-load path now goes through
 * the core v1 importer, which decodes PNGs without the DOM.)
 */
export async function pngToBuffer(png: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const img = new Image()
  img.src = png
  await img.decode()
  const scratch = getScratch(w, h)
  scratch.clearRect(0, 0, w, h)
  scratch.imageSmoothingEnabled = false
  scratch.drawImage(img, 0, 0, w, h)
  const data = scratch.getImageData(0, 0, w, h)
  return new Uint8ClampedArray(data.data)
}

/** Re-exported convenience for callers that already hold a Project. */
export type { Project }
