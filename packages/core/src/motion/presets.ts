/**
 * The five deterministic motion presets (v3.1 §4.1 table — Task 10).
 *
 * Every curve below is the plan's canonical 32×32-reference value; the
 * composer maps each value through the R10 rule (sign(v)·max(1,|round(v·ampScale)|))
 * at runtime, so behavior at 16/32/64 px canvases is spec-defined, not
 * ad-hoc. Nothing here invents motion mathematics the plan does not define:
 *
 *   idle-bob | 4      | body dy [0,−1,−2,−1]; head dy = body; hair/coat 1-frame lag
 *   walk     | 4/6/8  | legL/legR alternate dx ±3, dy [0,−1]; body bob dy [0,−1,0,1]; arm counter-swing
 *   run      | 6      | walk amplitude ×1.5, forward lean dx +1, dy arc
 *   attack   | 4–6    | armL arc keyframes (raise→swing→recover), 1-px smear frame option
 *   jump     | 6      | dy parabola, squash [1,2] px on takeoff/land
 *
 * The 4/6/8-frame walk tables and the resampled jump parabola are the
 * canonical instantiations of the plan's "4/6/8" and "configurable
 * duration" clauses — same reference amplitudes, more poses per cycle.
 * Pure TypeScript; tables are literal and golden-tested.
 */

import type {
  MotionPresetId,
  MotionParams,
  PartOffset,
  PresetCurves,
  PresetDef,
} from './types';

// ---------------------------------------------------------------------------
// idle-bob — 4 frames (fixed): body dy [0,−1,−2,−1]; head = body; hair lags 1
// ---------------------------------------------------------------------------

const IDLE_BODY: PartOffset[] = [
  { dx: 0, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: -2 },
  { dx: 0, dy: -1 },
];
/** hair/coat 1-frame lag: hair[i] = body[i−1 mod 4] (deterministic lag). */
const IDLE_HAIR: PartOffset[] = [
  IDLE_BODY[3], // −1
  IDLE_BODY[0], //  0
  IDLE_BODY[1], // −1
  IDLE_BODY[2], // −2
];

function idleCurves(): PresetCurves {
  return { body: IDLE_BODY, head: IDLE_BODY, hair: IDLE_HAIR };
}

// ---------------------------------------------------------------------------
// walk — 4/6/8 frames: legs alternate dx ±3 / dy [0,−1]; body bob [0,−1,0,1];
// arms counter-swing (armL opposes legL, armR opposes legR); head = body.
// ---------------------------------------------------------------------------

const WALK_4: PresetCurves = {
  legL: [
    { dx: 3, dy: 0 }, { dx: 0, dy: -1 }, { dx: -3, dy: 0 }, { dx: 0, dy: -1 },
  ],
  legR: [
    { dx: -3, dy: -1 }, { dx: 0, dy: 0 }, { dx: 3, dy: -1 }, { dx: 0, dy: 0 },
  ],
  body: [
    { dx: 0, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 0 }, { dx: 0, dy: 1 },
  ],
  armL: [
    { dx: -3, dy: 0 }, { dx: 0, dy: -1 }, { dx: 3, dy: 0 }, { dx: 0, dy: -1 },
  ],
  armR: [
    { dx: 3, dy: -1 }, { dx: 0, dy: 0 }, { dx: -3, dy: -1 }, { dx: 0, dy: 0 },
  ],
};
WALK_4.head = WALK_4.body;

const WALK_6: PresetCurves = {
  legL: [
    { dx: 3, dy: 0 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 },
    { dx: -3, dy: 0 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 },
  ],
  legR: [
    { dx: -3, dy: -1 }, { dx: -1, dy: -1 }, { dx: 1, dy: 0 },
    { dx: 3, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 0 },
  ],
  body: [
    { dx: 0, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: 0 }, { dx: 0, dy: -1 },
  ],
  // arms counter-swing: armL runs in legR's phase, armR in legL's.
  armL: [
    { dx: -3, dy: -1 }, { dx: -1, dy: -1 }, { dx: 1, dy: 0 },
    { dx: 3, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 0 },
  ],
  armR: [
    { dx: 3, dy: 0 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 },
    { dx: -3, dy: 0 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 },
  ],
};
WALK_6.head = WALK_6.body;

