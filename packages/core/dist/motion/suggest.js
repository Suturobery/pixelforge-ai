"use strict";
/**
 * suggest_motion_preset — L0 helper (v3.1 §5.3): proposes a preset + params
 * from a natural-language prompt. Pure function, deterministic, $0 — no
 * model call, no document access. Priority order is documented: specific
 * action verbs (attack/jump/run) win over generic locomotion (walk) and
 * ambience (idle) when several keywords appear.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestMotionPreset = suggestMotionPreset;
const presets_1 = require("./presets");
/** Priority order: the first rule with a matching keyword wins. */
const RULES = [
    {
        preset: 'death',
        keywords: ['death', 'dying', 'dies', 'collapse', 'knocked out', 'perish', 'faints'],
    },
    {
        preset: 'hurt',
        keywords: ['hurt', 'knockback', 'recoil', 'flinch', 'stagger', 'damaged', 'wince'],
    },
    {
        preset: 'attack',
        keywords: ['attack', 'slash', 'swing', 'strike', 'hit', 'punch', 'stab', 'shoot', 'sword', 'axe', 'melee'],
    },
    {
        preset: 'jump',
        keywords: ['jump', 'hop', 'leap', 'bounce', 'vault'],
    },
    {
        preset: 'duck',
        keywords: ['duck', 'crouch', 'sneak', 'crawl', 'dodge'],
    },
    {
        preset: 'swim',
        keywords: ['swim', 'swimming', 'underwater', 'breaststroke'],
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
        preset: 'spin',
        keywords: ['spin', 'spinning', 'twirl', 'whirl', 'rotate'],
    },
    {
        preset: 'idle',
        keywords: ['idle', 'breathe', 'breathing', 'bob', 'float', 'hover', 'stand', 'rest', 'wait', 'ambient'],
    },
];
function suggestMotionPreset(prompt) {
    const text = prompt.toLowerCase();
    if (!text.trim())
        return null;
    for (const rule of RULES) {
        const hit = rule.keywords.find((k) => text.includes(k));
        if (hit) {
            const def = presets_1.MOTION_PRESETS[rule.preset];
            return {
                preset: rule.preset,
                label: def.label,
                params: {
                    amplitude: 1,
                    frameCount: def.defaultFrameCount,
                    gapFill: 'edge-extend',
                    smear: false,
                },
                matched: hit,
                reason: `matched "${hit}" → ${def.label}: ${def.description}`,
            };
        }
    }
    return null;
}
