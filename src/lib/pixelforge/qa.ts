import type {
  MotionFramePlan,
  MotionQAIssue,
  MotionQAMetrics,
  MotionQAReport,
  Offset,
  PixelGrid,
  PresetDef,
  Rect,
  Rig,
} from './types'
import {
  countEnclosedTransparent,
  diffCount,
  isOpaque,
  opaqueComponents,
} from './sprite'
import { composeFrame } from './composer'

export interface AnalyzeOptions {
  /** ignore ground-contact checks (e.g. user knows sprite floats) */
  ignoreGroundContact?: boolean
}

const GROUND_PRESETS = new Set(['idle', 'walk', 'run', 'jump'])
const LOOPS_FOR_JITTER = true // only looping presets get the vibration warning

interface ComposedFrame {
  grid: PixelGrid
  oob: number
  destMask: Uint8Array
  staticCovered: number
}

function composeAll(base: PixelGrid, rig: Rig, plans: MotionFramePlan[]): ComposedFrame[] {
  return plans.map((plan) => {
    const { grid, oobPixels, staticCovered } = composeFrame(base, rig, plan.offsets)
    const destMask = new Uint8Array(base.width * base.height)
    for (const part of rig.parts) {
      const o = plan.offsets[part.id] ?? plan.offsets[part.role] ?? { x: 0, y: 0 }
      const r: Rect = part.rect
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const sx = r.x + x
          const sy = r.y + y
          if (!isOpaque(base, sx, sy)) continue
          const dx = sx + o.x
          const dy = sy + o.y
          if (dx < 0 || dy < 0 || dx >= base.width || dy >= base.height) continue
          destMask[dy * base.width + dx] = 1
        }
      }
    }
    return { grid, oob: oobPixels, destMask, staticCovered }
  })
}

function legParts(rig: Rig): Rig['parts'] {
  return rig.parts.filter((p) => p.role === 'legL' || p.role === 'legR')
}

function legOffset(plan: MotionFramePlan, partId: string, role: string): Offset {
  return plan.offsets[partId] ?? plan.offsets[role] ?? { x: 0, y: 0 }
}

/** Lowest opaque row of the composed frame inside a (translated) leg rect. */
function contactRowOf(frame: PixelGrid, rect: Rect): number | null {
  for (let y = rect.y + rect.h - 1; y >= rect.y; y--) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (isOpaque(frame, x, y)) return y
    }
  }
  return null
}

/**
 * Non-destructive motion QA (R10). Produces heuristic warnings with
 * explanations; never mutates the sprite or the plan.
 */
