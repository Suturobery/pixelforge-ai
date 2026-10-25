import type { MotionFramePlan } from './types'

export type PlaybackMode = 'loop' | 'once' | 'reverse' | 'pingpong'

export interface PlaybackStep {
  /** index into the frame array */
  frame: number
  duration: number
}

/**
 * Build the played step sequence for a frame list.
 *  - loop:     0..n-1 cycling
 *  - once:     0..n-1 then hold on the last frame (attacks/jumps)
 *  - reverse:  n-1..0 cycling
 *  - pingpong: 0..n-1..0 without duplicating the end frames
 */
export function buildPlaybackSequence(
  plans: MotionFramePlan[],
  mode: PlaybackMode
): PlaybackStep[] {
  const n = plans.length
  if (n === 0) return []
  const durations = plans.map((p) => p.duration)
  switch (mode) {
    case 'once': {
      const steps: PlaybackStep[] = plans.map((_, i) => ({ frame: i, duration: durations[i] }))
      steps.push({ frame: n - 1, duration: Math.max(durations[n - 1], 400) })
      return steps
    }
    case 'reverse': {
      const steps: PlaybackStep[] = []
      for (let i = n - 1; i >= 0; i--) steps.push({ frame: i, duration: durations[i] })
      return steps
    }
    case 'pingpong': {
      const steps: PlaybackStep[] = []
      for (let i = 0; i < n; i++) steps.push({ frame: i, duration: durations[i] })
      for (let i = n - 2; i >= 1; i--) steps.push({ frame: i, duration: durations[i] })
      return steps
    }
    case 'loop':
    default: {
      return plans.map((_, i) => ({ frame: i, duration: durations[i] }))
    }
  }
}

/** Total cycle time in ms (for the timing readout). */
export function cycleTime(steps: PlaybackStep[]): number {
  return steps.reduce((a, s) => a + s.duration, 0)
}

/** Effective per-frame durations after overrides. */
export function effectiveDurations(
  plans: MotionFramePlan[],
  overrides: (number | undefined)[]
): number[] {
  return plans.map((p, i) => Math.max(20, overrides[i] ?? p.duration))
}
