/**
 * Task 10 QA (Phase 1) — CORE-engine Motion Accuracy Audit harness.
 *
 * Unlike scripts/motion-audit.ts (which drives the shelved Motion Lab
 * prototype in src/lib/pixelforge), this harness drives the AUTHORITATIVE
 * deterministic composer: packages/core planMotion() — the exact code path
 * used by the MotionPanel preview, the motion.apply CommandBus command and
 * the MCP apply_motion_preset tool.
 *
 * For every fixture (side/front × 16/32/64) × every preset it renders the
 * actual composed frames to PNG sprite sheets (checkerboard backdrop),
 * animated GIFs, and a JSON report with QA issues + motion metrics
 * (planted-foot lift, horizontal foot slide, part detachment, loop seam).
 *
 * Run: bun scripts/motion-audit-core.ts
 * No network, no AI calls — deterministic local rendering only.
 * R10 is non-destructive: the source document is never mutated (only read).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

import {
  createProject,
  planMotion,
  analyzeMotionPlan,
  type Clip,
  type Part,
  type PartRect,
  type Project,
  type RGBA,
} from '../packages/core/src/index'

const OUT = join(process.cwd(), 'artifacts', 'task10-core')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// deterministic humanoid fixtures (single layer, rect-tagged parts, z-ordered)
// ---------------------------------------------------------------------------

const C = {
  hair: [93, 39, 93, 255] as RGBA, // #5d275d
  head: [239, 125, 87, 255] as RGBA, // #ef7d57
  body: [56, 183, 100, 255] as RGBA, // #38b764
  armL: [31, 109, 66, 255] as RGBA, // #1f6d42 far/dark
  armR: [167, 240, 112, 255] as RGBA, // #a7f070 near/light
  legL: [86, 108, 134, 255] as RGBA, // #566c86 far/dark
  legR: [148, 176, 194, 255] as RGBA, // #94b0c2 near/light
} as const

interface FixtureDef {
  id: string
  size: number
  facing: 'side' | 'front'
  rects: Record<'hair' | 'head' | 'body' | 'armL' | 'armR' | 'legL' | 'legR', PartRect>
}

function sideRects(s: 16 | 32 | 64): FixtureDef['rects'] {
  const k = s / 32
  const r = (x: number, y: number, w: number, h: number): PartRect => ({
    x: Math.round(x * k),
    y: Math.round(y * k),
    w: Math.round(w * k),
    h: Math.round(h * k),
  })
  return {
    hair: r(11, 5, 10, 4),
    head: r(12, 6, 8, 7),
    body: r(11, 13, 9, 9),
    armL: r(9, 13, 3, 8), // far arm — behind body
    armR: r(19, 13, 3, 8), // near arm — in front
    legL: r(12, 22, 3, 9), // far leg
    legR: r(16, 22, 3, 9), // near leg
  }
}

function frontRects(s: 16 | 32 | 64): FixtureDef['rects'] {
  const k = s / 32
  const r = (x: number, y: number, w: number, h: number): PartRect => ({
    x: Math.round(x * k),
    y: Math.round(y * k),
    w: Math.round(w * k),
    h: Math.round(h * k),
  })
  return {
    hair: r(11, 5, 10, 4),
    head: r(12, 6, 8, 7),
    body: r(11, 13, 10, 9),
    armL: r(8, 13, 3, 8),
    armR: r(21, 13, 3, 8),
    legL: r(11, 22, 4, 9),
    legR: r(17, 22, 4, 9),
  }
}

/** z-order: far limbs behind, head/hair/near-arm in front (R1 paint order). */
const Z: Record<string, number> = { armL: 1, legL: 2, body: 3, legR: 4, head: 5, hair: 6, armR: 7 }

const FIXTURES: FixtureDef[] = [
  { id: 'side-16', size: 16, facing: 'side', rects: sideRects(16) },
  { id: 'front-16', size: 16, facing: 'front', rects: frontRects(16) },
  { id: 'side-32', size: 32, facing: 'side', rects: sideRects(32) },
  { id: 'front-32', size: 32, facing: 'front', rects: frontRects(32) },
  { id: 'side-64', size: 64, facing: 'side', rects: sideRects(64) },
  { id: 'front-64', size: 64, facing: 'front', rects: frontRects(64) },
]

