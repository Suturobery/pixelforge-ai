// PixelForge AI — export transport (Task 7).
//
// ALL export intelligence lives in @pixelforge/core (deterministic compose +
// PNG encode + metadata + atomic writes). This module only delivers bytes:
//   web prototype  → browser downloads (unchanged UX from Task 4),
//   desktop        → native dialogs + the session-allowlisted bridge fs.
//
// The canvas renderer is NOT part of the export path anymore — artifacts are
// composed from the document buffers in core, so web, desktop and the golden
// tests produce byte-identical output.

import {
  ExportError,
  buildAllArtifacts,
  buildAsepriteJson,
  buildAtlasAsepriteJson,
  composeAtlasRgba,
  decodePng,
  encodeExportPng,
  planExport,
  slugify,
  upscaleRgbaNearest,
  writeExportPlan,
  type AtlasLayout,
  type ExportRequest,
  type Project,
} from '@pixelforge/core'
import { getBridge, isDesktop, makeBridgeFs } from './desktop-bridge'

export type { ExportRequest } from '@pixelforge/core'
export type ExportScale = 1 | 2 | 4 | 8 | 16
export type ExportArtifactKind = 'png' | 'json' | 'tres'
export type JsonMetadataFormat = 'pixelforge' | 'aseprite'

export interface ExportArtifact {
  filename: string
  kind: ExportArtifactKind
  bytes: Uint8Array
}

/** Result of a user-facing export run (dialog maps these to toasts). */
export type ExportOutcome =
  | { status: 'saved'; filenames: string[]; destination: string }
  | { status: 'canceled' }
  | { status: 'conflicts'; conflicts: string[] }

export interface ExportRunOptions extends ExportRequest {
  /** Desktop only: replace existing files in the chosen destination. */
  overwrite?: boolean
  /** Nearest-neighbor integer export scale factor (default 1 = native resolution). */
  scale?: ExportScale
  /** Also export a Godot 4 SpriteFrames (.tres) resource for sprite sheets. */
  includeTres?: boolean
  /** Metadata schema for JSON sidecars: PixelForge v2 (default) or Aseprite-compatible JSON. */
  jsonFormat?: JsonMetadataFormat
}

export interface AtlasRunOptions {
  baseName?: string
  columns?: number
  padding?: number
  spacing?: number
  scale?: ExportScale
  includeJson?: boolean
  jsonFormat?: JsonMetadataFormat
  includeTres?: boolean
  overwrite?: boolean
}

export interface GodotTresInput {
  sheetFilename: string
  clipName: string
  fps: number
  loop: boolean
  frames: Array<{ index: number; x: number; y: number; w: number; h: number; durationMs?: number }>
  tags?: Array<{ name: string; from: number; to: number }>
}

/**
 * Generate native Godot 4 SpriteFrames (.tres) resource text format.
 * Enables zero-setup drag-and-drop onto AnimatedSprite2D nodes in Godot 4.
 */
export function generateGodot4SpriteFramesTres(options: GodotTresInput): string {
  const { sheetFilename, clipName, fps, loop, frames, tags = [] } = options
  const baseSpeed = Math.min(60, Math.max(1, fps || 8))
  const stepMs = 1000 / baseSpeed

  const loadSteps = frames.length + 2
  let out = `[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]\n\n`
  out += `[ext_resource type="Texture2D" path="res://${sheetFilename}" id="1_tex"]\n\n`

  frames.forEach((f) => {
    out += `[sub_resource type="AtlasTexture" id="AtlasTexture_${f.index}"]\n`
    out += `atlas = ExtResource("1_tex")\n`
    out += `region = Rect2(${f.x}, ${f.y}, ${f.w}, ${f.h})\n\n`
  })

  const formatFrames = (slice: typeof frames) => {
    return slice
      .map((f) => {
        const dur = f.durationMs && f.durationMs > 0 ? Number((f.durationMs / stepMs).toFixed(3)) : 1.0
        return `{\n"duration": ${dur},\n"texture": SubResource("AtlasTexture_${f.index}")\n}`
      })
      .join(', ')
  }

  const animations: string[] = []
  const mainName = clipName.trim() || 'default'
  animations.push(`{\n"frames": [${formatFrames(frames)}],\n"loop": ${loop},\n"name": &"${mainName}",\n"speed": ${Number(baseSpeed.toFixed(2))}\n}`)

  for (const tag of tags) {
    const from = Math.max(0, tag.from)
    const to = Math.min(frames.length - 1, tag.to)
    if (from <= to) {
      const tagFrames = frames.slice(from, to + 1)
      animations.push(`{\n"frames": [${formatFrames(tagFrames)}],\n"loop": ${loop},\n"name": &"${tag.name.trim()}",\n"speed": ${Number(baseSpeed.toFixed(2))}\n}`)
    }
  }

  out += `[resource]\n`
  out += `animations = [${animations.join(', ')}]\n`
  return out
}