export function analyzeMotion(
  base: PixelGrid,
  rig: Rig,
  preset: PresetDef,
  plans: MotionFramePlan[],
  opts: AnalyzeOptions = {}
): MotionQAReport {
  const issues: MotionQAIssue[] = []
  const n = plans.length
  const frames = composeAll(base, rig, plans)
  const legs = legParts(rig)

  /* --- foot contact & penetration ------------------------------------ */
  const baseContact =
    legs.length > 0
      ? Math.max(
          ...legs.map((p) => {
            let lowest: number | null = null
            for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++)
              for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++)
                if (isOpaque(base, x, y)) { lowest = y; break }
            return lowest ?? -1
          })
        )
      : null

  const footContactRow: (number | null)[] = frames.map((frame, fi) => {
    if (legs.length === 0) return null
    let lowest: number | null = null
    for (const p of legs) {
      const o = legOffset(plans[fi], p.id, p.role)
      const row = contactRowOf(frame.grid, {
        x: p.rect.x + o.x,
        y: p.rect.y + o.y,
        w: p.rect.w,
        h: p.rect.h,
      })
      if (row !== null && (lowest === null || row > lowest)) lowest = row
    }
    return lowest
  })

  // Penetration: any frame where legs are NOT lifted (dy >= 0) but the lowest
  // foot row sits below the sprite's own resting contact row.
  if (baseContact !== null && baseContact >= 0 && legs.length > 0 && !opts.ignoreGroundContact) {
    const sinkFrames: number[] = []
    let sank = 0
    plans.forEach((plan, i) => {
      const lifted = legs.some((p) => legOffset(plan, p.id, p.role).y < 0)
      if (lifted) return
      const row = footContactRow[i]
      if (row !== null && row > baseContact) {
        sinkFrames.push(i)
        sank = Math.max(sank, row - baseContact)
      }
    })
    if (sinkFrames.length > 0 && GROUND_PRESETS.has(preset.id)) {
      issues.push({
        severity: 'warning',
        code: 'GROUND_PENETRATION',
        message: `Feet sink ${sank}px below the standing ground line on frame${sinkFrames.length > 1 ? 's' : ''} ${sinkFrames.join(', ')}.`,
        frames: sinkFrames,
        explanation:
          'Heuristic: on frames where legs were translated downward (or the body moved without leg compensation), the lowest foot pixels drop below the sprite’s own resting contact row — usually feet moving into the floor rather than bending.',
      })
    }
  }

  // Foot slide: consecutive frames where the same leg stays at dy === 0
  // (planted) but its horizontal offset jumps by >= 2px.
  const slideFrames: number[] = []
  let slideMax = 0
  if (legs.length > 0) {
    for (const p of legs) {
      for (let i = 0; i < n - 1; i++) {
        const a = legOffset(plans[i], p.id, p.role)
        const b = legOffset(plans[i + 1], p.id, p.role)
        if (a.y === 0 && b.y === 0 && Math.abs(b.x - a.x) >= 2) {
          slideFrames.push(i + 1)
          slideMax = Math.max(slideMax, Math.abs(b.x - a.x))
        }
      }
    }
    if (slideFrames.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'FOOT_SLIDE',
        message: `Planted foot slides ${slideMax}px between frames (${slideFrames.join(', ')}) — skating look.`,
        frames: slideFrames,
        explanation:
          'Heuristic: a leg that stays at ground level (dy=0) but shifts horizontally ≥2px between consecutive frames reads as sliding. Lift the foot (dy<0) while it travels, or keep its x offset constant while planted.',
      })
    }
  }

  /* --- transitions / loop / stutter / flicker ------------------------ */
  const transitions: number[] = []
  for (let i = 0; i < n - 1; i++) {
    transitions.push(diffCount(frames[i].grid, frames[i + 1].grid))
  }
  const wrap = diffCount(frames[n - 1].grid, frames[0].grid)
  const loopTransitionDelta = preset.loops ? wrap : 0
  const meanTransitionDelta =
    transitions.length > 0 ? transitions.reduce((a, b) => a + b, 0) / transitions.length : 0

  if (preset.loops && transitions.length > 1 && meanTransitionDelta > 0) {
    // 2.5x allowance: gait cycles legitimately run ~2x the mean on contact
    // transitions because small "plant" adjustments dilute the average.
    if (loopTransitionDelta > Math.max(2.5 * meanTransitionDelta, meanTransitionDelta + 6)) {
      issues.push({
        severity: 'warning',
        code: 'LOOP_BREAK',
        message: `Loop wrap (last→first) changes ${loopTransitionDelta}px vs ${Math.round(meanTransitionDelta)}px typical — likely visible pop.`,
        frames: [n - 1],
        explanation:
          'Heuristic: for a seamless cycle the wrap transition should be comparable in size to the other transitions. A much larger wrap usually means the cycle does not return to its start pose.',
      })
    }
    if (loopTransitionDelta === 0) {
      issues.push({
        severity: 'warning',
        code: 'LOOP_DWELL',
        message: `First and last frames are identical — that pose displays for ${plans[n - 1].duration + plans[0].duration}ms every cycle.`,
        frames: [n - 1, 0],
        explanation:
          'Heuristic: identical first/last frames create a double-length dwell at the loop point. Sometimes intended (a rest beat), but for breathing/locomotion it reads as a stutter.',
      })
    }
  }

  // Stutter: near-zero transition flanked by moving ones — but skip perfect
  // alternating move/hold rhythms (half the transitions are holds by design).
  // Suppressed entirely when required parts are missing: a degraded animation
  // holds frames because limbs cannot move — MISSING_PARTS explains that.
  const missingRoles = preset.requiredRoles.filter((r) => !rig.parts.some((p) => p.role === r))
  const scan = preset.loops ? [...transitions, wrap] : transitions
  const scanMean =
    scan.length > 0 ? scan.reduce((a, b) => a + b, 0) / scan.length : 0
  const smallThreshold = Math.max(2, scanMean * 0.05)
  const smallIdx = scan
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => scanMean > 0 && t <= smallThreshold)
    .map(({ i }) => i)
  const movingCount = scan.filter((t) => t > smallThreshold).length
  const alternatingRhythm =
    smallIdx.length > 0 && Math.abs(smallIdx.length - movingCount) <= 1 &&
    smallIdx.every((i, k) => k === 0 || smallIdx[k - 1] === i - 2 || smallIdx[k - 1] === i - 1 || smallIdx[k - 1] + 2 === i)
  const stutterTransitions =
    missingRoles.length > 0 || alternatingRhythm ? [] : smallIdx
  if (stutterTransitions.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'STUTTER',
      message: `Frame${stutterTransitions.length > 1 ? 's' : ''} ${stutterTransitions.join(', ')} barely change while neighbouring frames move — playback stutter.`,
      frames: stutterTransitions,
      explanation:
        'Heuristic: a nearly-identical frame sandwiched between moving frames often reads as a freeze or duplicated frame. May be intentional (pose hold) — review before changing.',
    })
  }

  let flickerCycles = 0
  if (missingRoles.length === 0) {
    for (let i = 0; i + 1 < scan.length; i += 2) {
      if (scan[i] > scanMean * 1.5 && scan[i + 1] < scanMean * 0.5) flickerCycles++
    }
  }
  if (flickerCycles >= 2) {
    issues.push({
      severity: 'warning',
      code: 'FLICKER',
      message: `Alternating big/small frame changes detected (${flickerCycles} cycles) — may flicker at speed.`,
      frames: [],
      explanation:
        'Heuristic: repeated large-then-tiny transitions at uniform durations can read as flicker. Consider evening out pose deltas or durations.',
    })
  }

  /* --- jitter: period-2 offset vibration ------------------------------ */
  // A part whose offset vibrates A,B,A,B between frames looks shaky.
  // Only looping presets get the warning; sharp one-shot reversals
  // (attacks, crouches) are intentional snap and reported as info.
  let vibrationAxes = 0
  const vibParts: string[] = []
  if (n >= 5) {
    for (const part of rig.parts) {
      for (const axis of ['x', 'y'] as const) {
        const series = plans.map((p) => (p.offsets[part.id] ?? p.offsets[part.role] ?? { x: 0, y: 0 })[axis])
        const d: number[] = []
        for (let i = 0; i < n; i++) {
          const next = preset.loops ? series[(i + 1) % n] : series[Math.min(i + 1, n - 1)]
          d.push(next - series[i])
        }
        for (let i = 0; i + 3 < d.length; i++) {
          const s = [Math.sign(d[i]), Math.sign(d[i + 1]), Math.sign(d[i + 2]), Math.sign(d[i + 3])]
          if (s.every((v) => v !== 0) && s[0] === -s[1] && s[1] === -s[2] && s[2] === -s[3]) {
            vibrationAxes++
            vibParts.push(`${part.label}.${axis}`)
            break
          }
        }
      }
    }
  }
  if (vibrationAxes > 0) {
    issues.push({
      severity: preset.loops && LOOPS_FOR_JITTER ? 'warning' : 'info',
      code: 'JITTER',
      message: `Offset vibration on ${vibParts.join(', ')} — part(s) alternate direction every frame.`,
      frames: [],
      explanation:
        'Heuristic: true vibration is a part alternating A,B,A,B each frame. Deliberate fast reversals (attack windup→strike) are normal; review only if the limb looks shaky in playback.',
    })
  }

  /* --- separation / holes / oob / amplitude --------------------------- */
  const partComponents: number[] = []
  const separationFrames: number[] = []
  for (let i = 0; i < n; i++) {
    const comps = opaqueComponents(frames[i].grid, frames[i].destMask).filter((s) => s >= 3)
    partComponents.push(comps.length)
    if (comps.length > 1) separationFrames.push(i)
  }
  if (separationFrames.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'PART_SEPARATION',
      message: `Moving parts split into disconnected pieces on frame${separationFrames.length > 1 ? 's' : ''} ${separationFrames.join(', ')}.`,
      frames: separationFrames,
      explanation:
        'Heuristic: pixels belonging to rig parts form more than one island — a limb likely detached from the body at its joint. Fix by enlarging the part rect overlap or reducing that part’s offset.',
    })
  }

  // Holes relative to the base sprite: only NEW enclosures count (the base
  // may legitimately contain enclosed background, e.g. between the legs).
  const baseEnclosed = baseEnclosedSet(base)
  const interiorHoles: number[] = []
  const holeFrames: number[] = []
  frames.forEach((frame, i) => {
    const enclosed = frameEnclosedSet(frame.grid)
    let fresh = 0
    enclosed.forEach((idxVal) => {
      if (!baseEnclosed.has(idxVal)) fresh++
    })
    interiorHoles.push(fresh)
    if (fresh > 0) holeFrames.push(i)
  })
  if (holeFrames.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'TRANSPARENCY_HOLES',
      message: `${holeFrames.length} frame${holeFrames.length > 1 ? 's' : ''} gain enclosed transparent holes (${holeFrames.join(', ')}) that the base sprite does not have.`,
      frames: holeFrames,
      explanation:
        'Heuristic: after composition some pixels become fully enclosed by opaque pixels but stay transparent — often a 1px gap where two moving parts used to overlap. Enclosed background already present in the base sprite (e.g. between the legs) is not counted.',
    })
  }

  const oobPixels: number[] = frames.map((f) => f.oob)
  const oobFrames: number[] = []
  oobPixels.forEach((o, i) => { if (o > 0) oobFrames.push(i) })
  if (oobFrames.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'OUT_OF_BOUNDS',
      message: `Frame${oobFrames.length > 1 ? 's' : ''} ${oobFrames.join(', ')} clip ${Math.max(...oobPixels)} part pixel(s) at the canvas edge — add margin or reduce amplitude.`,
      frames: oobFrames,
      explanation:
        'Deterministic count of rig pixels whose translated destination lies outside the canvas. Clipped pixels are dropped from output.',
    })
  }

  // Static coverage: moving parts landing on static artwork (ground lines,
  // background details) — reported, never modified (R10).
  const staticCovered: number[] = frames.map((f) => f.staticCovered)
  const coverFrames: number[] = []
  staticCovered.forEach((c, i) => { if (c > 0) coverFrames.push(i) })
  if (coverFrames.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'STATIC_OVERLAP',
      message: `Motion covers static pixels (ground/background) on frame${coverFrames.length > 1 ? 's' : ''} ${coverFrames.join(', ')} (up to ${Math.max(...staticCovered)}px).`,
      frames: coverFrames,
      explanation:
        'Heuristic: translated part pixels are drawn over static artwork that belongs to no part — typically a ground line under a crouching/bouncing body. Shrink the part rect, move the detail, or accept the overlap (squash effects often want this).',
    })
  }

  let maxOffsetPx = 0
  for (const plan of plans) {
    for (const part of rig.parts) {
      const o = plan.offsets[part.id] ?? plan.offsets[part.role]
      if (!o) continue
      maxOffsetPx = Math.max(maxOffsetPx, Math.abs(o.x) + Math.abs(o.y))
    }
  }
  const amplitudeLimit = Math.max(4, Math.round(base.height * 0.16))
  if (maxOffsetPx > amplitudeLimit) {
    issues.push({
      severity: 'warning',
      code: 'EXCESS_AMPLITUDE',
      message: `Largest part move is ${maxOffsetPx}px; > ${amplitudeLimit}px tends to break small sprites.`,
      frames: [],
      explanation:
        'Heuristic: translation beyond ~16% of sprite height usually detaches limbs or exits the canvas on 16–48px art. Review silhouette after applying.',
    })
  }

  /* --- missing required parts ----------------------------------------- */
  const roles = new Set(rig.parts.map((p) => p.role))
  const missing = preset.requiredRoles.filter((r) => !roles.has(r))
  if (missing.length > 0) {
    issues.push({
      severity: missing.length === preset.requiredRoles.length ? 'warning' : 'info',
      code: 'MISSING_PARTS',
      message: `Preset expects ${preset.requiredRoles.join(' + ')}; your rig is missing: ${missing.join(', ')}.`,
      frames: [],
      explanation:
        'Parts are matched by role. Missing roles simply do not move, so the motion will look partial (e.g. legs slide under a static body). Assign the missing parts in the rig editor for full motion.',
    })
  }

  const metrics: MotionQAMetrics = {
    footContactRow,
    footContactVariance: footContactVarianceOf(plans, footContactRow, legs),
    transitions: [...transitions, ...(preset.loops ? [wrap] : [])],
    loopTransitionDelta,
    meanTransitionDelta,
    partComponents,
    interiorHoles,
    oobPixels,
    maxOffsetPx,
    jitterScore: vibrationAxes,
    stutterTransitions,
    staticCovered,
  }

  return { presetId: preset.id, issues, metrics }
}