function buildDocument(f: FixtureDef): { project: Project; clip: Clip } {
  const project = createProject({ name: `audit-${f.id}`, width: f.size, height: f.size })
  const clip = project.clips[0]
  const layerId = clip.layers[0].id
  const frameId = clip.frames[0].id

  const buf = new Uint8ClampedArray(f.size * f.size * 4)
  const paint = (r: PartRect, c: RGBA) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * f.size + x) * 4
        buf[i] = c[0]
        buf[i + 1] = c[1]
        buf[i + 2] = c[2]
        buf[i + 3] = c[3]
      }
    }
  }
  // paint in z order (later paints win — matches R1 for same-pixel ties)
  for (const role of ['armL', 'legL', 'body', 'legR', 'head', 'hair', 'armR'] as const) {
    paint(f.rects[role], C[role])
  }
  clip.frames[0].cels[layerId] = { buffer: buf, linked: false }

  const parts: Part[] = (Object.keys(f.rects) as (keyof FixtureDef['rects'])[]).map((role, i) => ({
    id: `pt-${role}`,
    name: role,
    layerId,
    rect: f.rects[role],
    anchorFrameId: frameId,
    z: Z[role],
  }))
  clip.parts = parts
  return { project, clip }
}

// ---------------------------------------------------------------------------
// motion metrics — the Phase-1 audit checklist as deterministic measurements
// ---------------------------------------------------------------------------

interface FrameMetric {
  frame: number
  /** lowest opaque row of the whole sprite (ground contact row) */
  lowestRow: number
  /** lowest opaque row of each leg color (null = leg fully off-canvas) */
  legLBottom: number | null
  legRBottom: number | null
  /** horizontal span [minX,maxX] of leg pixels with dy=0 (planted) */
  legLX: [number, number] | null
  legRX: [number, number] | null
}

interface CompMetrics {
  fixture: string
  preset: string
  frameCount: number
  ampScale: number
  /** per-frame plant status: at least one leg keeping its anchor bottom row */
  plantedPerFrame: boolean[]
  /** max upward lift of the planted leg pair across ground-contact frames */
  maxBothLift: number
  /** max horizontal shift of any planted-leg pixel vs anchor (slide) */
  maxPlantedSlideX: number
  /** true when any composed frame has leg pixels BELOW the anchor bottom (penetration) */
  groundPenetration: boolean
  /** seam offset: |dy(last→first)| of body pixels (loop smoothness) */
  loopSeamPx: number
  /** any composed frame where a leg color disappeared entirely (detachment risk) */
  legVanished: boolean
  movedPixels: number[]
  qaIssues: { code: string; message: string; frameIndexes?: number[] }[]
  skippedRoles: string[]
}

/** strict per-color matcher (fixtures use exact palette colors) */
function isColor(c: RGBA): (buf: Uint8ClampedArray, i: number) => boolean {
  return (buf, i) =>
    buf[i] === c[0] && buf[i + 1] === c[1] && buf[i + 2] === c[2] && buf[i + 3] === 255
}

// ---------------------------------------------------------------------------
// rendering helpers (checkerboard backdrop, nearest-neighbor scale)
// ---------------------------------------------------------------------------

function frameToPng(buf: Uint8ClampedArray, w: number, h: number, scale: number): PNG {
  const png = new PNG({ width: w * scale, height: h * scale })
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const sx = Math.floor(x / scale)
      const sy = Math.floor(y / scale)
      const si = (sy * w + sx) * 4
      const checker = ((Math.floor(x / (4 * scale)) + Math.floor(y / (4 * scale))) % 2) === 0
      const bg = checker ? 235 : 205
      const a = buf[si + 3] / 255
      const di = (y * png.width + x) * 4
      png.data[di] = Math.round(buf[si] * a + bg * (1 - a))
      png.data[di + 1] = Math.round(buf[si + 1] * a + bg * (1 - a))
      png.data[di + 2] = Math.round(buf[si + 2] * a + bg * (1 - a))
      png.data[di + 3] = 255
    }
  }
  return png
}

function writeSheet(
  name: string,
  frames: Uint8ClampedArray[],
  w: number,
  h: number,
  scale: number
): void {
  const pad = 8 * scale
  const width = frames.length * (w * scale) + (frames.length + 1) * pad
  const height = h * scale + 2 * pad
  const sheet = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const checker = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) === 0
      const bg = checker ? 225 : 195
      const i = (y * width + x) * 4
      sheet.data[i] = bg
      sheet.data[i + 1] = bg
      sheet.data[i + 2] = bg
      sheet.data[i + 3] = 255
    }
  }
  frames.forEach((f, idx) => {
    const fp = frameToPng(f, w, h, scale)
    const ox = pad + idx * (w * scale + pad)
    PNG.bitblt(fp, sheet, 0, 0, fp.width, fp.height, ox, pad)
  })
  writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(sheet))
}

