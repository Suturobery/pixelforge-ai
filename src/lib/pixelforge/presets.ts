import type {
  Facing,
  MotionFramePlan,
  Offset,
  PartRole,
  PresetDef,
  PresetId,
  PresetParams,
  Rig,
} from './types'

type Vec = [number, number]
type PoseRow = Partial<Record<PartRole, Vec>>

function off(v: Vec, amp: number): Offset {
  return { x: Math.round(v[0] * amp), y: Math.round(v[1] * amp) }
}

function buildPoses(
  rows: PoseRow[],
  baseDurations: number[],
  params: PresetParams
): MotionFramePlan[] {
  const amp = params.amplitude
  return rows.map((row, i) => {
    const offsets: Record<string, Offset> = {}
    for (const role of Object.keys(row) as PartRole[]) {
      const v = row[role]
      if (!v) continue
      offsets[role] = off(v, amp)
    }
    const duration = Math.max(20, Math.round(baseDurations[i] * params.speed))
    return { offsets, duration }
  })
}

/** Static zero pose for convenience. */
const ZERO: PoseRow = {}

/* ------------------------------------------------------------------ */
/* V1 — baseline formulas (pre-audit "as reported" behaviour).        */
/* Kept for before/after comparison and the in-app Legacy toggle.     */
/* ------------------------------------------------------------------ */

const idleV1: PresetDef = {
  id: 'idle',
  label: 'Idle',
  description: 'Breathing bob (baseline v1: 3-frame cycle, arms static).',
  loops: true,
  requiredRoles: ['torso'],
  optionalRoles: ['head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    return buildPoses(
      [
        ZERO,
        { torso: [0, 1], head: [0, 1] },
        ZERO,
      ],
      [250, 250, 250],
      params
    )
  },
}

const walkV1: PresetDef = {
  id: 'walk',
  label: 'Walk',
  description: 'Horizontal scissor legs (baseline v1: no vertical motion, feet slide).',
  loops: true,
  requiredRoles: ['legL', 'legR'],
  optionalRoles: ['torso', 'head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    return buildPoses(
      [
        { legL: [2, 0], legR: [-2, 0], armL: [-1, 0], armR: [1, 0] },
        ZERO,
        { legL: [-2, 0], legR: [2, 0], armL: [1, 0], armR: [-1, 0] },
        ZERO,
      ],
      [120, 120, 120, 120],
      params
    )
  },
}

const runV1: PresetDef = {
  id: 'run',
  label: 'Run',
  description: 'Wide scissor with upper-body bob (baseline v1: legs never follow the bob).',
  loops: true,
  requiredRoles: ['legL', 'legR'],
  optionalRoles: ['torso', 'head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    const body: PoseRow = { head: [0, 0], torso: [0, 0] }
    return buildPoses(
      [
        { ...body, legL: [3, 0], legR: [-3, 0], armL: [-2, 0], armR: [2, 0] },
        { head: [0, -1], torso: [0, -1], armL: [0, -1], armR: [0, -1], legL: [0, 0], legR: [0, 0] },
        { ...body, legL: [-3, 0], legR: [3, 0], armL: [2, 0], armR: [-2, 0] },
        { head: [0, -1], torso: [0, -1], armL: [0, -1], armR: [0, -1], legL: [0, 0], legR: [0, 0] },
      ],
      [100, 100, 100, 100],
      params
    )
  },
}

const attackV1: PresetDef = {
  id: 'attack',
  label: 'Attack',
  description: 'Stab (baseline v1: loops, uniform timing, no recovery pose).',
  loops: true, // v1 defect: attack loops instead of recovering (R8 violation)
  requiredRoles: ['armR'],
  optionalRoles: ['armL', 'torso', 'head'],
  buildFrames(_rig, params) {
    return buildPoses(
      [
        ZERO,
        { armR: [-2, 0] },
        { armR: [3, 0], torso: [1, 0], head: [1, 0] },
        ZERO,
      ],
      [150, 150, 150, 150],
      params
    )
  },
}

