"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFERENCE_TARGET_SIZES = void 0;
exports.isReferenceTargetSize = isReferenceTargetSize;
exports.buildReferencePrompt = buildReferencePrompt;
exports.buildReferenceCandidate = buildReferenceCandidate;
const png_1 = require("../persist/png");
const normalize_v2_1 = require("./normalize-v2");
const style_validation_1 = require("./style-validation");
const style_profile_1 = require("../style-profile");
/** Target sizes supported by the Create-from-Reference workflow (this release). */
exports.REFERENCE_TARGET_SIZES = [16, 32];
function isReferenceTargetSize(n) {
    return n === 16 || n === 32;
}
/** The brief the artist typed plus the project's style contract, bounded. */
function buildReferencePrompt(brief, profile, targetSize) {
    const b = brief.trim().slice(0, 400);
    return [
        b || 'a matching game asset',
        'new sprite that visually belongs with the attached approved reference sprite',
        'match its palette, outline weight, lighting direction, and level of detail',
        ...(0, style_profile_1.styleProfilePromptTags)(profile),
        `${targetSize}×${targetSize} pixel art, crisp pixels, no anti-aliasing`,
        'isolated subject on a plain solid background',
    ]
        .filter((line) => Boolean(line))
        .join('; ')
        .slice(0, 1200);
}
/** Decode + normalize one provider/import PNG into a reviewable candidate. */
async function buildReferenceCandidate(input) {
    if (!isReferenceTargetSize(input.targetSize)) {
        throw new Error(`reference candidate: target size must be 16 or 32 (got ${input.targetSize})`);
    }
    const decoded = await (0, png_1.decodePng)(input.providerPng);
    const cleaned = (0, normalize_v2_1.normalizeV2)(decoded.rgba, decoded.width, decoded.height, {
        targetW: input.targetSize,
        targetH: input.targetSize,
        removeBg: input.profile.transparentBackground !== false,
        bgTolerance: 48,
        paletteMode: input.profile.paletteMode === 'enforce' ? 'project' : 'auto',
        palette: [...input.palette],
        maxColors: Math.max(2, Math.min(64, input.palette.length)),
        outlineCleanup: input.profile.outline !== 'none',
        fit: 'contain',
        paddingPct: 0.04,
        alphaThreshold: 128,
        strayCleanup: 'normal',
    });
    const checks = (0, style_validation_1.validateStyleCandidate)({
        buffer: cleaned.buffer,
        width: cleaned.width,
        height: cleaned.height,
        targetWidth: input.targetSize,
        targetHeight: input.targetSize,
        palette: input.palette,
        profile: input.profile,
        grid: cleaned.stats.grid,
    });
    return {
        brief: input.brief.trim().slice(0, 400),
        prompt: buildReferencePrompt(input.brief, input.profile, input.targetSize),
        providerId: input.providerId,
        model: input.model,
        original: { buffer: decoded.rgba, width: decoded.width, height: decoded.height },
        cleaned: { buffer: cleaned.buffer, width: cleaned.width, height: cleaned.height },
        stats: cleaned.stats,
        checks,
    };
}