function writeGif(name: string, frames: Uint8ClampedArray[], w: number, h: number, scale: number, fps = 8): void {
  const gif = GIFEncoder()
  const delayMs = Math.round(1000 / fps)
  for (const f of frames) {
    const png = frameToPng(f, w, h, scale)
    const rgba = new Uint8Array(png.data)
    const palette = quantize(rgba, 256)
    const idx = applyPalette(rgba, palette)
    gif.writeFrame(idx, png.width, png.height, { palette, delay: delayMs })
  }
  gif.finish()
  writeFileSync(join(OUT, `${name}.gif`), gif.bytes())
}

// ---------------------------------------------------------------------------
// main audit matrix
// ---------------------------------------------------------------------------

interface RunSpec {
  fixture: FixtureDef
  preset: string
  frameCount?: number
}

const RUNS: RunSpec[] = []
for (const fixture of FIXTURES) {
  RUNS.push(
    { fixture, preset: 'idle' },
    { fixture, preset: 'walk' },
    { fixture, preset: 'run' },
    { fixture, preset: 'attack' },
    { fixture, preset: 'jump' }
  )
}
// extra timing variants (roadmap: "poor walk/run timing", wind-up, anticipation)
RUNS.push(
  { fixture: FIXTURES[2], preset: 'walk', frameCount: 8 }, // side-32 walk 8
  { fixture: FIXTURES[0], preset: 'walk', frameCount: 6 }, // side-16 walk 6
  { fixture: FIXTURES[3], preset: 'attack', frameCount: 6 }, // front-32 attack 6
  { fixture: FIXTURES[0], preset: 'jump', frameCount: 4 } // side-16 jump 4
)

const report: CompMetrics[] = []
const GROUND_PRESETS = new Set(['idle', 'walk', 'run'])

for (const run of RUNS) {
  const { project, clip } = buildDocument(run.fixture)
  const anchorBuf = clip.frames[0].cels[clip.layers[0].id].buffer
  const w = project.width
  const h = project.height

  const plan = planMotion(project, clip, {
    preset: run.preset as never,
    params: run.frameCount ? { frameCount: run.frameCount } : undefined,
  })
  const qa = analyzeMotionPlan(project, clip, plan)
  const layerId = plan.report.affectedLayerIds[0] ?? clip.layers[0].id

  // composed frame buffers (falls back to anchor cel for completeness)
  const buffers = plan.frames.map((fr) => fr.cels[layerId] ?? anchorBuf)

  // metrics per frame
  const legLBottoms: (number | null)[] = []
  const legRBottoms: (number | null)[] = []
  const legLSpans: ([number, number] | null)[] = []
  const legRSpans: ([number, number] | null)[] = []
  const legLVanished: boolean[] = []
  const legRVanished: boolean[] = []

  const aLegL = lowestRowWhere(anchorBuf, w, h, isColor(C.legL))
  const aLegR = lowestRowWhere(anchorBuf, w, h, isColor(C.legR))

  for (const buf of buffers) {
    const lb = lowestRowWhere(buf, w, h, isColor(C.legL))
    const rb = lowestRowWhere(buf, w, h, isColor(C.legR))
    legLBottoms.push(lb)
    legRBottoms.push(rb)
    legLVanished.push(lb === null)
    legRVanished.push(rb === null)
    legLSpans.push(lb !== null ? xSpanWhereRow(buf, w, h, lb, isColor(C.legL)) : null)
    legRSpans.push(rb !== null ? xSpanWhereRow(buf, w, h, rb, isColor(C.legR)) : null)
  }

  // planted-foot analysis: ground presets should keep ≥1 leg at anchor bottom
  const plantedPerFrame: boolean[] = []
  let maxBothLift = 0
  let maxPlantedSlideX = 0
  for (let i = 0; i < buffers.length; i++) {
    const lb = legLBottoms[i]
    const rb = legRBottoms[i]
    const lLift = lb === null || aLegL === null ? 99 : aLegL - lb
    const rLift = rb === null || aLegR === null ? 99 : aLegR - rb
    const planted = Math.min(lLift, rLift) <= 0
    plantedPerFrame.push(GROUND_PRESETS.has(run.preset) ? planted : true)
    maxBothLift = Math.max(maxBothLift, Math.min(lLift, rLift))
    // slide = horizontal span shift of the leg that stays planted
    const lSpan = legLSpans[i]
    const rSpan = legRSpans[i]
    if (legLBottoms[i] === aLegL && lSpan && aLegL !== null) {
      const aSpan = xSpanWhereRow(anchorBuf, w, h, aLegL, isColor(C.legL))
      if (aSpan) {
        maxPlantedSlideX = Math.max(
          maxPlantedSlideX,
          Math.abs(lSpan[0] - aSpan[0]),
          Math.abs(lSpan[1] - aSpan[1])
        )
      }
    }
    if (legRBottoms[i] === aLegR && rSpan && aLegR !== null) {
      const aSpan = xSpanWhereRow(anchorBuf, w, h, aLegR, isColor(C.legR))
      if (aSpan) {
        maxPlantedSlideX = Math.max(
          maxPlantedSlideX,
          Math.abs(rSpan[0] - aSpan[0]),
          Math.abs(rSpan[1] - aSpan[1])
        )
      }
    }
  }

  // ground penetration: any leg pixel lower than its anchor bottom
  let groundPenetration = false
  if (aLegL !== null) groundPenetration ||= legLBottoms.some((b) => b !== null && b > aLegL)
  if (aLegR !== null) groundPenetration ||= legRBottoms.some((b) => b !== null && b > aLegR)

  // loop seam: body-color lowest-row delta between last and first frame
  const firstBody = lowestRowWhere(buffers[0], w, h, isColor(C.body))
  const lastBody = lowestRowWhere(buffers[buffers.length - 1], w, h, isColor(C.body))
  const loopSeamPx = firstBody !== null && lastBody !== null ? Math.abs(firstBody - lastBody) : -1

  const legVanished = legLVanished.some(Boolean) || legRVanished.some(Boolean)

  const m: CompMetrics = {
    fixture: run.fixture.id,
    preset: run.preset,
    frameCount: plan.report.frameCount,
    ampScale: plan.report.ampScale,
    plantedPerFrame,
    maxBothLift,
    maxPlantedSlideX,
    groundPenetration,
    loopSeamPx,
    legVanished,
    movedPixels: plan.frames.map((_f, i) => countMoved(buffers[i], anchorBuf)),
    qaIssues: qa.map((is) => ({
      code: is.code,
      message: is.message,
      ...(is.frameIndexes ? { frameIndexes: [...is.frameIndexes] } : {}),
    })),
    skippedRoles: plan.report.skipped.map((s) => `${s.role}:${s.reason}`),
  }
  report.push(m)

  // artifacts
  const scale = run.fixture.size <= 16 ? 8 : run.fixture.size <= 32 ? 4 : 2
  const name = `${run.fixture.id}--${run.preset}${run.frameCount ? `-f${run.frameCount}` : ''}`
  writeSheet(name, buffers, w, h, scale)
  writeGif(name, buffers, w, h, scale)
}

