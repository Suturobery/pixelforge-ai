// PixelForge AI — pixelfx integration (MIT, github:patch-gg/pixelfx pinned
// a841596 / v0.3.0 — install from GitHub, not npm registry). Deterministic
// procedural VFX rendered headless (pure JS buffers, no DOM) into a project
// clip via the SAME bus path as PNG-sequence import: one undo transaction.

import { getBus } from './store'
import { followCommandTarget } from './mcp-follow'
import { loadCatalog } from './vfx-catalog'

export { listVfx, resolveVfxEffect } from './vfx-catalog'
export type { VfxEffectInfo } from './vfx-catalog'

const MAX_FRAMES = 64

export interface VfxRenderOptions {
  /** Catalog id OR a vague name — resolved by the app ("campfire" works). */
  effect: string
  seed?: number
  /** Default: cover the effect's meta.duration at the chosen fps (clamped 1..64). */
  frames?: number
  fps?: number
  /** Explicit dark→bright hex ramp, the string "project" (Style Lock palette,
   * sorted dark→bright), or undefined — which AUTO-USES the project palette
   * when a Style Lock profile is enabled (the app stays on-style by default). */
  palette?: string[] | 'project'
  /** Additive-light intensity 0..1 (default 1). Lower = subtler glow, more transparency. */
  /** 'fit' = render at native effect size then downsample (default). 'crop' = render
   * directly at canvas size — the original tighter/crisper composition. */
  fit?: 'fit' | 'crop'
  light?: number
  /** Placement on the canvas (canvas coords). Default: effect origin, fitted. */
  x?: number
  y?: number
  name?: string
}

function luminance(hex: string): number {
  const m = hex.replace('#', '')
  const n = m.length >= 6 ? parseInt(m.slice(0, 6), 16) : parseInt(m.replace(/(.)/g, '$1$1').slice(0, 6), 16)
  if (Number.isNaN(n)) return 0
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
}

export interface VfxRenderResult {
  ok: boolean
  error?: { code: string; message: string; hint?: string }
  clipId?: string
  clipName?: string
  frames?: number
  fps?: number
  previewPng?: string
  /** What the app resolved the (possibly vague) request to — transparency. */
  resolvedEffect?: string
  paletteApplied?: 'project' | 'custom' | 'effect-default'
}

/** Downsample: exact integer ratios use nearest-center sampling (pixel-art
 * crisp; a 128→50% campfire keeps its smoke/logs whole), others box-average. */
function boxDownsample(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4)
  if (sw % dw === 0 && sh % dh === 0) {
    const rx = sw / dw, ry = sh / dh
    for (let dy = 0; dy < dh; dy++) for (let dx = 0; dx < dw; dx++) {
      const si = ((dy * ry + (ry >> 1)) * sw + (dx * rx + (rx >> 1))) * 4
      const di = (dy * dw + dx) * 4
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
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
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
    }
  }
  return out
}

/** Render one RGBA frame sequence, deterministic for a given (effect, seed, options). */
async function renderVfxFrames(
  opts: VfxRenderOptions,
  w: number,
  h: number,
  resolved: { id: string; palette?: string[] },
): Promise<Uint8ClampedArray[]> {
  const effects = await loadCatalog()
  const mod = effects[resolved.id]
  if (!mod?.meta) throw new Error(`Unknown effect "${resolved.id}".`)

  const { createFrame, clearFrame, createFx, composite } = await import('pixelfx')
  const fps = opts.fps ?? 12
  const metaDuration = mod.meta.duration ?? 1
  const frameCount = Math.max(1, Math.min(MAX_FRAMES, opts.frames ?? Math.ceil(metaDuration * fps)))
  const dt = 1 / fps
  const lightK = Math.max(0, Math.min(1, opts.light ?? 1))

  // Effects are designed at their meta.size — render at NATIVE size (never
  // cropped) inside the canvas, then downsample to fit. Placement
  // defaults to the effect origin scaled into the native buffer.
  const crop = opts.fit === 'crop'
  const nativeW = crop ? w : Math.max(w, Math.round(mod.meta.size?.[0] ?? w))
  const nativeH = crop ? h : Math.max(h, Math.round(mod.meta.size?.[1] ?? h))
  const originX = mod.meta.origin?.[0] ?? nativeW / 2
  const originY = mod.meta.origin?.[1] ?? nativeH
  const fx = createFx(mod as never, {
    x: Math.round(opts.x !== undefined ? (opts.x / w) * nativeW : (crop ? w / 2 : originX)),
    y: Math.round(opts.y !== undefined ? (opts.y / h) * nativeH : (crop ? h * 0.7 : originY)),
    seed: opts.seed ?? 1,
    ...(resolved.palette && resolved.palette.length >= 2 ? { palette: resolved.palette } : {}),
  })
  const frame = createFrame(nativeW, nativeH)
  const out = new Uint8ClampedArray(nativeW * nativeH * 4)
  const cells: Uint8ClampedArray[] = []
  for (let i = 0; i < frameCount; i++) {
    fx.update(dt)
    clearFrame(frame)
    fx.draw(frame, 'back')
    fx.draw(frame, 'front')
    composite(frame, out, null, lightK)
    cells.push(nativeW === w && nativeH === h ? new Uint8ClampedArray(out) : boxDownsample(out, nativeW, nativeH, w, h))
  }
  return cells
}

