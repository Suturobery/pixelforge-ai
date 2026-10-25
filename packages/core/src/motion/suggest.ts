/**
 * suggest_motion_preset — L0 helper (v3.1 §5.3): proposes a preset + params
 * from a natural-language prompt. Pure function, deterministic, $0 — no
 * model call, no document access. Priority order is documented: specific
 * action verbs (attack/jump/run) win over generic locomotion (walk) and
 * ambience (idle) when several keywords appear.
 */

import type { MotionPresetId, MotionParams } from './types';
import { MOTION_PRESETS } from './presets';

interface KeywordRule {
  preset: MotionPresetId;
  keywords: readonly string[];
}

/** Priority order: the first rule with a matching keyword wins. */
const RULES: readonly KeywordRule[] = [
  {
    preset: 'attack',
    keywords: ['attack', 'slash', 'swing', 'strike', 'hit', 'punch', 'stab', 'shoot', 'sword', 'axe', 'melee'],
  },
  {
    preset: 'jump',
    keywords: ['jump', 'hop', 'leap', 'bounce', 'vault'],
  },
  {
    preset: 'run',
    keywords: ['run', 'sprint', 'dash', 'charge', 'rush', 'chase', 'flee'],
  },
  {
    preset: 'walk',
    keywords: ['walk', 'stroll', 'step', 'march', 'patrol', 'wander'],
  },
  {
    preset: 'idle',
    keywords: ['idle', 'breathe', 'breathing', 'bob', 'float', 'hover', 'stand', 'rest', 'wait', 'ambient'],
  },
];

export interface MotionSuggestion {
  preset: MotionPresetId;
  label: string;
  params: MotionParams;
  matched: string;
  reason: string;
}

export function suggestMotionPreset(prompt: string): MotionSuggestion | null {
  const text = prompt.toLowerCase();
  if (!text.trim()) return null;
  for (const rule of RULES) {
    const hit = rule.keywords.find((k) => text.includes(k));
    if (hit) {
      const def = MOTION_PRESETS[rule.preset];
      return {
        preset: rule.preset,
        label: def.label,
        params: {
          amplitude: 1,
          frameCount: def.defaultFrameCount,
          gapFill: 'none',
          smear: false,
        },
        matched: hit,
        reason: `matched "${hit}" → ${def.label}: ${def.description}`,
      };
    }
  }
  return null;
}