function lowestRowWhere(buf: Uint8ClampedArray, w: number, h: number, test: (b: Uint8ClampedArray, i: number) => boolean): number | null {
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      if (test(buf, (y * w + x) * 4)) return y
    }
  }
  return null
}

function xSpanWhereRow(buf: Uint8ClampedArray, w: number, h: number, row: number, test: (b: Uint8ClampedArray, i: number) => boolean): [number, number] | null {
  let minX = Infinity
  let maxX = -Infinity
  for (let x = 0; x < w; x++) {
    if (test(buf, (row * w + x) * 4)) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
  }
  return Number.isFinite(minX) ? [minX, maxX] : null
}

function countMoved(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (
      a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]
    ) {
      n++
    }
  }
  return n
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

// console summary
console.log(`== CORE motion audit — ${report.length} compositions → ${OUT}`)
let flags = 0
for (const m of report) {
  const problems: string[] = []
  if (GROUND_PRESETS.has(m.preset) && m.plantedPerFrame.some((p) => !p)) problems.push('FLOATING')
  if (m.groundPenetration) problems.push('GROUND-PENETRATION')
  if (m.legVanished) problems.push('LEG-VANISHED')
  if (m.loopSeamPx > 2) problems.push(`LOOP-SEAM(${m.loopSeamPx})`)
  if (m.qaIssues.some((i) => !['out_of_bounds', 'play_once'].includes(i.code))) {
    problems.push(`QA(${m.qaIssues.map((i) => i.code).join(',')})`)
  }
  if (problems.length) flags++
  console.log(
    `${problems.length ? '⚠' : '✓'} ${m.fixture} × ${m.preset}${m.frameCount}  moved=[${m.movedPixels.join(',')}]  lift=${m.maxBothLift} slideX=${m.maxPlantedSlideX}${problems.length ? '  → ' + problems.join(' ') : ''}`
  )
}
console.log(flags === 0 ? 'ALL COMPOSITIONS CLEAN' : `${flags} composition(s) flagged for visual review`)
