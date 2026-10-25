/**
 * Task 10 — Motion Accuracy Audit harness.
 * Renders every preset's actual frames (no mocks), computes metrics, writes
 * sprite sheets (x4 nearest), animated GIFs and a JSON report to artifacts/.
 *
 * Run: bun scripts/motion-audit.ts [v1|v2|both] [fixture|all]
 * No network, no AI calls — deterministic local rendering only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

import type { PixelGrid, PresetId, PresetParams } from '../src/lib/pixelforge/types'
import { getFixture, type FixtureId } from '../src/lib/pixelforge/fixtures'
import { getPresetSet, PRESET_ORDER, DEFAULT_PARAMS, type PresetVersion } from '../src/lib/pixelforge/presets'
import { generateAnimation } from '../src/lib/pixelforge/animate'
import { analyzeMotion, classifyReport } from '../src/lib/pixelforge/qa'
import { getPixel } from '../src/lib/pixelforge/sprite'

const OUT = join(process.cwd(), 'artifacts', 'task10')
mkdirSync(OUT, { recursive: true })

function gridToPng(grid: PixelGrid, scale = 1): PNG {
  const png = new PNG({ width: grid.width * scale, height: grid.height * scale })
  for (let y = 0; y < grid.height * scale; y++) {
    for (let x = 0; x < grid.width * scale; x++) {
      const c = getPixel(grid, Math.floor(x / scale), Math.floor(y / scale))
      const i = (y * png.width + x) * 4
      png.data[i] = c.r
      png.data[i + 1] = c.g
      png.data[i + 2] = c.b
      if (scale > 1) {
        // checkerboard backdrop for transparency visibility at preview scale
        const checker = ((Math.floor(x / (4 * scale)) + Math.floor(y / (4 * scale))) % 2) === 0
        const bg = checker ? 210 : 170
        const alpha = c.a / 255
        png.data[i] = Math.round(c.r * alpha + bg * (1 - alpha))
        png.data[i + 1] = Math.round(c.g * alpha + bg * (1 - alpha))
        png.data[i + 2] = Math.round(c.b * alpha + bg * (1 - alpha))
        png.data[i + 3] = 255
      } else {
        png.data[i + 3] = c.a
      }
    }
  }
  return png
}

function writeSheet(name: string, frames: PixelGrid[], scale: number): void {
  const w = frames.reduce((a, f) => a + f.width * scale + 8 * scale, 8 * scale)
  const h = Math.max(...frames.map((f) => f.height)) * scale + 16 * scale
  const sheet = new PNG({ width: w, height: h })
  const bg = (x: number, y: number) => (((Math.floor(x / 8) + Math.floor(y / 8)) % 2) === 0 ? 235 : 205)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    sheet.data[i] = bg(x, y); sheet.data[i + 1] = bg(x, y); sheet.data[i + 2] = bg(x, y); sheet.data[i + 3] = 255
  }
  let cursor = 8 * scale
  for (const f of frames) {
    const png = gridToPng(f, scale)
    PNG.bitblt(png, sheet, 0, 0, png.width, png.height, cursor, 8 * scale)
    cursor += png.width + 8 * scale
  }
  writeFileSync(join(OUT, name), PNG.sync.write(sheet))
}

function writeGif(name: string, frames: PixelGrid[], durations: number[], scale: number): void {
  // Compose on checkerboard for visibility
  const rgbaFrames = frames.map((f) => {
    const png = gridToPng(f, scale)
    return { data: new Uint8Array(png.data), width: png.width, height: png.height }
  })
  const gif = GIFEncoder()
  const palette = quantize(rgbaFrames[0].data, 64)
  for (let i = 0; i < rgbaFrames.length; i++) {
    const indexed = applyPalette(rgbaFrames[i].data, palette)
    gif.writeFrame(indexed, rgbaFrames[i].width, rgbaFrames[i].height, { palette, delay: durations[i], dispose: 2 })
  }
  gif.finish()
  writeFileSync(join(OUT, name), Buffer.from(gif.bytes()))
}

interface AuditRow {
  fixture: FixtureId
  preset: PresetId
  version: PresetVersion
  facing: PresetParams['facing']
  rating: string
  reasons: string[]
  issues: { code: string; severity: string; message: string }[]
  metrics: {
    frames: number
    durationsMs: number[]
    footContactRow: (number | null)[]
    footContactVariance: number
    transitions: number[]
    loopTransitionDelta: number
    meanTransitionDelta: number
    partComponents: number[]
    interiorHoles: number[]
    oobPixels: number[]
    maxOffsetPx: number
    jitterScore: number
    stutterTransitions: number[]
    staticCovered: number[]
  }
}

const versionArg = (process.argv[2] as PresetVersion | 'both' | undefined) ?? 'both'
const fixtureArg = (process.argv[3] as FixtureId | 'all' | undefined) ?? 'all'
const fixtureIds: FixtureId[] = fixtureArg === 'all' ? ['simple', 'detailed', 'slime'] : [fixtureArg]
const versions: PresetVersion[] = versionArg === 'both' ? ['v1', 'v2'] : [versionArg]

const rows: AuditRow[] = []

for (const fixtureId of fixtureIds) {
  const { grid, rig, label } = getFixture(fixtureId)
  for (const version of versions) {
    const set = getPresetSet(version)
    for (const presetId of PRESET_ORDER) {
      const preset = set[presetId]
      const facing: PresetParams['facing'] = 'side'
      const anim = generateAnimation(grid, rig, preset, { ...DEFAULT_PARAMS, facing })
      const qa = analyzeMotion(grid, rig, preset, anim.plans)
      const { rating, reasons } = classifyReport(qa)
      const tag = `${fixtureId}-${presetId}-${version}`
      writeSheet(`${tag}-sheet.png`, anim.frames, 4)
      writeGif(`${tag}.gif`, anim.frames, anim.plans.map((p) => p.duration), 6)
      rows.push({
        fixture: fixtureId,
        preset: presetId,
        version,
        facing,
        rating,
        reasons,
        issues: qa.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
        metrics: {
          frames: anim.frames.length,
          durationsMs: anim.plans.map((p) => p.duration),
          footContactRow: qa.metrics.footContactRow,
          footContactVariance: qa.metrics.footContactVariance,
          transitions: qa.metrics.transitions,
          loopTransitionDelta: qa.metrics.loopTransitionDelta,
          meanTransitionDelta: Math.round(qa.metrics.meanTransitionDelta * 10) / 10,
          partComponents: qa.metrics.partComponents,
          interiorHoles: qa.metrics.interiorHoles,
          oobPixels: qa.metrics.oobPixels,
          maxOffsetPx: qa.metrics.maxOffsetPx,
          jitterScore: qa.metrics.jitterScore,
          stutterTransitions: qa.metrics.stutterTransitions,
          staticCovered: qa.metrics.staticCovered,
        },
      })
      console.log(
        `[${label}] ${presetId} ${version}: ${rating.toUpperCase()}` +
        (qa.issues.length ? ` — ${qa.issues.map((i) => i.code).join(', ')}` : ' — clean')
      )
    }
  }
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2))
console.log(`\nWrote ${rows.length} audit rows + sheets/gifs to ${OUT}`)

/* ---- Amplitude sweep: user-control evidence (Section 5) -----------------
 * Tight-canvas sprites (detailed 48x48, sword near the right edge) may clip
 * at full amplitude. Sweep amplitude to show the recovery path.            */
