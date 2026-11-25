/**
 * PixelForge AI — project style profile.
 *
 * This is deliberately a small, serializable contract that every generation
 * surface can share. It is not an instruction channel: all values are
 * bounded data and become descriptive prompt tags only at the AI boundary.
 */

export const STYLE_PROFILE_MAX_NAME = 48;
export const STYLE_PROFILE_MAX_DIRECTION = 180;
export const STYLE_PROFILE_MAX_NOTES = 480;
export const STYLE_PROFILE_MAX_REFERENCES = 6;
export const STYLE_REFERENCE_MAX_LABEL = 80;
/** Base64 cap for an embedded reference sprite (≈12 KB decoded PNG). */
export const STYLE_REFERENCE_MAX_PNG_BASE64 = 16384;
/** Supported reference sprite sizes for the Create-from-Reference workflow. */
export const STYLE_REFERENCE_SIZES = [16, 32] as const;
export const STYLE_FEEDBACK_MAX_CUES = 4;
export const STYLE_FEEDBACK_CUE_MAX = 72;

export const STYLE_LIGHTING = ['top-left', 'top', 'front', 'flat'] as const;
export type StyleLighting = (typeof STYLE_LIGHTING)[number];

export const STYLE_OUTLINES = ['dark-1px', 'light-1px', 'none'] as const;
export type StyleOutline = (typeof STYLE_OUTLINES)[number];

export const STYLE_PALETTE_MODES = ['enforce', 'prefer', 'none'] as const;
export type StylePaletteMode = (typeof STYLE_PALETTE_MODES)[number];

export const STYLE_CAMERA_ANGLES = ['side view', 'front', '3/4 view', 'top-down', 'isometric'] as const;
export type StyleCameraAngle = (typeof STYLE_CAMERA_ANGLES)[number];

export const STYLE_ANCHOR_OUTLINES = ['dark-ink', 'sel-out', 'lineless'] as const;
export type StyleAnchorOutline = (typeof STYLE_ANCHOR_OUTLINES)[number];

/** Measured hero-sprite consistency anchor pinned by the artist (v0.4.0). */
export interface StyleAnchor {
  label: string;
  clipId: string;
  frameIndex: number;
  canvasWidth: number;
  canvasHeight: number;
  spriteWidth: number;
  spriteHeight: number;
  heightRatio: number;
  bottomMargin: number;
  outlineStyle: StyleAnchorOutline;
  paletteUsed: string[];
  craftScore: number;
  pinnedAt: number;
}

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
  /** Measured hero sprite anchor (proportions, ground baseline, outline, palette). */
  anchor?: StyleAnchor;
}

export const DEFAULT_STYLE_PROFILE: Readonly<StyleProfile> = Object.freeze({
  enabled: true,
  name: 'Project style',
  artDirection: 'clean readable pixel-art game assets',
  lighting: 'top-left',
  outline: 'dark-1px',
  paletteMode: 'enforce',
  transparentBackground: true,
  cameraAngle: 'side view',
  notes: '',
  references: [],
  feedback: { prefer: [], avoid: [] },
});