export async function generateVfx(opts: VfxRenderOptions): Promise<VfxRenderResult> {
  try {
    const bus = getBus()
    const project = bus.getProject()
    const fps = opts.fps ?? 12

    // ---- the APP owns accuracy: resolve fuzzy names, auto palette ---------
    const { resolveVfxEffect } = await import('./vfx')
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

    // palette: explicit array wins > "project" > AUTO when Style Lock is on
    const profile = project.settings.styleProfile
    let palette: string[] | undefined
    let paletteApplied: 'project' | 'custom' | 'effect-default' = 'effect-default'
    if (Array.isArray(opts.palette) && opts.palette.length >= 2) {
      palette = opts.palette
      paletteApplied = 'custom'
    } else if (opts.palette === 'project' || (profile?.enabled && profile.paletteMode !== 'none')) {
      const ramp = [...project.palette].sort((a, b) => luminance(a) - luminance(b))
      if (ramp.length >= 2) {
        palette = ramp
        paletteApplied = 'project'
      }
    }

    const cells = await renderVfxFrames(opts, project.width, project.height, { id: resolvedId, palette })
    const name = (opts.name ?? `vfx-${resolvedId.split('/').pop()}`).trim().slice(0, 120) || 'vfx'

    const createdClipId = bus.transaction(`Generate VFX "${resolvedId}" (${cells.length} frames)`, 'mcp', () => {
      bus.execute('clip.add', { name, fps }, 'mcp') // clip.add creates exactly ONE frame
      let clip = bus.getProject().clips[bus.getProject().clips.length - 1]!
      for (let f = 1; f < cells.length; f++) {
        bus.execute('frame.add', { clipId: clip.id }, 'mcp')
        clip = bus.getProject().clips[bus.getProject().clips.length - 1]!
      }
      bus.execute('layer.add', { clipId: clip.id, name: 'vfx' }, 'mcp')
      const layer = bus.getProject().clips.find((c) => c.id === clip.id)!.layers.slice(-1)[0]!
      for (let idx = 0; idx < cells.length; idx++) {
        const live = bus.getProject().clips.find((c) => c.id === clip.id)!
        const frame = live.frames[idx]!
        bus.execute(
          'pixels.applyOp',
          { clipId: clip.id, frameId: frame.id, layerId: layer.id, ops: [{ op: 'setBuffer', buffer: cells[idx]! }] },
          'mcp',
        )
      }
      return clip.id
    })

    followCommandTarget({ clipId: createdClipId })
    const after = bus.getProject().clips.find((c) => c.id === createdClipId)!
    const lastLayerId = after.layers[after.layers.length - 1]!.id
    const firstCel = after.frames[0]?.cels[lastLayerId]?.buffer
    let previewPng: string | undefined
    if (firstCel) {
      const { encodePng } = await import('@pixelforge/core')
      const png = await encodePng(project.width, project.height, firstCel)
      previewPng = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`
    }
    return {
      ok: true,
      clipId: after.id,
      clipName: after.name,
      frames: after.frames.length,
      fps,
      previewPng,
      resolvedEffect: resolvedId,
      paletteApplied,
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