const jumpV1: PresetDef = {
  id: 'jump',
  label: 'Jump',
  description: 'Crouch/leap (baseline v1: legs move down on crouch, uniform timing, loops).',
  loops: true, // v1 defect
  requiredRoles: ['torso', 'legL', 'legR'],
  optionalRoles: ['head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    const all: PoseRow = {
      head: [0, 1], torso: [0, 1], armL: [0, 1], armR: [0, 1], legL: [0, 1], legR: [0, 1],
    }
    const up = (dy: number): PoseRow => ({
      head: [0, dy], torso: [0, dy], armL: [0, dy], armR: [0, dy], legL: [0, dy], legR: [0, dy],
    })
    return buildPoses(
      [all, up(-2), up(-3), all],
      [150, 150, 150, 150],
      params
    )
  },
}

export const PRESETS_V1: Record<PresetId, PresetDef> = {
  idle: idleV1,
  walk: walkV1,
  run: runV1,
  attack: attackV1,
  jump: jumpV1,
}

/* ------------------------------------------------------------------ */
/* V2 — improved formulas (post-audit).                               */
/* Key fixes vs v1:                                                   */
/*  - idle: 4-frame move/hold rhythm, arms+head follow torso.         */
/*  - walk: 6 frames, planted near-foot phase, rear-foot lift,        */
/*          body bob on pass frames only, equal transition rhythm.    */
/*  - run:  flight phase (both feet off ground), legs follow bob.     */
/*  - attack: one-shot with anticipation/fast strike/recovery,        */
/*          facing-aware (side stab vs front overhead chop).          */
/*  - jump: feet stay planted on crouch/land, airborne tuck,          */
/*          gravity-feel timing, one-shot.                            */
/*  - front-facing variants for walk/run instead of side scissor.     */
/* ------------------------------------------------------------------ */

const idleV2: PresetDef = {
  id: 'idle',
  label: 'Idle',
  description: 'Two-pose breathing bob (settle/rise) — no dwell frames, seamless cycle.',
  loops: true,
  requiredRoles: ['torso'],
  optionalRoles: ['head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    const down: PoseRow = { torso: [0, 1], head: [0, 1], armL: [0, 1], armR: [0, 1] }
    return buildPoses(
      [ZERO, down],
      [550, 450],
      params
    )
  },
}

const walkV2: PresetDef = {
  id: 'walk',
  label: 'Walk',
  description: '6-frame cycle: planted contact phase, rear-foot lift, pass-frame bob.',
  loops: true,
  requiredRoles: ['legL', 'legR'],
  optionalRoles: ['torso', 'head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    if (params.facing === 'front') {
      // Front-facing: legs alternate lifting (march), arms counter-phase.
      return buildPoses(
        [
          { legL: [0, -1], armL: [0, 1], armR: [0, 0] },
          ZERO,
          { legR: [0, -1], armR: [0, 1], armL: [0, 0] },
          ZERO,
        ],
        [130, 130, 130, 130],
        params
      )
    }
    return buildPoses(
      [
        // f0 contact A: near leg forward planted, far leg back + lifted
        { legL: [2, 0], legR: [-2, -1], armL: [-1, 0], armR: [1, 0] },
        // f1 plant A: near foot stays planted while far foot reaches
        { legL: [2, 0], legR: [-1, -1], armL: [-1, 0], armR: [1, 0] },
        // f2 pass A: support (near) leg planted, swing (far) leg lifted, body up 1px
        { legL: [1, 0], legR: [0, -1], armL: [0, -1], armR: [0, -1], torso: [0, -1], head: [0, -1] },
        // f3 contact B (exact mirror of f0): near leg rear + lifted, far leg forward planted
        { legL: [-2, -1], legR: [2, 0], armL: [1, 0], armR: [-1, 0] },
        // f4 plant B
        { legL: [-1, -1], legR: [2, 0], armL: [1, 0], armR: [-1, 0] },
        // f5 pass B (mirror of f2)
        { legL: [0, -1], legR: [1, 0], armL: [0, -1], armR: [0, -1], torso: [0, -1], head: [0, -1] },
      ],
      [110, 100, 90, 110, 100, 90],
      params
    )
  },
}

