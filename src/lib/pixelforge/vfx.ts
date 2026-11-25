// PixelForge AI — pixelfx integration (MIT, github:patch-gg/pixelfx pinned
// a841596 / v0.3.0 — install from GitHub, not npm registry). Deterministic
// procedural VFX rendered headless (pure JS buffers, no DOM) into either a
// standalone clip OR directly onto the current sprite clip as depth-wrapped
// Back + Front layers — one undoable CommandBus transaction.

import { remapBufferToPalette, type CommandOrigin } from '@pixelforge/core'
import { getBus, useEditor } from './store'
import { followCommandTarget } from './mcp-follow'
import { loadCatalog, resolveVfxEffect } from './vfx-catalog'

export { listVfx, listVfxCategories, resolveVfxEffect } from './vfx-catalog'
export type { VfxEffectInfo } from './vfx-catalog'

const MAX_FRAMES = 64

export type VfxTarget = 'new_clip' | 'current_clip'
export type VfxDepthMode = 'combined' | 'split' | 'front' | 'back'

export interface VfxRenderOptions {
  /** Catalog id OR a vague name — resolved by the app ("campfire" works). */
  effect: string
  seed?: number
  /** Default: matches current clip frame count (for current_clip) or meta.duration * fps (clamped 1..64). */
  frames?: number
  fps?: number
  /** Explicit dark→bright hex ramp, the string "project" (project palette sorted
   * dark→bright), or undefined — which AUTO-USES the project palette when Style Lock
   * is enabled (the app stays on-style by default). */
  palette?: string[] | 'project'
  /** 'fit' = render at native effect size then scale (default). 'crop' = render
   * directly at canvas size — tighter composition. */
  fit?: 'fit' | 'crop'
  /** Additive-light intensity 0..1 (default 0.72 in crisp mode, 1 in soft mode). Lower = subtler glow. */
  light?: number
  /** Placement on the canvas (canvas coords). Default: effect origin, fitted. */
  x?: number
  y?: number
  /** Clip name (for new_clip) or base layer name (for current_clip). */
  name?: string
  /** Where to commit the rendered VFX:
   * - 'new_clip' (default): creates a standalone clip
   * - 'current_clip': adds VFX layer(s) directly onto the active/specified clip! */
  target?: VfxTarget
  /** Optional clip id when target === 'current_clip'. Defaults to active clip. */
  clipId?: string
  /** Depth layering strategy:
   * - 'split': separate Back (index 0, behind sprite) and Front (top, over sprite) layers via pixelfx back/front passes
   * - 'back': single layer placed behind all sprite layers (index 0)
   * - 'front': single layer placed on top of all sprite layers
   * - 'combined': single layer on top with merged back+front pass */
  depth?: VfxDepthMode
  /** Authentic pixel-art post-processing: nearest-center sampling + crisp alpha cutoff +
   * OKLab nearest-palette lock when a palette ramp is active. Default: true. */
  crispPixelArt?: boolean
  /** Alpha cutoff (1..254) used when crispPixelArt is true. Default: 96. */
  alphaThreshold?: number
  /** Pre-roll update ticks before frame 0 so looping effects start alive (no empty frame 1).
   * 'auto' (default) runs 12 warmup ticks for loop:true effects and 0 for one-shots. */
  warmup?: number | 'auto'
  /** CommandBus origin ('ui' | 'mcp'). Defaults to 'mcp'. */
  origin?: CommandOrigin
}

export interface VfxRenderedSequence {
  resolvedEffect: string
  paletteApplied: 'project' | 'custom' | 'effect-default'
  fps: number
  loop: boolean
  warmupUsed: number
  crispPixelArt: boolean
  backFrames: Uint8ClampedArray[]
  frontFrames: Uint8ClampedArray[]
  combinedFrames: Uint8ClampedArray[]
}

export interface VfxRenderResult {
  ok: boolean
  error?: { code: string; message: string; hint?: string }
  clipId?: string
  clipName?: string
  target?: VfxTarget
  depth?: VfxDepthMode
  createdLayerIds?: string[]
  frames?: number
  fps?: number
  previewPng?: string
  /** What the app resolved the (possibly vague) request to — transparency. */
  resolvedEffect?: string
  paletteApplied?: 'project' | 'custom' | 'effect-default'
  crispPixelArt?: boolean
  warmupUsed?: number
}

function luminance(hex: string): number {
  const m = hex.replace('#', '')
  const n = m.length >= 6 ? parseInt(m.slice(0, 6), 16) : parseInt(m.replace(/(.)/g, '$1$1').slice(0, 6), 16)
  if (Number.isNaN(n)) return 0
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
}