function footContactVarianceOf(
  plans: MotionFramePlan[],
  rows: (number | null)[],
  legs: Rig['parts']
): number {
  if (legs.length === 0) return 0
  // Variance across frames where all legs are planted (dy === 0).
  const plantedRows: number[] = []
  plans.forEach((plan, i) => {
    const allPlanted = legs.every((p) => legOffset(plan, p.id, p.role).y === 0)
    if (allPlanted && rows[i] !== null) plantedRows.push(rows[i] as number)
  })
  if (plantedRows.length === 0) return 0
  return Math.max(...plantedRows) - Math.min(...plantedRows)
}

/** Indices of fully-enclosed transparent pixels. */
function frameEnclosedSet(grid: PixelGrid): Set<number> {
  return enclosedSet(grid, false)
}

function baseEnclosedSet(grid: PixelGrid): Set<number> {
  return enclosedSet(grid, false)
}

function enclosedSet(grid: PixelGrid, _unused?: boolean): Set<number> {
  const total = grid.width * grid.height
  const reached = new Uint8Array(total)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return
    const i = y * grid.width + x
    if (reached[i]) return
    if (isOpaque(grid, x, y)) return
    reached[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < grid.width; x++) { push(x, 0); push(x, grid.height - 1) }
  for (let y = 0; y < grid.height; y++) { push(0, y); push(grid.width - 1, y) }
  while (stack.length > 0) {
    const cur = stack.pop() as number
    const x = cur % grid.width
    const y = (cur - x) / grid.width
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1)
  }
  const out = new Set<number>()
  for (let i = 0; i < total; i++) {
    if (reached[i]) continue
    const x = i % grid.width
    const y = (i - x) / grid.width
    if (!isOpaque(grid, x, y)) out.add(i)
  }
  return out
}

export type Rating = 'good' | 'needs-adjustment' | 'poor'

const HARD_CODES = new Set([
  'PART_SEPARATION',
  'GROUND_PENETRATION',
  'OUT_OF_BOUNDS',
  'MISSING_PARTS',
  'FOOT_SLIDE',
  'LOOP_BREAK',
])

/** Rating rule used by the audit + UI badge (heuristic, explainable). */
export function classifyReport(report: MotionQAReport): { rating: Rating; reasons: string[] } {
  const warnings = report.issues.filter((i) => i.severity === 'warning')
  if (warnings.length === 0) {
    return { rating: 'good', reasons: ['No heuristic warnings fired.'] }
  }
  const hard = warnings.filter((w) => HARD_CODES.has(w.code))
  const soft = warnings.filter((w) => !HARD_CODES.has(w.code))
  if (hard.length > 0 || soft.length >= 3) {
    return {
      rating: 'poor',
      reasons: [...hard.map((w) => w.message), ...soft.map((w) => w.message)],
    }
  }
  return {
    rating: 'needs-adjustment',
    reasons: soft.map((w) => w.message),
  }
}