/**
 * Generate ONE combined Godot 4 SpriteFrames (.tres) resource for a multi-clip Master Atlas.
 * Every clip (and any unique sub-tags) becomes its own named animation referencing the single atlas PNG.
 */
export function generateGodot4AtlasTres(
  sheetFilename: string,
  layout: AtlasLayout,
  scale: ExportScale = 1,
): string {
  const loadSteps = layout.frames.length + 2
  let out = `[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]\n\n`
  out += `[ext_resource type="Texture2D" path="res://${sheetFilename}" id="1_tex"]\n\n`

  for (const f of layout.frames) {
    out += `[sub_resource type="AtlasTexture" id="AtlasTexture_${f.globalIndex}"]\n`
    out += `atlas = ExtResource("1_tex")\n`
    out += `region = Rect2(${f.x * scale}, ${f.y * scale}, ${f.w * scale}, ${f.h * scale})\n\n`
  }

  const animations: string[] = []
  const seenNames = new Set<string>()
  const formatSlice = (from: number, to: number, baseSpeed: number) => {
    const stepMs = 1000 / baseSpeed
    return layout.frames
      .slice(from, to + 1)
      .map((f) => {
        const dur = f.durationMs > 0 ? Number((f.durationMs / stepMs).toFixed(3)) : 1.0
        return `{\n"duration": ${dur},\n"texture": SubResource("AtlasTexture_${f.globalIndex}")\n}`
      })
      .join(', ')
  }

  for (const span of layout.clips) {
    const baseSpeed = Math.min(60, Math.max(1, span.fps || 8))
    const name = span.name.trim() || `clip_${span.clipId}`
    if (!seenNames.has(name)) {
      seenNames.add(name)
      animations.push(
        `{\n"frames": [${formatSlice(span.from, span.to, baseSpeed)}],\n"loop": ${span.loop},\n"name": &"${name}",\n"speed": ${Number(baseSpeed.toFixed(2))}\n}`,
      )
    }
    for (const tag of span.tags) {
      const tName = tag.name.trim()
      if (!tName || seenNames.has(tName)) continue
      seenNames.add(tName)
      animations.push(
        `{\n"frames": [${formatSlice(tag.from, tag.to, baseSpeed)}],\n"loop": ${span.loop},\n"name": &"${tName}",\n"speed": ${Number(baseSpeed.toFixed(2))}\n}`,
      )
    }
  }

  out += `[resource]\n`
  out += `animations = [${animations.join(', ')}]\n`
  return out
}

const PNG_FILTERS = [{ name: 'PNG image', extensions: ['png'] }]
const JSON_FILTERS = [{ name: 'JSON metadata', extensions: ['json'] }]
const TRES_FILTERS = [{ name: 'Godot 4 SpriteFrames', extensions: ['tres'] }]

function toBlob(kind: ExportArtifactKind, bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], {
    type: kind === 'png' ? 'image/png' : kind === 'json' ? 'application/json' : 'text/plain',
  })
}

function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

/**
 * Build the artifact bytes (all-or-nothing) — exposed for the dev probe and
 * reused by the transport below so validation errors surface identically.
 */
