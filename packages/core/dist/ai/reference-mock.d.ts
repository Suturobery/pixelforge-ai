/**
 * PixelForge AI — deterministic reference test provider (NO network).
 *
 * Stands in for a real image provider in automated tests: it "generates" a
 * candidate by deterministically mutating the approved reference (palette
 * recolor + mirror, seeded by the brief), pasted onto an off-palette solid
 * background — deliberately imperfect input so the candidate pipeline's
 * background removal, palette mapping, and resize are actually exercised.
 *
 * Same brief + same reference + same palette ⇒ byte-identical PNG.
 * Pure TypeScript; encodePng is the only I/O (in-memory bytes).
 */
/** FNV-1a — stable across runtimes, no locale/clock dependence. */
export declare function hashBrief(brief: string): number;
/**
 * Build the mock candidate PNG. The reference is recolored by rotating each
 * distinct color's palette index (per-hash offset), mirrored when hash bit 3
 * is set, then pasted centered on a solid off-palette backdrop sized to the
 * reference (or 2× when the target is smaller, so the resize path runs too).
 */
export declare function renderMockReferenceCandidate(reference: {
    buffer: Uint8ClampedArray;
    width: number;
    height: number;
}, palette: string[], brief: string): Promise<Uint8Array>;
