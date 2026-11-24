/**
 * PixelForge AI — Create from Reference candidate pipeline.
 *
 * Turns a raw provider/import PNG into a canvas-ready candidate:
 * decode → normalize-v2 (trim, background removal, resize to the project's
 * 16/32 target, palette mapping, transparency cleanup) → technical checks.
 * PURE TypeScript (the only async step is PNG decode); the same code runs in
 * the renderer, tests, and future MCP surfaces.
 *
 * The ORIGINAL provider/import pixels are kept alongside the cleaned result —
 * the artist review compares both so lost detail is visible. Technical checks
 * are separate data; the artist's visual approval is theirs to make.
 */
import { type Normalize2Stats } from './normalize-v2';
import { type StyleCheck } from './style-validation';
import { type StyleProfile } from '../style-profile';
/** Target sizes supported by the Create-from-Reference workflow (this release). */
export declare const REFERENCE_TARGET_SIZES: readonly number[];
export declare function isReferenceTargetSize(n: unknown): n is 16 | 32;
/** The brief the artist typed plus the project's style contract, bounded. */
export declare function buildReferencePrompt(brief: string, profile: StyleProfile, targetSize: number): string;
export interface ReferenceCandidateInput {
    /** The artist's brief ("a brass key") — used for labels; the provider got the prompt. */
    brief: string;
    providerId: string;
    model: string;
    /** Raw provider/import PNG bytes (any size; the pipeline normalizes). */
    providerPng: Uint8Array;
    /** The approved reference sprite (project palette + style rules anchor). */
    reference: {
        buffer: Uint8ClampedArray;
        width: number;
        height: number;
    };
    palette: string[];
    profile: StyleProfile;
    /** Project canvas size — must be 16 or 32 for this release. */
    targetSize: number;
}
export interface ReferenceCandidate {
    brief: string;
    prompt: string;
    providerId: string;
    model: string;
    /** Provider/import pixels as received (never mutated). */
    original: {
        buffer: Uint8ClampedArray;
        width: number;
        height: number;
    };
    /** Normalized, palette-mapped, canvas-ready pixels. */
    cleaned: {
        buffer: Uint8ClampedArray;
        width: number;
        height: number;
    };
    stats: Normalize2Stats;
    /** Technical checks on the CLEANED result — separate from visual approval. */
    checks: StyleCheck[];
}
/** Decode + normalize one provider/import PNG into a reviewable candidate. */
export declare function buildReferenceCandidate(input: ReferenceCandidateInput): Promise<ReferenceCandidate>;