const WALK_8: PresetCurves = {
  legL: [
    { dx: 3, dy: 0 }, { dx: 2, dy: -1 }, { dx: 0, dy: -1 }, { dx: -2, dy: -1 },
    { dx: -3, dy: 0 }, { dx: -2, dy: -1 }, { dx: 0, dy: -1 }, { dx: 2, dy: -1 },
  ],
  legR: [
    { dx: -3, dy: -1 }, { dx: -2, dy: -1 }, { dx: 0, dy: -1 }, { dx: 2, dy: 0 },
    { dx: 3, dy: -1 }, { dx: 2, dy: -1 }, { dx: 0, dy: -1 }, { dx: -2, dy: 0 },
  ],
  // two bob cycles per full 8-frame stride (dips at both contacts)
  body: [
    { dx: 0, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 0 }, { dx: 0, dy: 1 },
    { dx: 0, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 0 }, { dx: 0, dy: 1 },
  ],
};
WALK_8.head = WALK_8.body;
// arms counter-swing: armL runs in legR's phase, armR in legL's.
WALK_8.armL = WALK_8.legR.map((o) => ({ ...o }));
WALK_8.armR = WALK_8.legL.map((o) => ({ ...o }));

// ---------------------------------------------------------------------------
// run — 6 frames (fixed): walk amplitude ×1.5, forward lean dx +1, body arc.
// ---------------------------------------------------------------------------

function runCurves(): PresetCurves {
  const x15 = (o: PartOffset): PartOffset => ({ dx: o.dx * 1.5, dy: o.dy * 1.5 });
  const arcDy = [0, -1, -2, -2, -1, 0]; // dy arc (airborne apex mid-cycle; wraps 0→0)
  const body = arcDy.map((dy) => ({ dx: 1, dy: dy * 1.5 })); // +1 forward lean
  return {
    legL: WALK_6.legL.map(x15),
    legR: WALK_6.legR.map(x15),
    armL: WALK_6.armL.map(x15),
    armR: WALK_6.armR.map(x15),
    body,
    head: body.map((o) => ({ ...o })),
  };
}

// ---------------------------------------------------------------------------
// attack — 4/5/6 frames: armL arc keyframes raise→swing→recover, hold frames
// stretch the wind-up; optional 1-px smear on the swing frame (composer).
// ---------------------------------------------------------------------------

const ATTACK_4: PartOffset[] = [
  { dx: 0, dy: -2 }, // raise
  { dx: -1, dy: -2 }, // wind-up
  { dx: 2, dy: 1 }, // swing
  { dx: 0, dy: 0 }, // recover
];
const ATTACK_5: PartOffset[] = [
  { dx: 0, dy: -2 },
  { dx: -1, dy: -2 },
  { dx: -1, dy: -2 }, // wind-up hold
  { dx: 2, dy: 1 },
  { dx: 0, dy: 0 },
];
const ATTACK_6: PartOffset[] = [
  { dx: 0, dy: -2 },
  { dx: 0, dy: -2 }, // raise hold
  { dx: -1, dy: -2 },
  { dx: -1, dy: -2 }, // wind-up hold
  { dx: 2, dy: 1 },
  { dx: 0, dy: 0 },
];

function attackCurves(frameCount: number): PresetCurves {
  const armL =
    frameCount === 4 ? ATTACK_4 : frameCount === 5 ? ATTACK_5 : ATTACK_6;
  return { armL };
}

// ---------------------------------------------------------------------------
// jump — 6 canonical poses (prep, ascent, apex, apex-hang, descent, land);
// other allowed counts resample the same parabola (nearest canonical pose).
// squash [1,2] px on takeoff/land (ground-anchored top-drop in the composer).
// ---------------------------------------------------------------------------