const ampRows: AuditRow[] = []
{
  const { grid, rig, label } = getFixture('detailed')
  const setV2 = getPresetSet('v2')
  for (const presetId of ['attack', 'run', 'walk'] as const) {
    for (const amp of [0.75, 1.25, 1.5]) {
      const preset = setV2[presetId]
      const anim = generateAnimation(grid, rig, preset, { ...DEFAULT_PARAMS, amplitude: amp })
      const qa = analyzeMotion(grid, rig, preset, anim.plans)
      const { rating, reasons } = classifyReport(qa)
      const tag = `detailed-${presetId}-v2-amp${amp}`
      if (presetId === 'attack') writeSheet(`${tag}-sheet.png`, anim.frames, 4)
      ampRows.push({
        fixture: 'detailed',
        preset: presetId,
        version: 'v2',
        facing: 'side',
        rating,
        reasons,
        issues: qa.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
        metrics: {
          frames: anim.frames.length,
          durationsMs: anim.plans.map((p) => p.duration),
          footContactRow: qa.metrics.footContactRow,
          footContactVariance: qa.metrics.footContactVariance,
          transitions: qa.metrics.transitions,
          loopTransitionDelta: qa.metrics.loopTransitionDelta,
          meanTransitionDelta: Math.round(qa.metrics.meanTransitionDelta * 10) / 10,
          partComponents: qa.metrics.partComponents,
          interiorHoles: qa.metrics.interiorHoles,
          oobPixels: qa.metrics.oobPixels,
          maxOffsetPx: qa.metrics.maxOffsetPx,
          jitterScore: qa.metrics.jitterScore,
          stutterTransitions: qa.metrics.stutterTransitions,
          staticCovered: qa.metrics.staticCovered,
        },
      })
      console.log(
        `[${label}] ${presetId} v2 amp=${amp}: ${rating.toUpperCase()}` +
        (qa.issues.length ? ` — ${qa.issues.map((i) => i.code).join(', ')}` : ' — clean')
      )
    }
  }
}
writeFileSync(
  join(OUT, 'report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), rows, amplitudeSweep: ampRows }, null, 2)
)
console.log(`\nTotal: ${rows.length} audit rows + ${ampRows.length} amplitude rows`)