const runV2: PresetDef = {
  id: 'run',
  label: 'Run',
  description: '4-frame cycle with airborne flight phase and leg-follow bob.',
  loops: true,
  requiredRoles: ['legL', 'legR'],
  optionalRoles: ['torso', 'head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    if (params.facing === 'front') {
      return buildPoses(
        [
          { legL: [0, -2], armL: [0, 2] },
          ZERO,
          { legR: [0, -2], armR: [0, 2] },
          ZERO,
        ],
        [90, 90, 90, 90],
        params
      )
    }
    return buildPoses(
      [
        // f0 contact A: near leg forward planted, far leg rear lifted, arms counter-swing
        { legL: [3, 0], legR: [-2, -1], armL: [-2, 0], armR: [1, 0] },
        // f1 flight: both feet off the ground, body up
        { legL: [1, -1], legR: [0, -1], armL: [-1, -1], armR: [0, -1], torso: [0, -1], head: [0, -1] },
        // f2 contact B (mirror of f0)
        { legL: [-2, -1], legR: [3, 0], armL: [2, 0], armR: [-1, 0] },
        // f3 flight
        { legL: [0, -1], legR: [1, -1], armL: [1, -1], armR: [-1, -1], torso: [0, -1], head: [0, -1] },
      ],
      [110, 90, 110, 90],
      params
    )
  },
}

const attackV2: PresetDef = {
  id: 'attack',
  label: 'Attack',
  description: 'One-shot: anticipation, fast strike, follow-through, recovery (side = lunging stab, front = overhead chop).',
  loops: false, // R8: attack recovers instead of looping
  requiredRoles: ['armR'],
  optionalRoles: ['armL', 'torso', 'head'],
  buildFrames(_rig, params) {
    if (params.facing === 'front') {
      // Front-facing: overhead chop (translation-only approximation).
      return buildPoses(
        [
          ZERO,
          { armR: [0, -2], armL: [0, -1] },
          { armR: [0, 1], armL: [0, 1], torso: [0, 1], head: [0, 1] },
          { armR: [0, 1], armL: [0, 1], torso: [0, 1], head: [0, 1] },
          ZERO,
        ],
        [220, 160, 70, 130, 220],
        params
      )
    }
    return buildPoses(
      [
        ZERO,
        // windup: near arm pulls back across the body, far arm follows
        { armL: [-1, 0], armR: [-1, 0] },
        // strike: forward LUNGE — torso steps 2px so the arm stays attached
        { armL: [2, 0], armR: [1, 0], torso: [2, 0], head: [1, 0] },
        // follow-through: settle back 1px, hold the lunge
        { armL: [1, 0], armR: [0, 0], torso: [1, 0], head: [1, 0] },
        ZERO,
      ],
      [220, 160, 70, 130, 220],
      params
    )
  },
}

const jumpV2: PresetDef = {
  id: 'jump',
  label: 'Jump',
  description: 'One-shot: planted crouch, airborne tuck, gravity timing, landing recovery.',
  loops: false,
  requiredRoles: ['torso', 'legL', 'legR'],
  optionalRoles: ['head', 'armL', 'armR'],
  buildFrames(_rig, params) {
    const upper = (dy: number): PoseRow => ({
      torso: [0, dy], head: [0, dy], armL: [0, dy], armR: [0, dy],
    })
    const air = (bodyDy: number, legDy: number): PoseRow => ({
      ...upper(bodyDy),
      legL: [0, legDy],
      legR: [0, legDy],
    })
    return buildPoses(
      [
        ZERO, // f0 stand
        upper(1), // f1 crouch: body sinks, legs stay planted
        air(-2, -1), // f2 launch
        air(-3, -2), // f3 apex: tuck
        air(-1, -1), // f4 fall
        upper(1), // f5 land: planted compress
        ZERO, // f6 recover
      ],
      [160, 120, 90, 140, 110, 100, 160],
      params
    )
  },
}

export const PRESETS_V2: Record<PresetId, PresetDef> = {
  idle: idleV2,
  walk: walkV2,
  run: runV2,
  attack: attackV2,
  jump: jumpV2,
}

export type PresetVersion = 'v1' | 'v2'

export function getPresetSet(version: PresetVersion): Record<PresetId, PresetDef> {
  return version === 'v1' ? PRESETS_V1 : PRESETS_V2
}

export const DEFAULT_PARAMS: PresetParams = {
  amplitude: 1,
  speed: 1,
  facing: 'side',
}

export const PRESET_ORDER: PresetId[] = ['idle', 'walk', 'run', 'attack', 'jump']
export const FACING_OPTIONS: Facing[] = ['side', 'front']