/** Nearest-center pixel-art resampling — preserves sharp pixels at any size ratio. */
function nearestDownsample(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4)
  if (sw === dw && sh === dh) {
    out.set(src)
    return out
  }
  const sx = sw / dw
  const sy = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const y = Math.min(sh - 1, Math.floor((dy + 0.5) * sy))
    for (let dx = 0; dx < dw; dx++) {
      const x = Math.min(sw - 1, Math.floor((dx + 0.5) * sx))
      const si = (y * sw + x) * 4
      const di = (dy * dw + dx) * 4
      out[di] = src[si]!
      out[di + 1] = src[si + 1]!
      out[di + 2] = src[si + 2]!
      out[di + 3] = src[si + 3]!
    }
  }
  return out
}

/** Downsample: exact integer ratios use nearest-center sampling; others box-average (soft glow mode). */
function boxDownsample(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4)
  if (sw === dw && sh === dh) {
    out.set(src)
    return out
  }
  if (sw % dw === 0 && sh % dh === 0) {
    const rx = sw / dw, ry = sh / dh
    for (let dy = 0; dy < dh; dy++) for (let dx = 0; dx < dw; dx++) {
      const si = ((dy * ry + (ry >> 1)) * sw + (dx * rx + (rx >> 1))) * 4
      const di = (dy * dw + dx) * 4
      out[di] = src[si]!; out[di + 1] = src[si + 1]!; out[di + 2] = src[si + 2]!; out[di + 3] = src[si + 3]!
    }
    return out
  }
  const sx = sw / dw, sy = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      const x0 = Math.floor(dx * sx), x1 = Math.max(x0 + 1, Math.floor((dx + 1) * sx))
      const y0 = Math.floor(dy * sy), y1 = Math.max(y0 + 1, Math.floor((dy + 1) * sy))
      for (let y = y0; y < y1 && y < sh; y++) {
        for (let x = x0; x < x1 && x < sw; x++) {
          const i = (y * sw + x) * 4
          r += src[i]!; g += src[i + 1]!; b += src[i + 2]!; a += src[i + 3]!; n++
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
    }
  }
  return out
}

function postProcessVfxFrame(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  crispPixelArt: boolean,
  alphaThreshold: number,
  paletteRamp?: string[],
): Uint8ClampedArray {
  if (!crispPixelArt) {
    return boxDownsample(src, sw, sh, dw, dh)
  }
  const out = nearestDownsample(src, sw, sh, dw, dh)
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3]! < alphaThreshold) {
      out[i] = 0
      out[i + 1] = 0
      out[i + 2] = 0
      out[i + 3] = 0
    } else {
      out[i + 3] = 255
    }
  }
  if (paletteRamp && paletteRamp.length >= 2) {
    remapBufferToPalette(out, paletteRamp, { mode: 'nearest' })
  }
  return out
}

function hasOpaquePixels(frames: Uint8ClampedArray[]): boolean {
  for (const buf of frames) {
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i]! > 0) return true
    }
  }
  return false
}

function resolvePaletteRamp(
  optsPalette: string[] | 'project' | undefined,
  projectPalette: string[],
  styleLocked: boolean,
): { ramp?: string[]; applied: 'project' | 'custom' | 'effect-default' } {
  if (Array.isArray(optsPalette) && optsPalette.length >= 2) {
    return { ramp: optsPalette, applied: 'custom' }
  }
  if (optsPalette === 'project' || styleLocked) {
    const ramp = [...projectPalette].sort((a, b) => luminance(a) - luminance(b))
    if (ramp.length >= 2) {
      return { ramp, applied: 'project' }
    }
  }
  return { ramp: undefined, applied: 'effect-default' }
}

/**
 * Pure, zero-mutation renderer shared by both live VFX Studio preview AND
 * CommandBus commit (generateVfx) — what you preview is byte-identical to
 * what gets committed!
 */
