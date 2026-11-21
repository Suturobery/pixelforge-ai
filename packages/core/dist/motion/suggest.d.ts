/**
 * suggest_motion_preset — L0 helper (v3.1 §5.3): proposes a preset + params
 * from a natural-language prompt. Pure function, deterministic, $0 — no
 * model call, no document access. Priority order is documented: specific
 * action verbs (attack/jump/run) win over generic locomotion (walk) and
 * ambience (idle) when several keywords appear.
 */
import type { MotionPresetId, MotionParams } from './types';
export interface MotionSuggestion {
    preset: MotionPresetId;
    label: string;
    params: MotionParams;
    matched: string;
    reason: string;
}
export declare function suggestMotionPreset(prompt: string): MotionSuggestion | null;
