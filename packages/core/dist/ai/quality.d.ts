/**
 * @pixelforge/core — AI sprite output quality report (Task 9 quality
 * follow-up, requirement #4 "non-destructive checks").
 *
 * PURE, deterministic, read-only: it inspects a NORMALIZED sprite buffer and
 * the normalize stats, and returns human-readable findings. It NEVER mutates
 * the buffer and NEVER blocks the review workflow — findings are HEURISTIC
 * signals for the user, not guaranteed defect detections (wording reflects
 * that: "possible", "may", "check").
 *
 * Checks:
 *   • empty sprite (normalization likely erased the subject)
 *   • content touching the canvas edges (possible clipped subject)
 *   • subject filling the whole source frame (likely cropped by the
 *     generator — regeneration recommended)
 *   • isolated stray pixels surviving cleanup
 *   • enclosed background residue (pools matching the original bg color)
 *   • unexpected transparent holes inside the sprite
 *   • excessive palette colors / palette limit reached
 *   • aggressive cleanup (possible missing details)
 *   • anisotropic stretch when fit='fill' on a mismatched aspect
 *   • background removal disabled (matte kept)
 */
import type { GridSnapStats } from './grid-detect';
export interface QualityFinding {
    /** stable machine id, e.g. 'bg-residue' */
    code: string;
    severity: 'error' | 'warning' | 'info';
    /** user-facing explanation (heuristic wording — never a guarantee) */
    message: string;
    /** optional actionable hint */
    hint?: string;
}
export interface AnalyzeSpriteQualityInput {
    /** normalized RGBA buffer (targetW×targetH×4) */
    buffer: Uint8Array | Uint8ClampedArray;
    w: number;
    h: number;
    /** stats from normalizeV2 (carries trim/bgColor/cleanup counters) */
    stats: {
        trim: {
            x: number;
            y: number;
            w: number;
            h: number;
        };
        bgRemoved: number;
        specklesRemoved: number;
        colorsOut: number;
        fringeRemoved: number;
        paletteUsed: 'project' | 'auto' | 'off';
        fit: 'fill' | 'contain';
        sourceStraysRemoved: number;
        residueRemoved: number;
        bgColor: string;
        grid?: GridSnapStats;
    };
    /** the options the result was produced with (fit/removeBg/maxColors...) */
    opts: {
        removeBg: boolean;
        bgTolerance: number;
        paletteMode: 'project' | 'auto' | 'off';
        maxColors: number;
        fit?: 'fill' | 'contain';
        enclosedResidueCleanup?: boolean;
    };
    /** ORIGINAL source dimensions (for the clipped-subject heuristic) */
    source?: {
        w: number;
        h: number;
    };
}
/**
 * Non-destructive quality report. Deterministic: same inputs → same
 * findings. Every message is a heuristic signal, never a guaranteed defect
 * detection.
 */
export declare function analyzeSpriteQuality(input: AnalyzeSpriteQualityInput): QualityFinding[];
