/**
 * v1 → v2 project importer (v3.1 §2.4 "Migration", §13 "v1→v2 migration
 * golden files incl. loop mapping C3; forward-read refusal").
 *
 * v1 shape (prototype serialize.ts): per-frame layer stacks, each layer a
 * PNG data URL, `loop: boolean` per clip. v1 layer ids are PER-FRAME (the
 * flaw v2 fixes), so layers are matched across frames **by name** (first
 * occurrence wins; the prototype's own deleteFrame had the same constraint).
 *
 * Guarantees:
 *  - unknown-shaped input is rejected up front (never half-converted);
 *  - loop mapping per C3 (loop:false = play once, mode forward);
 *  - a layer missing from a frame becomes an ABSENT cel (= transparent, C2)
 *    with a warning;
 *  - layer property mismatches across frames adopt the first occurrence and
 *    warn;
 *  - cel PNG dimension mismatches are pad/cropped (top-left anchored) with a
 *    warning — v1 canvases were always drawn at project size, but a resized
 *    v1 file could carry stale cels;
 *  - the result passes validateSerializedProjectV2 when re-serialized.
 */
import type { CelSourceResolver, V1ImportResult, V1ToV2Importer } from '../types/v1';
export declare class V1ProjectImporter implements V1ToV2Importer {
    import(raw: unknown, resolver: CelSourceResolver, opts?: {
        name?: string;
        id?: string | null;
    }): Promise<V1ImportResult>;
}
/**
 * CelSourceResolver for v1 PNG data URLs (data:image/png;base64,…).
 * Dimension mismatches are top-left anchored: crop overflow, pad (transparent)
 * shortfall — deterministic and lossless for conforming v1 files.
 */
export declare const pngDataUrlResolver: CelSourceResolver;
/** Convenience singleton (matches the V1ToV2Importer contract). */
export declare const v1Importer: V1ToV2Importer;
