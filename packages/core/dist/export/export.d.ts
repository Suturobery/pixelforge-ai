/**
 * PixelForge AI — export service (Task 7, v3.1 Plan §7 + §8.3).
 *
 * THE single export implementation: deterministic frame/sprite-sheet
 * compositing, JSON animation metadata, and atomic multi-file writes.
 * Pure TypeScript, zero DOM — the same code runs in the browser renderer,
 * the Electron renderer, workers, and unit tests.
 *
 * Determinism contract (§7 "exported pixels/JSON match the project exactly"):
 *   - Compositing is straight-alpha source-over with fixed rounding — the
 *     same formula family as the server-side MCP compositor (reviewed
 *     precedent). No canvas 2D, no platform rounding differences.
 *   - PNG encoding is the package's own RGBA8/filter-0 codec (persist/png).
 *   - Metadata contains no timestamps or ambient state — two exports of the
 *     same document with the same options produce identical bytes.
 *   - The source document is never mutated; every buffer is freshly
 *     allocated. Onion skins / selection ants / guides are RENDERER concepts
 *     and physically cannot enter this module (no such inputs exist here).
 *
 * Out of scope (later tasks): GIF + Godot `.tres` (Task 12), MCP unification
 * (Task 8). Nearest-neighbor scaling is intentionally NOT added — exports are
 * always native size (v3.1: "NN scaling optional and never alters source").
 */
import type { Clip, Frame, Project } from '../types/document';
import type { FileFs } from '../persist/store';
export type ExportErrorCode = 'EMPTY_PROJECT' | 'EMPTY_CLIP' | 'INVALID_OPTIONS' | 'SHEET_TOO_LARGE' | 'BAD_CEL_BUFFER' | 'DUPLICATE_FILENAME' | 'INVALID_FILENAME' | 'ENCODE_FAILED' | 'WRITE_FAILED';
/** Typed export failure — UI maps `code` to friendly copy, tests assert it. */
export declare class ExportError extends Error {
    readonly code: ExportErrorCode;
    readonly details?: Record<string, unknown>;
    constructor(code: ExportErrorCode, message: string, details?: Record<string, unknown>);
}
/** Filesystem-safe slug: lowercase, non-alphanumerics → '-', never empty. */
export declare function slugify(s: string): string;
/** Layout description shared by the sheet raster and its metadata. */
export interface SheetLayout {
    /** 'horizontal' is the degenerate grid: columns === frame count (one row). */
    layout: 'horizontal' | 'grid';
    columns: number;
    rows: number;
    /** Outer margin around the whole sheet, px. */
    padding: number;
    /** Gap between neighbouring frames, px. */
    spacing: number;
    frameWidth: number;
    frameHeight: number;
    width: number;
    height: number;
}
export interface SheetOptions {
    /** 0 = horizontal strip (single row). */
    columns: number;
    /** Outer margin around the sheet, px. */
    padding: number;
    /**
     * Gap between frames, px. Defaults to `padding` — the legacy single-knob
     * behavior (`(cols+1)*pad` total) is preserved when spacing is omitted.
     */
    spacing?: number;
}
/** Resolve + validate sheet geometry (shared by compose + metadata + planner). */
export declare function resolveSheetLayout(project: Project, clip: Clip, opts: SheetOptions): SheetLayout;
/** Top-left pixel origin of frame `index` within the sheet. */
export declare function sheetFrameOrigin(layout: SheetLayout, index: number): {
    x: number;
    y: number;
};
/**
 * Composite one frame (visible clip layers, bottom → top) into a fresh RGBA
 * buffer at the project's native size. Absent cels render as fully
 * transparent (C2); linked cels simply share their buffer (read-only).
 *
 * Blend math (straight-alpha source-over, per pixel, fixed rounding):
 *   sa = (srcA/255) · layerOpacity;  da = dstA/255
 *   oa = sa + da·(1-sa)
 *   outA = round(oa·255);  outC = round((srcC·sa + dstC·da·(1-sa)) / oa)
 * Same formula family as the reviewed server compositor — one defined truth.
 */
export declare function composeFrameRgba(project: Project, clip: Clip, frame: Frame): Uint8ClampedArray;
/**
 * Composite every frame of the clip into one sprite-sheet RGBA buffer.
 * Frame placement matches `sheetFrameOrigin` exactly — metadata and pixels
 * cannot disagree because both derive from the same SheetLayout.
 */