export async function previewVfxFrames(
  opts: VfxRenderOptions,
  w: number,
  h: number,
  projectPalette: string[] = [],
  styleLocked = false,
): Promise<VfxRenderedSequence> {
  const resolved = await resolveVfxEffect(opts.effect)
  if (!resolved.id) {
    const hint = resolved.suggestions?.join(', ') ?? 'call list_vfx'
    throw new Error(`No VFX matches "${opts.effect}". Closest ids: ${hint}.`)
  }
  const effects = await loadCatalog()
  const mod = effects[resolved.id]
  if (!mod?.meta) throw new Error(`Unknown effect "${resolved.id}".`)

  const { createFrame, clearFrame, createFx, composite } = await import('pixelfx')
  const fps = Math.max(1, Math.min(60, Math.round(opts.fps ?? 12)))
  const metaDuration = mod.meta.duration ?? 1
  const frameCount = Math.max(1, Math.min(MAX_FRAMES, Math.round(opts.frames ?? Math.ceil(metaDuration * fps))))
  const dt = 1 / fps
  const crispPixelArt = opts.crispPixelArt ?? true
  const alphaThreshold = Math.max(1, Math.min(254, Math.round(opts.alphaThreshold ?? 96)))
  const lightK = Math.max(0, Math.min(1, opts.light ?? (crispPixelArt ? 0.72 : 1)))
  const isLoop = Boolean(mod.meta.loop)
  const warmupUsed =
    typeof opts.warmup === 'number'
      ? Math.max(0, Math.min(64, Math.round(opts.warmup)))
      : isLoop
        ? 12
        : 0

  const { ramp, applied: paletteApplied } = resolvePaletteRamp(opts.palette, projectPalette, styleLocked)

  // Effects are authored at meta.size — render at native size then scale unless crop requested.
  const crop = opts.fit === 'crop'
  const nativeW = crop ? w : Math.max(w, Math.round(mod.meta.size?.[0] ?? w))
  const nativeH = crop ? h : Math.max(h, Math.round(mod.meta.size?.[1] ?? h))
  const originX = mod.meta.origin?.[0] ?? nativeW / 2
  const originY = mod.meta.origin?.[1] ?? nativeH
  const fx = createFx(mod as never, {
    x: Math.round(opts.x !== undefined ? (opts.x / w) * nativeW : (crop ? w / 2 : originX)),
    y: Math.round(opts.y !== undefined ? (opts.y / h) * nativeH : (crop ? h * 0.7 : originY)),
    seed: opts.seed ?? 1,
    ...(ramp && ramp.length >= 2 ? { palette: ramp } : {}),
  })

  const backFrame = createFrame(nativeW, nativeH)
  const frontFrame = createFrame(nativeW, nativeH)
  const combinedFrame = createFrame(nativeW, nativeH)
  const backOut = new Uint8ClampedArray(nativeW * nativeH * 4)
  const frontOut = new Uint8ClampedArray(nativeW * nativeH * 4)
  const combinedOut = new Uint8ClampedArray(nativeW * nativeH * 4)

  for (let pre = 0; pre < warmupUsed; pre++) {
    fx.update(dt)
  }

  const backFrames: Uint8ClampedArray[] = []
  const frontFrames: Uint8ClampedArray[] = []
  const combinedFrames: Uint8ClampedArray[] = []

  for (let i = 0; i < frameCount; i++) {
    fx.update(dt)

    clearFrame(backFrame)
    fx.draw(backFrame, 'back')
    backOut.fill(0)
    composite(backFrame, backOut, null, lightK)
    backFrames.push(postProcessVfxFrame(backOut, nativeW, nativeH, w, h, crispPixelArt, alphaThreshold, ramp))

    clearFrame(frontFrame)
    fx.draw(frontFrame, 'front')
    frontOut.fill(0)
    composite(frontFrame, frontOut, null, lightK)
    frontFrames.push(postProcessVfxFrame(frontOut, nativeW, nativeH, w, h, crispPixelArt, alphaThreshold, ramp))

    clearFrame(combinedFrame)
    fx.draw(combinedFrame, 'back')
    fx.draw(combinedFrame, 'front')
    combinedOut.fill(0)
    composite(combinedFrame, combinedOut, null, lightK)
    combinedFrames.push(postProcessVfxFrame(combinedOut, nativeW, nativeH, w, h, crispPixelArt, alphaThreshold, ramp))
  }

  return {
    resolvedEffect: resolved.id,
    paletteApplied,
    fps,
    loop: isLoop,
    warmupUsed,
    crispPixelArt,
    backFrames,
    frontFrames,
    combinedFrames,
  }
}