export async function buildExportArtifacts(
  project: Project,
  request: ExportRequest,
  scale: ExportScale = 1,
  includeTres = false,
  jsonFormat: JsonMetadataFormat = 'pixelforge',
): Promise<ExportArtifact[]> {
  const needJsonForTres = includeTres && !request.includeJson
  const plan = planExport(project, needJsonForTres ? { ...request, includeJson: true } : request)
  let artifacts: ExportArtifact[] = (await buildAllArtifacts(plan)) as ExportArtifact[]
  if (scale && scale > 1) {
    artifacts = await Promise.all(
      artifacts.map(async (f) => {
        if (f.kind === 'png') {
          const decoded = await decodePng(f.bytes)
          const scaled = upscaleRgbaNearest(decoded.rgba, decoded.width, decoded.height, scale)
          const pngBytes = await encodeExportPng(decoded.width * scale, decoded.height * scale, scaled)
          return { ...f, bytes: pngBytes }
        }
        try {
          const meta = JSON.parse(new TextDecoder().decode(f.bytes)) as Record<string, unknown>
          if (typeof meta.frameWidth === 'number') meta.frameWidth *= scale
          if (typeof meta.frameHeight === 'number') meta.frameHeight *= scale
          if (typeof meta.padding === 'number') meta.padding *= scale
          if (typeof meta.spacing === 'number') meta.spacing *= scale
          if (Array.isArray(meta.frames)) {
            meta.frames = meta.frames.map((fr: Record<string, unknown>) => ({
              ...fr,
              ...(typeof fr.x === 'number' ? { x: fr.x * scale } : {}),
              ...(typeof fr.y === 'number' ? { y: fr.y * scale } : {}),
              ...(typeof fr.w === 'number' ? { w: fr.w * scale } : {}),
              ...(typeof fr.h === 'number' ? { h: fr.h * scale } : {}),
            }))
          }
          return { ...f, bytes: new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n') }
        } catch {
          return f
        }
      }),
    )
  }

  if (includeTres) {
    const tresArtifacts: ExportArtifact[] = []
    for (const f of artifacts) {
      if (f.kind === 'json') {
        try {
          const meta = JSON.parse(new TextDecoder().decode(f.bytes)) as Record<string, unknown>
          const clipMeta = (meta.clip as Record<string, unknown>) ?? {}
          const sheetImage = typeof meta.image === 'string' ? meta.image : f.filename.replace(/\.json$/, '_sheet.png')
          const clipName = typeof clipMeta.name === 'string' ? clipMeta.name : 'default'
          const fps = typeof clipMeta.fps === 'number' ? clipMeta.fps : 8
          const loop = typeof clipMeta.loop === 'boolean' ? clipMeta.loop : true
          const tags = Array.isArray(clipMeta.tags) ? (clipMeta.tags as Array<{ name: string; from: number; to: number }>) : []
          const frames = Array.isArray(meta.frames) ? (meta.frames as Array<{ index: number; x: number; y: number; w: number; h: number; durationMs?: number }>) : []

          const tresContent = generateGodot4SpriteFramesTres({
            sheetFilename: sheetImage,
            clipName,
            fps,
            loop,
            frames,
            tags,
          })

          tresArtifacts.push({
            filename: f.filename.replace(/\.json$/, '.tres'),
            kind: 'tres',
            bytes: new TextEncoder().encode(tresContent),
          })
        } catch {
          /* ignore unparseable json */
        }
      }
    }
    if (needJsonForTres) {
      artifacts = artifacts.filter((a) => a.kind !== 'json')
    }
    artifacts.push(...tresArtifacts)
  }

  // Convert sheet JSON sidecars to standard Aseprite format when requested (Unity / Phaser / PixiJS / Godot)
  if (jsonFormat === 'aseprite' && request.format === 'sheet' && request.includeJson) {
    const sheetOpts = request.sheet ?? { columns: 0, padding: 0 }
    const clipById = new Map(project.clips.map((c) => [c.id, c]))
    artifacts = artifacts.map((f) => {
      if (f.kind !== 'json') return f
      try {
        const meta = JSON.parse(new TextDecoder().decode(f.bytes)) as {
          clip?: { id?: string }
          image?: string
        }
        const clip = meta.clip?.id ? clipById.get(meta.clip.id) : project.clips[0]
        const imageFilename = typeof meta.image === 'string' ? meta.image : f.filename.replace(/\.json$/, '_sheet.png')
        if (!clip) return f
        const ase = buildAsepriteJson(project, clip, sheetOpts, imageFilename, scale)
        return { ...f, bytes: new TextEncoder().encode(JSON.stringify(ase, null, 2) + '\n') }
      } catch {
        return f
      }
    })
  }

  return artifacts
}

/**
 * Build Master Atlas artifacts combining ALL clips of the project into a single PNG,
 * plus optional Aseprite/PixelForge JSON metadata and combined Godot 4 SpriteFrames (.tres).
 */
export async function buildAtlasExportArtifacts(
  project: Project,
  options: Omit<AtlasRunOptions, 'overwrite'> = {},
): Promise<ExportArtifact[]> {
  const base = slugify(options.baseName || project.name)
  const scale: ExportScale = options.scale ?? 1
  const atlasOpts = {
    columns: options.columns ?? 0,
    padding: options.padding ?? 0,
    spacing: options.spacing ?? options.padding ?? 0,
  }
  const { rgba, layout } = composeAtlasRgba(project, atlasOpts)
  const scaledRgba = scale > 1 ? upscaleRgbaNearest(rgba, layout.width, layout.height, scale) : rgba
  const imageFilename = `${base}_atlas.png`
  const pngBytes = await encodeExportPng(layout.width * scale, layout.height * scale, scaledRgba)

  const artifacts: ExportArtifact[] = [{ filename: imageFilename, kind: 'png', bytes: pngBytes }]

  if (options.includeJson !== false) {
    const jsonFormat = options.jsonFormat ?? 'aseprite'
    const jsonObj =
      jsonFormat === 'aseprite'
        ? buildAtlasAsepriteJson(project, atlasOpts, imageFilename, scale)
        : {
            app: 'PixelForge AI',
            version: 2,
            kind: 'master-atlas',
            image: imageFilename,
            scale,
            width: layout.width * scale,
            height: layout.height * scale,
            frameWidth: layout.frameWidth * scale,
            frameHeight: layout.frameHeight * scale,
            columns: layout.columns,
            rows: layout.rows,
            padding: layout.padding * scale,
            spacing: layout.spacing * scale,
            clips: layout.clips,
            frames: layout.frames.map((f) => ({
              ...f,
              x: f.x * scale,
              y: f.y * scale,
              w: f.w * scale,
              h: f.h * scale,
            })),
          }
    artifacts.push({
      filename: `${base}_atlas.json`,
      kind: 'json',
      bytes: new TextEncoder().encode(JSON.stringify(jsonObj, null, 2) + '\n'),
    })
  }

  if (options.includeTres) {
    const tres = generateGodot4AtlasTres(imageFilename, layout, scale)
    artifacts.push({
      filename: `${base}_atlas.tres`,
      kind: 'tres',
      bytes: new TextEncoder().encode(tres),
    })
  }

  return artifacts
}

async function deliverExportArtifacts(files: ExportArtifact[], overwrite?: boolean): Promise<ExportOutcome> {
  // --- web prototype: browser downloads (browser names/conflict UI its own) ---
  if (!isDesktop()) {
    for (const f of files) {
      downloadData(toBlob(f.kind, f.bytes), f.filename)
    }
    return { status: 'saved', filenames: files.map((f) => f.filename), destination: 'browser downloads' }
  }

  // --- desktop: native dialogs + allowlisted fs (main performs I/O) ---
  const bridge = getBridge()
  if (!bridge) throw new ExportError('WRITE_FAILED', 'desktop bridge is unavailable')

  if (files.length === 1) {
    const file = files[0]
    const save = await bridge.project.pickSave({
      defaultPath: file.filename,
      filters: file.kind === 'png' ? PNG_FILTERS : file.kind === 'tres' ? TRES_FILTERS : JSON_FILTERS,
    })
    if (save.canceled || !save.path) return { status: 'canceled' }
    const written = [{ filename: file.filename, bytes: file.bytes }]
    const result = await writeExportPlan(makeBridgeFs(), dirnameOf(save.path), written, { overwrite: true })
    if (result.status === 'partial') {
      throw new ExportError('WRITE_FAILED', `could not write ${result.failures[0].filename}: ${result.failures[0].message}`)
    }
    return { status: 'saved', filenames: [save.path], destination: dirnameOf(save.path) }
  }

  const picked = await bridge.exports.pickDir()
  if (picked.canceled || !picked.dir) return { status: 'canceled' }
  const result = await writeExportPlan(makeBridgeFs(), picked.dir, files, { overwrite })
  if (result.status === 'conflicts') {
    return { status: 'conflicts', conflicts: result.conflicts }
  }
  if (result.status === 'partial') {
    const first = result.failures[0]
    throw new ExportError(
      'WRITE_FAILED',
      `export partially failed — ${result.written.length} file(s) written, then ${first.filename}: ${first.message}`,
      { failures: result.failures },
    )
  }
  return { status: 'saved', filenames: files.map((f) => f.filename), destination: picked.dir }
}

/**
 * Run a full export: validate → build every artifact in memory → deliver.
 * Throws ExportError for invalid input (caller shows a friendly toast);
 * never mutates the project.
 */
export async function runExport(project: Project, options: ExportRunOptions): Promise<ExportOutcome> {
  const { overwrite, scale = 1, includeTres = false, jsonFormat = 'pixelforge', ...request } = options
  const files = await buildExportArtifacts(project, request, scale, includeTres, jsonFormat)
  return deliverExportArtifacts(files, overwrite)
}

/** Run a Master Atlas export combining all clips into one PNG + optional JSON / Godot 4 .tres. */
export async function runAtlasExport(project: Project, options: AtlasRunOptions = {}): Promise<ExportOutcome> {
  const { overwrite, ...atlasOpts } = options
  const files = await buildAtlasExportArtifacts(project, atlasOpts)
  return deliverExportArtifacts(files, overwrite)
}

// keep the original helper name/behavior (web downloads)
export function downloadData(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/**
 * Pure animated GIF encoder via gifenc.
 * Uses an EXACT lossless RGB888 palette whenever a frame has ≤255 opaque colors
 * (virtually all pixel art) so crisp pixel colors never suffer rgb565 truncation
 * or banding, falling back to quantize only when >255 unique colors exist.
 */
export async function encodeGifBytes(
  frames: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }[],
  durations: number[],
  opts: { scale?: number; checker?: boolean; bg?: string } = {}
): Promise<Uint8Array> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const scale = Math.max(1, Math.round(opts.scale ?? 1))
  const bgHex = opts.bg && opts.bg !== 'transparent' ? opts.bg : '#101014'
  const bgR = parseInt(bgHex.slice(1, 3), 16) || 16
  const bgG = parseInt(bgHex.slice(3, 5), 16) || 16
  const bgB = parseInt(bgHex.slice(5, 7), 16) || 20
  const transparent = opts.bg === 'transparent'

  const gif = GIFEncoder()
  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ]

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const fw = f.width * scale
    const fh = f.height * scale
    const rgba = new Uint8Array(fw * fh * 4)

    for (let y = 0; y < fh; y++) {
      const sy = Math.floor(y / scale)
      for (let x = 0; x < fw; x++) {
        const sx = Math.floor(x / scale)
        const si = (sy * f.width + sx) * 4
        const di = (y * fw + x) * 4
        const a = f.data[si + 3] / 255

        if (transparent) {
          const t = Math.max((BAYER[y & 3][x & 3] + 0.5) / 16, 0.04)
          rgba[di] = f.data[si]
          rgba[di + 1] = f.data[si + 1]
          rgba[di + 2] = f.data[si + 2]
          rgba[di + 3] = a > t ? 255 : 0
        } else if (a >= 1) {
          rgba[di] = f.data[si]
          rgba[di + 1] = f.data[si + 1]
          rgba[di + 2] = f.data[si + 2]
          rgba[di + 3] = 255
        } else if (a <= 0) {
          rgba[di] = bgR
          rgba[di + 1] = bgG
          rgba[di + 2] = bgB
          rgba[di + 3] = 255
        } else {
          rgba[di] = Math.round(f.data[si] * a + bgR * (1 - a))
          rgba[di + 1] = Math.round(f.data[si + 1] * a + bgG * (1 - a))
          rgba[di + 2] = Math.round(f.data[si + 2] * a + bgB * (1 - a))
          rgba[di + 3] = 255
        }
      }
    }

    // Exact lossless palette fast-path for authentic pixel art (≤255/256 unique colors)
    const maxColors = transparent ? 255 : 256
    const colorToIndex = new Map<number, number>()
    const exactPalette: number[][] = []
    let overflow = false
    for (let p = 0; p < rgba.length; p += 4) {
      if (transparent && rgba[p + 3] === 0) continue
      const key = (rgba[p]! << 16) | (rgba[p + 1]! << 8) | rgba[p + 2]!
      if (!colorToIndex.has(key)) {
        if (exactPalette.length >= maxColors) {
          overflow = true
          break
        }
        colorToIndex.set(key, exactPalette.length)
        exactPalette.push([rgba[p]!, rgba[p + 1]!, rgba[p + 2]!])
      }
    }

    let palette: number[][]
    let indexed: Uint8Array
    const frameOpts: {
      palette: number[][]
      delay: number
      dispose: number
      transparent?: boolean
      transparentIndex?: number
    } = { palette: [], delay: durations[i] || 125, dispose: 2 }

    if (!overflow) {
      // Ensure at least 2 entries for valid GIF color table
      if (exactPalette.length === 0) exactPalette.push([bgR, bgG, bgB])
      palette = exactPalette
      let ti = 0
      if (transparent) {
        palette.push([0, 0, 0])
        ti = palette.length - 1
        frameOpts.transparent = true
        frameOpts.transparentIndex = ti
      }
      if (palette.length < 2) palette.push([0, 0, 0])
      indexed = new Uint8Array(fw * fh)
      for (let p = 0, px = 0; p < rgba.length; p += 4, px++) {
        if (transparent && rgba[p + 3] === 0) {
          indexed[px] = ti
        } else {
          const key = (rgba[p]! << 16) | (rgba[p + 1]! << 8) | rgba[p + 2]!
          indexed[px] = colorToIndex.get(key) ?? 0
        }
      }
    } else {
      palette = quantize(rgba, maxColors, { format: 'rgb565' })
      indexed = applyPalette(rgba, palette, 'rgb565')
      if (transparent) {
        palette.push([0, 0, 0])
        const ti = palette.length - 1
        for (let p = 0; p < rgba.length; p += 4) {
          if (rgba[p + 3] === 0) indexed[p / 4] = ti
        }
        frameOpts.transparent = true
        frameOpts.transparentIndex = ti
      }
    }

    frameOpts.palette = palette
    gif.writeFrame(indexed, fw, fh, frameOpts)
  }

  gif.finish()
  return gif.bytes()
}

/**
 * Animated GIF export via gifenc (lossless RGB888 for pixel art + nearest-neighbor upscale).
 */
export async function exportGif(
  frames: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }[],
  durations: number[],
  filename: string,
  opts: { scale?: number; checker?: boolean; bg?: string } = {}
): Promise<void> {
  const bytes = await encodeGifBytes(frames, durations, opts)
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' })
  downloadData(blob, filename)
}

/**
 * Decode export PNG bytes to pixels for previews — thin re-export so the
 * dialog (and the dev probe) can verify artifacts without another import.
 */
export function decodeExportPng(bytes: Uint8Array) {
  return decodePng(bytes)
}
