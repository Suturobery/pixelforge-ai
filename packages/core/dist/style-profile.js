"use strict";
/**
 * PixelForge AI — project style profile.
 *
 * This is deliberately a small, serializable contract that every generation
 * surface can share. It is not an instruction channel: all values are
 * bounded data and become descriptive prompt tags only at the AI boundary.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_STYLE_PROFILE = exports.STYLE_PALETTE_MODES = exports.STYLE_OUTLINES = exports.STYLE_LIGHTING = exports.STYLE_FEEDBACK_CUE_MAX = exports.STYLE_FEEDBACK_MAX_CUES = exports.STYLE_REFERENCE_MAX_LABEL = exports.STYLE_PROFILE_MAX_REFERENCES = exports.STYLE_PROFILE_MAX_NOTES = exports.STYLE_PROFILE_MAX_DIRECTION = exports.STYLE_PROFILE_MAX_NAME = void 0;
exports.defaultStyleProfile = defaultStyleProfile;
exports.parseStyleProfile = parseStyleProfile;
exports.cloneStyleProfile = cloneStyleProfile;
exports.styleProfilePromptTags = styleProfilePromptTags;
exports.STYLE_PROFILE_MAX_NAME = 48;
exports.STYLE_PROFILE_MAX_DIRECTION = 180;
exports.STYLE_PROFILE_MAX_NOTES = 480;
exports.STYLE_PROFILE_MAX_REFERENCES = 6;
exports.STYLE_REFERENCE_MAX_LABEL = 80;
exports.STYLE_FEEDBACK_MAX_CUES = 4;
exports.STYLE_FEEDBACK_CUE_MAX = 72;
exports.STYLE_LIGHTING = ['top-left', 'top', 'front', 'flat'];
exports.STYLE_OUTLINES = ['dark-1px', 'light-1px', 'none'];
exports.STYLE_PALETTE_MODES = ['enforce', 'prefer', 'none'];
exports.DEFAULT_STYLE_PROFILE = Object.freeze({
    enabled: true,
    name: 'Project style',
    artDirection: 'clean readable pixel-art game assets',
    lighting: 'top-left',
    outline: 'dark-1px',
    paletteMode: 'enforce',
    transparentBackground: true,
    notes: '',
    references: [],
    feedback: { prefer: [], avoid: [] },
});
function defaultStyleProfile() {
    return {
        ...exports.DEFAULT_STYLE_PROFILE,
        references: [],
        feedback: { prefer: [], avoid: [] },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validString(value, max) {
    return typeof value === 'string' && value.trim().length <= max;
}
function isSafeId(value) {
    return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value);
}
function parseStyleReferences(value) {
    if (value === undefined)
        return []; // profile v1 compatibility
    if (!Array.isArray(value) || value.length > exports.STYLE_PROFILE_MAX_REFERENCES)
        return null;
    const seen = new Set();
    const refs = [];
    for (const raw of value) {
        if (!isRecord(raw) || !isSafeId(raw.clipId) || !isSafeId(raw.frameId) || !validString(raw.label, exports.STYLE_REFERENCE_MAX_LABEL)) {
            return null;
        }
        const label = raw.label.trim();
        if (!label)
            return null;
        const key = `${raw.clipId}\u0000${raw.frameId}`;
        if (seen.has(key))
            return null;
        seen.add(key);
        refs.push({ clipId: raw.clipId, frameId: raw.frameId, label });
    }
    return refs;
}
function parseFeedbackCues(value) {
    if (!Array.isArray(value) || value.length > exports.STYLE_FEEDBACK_MAX_CUES)
        return null;
    const seen = new Set();
    const cues = [];
    for (const raw of value) {
        if (typeof raw !== 'string' || raw.length > exports.STYLE_FEEDBACK_CUE_MAX || /[\u0000-\u001f\u007f]/.test(raw))
            return null;
        const cue = raw.trim().replace(/\s+/g, ' ');
        if (!cue || cue.length > exports.STYLE_FEEDBACK_CUE_MAX || seen.has(cue.toLowerCase()))
            return null;
        seen.add(cue.toLowerCase());
        cues.push(cue);
    }
    return cues;
}
function parseStyleFeedback(value) {
    if (value === undefined)
        return { prefer: [], avoid: [] }; // profile v2 compatibility
    if (!isRecord(value))
        return null;
    const prefer = parseFeedbackCues(value.prefer);
    const avoid = parseFeedbackCues(value.avoid);
    if (!prefer || !avoid)
        return null;
    return { prefer, avoid };
}
/** Strict boundary parser for saved files, UI commands, and future MCP calls. */
function parseStyleProfile(value) {
    if (!isRecord(value))
        return null;
    const references = parseStyleReferences(value.references);
    const feedback = parseStyleFeedback(value.feedback);
    if (typeof value.enabled !== 'boolean' ||
        !validString(value.name, exports.STYLE_PROFILE_MAX_NAME) ||
        !validString(value.artDirection, exports.STYLE_PROFILE_MAX_DIRECTION) ||
        !exports.STYLE_LIGHTING.includes(value.lighting) ||
        !exports.STYLE_OUTLINES.includes(value.outline) ||
        !exports.STYLE_PALETTE_MODES.includes(value.paletteMode) ||
        typeof value.transparentBackground !== 'boolean' ||
        !validString(value.notes, exports.STYLE_PROFILE_MAX_NOTES) ||
        !references ||
        !feedback) {
        return null;
    }
    const name = value.name.trim();
    const artDirection = value.artDirection.trim();
    if (!name || !artDirection)
        return null;
    return {
        enabled: value.enabled,
        name,
        artDirection,
        lighting: value.lighting,
        outline: value.outline,
        paletteMode: value.paletteMode,
        transparentBackground: value.transparentBackground,
        notes: value.notes.trim(),
        references,
        feedback,
    };
}
function cloneStyleProfile(profile) {
    return {
        ...profile,
        references: profile.references.map((reference) => ({ ...reference })),
        feedback: { prefer: [...(profile.feedback?.prefer ?? [])], avoid: [...(profile.feedback?.avoid ?? [])] },
    };
}
/** Deterministic, provider-neutral tags. The user's creative prompt stays first. */
function styleProfilePromptTags(profile) {
    if (!profile?.enabled)
        return [];
    // Hot-reloaded renderer state and old in-memory documents can predate
    // feedback. Persistence normalizes them, but generation stays safe too.
    const feedback = profile.feedback ?? { prefer: [], avoid: [] };
    const lighting = {
        'top-left': 'lighting from the top left',
        top: 'lighting from directly above',
        front: 'front-facing even lighting',
        flat: 'flat graphic lighting with minimal shading',
    };
    const outline = {
        'dark-1px': 'consistent dark 1-pixel outline',
        'light-1px': 'consistent light 1-pixel outline',
        none: null,
    };
    return [
        `project art direction: ${profile.artDirection}`,
        lighting[profile.lighting],
        outline[profile.outline],
        profile.paletteMode === 'enforce' ? 'use only the supplied project palette' : null,
        profile.paletteMode === 'prefer' ? 'prefer the supplied project palette' : null,
        profile.transparentBackground ? 'isolated subject intended for a transparent background' : null,
        profile.notes ? `project style notes: ${profile.notes}` : null,
        ...feedback.prefer.map((cue) => `repeat this approved visual trait: ${cue}`),
        ...feedback.avoid.map((cue) => `avoid this visual trait: ${cue}`),
    ].filter((tag) => Boolean(tag));
}