export declare function composeSheetRgba(project: Project, clip: Clip, opts: SheetOptions): {
    rgba: Uint8ClampedArray;
    layout: SheetLayout;
};
/** Metadata contract version (bumped only on breaking shape changes). */
export declare const EXPORT_METADATA_VERSION = 2;
export interface ClipExportMetadata {
    app: 'PixelForge AI';
    version: typeof EXPORT_METADATA_VERSION;
    project: {
        name: string;
        width: number;
        height: number;
        palette: string[];
    };
    clip: {
        id: string;
        name: string;
        fps: number;
        loop: boolean;
        loopMode: 'forward' | 'reverse' | 'pingpong';
        frameCount: number;
        tags: {
            name: string;
            from: number;
            to: number;
        }[];
    };
    layout: 'horizontal' | 'grid';
    frameWidth: number;
    frameHeight: number;
    columns: number;
    rows: number;
    padding: number;
    spacing: number;
    image: string;
    frames: {
        index: number;
        x: number;
        y: number;
        w: number;
        h: number;
        durationMs: number;
    }[];
    playback: {
        mode: 'forward' | 'reverse' | 'pingpong';
        loop: boolean;
        fps: number;
        sequence: number[];
        frameDurationsMs: number[];
        cycleMs: number;
        interpretation: string;
    };
    godot: {
        animation: string;
        fps: number;
        loop: boolean;
        frames: number[];
        sheet: string;
    };
}
/**
 * Metadata for one exported sheet image. Frame rects come from the SAME
 * SheetLayout the raster used; `imageFilename` must be the actual artifact
 * name so external tooling can resolve it losslessly.
 */
export declare function buildClipMetadata(project: Project, clip: Clip, opts: SheetOptions, imageFilename: string): ClipExportMetadata;
export type ExportScope = 'frame' | 'clip' | 'all-clips';
export type ExportFormat = 'png-frames' | 'sheet';
export interface ExportRequest {
    scope: ExportScope;
    format: ExportFormat;
    /** Clip to export for scope 'frame' | 'clip'; defaults to the first clip. */
    clipId?: string;
    /** Scope 'frame' only: index of the frame to export. */
    frameIndex?: number;
    /** Sheet layout; required for format 'sheet'. */
    sheet?: SheetOptions;
    /** Sheet only: emit the sidecar JSON metadata next to the image. */
    includeJson?: boolean;
    /** Filename base; default slugify(project.name). Slugified again defensively. */
    baseName?: string;
    /** Zero-pad frame indices to N digits (0 = off). Default 2. */
    zeroPadFrames?: number;
}
export interface PlannedArtifact {
    filename: string;
    kind: 'png' | 'json';
    /** Human label for UI summaries. */
    label: string;
    build: () => Promise<Uint8Array>;
}
export interface ExportPlan {
    artifacts: PlannedArtifact[];
    clipCount: number;
    /** Total pixel area across all PNG artifacts (UI size hint). */
    totalPixels: number;
}
/**
 * Build the deterministic export plan. Validates everything up-front — a
 * resolved plan either produces every artifact or throws before any bytes
 * exist (so callers can never end up half-planned).
 */
export declare function planExport(project: Project, request: ExportRequest): ExportPlan;
/** PNG-encode via the package codec; PersistError is normalized to ExportError. */
export declare function encodeExportPng(width: number, height: number, rgba: Uint8ClampedArray): Promise<Uint8Array>;
/** Build every artifact's bytes up-front (all-or-nothing; nothing is written). */
export declare function buildAllArtifacts(plan: ExportPlan): Promise<{
    filename: string;
    bytes: Uint8Array;
    kind: 'png' | 'json';
}[]>;
export interface WriteExportOptions {
    /** false (default): preflight existing targets and refuse before writing. */
    overwrite?: boolean;
}
export type WriteExportResult = {
    status: 'ok';
    written: string[];
} | {
    status: 'conflicts';
    conflicts: string[];
} | {
    status: 'partial';
    written: string[];
    failures: {
        filename: string;
        message: string;
    }[];
};
/**
 * Write export artifacts into `dir` over a core FileFs (bridge fs on
 * desktop, MemoryFs in tests). Per-file atomic write (`<name>.tmp` →
 * rename), so a failure mid-run never corrupts an existing export — the old
 * file either stays intact or the new one lands complete. Nothing is
 * written when `overwrite` is false and any target already exists.
 */
export declare function writeExportPlan(fs: FileFs, dir: string, files: {
    filename: string;
    bytes: Uint8Array;
}[], options?: WriteExportOptions): Promise<WriteExportResult>;
