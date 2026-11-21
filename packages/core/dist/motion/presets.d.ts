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
import type { MotionPresetId, MotionParams, PresetDef } from './types';
export declare const MOTION_PRESETS: Record<MotionPresetId, PresetDef>;
export declare const PRESET_IDS: readonly MotionPresetId[];
export declare function getPreset(id: string): PresetDef | undefined;
/** Resolve user params against a preset (validation lives in the commands). */
export declare function resolveParams(preset: PresetDef, partial?: Partial<MotionParams>): MotionParams;