const JUMP_POSES: PartOffset[] = [
  { dx: 0, dy: 1, squash: 2 }, // preparation (crouch)
  { dx: 0, dy: -2, squash: 1 }, // takeoff
  { dx: 0, dy: -4 }, // ascent
  { dx: 0, dy: -4 }, // apex (hang)
  { dx: 0, dy: -2 }, // descent
  { dx: 0, dy: 1, squash: 2 }, // landing (crouch)
];

function jumpCurves(frameCount: number): PresetCurves {
  const n = Math.max(2, frameCount);
  const poses = Array.from({ length: n }, (_, i) => {
    const idx = Math.round((i * (JUMP_POSES.length - 1)) / (n - 1));
    return { ...JUMP_POSES[Math.min(JUMP_POSES.length - 1, Math.max(0, idx))] };
  });
  return { body: poses, head: poses.map((o) => ({ ...o })) };
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const MOTION_PRESETS: Record<MotionPresetId, PresetDef> = {
  idle: {
    id: 'idle',
    label: 'Idle (bob)',
    frameCounts: [4],
    defaultFrameCount: 4,
    playOnceSuggested: false,
    curvesFor: () => idleCurves(),
    description:
      'Subtle breathing/bobbing: body dy [0,−1,−2,−1], head follows, hair/coat lags 1 frame.',
  },
  walk: {
    id: 'walk',
    label: 'Walk',
    frameCounts: [4, 6, 8],
    defaultFrameCount: 4,
    playOnceSuggested: false,
    curvesFor: (n) => (n === 6 ? WALK_6 : n === 8 ? WALK_8 : WALK_4),
    description:
      'Alternating limbs: legs dx ±3 / dy [0,−1], body bob [0,−1,0,1], arms counter-swing. Loop-compatible.',
  },
  run: {
    id: 'run',
    label: 'Run',
    frameCounts: [6],
    defaultFrameCount: 6,
    playOnceSuggested: false,
    curvesFor: () => runCurves(),
    description:
      'Walk amplitude ×1.5, forward lean +1 px, body dy arc. Loop-compatible.',
  },
  attack: {
    id: 'attack',
    label: 'Attack',
    frameCounts: [4, 5, 6],
    defaultFrameCount: 4,
    playOnceSuggested: true,
    curvesFor: (n) => attackCurves(n),
    description:
      'armL arc: raise → wind-up → swing → recover; optional 1-px smear on the swing frame. Play-once suggested.',
  },
  jump: {
    id: 'jump',
    label: 'Jump',
    frameCounts: [4, 5, 6, 7, 8],
    defaultFrameCount: 6,
    playOnceSuggested: true,
    curvesFor: (n) => jumpCurves(n),
    description:
      'Parabola with preparation/ascent/apex/descent/landing phases and [1,2] px squash on takeoff/land. Play-once suggested.',
  },
};

export const PRESET_IDS: readonly MotionPresetId[] = ['idle', 'walk', 'run', 'attack', 'jump'];

export function getPreset(id: string): PresetDef | undefined {
  return (PRESET_IDS as string[]).includes(id)
    ? MOTION_PRESETS[id as MotionPresetId]
    : undefined;
}

/** Resolve user params against a preset (validation lives in the commands). */
export function resolveParams(
  preset: PresetDef,
  partial: Partial<MotionParams> = {}
): MotionParams {
  const frameCount =
    partial.frameCount !== undefined && partial.frameCount > 0
      ? partial.frameCount
      : preset.defaultFrameCount;
  return {
    amplitude: partial.amplitude ?? 1,
    frameCount: preset.frameCounts.includes(frameCount)
      ? frameCount
      : preset.defaultFrameCount,
    gapFill: partial.gapFill ?? 'edge-extend',
    smear: partial.smear ?? false,
  };
}
