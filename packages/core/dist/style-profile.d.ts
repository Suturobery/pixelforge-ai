/**
 * PixelForge AI — project style profile.
 *
 * This is deliberately a small, serializable contract that every generation
 * surface can share. It is not an instruction channel: all values are
 * bounded data and become descriptive prompt tags only at the AI boundary.
 */
export declare const STYLE_PROFILE_MAX_NAME = 48;
export declare const STYLE_PROFILE_MAX_DIRECTION = 180;
export declare const STYLE_PROFILE_MAX_NOTES = 480;
export declare const STYLE_PROFILE_MAX_REFERENCES = 6;
export declare const STYLE_REFERENCE_MAX_LABEL = 80;
/** Base64 cap for an embedded reference sprite (≈12 KB decoded PNG). */
export declare const STYLE_REFERENCE_MAX_PNG_BASE64 = 16384;
/** Supported reference sprite sizes for the Create-from-Reference workflow. */
export declare const STYLE_REFERENCE_SIZES: readonly [16, 32];
export declare const STYLE_FEEDBACK_MAX_CUES = 4;
export declare const STYLE_FEEDBACK_CUE_MAX = 72;
export declare const STYLE_LIGHTING: readonly ["top-left", "top", "front", "flat"];
export type StyleLighting = (typeof STYLE_LIGHTING)[number];
export declare const STYLE_OUTLINES: readonly ["dark-1px", "light-1px", "none"];
export type StyleOutline = (typeof STYLE_OUTLINES)[number];
export declare const STYLE_PALETTE_MODES: readonly ["enforce", "prefer", "none"];
export type StylePaletteMode = (typeof STYLE_PALETTE_MODES)[number];
export declare const STYLE_CAMERA_ANGLES: readonly ["side view", "front", "3/4 view", "top-down", "isometric"];
export type StyleCameraAngle = (typeof STYLE_CAMERA_ANGLES)[number];
/**
 * Reference sprite anchor. `clipId`/`frameId` point at an existing project
 * frame; an IMPORTED reference instead embeds its PNG (`pngBase64`) at its
 * native `width`×`height` (16 or 32 — STYLE_REFERENCE_SIZES) with empty ids.
 */
export interface StyleReference {
    clipId: string;
    frameId: string;
    label: string;
    pngBase64?: string;
    width?: number;
    height?: number;
}
/** Artist-approved guidance collected from candidate review, never hidden training data. */
export interface StyleFeedback {
    /** Traits the artist wants the next candidates to repeat. */
    prefer: string[];
    /** Traits the artist wants the next candidates to avoid. */
    avoid: string[];
}
export interface StyleProfile {
    /**
     * On by default: every new project starts with the shared style contract
     * (audit direction #2) so candidates are consistent from the first
     * generation. Saved documents keep their own persisted value.
     */
    enabled: boolean;
    /** Artist-facing label; never interpreted as a command. */
    name: string;
    /** Concise visual direction, e.g. "cozy 16-bit fantasy RPG". */
    artDirection: string;
    lighting: StyleLighting;
    outline: StyleOutline;
    /** enforce also switches the normalizer to the project palette. */
    paletteMode: StylePaletteMode;
    /** AI providers usually return an opaque image; normalizer removes it. */
    transparentBackground: boolean;
    /** Camera angle shared by the project's sprites (Create-from-Reference). */
    cameraAngle?: StyleCameraAngle;
    /** Extra project rules, bounded so they cannot bloat saved files/prompts. */
    notes: string;
    /** Up to six project-native frame anchors for connected visual-capable IDEs. */
    references: StyleReference[];
    /** Short, artist-authored cues from candidate review. */
    feedback: StyleFeedback;
}
export declare const DEFAULT_STYLE_PROFILE: Readonly<StyleProfile>;
export declare function defaultStyleProfile(): StyleProfile;
/** Strict boundary parser for saved files, UI commands, and future MCP calls. */
export declare function parseStyleProfile(value: unknown): StyleProfile | null;
export declare function cloneStyleProfile(profile: StyleProfile): StyleProfile;
/** Deterministic, provider-neutral tags. The user's creative prompt stays first. */
export declare function styleProfilePromptTags(profile: StyleProfile | undefined): string[];