/** Alpha-over helper for live composited previews (pure, non-mutating). */
export function alphaOverRgba(bottom: Uint8ClampedArray, top: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bottom)
  for (let i = 0; i < out.length; i += 4) {
    const sa = top[i + 3]! / 255
    if (sa <= 0) continue
    if (sa >= 1 || out[i + 3]! === 0) {
      out[i] = top[i]!
      out[i + 1] = top[i + 1]!
      out[i + 2] = top[i + 2]!
      out[i + 3] = top[i + 3]!
      continue
    }
    const da = out[i + 3]! / 255
    const oa = sa + da * (1 - sa)
    out[i] = Math.round((top[i]! * sa + out[i]! * da * (1 - sa)) / oa)
    out[i + 1] = Math.round((top[i + 1]! * sa + out[i + 1]! * da * (1 - sa)) / oa)
    out[i + 2] = Math.round((top[i + 2]! * sa + out[i + 2]! * da * (1 - sa)) / oa)
    out[i + 3] = Math.round(oa * 255)
  }
  return out
}

export async function generateVfx(opts: VfxRenderOptions, beforeCommit?: () => void): Promise<VfxRenderResult> {
  try {
    const bus = getBus()
    const project = bus.getProject()
    const target: VfxTarget = opts.target ?? 'new_clip'
    const depth: VfxDepthMode = opts.depth ?? (target === 'current_clip' ? 'split' : 'combined')
    const origin: CommandOrigin = opts.origin ?? 'mcp'

    // Resolve target clip if overlaying onto an existing clip
    const activeClipId = useEditor.getState().activeClipId
    const existingClip =
      target === 'current_clip'
        ? (opts.clipId ? project.clips.find((c) => c.id === opts.clipId) : undefined) ??
          project.clips.find((c) => c.id === activeClipId) ??
          project.clips[0]
        : undefined
    if (target === 'current_clip' && !existingClip) {
      return {
        ok: false,
        error: { code: 'vfx_no_clip', message: 'No clip found to apply VFX onto.' },
      }
    }

    // ---- the APP owns accuracy: resolve fuzzy names, auto palette ---------
    let resolvedId = ''
    let suggestions: string[] | undefined
    try {
      const r = await resolveVfxEffect(opts.effect)
      resolvedId = r.id
      suggestions = r.suggestions
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Invalid effect name.')
    }
    if (!resolvedId) {
      return {
        ok: false,
        error: {
          code: 'vfx_unknown_effect',
          message: `No VFX matches "${opts.effect}".`,
          hint: `Closest ids: ${suggestions?.join(', ') ?? 'call list_vfx'}.`,
        },
      }
    }

    const profile = project.settings.styleProfile
    const styleLocked = Boolean(profile?.enabled && profile.paletteMode !== 'none')
    const fps = opts.fps ?? (target === 'current_clip' ? existingClip?.fps ?? 12 : 12)
    // Match current clip frame count automatically when overlaying onto an animated clip;
    // for a 1-frame static sprite, default to 12 frames so the VFX plays smoothly!
    const desiredFrames =
      opts.frames ??
      (target === 'current_clip' && existingClip
        ? existingClip.frames.length > 1
          ? existingClip.frames.length
          : 12
        : undefined)

    const seq = await previewVfxFrames(
      { ...opts, effect: resolvedId, fps, frames: desiredFrames },
      project.width,
      project.height,
      project.palette,
      styleLocked,
    )

    const shortName = resolvedId.split('/').pop() ?? 'vfx'
    const baseName = (opts.name ?? (target === 'current_clip' ? `VFX ${shortName}` : `vfx-${shortName}`)).trim().slice(0, 120) || 'vfx'

    beforeCommit?.()

    const writeFramesToLayer = (clipId: string, layerId: string, buffers: Uint8ClampedArray[]) => {
      const live = bus.getProject().clips.find((c) => c.id === clipId)!
      for (let idx = 0; idx < live.frames.length; idx++) {
        const frame = live.frames[idx]!
        const buf = buffers[idx % buffers.length]!
        bus.execute(
          'pixels.applyOp',
          { clipId, frameId: frame.id, layerId, ops: [{ op: 'setBuffer', buffer: buf }] },
          origin,
        )
      }
    }

    const commitLayersForClip = (clipId: string): string[] => {
      const created: string[] = []
      if (depth === 'split') {
        const hasBack = hasOpaquePixels(seq.backFrames)
        const hasFront = hasOpaquePixels(seq.frontFrames)
        if (hasBack) {
          bus.execute('layer.add', { clipId, name: `${baseName} (Back)` }, origin)
          const backLayer = bus.getProject().clips.find((c) => c.id === clipId)!.layers.slice(-1)[0]!
          bus.execute('layer.reorder', { clipId, layerId: backLayer.id, to: 0 }, origin)
          writeFramesToLayer(clipId, backLayer.id, seq.backFrames)
          created.push(backLayer.id)
        }
        if (hasFront) {
          bus.execute('layer.add', { clipId, name: `${baseName} (Front)` }, origin)
          const frontLayer = bus.getProject().clips.find((c) => c.id === clipId)!.layers.slice(-1)[0]!
          writeFramesToLayer(clipId, frontLayer.id, seq.frontFrames)
          created.push(frontLayer.id)
        }
        if (created.length === 0) {
          bus.execute('layer.add', { clipId, name: baseName }, origin)
          const fallbackLayer = bus.getProject().clips.find((c) => c.id === clipId)!.layers.slice(-1)[0]!
          writeFramesToLayer(clipId, fallbackLayer.id, seq.combinedFrames)
          created.push(fallbackLayer.id)
        }
      } else if (depth === 'back') {
        bus.execute('layer.add', { clipId, name: `${baseName} (Back)` }, origin)
        const backLayer = bus.getProject().clips.find((c) => c.id === clipId)!.layers.slice(-1)[0]!
        bus.execute('layer.reorder', { clipId, layerId: backLayer.id, to: 0 }, origin)
        writeFramesToLayer(clipId, backLayer.id, seq.combinedFrames)
        created.push(backLayer.id)
      } else if (depth === 'front') {
        bus.execute('layer.add', { clipId, name: `${baseName} (Front)` }, origin)
        const frontLayer = bus.getProject().clips.find((c) => c.id === clipId)!.layers.slice(-1)[0]!
        writeFramesToLayer(clipId, frontLayer.id, seq.combinedFrames)
        created.push(frontLayer.id)
      } else {
        bus.execute('layer.add', { clipId, name: target === 'new_clip' ? 'vfx' : baseName }, origin)
        const layer = bus.getProject().clips.find((c) => c.id === clipId)!.layers.slice(-1)[0]!
        writeFramesToLayer(clipId, layer.id, seq.combinedFrames)
        created.push(layer.id)
      }
      return created
    }

    let resultClipId = ''
    let createdLayerIds: string[] = []

    if (target === 'current_clip' && existingClip) {
      const clipId = existingClip.id
      const res = await bus.transaction(`Apply VFX "${resolvedId}" to "${existingClip.name}"`, origin, () => {
        // If current clip has fewer frames than the VFX sequence (e.g. a 1-frame static sprite),
        // duplicate the sprite frame so the character stays visible while the VFX animates!
        let live = bus.getProject().clips.find((c) => c.id === clipId)!
        while (live.frames.length < seq.combinedFrames.length) {
          bus.execute('frame.add', { clipId, copy: true }, origin)
          live = bus.getProject().clips.find((c) => c.id === clipId)!
        }
        const ids = commitLayersForClip(clipId)
        return { clipId, ids }
      })
      resultClipId = res.clipId
      createdLayerIds = res.ids
    } else {
      const res = await bus.transaction(`Generate VFX "${resolvedId}" (${seq.combinedFrames.length} frames)`, origin, () => {
        bus.execute('clip.add', { name: baseName, fps: seq.fps }, origin) // clip.add creates 1 frame
        let clip = bus.getProject().clips[bus.getProject().clips.length - 1]!
        for (let f = 1; f < seq.combinedFrames.length; f++) {
          bus.execute('frame.add', { clipId: clip.id }, origin)
          clip = bus.getProject().clips[bus.getProject().clips.length - 1]!
        }
        const ids = commitLayersForClip(clip.id)
        return { clipId: clip.id, ids }
      })
      resultClipId = res.clipId
      createdLayerIds = res.ids
    }

    followCommandTarget({ clipId: resultClipId })
    const after = bus.getProject().clips.find((c) => c.id === resultClipId)!
    const previewCel = seq.combinedFrames[0]
    let previewPng: string | undefined
    if (previewCel) {
      const { encodePng } = await import('@pixelforge/core')
      const png = await encodePng(project.width, project.height, previewCel)
      previewPng = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`
    }
    return {
      ok: true,
      clipId: after.id,
      clipName: after.name,
      target,
      depth,
      createdLayerIds,
      frames: after.frames.length,
      fps: after.fps,
      previewPng,
      resolvedEffect: seq.resolvedEffect,
      paletteApplied: seq.paletteApplied,
      crispPixelArt: seq.crispPixelArt,
      warmupUsed: seq.warmupUsed,
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'vfx_failed',
        message: err instanceof Error ? err.message : 'VFX render failed.',
        hint: 'Call list_vfx for valid effect ids.',
      },
    }
  }
}