export function defaultStyleProfile(): StyleProfile {
  return {
    ...DEFAULT_STYLE_PROFILE,
    references: [],
    feedback: { prefer: [], avoid: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length <= max;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value);
}

function parseStyleReferences(value: unknown): StyleReference[] | null {
  if (value === undefined) return []; // profile v1 compatibility
  if (!Array.isArray(value) || value.length > STYLE_PROFILE_MAX_REFERENCES) return null;
  const seen = new Set<string>();
  const refs: StyleReference[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !validString(raw.label, STYLE_REFERENCE_MAX_LABEL)) {
      return null;
    }
    const label = raw.label.trim();
    if (!label) return null;
    // Embedded imported reference: PNG payload + native size, ids empty.
    if (raw.pngBase64 !== undefined) {
      const w = raw.width;
      const h = raw.height;
      if (
        typeof raw.pngBase64 !== 'string' ||
        raw.pngBase64.length === 0 ||
        raw.pngBase64.length > STYLE_REFERENCE_MAX_PNG_BASE64 ||
        !/^[A-Za-z0-9+/=]+$/.test(raw.pngBase64) ||
        typeof w !== 'number' ||
        typeof h !== 'number' ||
        w !== h ||
        (w !== 16 && w !== 32) ||
        raw.clipId !== '' ||
        raw.frameId !== ''
      ) {
        return null;
      }
      const key = `png\u0000${label.toLowerCase()}`;
      if (seen.has(key)) return null;
      seen.add(key);
      refs.push({ clipId: '', frameId: '', label, pngBase64: raw.pngBase64, width: w, height: h });
      continue;
    }
    if (!isSafeId(raw.clipId) || !isSafeId(raw.frameId)) {
      return null;
    }
    const key = `${raw.clipId}\u0000${raw.frameId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    refs.push({ clipId: raw.clipId, frameId: raw.frameId, label });
  }
  return refs;
}

function parseFeedbackCues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > STYLE_FEEDBACK_MAX_CUES) return null;
  const seen = new Set<string>();
  const cues: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length > STYLE_FEEDBACK_CUE_MAX || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    const cue = raw.trim().replace(/\s+/g, ' ');
    if (!cue || cue.length > STYLE_FEEDBACK_CUE_MAX || seen.has(cue.toLowerCase())) return null;
    seen.add(cue.toLowerCase());
    cues.push(cue);
  }
  return cues;
}

function parseStyleFeedback(value: unknown): StyleFeedback | null {
  if (value === undefined) return { prefer: [], avoid: [] }; // profile v2 compatibility
  if (!isRecord(value)) return null;
  const prefer = parseFeedbackCues(value.prefer);
  const avoid = parseFeedbackCues(value.avoid);
  if (!prefer || !avoid) return null;
  return { prefer, avoid };
}

function parseStyleAnchor(value: unknown): StyleAnchor | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return null;
  if (
    !validString(value.label, 64) ||
    !value.label.trim() ||
    !isSafeId(value.clipId) ||
    typeof value.frameIndex !== 'number' ||
    !Number.isInteger(value.frameIndex) ||
    value.frameIndex < 0 ||
    typeof value.canvasWidth !== 'number' ||
    typeof value.canvasHeight !== 'number' ||
    typeof value.spriteWidth !== 'number' ||
    typeof value.spriteHeight !== 'number' ||
    typeof value.heightRatio !== 'number' ||
    typeof value.bottomMargin !== 'number' ||
    typeof value.craftScore !== 'number' ||
    typeof value.pinnedAt !== 'number' ||
    !STYLE_ANCHOR_OUTLINES.includes(value.outlineStyle as StyleAnchorOutline) ||
    !Array.isArray(value.paletteUsed) ||
    value.paletteUsed.length > 32
  ) {
    return null;
  }
  const paletteUsed: string[] = [];
  for (const hex of value.paletteUsed) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
    paletteUsed.push(hex.toLowerCase());
  }
  return {
    label: value.label.trim(),
    clipId: value.clipId,
    frameIndex: value.frameIndex,
    canvasWidth: Math.max(1, Math.round(value.canvasWidth)),
    canvasHeight: Math.max(1, Math.round(value.canvasHeight)),
    spriteWidth: Math.max(1, Math.round(value.spriteWidth)),
    spriteHeight: Math.max(1, Math.round(value.spriteHeight)),
    heightRatio: Math.max(0, Math.min(1, Number(value.heightRatio))),
    bottomMargin: Math.max(0, Math.round(value.bottomMargin)),
    outlineStyle: value.outlineStyle as StyleAnchorOutline,
    paletteUsed,
    craftScore: Math.max(0, Math.min(100, Math.round(value.craftScore))),
    pinnedAt: Math.round(value.pinnedAt),
  };
}

/** Strict boundary parser for saved files, UI commands, and future MCP calls. */
export function parseStyleProfile(value: unknown): StyleProfile | null {
  if (!isRecord(value)) return null;
  const references = parseStyleReferences(value.references);
  const feedback = parseStyleFeedback(value.feedback);
  const anchor = parseStyleAnchor(value.anchor);
  const cameraAngle =
    value.cameraAngle === undefined
      ? undefined
      : (STYLE_CAMERA_ANGLES as readonly string[]).includes(value.cameraAngle as string)
        ? (value.cameraAngle as StyleCameraAngle)
        : null;
  if (
    cameraAngle === null ||
    anchor === null ||
    typeof value.enabled !== 'boolean' ||
    !validString(value.name, STYLE_PROFILE_MAX_NAME) ||
    !validString(value.artDirection, STYLE_PROFILE_MAX_DIRECTION) ||
    !STYLE_LIGHTING.includes(value.lighting as StyleLighting) ||
    !STYLE_OUTLINES.includes(value.outline as StyleOutline) ||
    !STYLE_PALETTE_MODES.includes(value.paletteMode as StylePaletteMode) ||
    typeof value.transparentBackground !== 'boolean' ||
    !validString(value.notes, STYLE_PROFILE_MAX_NOTES) ||
    !references ||
    !feedback
  ) {
    return null;
  }
  const name = value.name.trim();
  const artDirection = value.artDirection.trim();
  if (!name || !artDirection) return null;
  return {
    enabled: value.enabled,
    name,
    artDirection,
    lighting: value.lighting as StyleLighting,
    outline: value.outline as StyleOutline,
    paletteMode: value.paletteMode as StylePaletteMode,
    transparentBackground: value.transparentBackground,
    ...(cameraAngle !== undefined ? { cameraAngle } : {}),
    notes: value.notes.trim(),
    references,
    feedback,
    ...(anchor !== undefined ? { anchor } : {}),
  };
}

export function cloneStyleProfile(profile: StyleProfile): StyleProfile {
  return {
    ...profile,
    references: profile.references.map((reference) => ({ ...reference })),
    feedback: { prefer: [...(profile.feedback?.prefer ?? [])], avoid: [...(profile.feedback?.avoid ?? [])] },
    ...(profile.anchor ? { anchor: { ...profile.anchor, paletteUsed: [...profile.anchor.paletteUsed] } } : {}),
  };
}

/** Deterministic, provider-neutral tags. The user's creative prompt stays first. */
export function styleProfilePromptTags(profile: StyleProfile | undefined): string[] {
  if (!profile?.enabled) return [];
  // Hot-reloaded renderer state and old in-memory documents can predate
  // feedback. Persistence normalizes them, but generation stays safe too.
  const feedback = profile.feedback ?? { prefer: [], avoid: [] };
  const lighting: Record<StyleLighting, string> = {
    'top-left': 'lighting from the top left',
    top: 'lighting from directly above',
    front: 'front-facing even lighting',
    flat: 'flat graphic lighting with minimal shading',
  };
  const outline: Record<StyleOutline, string | null> = {
    'dark-1px': 'consistent dark 1-pixel outline',
    'light-1px': 'consistent light 1-pixel outline',
    none: null,
  };
  const anchorTag = profile.anchor
    ? `match hero style anchor "${profile.anchor.label}": ~${profile.anchor.spriteWidth}×${profile.anchor.spriteHeight}px silhouette on ${profile.anchor.canvasWidth}×${profile.anchor.canvasHeight} canvas, ${profile.anchor.bottomMargin}px ground margin, ${profile.anchor.outlineStyle} outline`
    : null;
  return [
    `project art direction: ${profile.artDirection}`,
    lighting[profile.lighting],
    outline[profile.outline],
    profile.cameraAngle ? `camera angle: ${profile.cameraAngle}` : null,
    anchorTag,
    profile.paletteMode === 'enforce' ? 'use only the supplied project palette' : null,
    profile.paletteMode === 'prefer' ? 'prefer the supplied project palette' : null,
    profile.transparentBackground ? 'isolated subject intended for a transparent background' : null,
    profile.notes ? `project style notes: ${profile.notes}` : null,
    ...feedback.prefer.map((cue) => `repeat this approved visual trait: ${cue}`),
    ...feedback.avoid.map((cue) => `avoid this visual trait: ${cue}`),
  ].filter((tag): tag is string => Boolean(tag));
}
