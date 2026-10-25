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

import type { Clip, Frame, Layer, Project } from '../types/document';
import { encodePng } from '../persist/png';
import { tmpPathFor } from '../persist/store';
import type { FileFs } from '../persist/store';
import { buildPlaybackCycle } from '../anim/clock';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type ExportErrorCode =
  | 'EMPTY_PROJECT'
  | 'EMPTY_CLIP'
  | 'INVALID_OPTIONS'
  | 'SHEET_TOO_LARGE'
  | 'BAD_CEL_BUFFER'
  | 'DUPLICATE_FILENAME'
  | 'INVALID_FILENAME'
  | 'ENCODE_FAILED'
  | 'WRITE_FAILED';

/** Typed export failure — UI maps `code` to friendly copy, tests assert it. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ExportErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// slug + filename safety (self-contained; mirrors the renderer's slugify)
// ---------------------------------------------------------------------------

/** Filesystem-safe slug: lowercase, non-alphanumerics → '-', never empty. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'sprite'
  );
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Defense-in-depth: export filenames are generated, but writes re-verify. */
function assertExportFilename(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 200 ||
    !FILENAME_RE.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new ExportError('INVALID_FILENAME', `unsafe export filename: ${String(name).slice(0, 60)}`);
  }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

// ---------------------------------------------------------------------------
// frame compositing (the deterministic pixel truth for exports)
// ---------------------------------------------------------------------------

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

const MAX_SHEET_SIDE = 16384;
/** 2^24 px ≈ 64 MB RGBA — far beyond any legit sprite sheet, hard memory guard. */
const MAX_SHEET_PIXELS = 1 << 24;

function intIn(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ExportError('INVALID_OPTIONS', `${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

/** Resolve + validate sheet geometry (shared by compose + metadata + planner). */
export function resolveSheetLayout(project: Project, clip: Clip, opts: SheetOptions): SheetLayout {
  const n = clip.frames.length;
  if (n === 0) throw new ExportError('EMPTY_CLIP', `clip "${clip.name}" has no frames to export`);
  const columns = intIn(opts.columns, 0, 4096, 'columns');
  const padding = intIn(opts.padding, 0, 512, 'padding');
  const spacing = opts.spacing === undefined ? padding : intIn(opts.spacing, 0, 512, 'spacing');
  const cols = columns > 0 ? Math.min(columns, n) : n;
  const rows = Math.ceil(n / cols);
  const w = project.width;
  const h = project.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 65535 || h > 65535) {
    throw new ExportError('INVALID_OPTIONS', `invalid project dimensions ${w}×${h}`);
  }
  // Geometry: padding = outer margin on all four sides; spacing = gap between
  // neighbouring frames. When spacing is omitted it defaults to padding, which
  // reproduces the legacy single-knob formula exactly:
  //   2·pad + cols·w + (cols−1)·pad = cols·w + (cols+1)·pad
  const width = 2 * padding + cols * w + Math.max(0, cols - 1) * spacing;
  const height = 2 * padding + rows * h + Math.max(0, rows - 1) * spacing;
  if (width > MAX_SHEET_SIDE || height > MAX_SHEET_SIDE || width * height > MAX_SHEET_PIXELS) {
    throw new ExportError(
      'SHEET_TOO_LARGE',
      `sprite sheet ${width}×${height} exceeds the ${MAX_SHEET_SIDE}px / ${MAX_SHEET_PIXELS}px limits — reduce columns, padding, or frame count`,
      { width, height },
    );
  }
  return {
    layout: columns === 0 ? 'horizontal' : 'grid',
    columns: cols,
    rows,
    padding,
    spacing,
    frameWidth: w,
    frameHeight: h,
    width,
    height,
  };
}

/** Top-left pixel origin of frame `index` within the sheet. */
export function sheetFrameOrigin(layout: SheetLayout, index: number): { x: number; y: number } {
  const cx = index % layout.columns;
  const cy = Math.floor(index / layout.columns);
  return {
    x: layout.padding + cx * (layout.frameWidth + layout.spacing),
    y: layout.padding + cy * (layout.frameHeight + layout.spacing),
  };
}

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
export function composeFrameRgba(project: Project, clip: Clip, frame: Frame): Uint8ClampedArray {
  const w = project.width;
  const h = project.height;
  const out = new Uint8ClampedArray(w * h * 4);
  for (const layer of clip.layers) {
    composeLayerInto(out, w, h, layer, frame);
  }
  return out;
}

function composeLayerInto(dst: Uint8ClampedArray, w: number, h: number, layer: Layer, frame: Frame): void {
  if (!layer.visible || layer.opacity <= 0) return;
  const cel = frame.cels[layer.id];
  if (!cel || !cel.buffer) return; // absent cel = fully transparent (C2)
  const src = cel.buffer;
  if (src.length !== w * h * 4) {
    throw new ExportError(
      'BAD_CEL_BUFFER',
      `cel buffer for layer "${layer.name}" on frame "${frame.id}" is ${src.length} bytes, expected ${w * h * 4}`,
      { layerId: layer.id, frameId: frame.id, bytes: src.length, expected: w * h * 4 },
    );
  }
  const opacity = Math.min(1, Math.max(0, layer.opacity));
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) continue;
    if (a === 255 && opacity >= 1) {
      // Exact fast path: a fully opaque src pixel strictly replaces dst
      // (sa=1 ⇒ oa=1, outC=srcC — identical to the general blend below).
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = 255;
    } else {
      blendPixel(dst, i, src, i, opacity);
    }
  }
}

function blendPixel(dst: Uint8ClampedArray, di: number, src: Uint8ClampedArray, si: number, opacity: number): void {
  const sa = (src[si + 3] / 255) * opacity;
  if (sa <= 0) return;
  const da = dst[di + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  dst[di] = Math.round((src[si] * sa + dst[di] * da * (1 - sa)) / oa);
  dst[di + 1] = Math.round((src[si + 1] * sa + dst[di + 1] * da * (1 - sa)) / oa);
  dst[di + 2] = Math.round((src[si + 2] * sa + dst[di + 2] * da * (1 - sa)) / oa);
  dst[di + 3] = Math.round(oa * 255);
}

/**
 * Composite every frame of the clip into one sprite-sheet RGBA buffer.
 * Frame placement matches `sheetFrameOrigin` exactly — metadata and pixels
 * cannot disagree because both derive from the same SheetLayout.
 */
export function composeSheetRgba(
  project: Project,
  clip: Clip,
  opts: SheetOptions,
): { rgba: Uint8ClampedArray; layout: SheetLayout } {
  const layout = resolveSheetLayout(project, clip, opts);
  const out = new Uint8ClampedArray(layout.width * layout.height * 4);
  for (let i = 0; i < clip.frames.length; i++) {
    const { x, y } = sheetFrameOrigin(layout, i);
    const frameRgba = composeFrameRgba(project, clip, clip.frames[i]);
    blitRect(out, layout.width, x, y, layout.frameWidth, layout.frameHeight, frameRgba);
  }
  return { rgba: out, layout };
}

function blitRect(
  dst: Uint8ClampedArray,
  dstW: number,
  ox: number,
  oy: number,
  w: number,
  h: number,
  src: Uint8ClampedArray,
): void {
  for (let y = 0; y < h; y++) {
    const di = ((oy + y) * dstW + ox) * 4;
    const si = y * w * 4;
    dst.set(src.subarray(si, si + w * 4), di);
  }
}

// ---------------------------------------------------------------------------
// JSON animation metadata (stable contract — see docs/export-metadata.md)
// ---------------------------------------------------------------------------

/** Metadata contract version (bumped only on breaking shape changes). */
export const EXPORT_METADATA_VERSION = 2;

const PLAYBACK_INTERPRETATION =
  'sequence lists ONE full playback cycle in engine-visible order; ' +
  'frameDurationsMs runs parallel to sequence (effective ms per step) and ' +
  'cycleMs is their sum. While loop=true the engine repeats sequence from ' +
  'its start; loop=false plays it once and stops on the final entry. ' +
  'Reverse and ping-pong direction is already baked into sequence order — ' +
  'engines that only play forward can play sequence verbatim. ' +
  'frames[i].durationMs is the per-frame display duration for engines that ' +
  'step frames instead of steps.';

export interface ClipExportMetadata {
  app: 'PixelForge AI';
  version: typeof EXPORT_METADATA_VERSION;
  project: { name: string; width: number; height: number; palette: string[] };
  clip: {
    id: string;
    name: string;
    fps: number;
    loop: boolean;
    loopMode: 'forward' | 'reverse' | 'pingpong';
    frameCount: number;
    tags: { name: string; from: number; to: number }[];
  };
  layout: 'horizontal' | 'grid';
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  padding: number;
  spacing: number;
  image: string;
  frames: { index: number; x: number; y: number; w: number; h: number; durationMs: number }[];
  playback: {
    mode: 'forward' | 'reverse' | 'pingpong';
    loop: boolean;
    fps: number;
    sequence: number[];
    frameDurationsMs: number[];
    cycleMs: number;
    interpretation: string;
  };
  godot: { animation: string; fps: number; loop: boolean; frames: number[]; sheet: string };
}

/**
 * Metadata for one exported sheet image. Frame rects come from the SAME
 * SheetLayout the raster used; `imageFilename` must be the actual artifact
 * name so external tooling can resolve it losslessly.
 */
export function buildClipMetadata(
  project: Project,
  clip: Clip,
  opts: SheetOptions,
  imageFilename: string,
): ClipExportMetadata {
  const layout = resolveSheetLayout(project, clip, opts);
  assertExportFilename(imageFilename);
  const fallbackMs = Math.max(1, Math.round(1000 / Math.min(60, Math.max(1, Math.round(clip.fps || 8)))));
  const cycle = buildPlaybackCycle(clip);
  return {
    app: 'PixelForge AI',
    version: EXPORT_METADATA_VERSION,
    project: { name: project.name, width: project.width, height: project.height, palette: [...project.palette] },
    clip: {
      id: clip.id,
      name: clip.name,
      fps: clip.fps,
      loop: clip.loop,
      loopMode: clip.loopMode,
      frameCount: clip.frames.length,
      tags: clip.tags.map((t) => ({ name: t.name, from: t.from, to: t.to })),
    },
    layout: layout.layout,
    frameWidth: layout.frameWidth,
    frameHeight: layout.frameHeight,
    columns: layout.columns,
    rows: layout.rows,
    padding: layout.padding,
    spacing: layout.spacing,
    image: imageFilename,
    frames: clip.frames.map((frame, i) => ({
      index: i,
      ...sheetFrameOrigin(layout, i),
      w: layout.frameWidth,
      h: layout.frameHeight,
      durationMs: frame.durationMs > 0 ? Math.max(1, Math.round(frame.durationMs)) : fallbackMs,
    })),
    playback: {
      mode: clip.loopMode,
      loop: clip.loop,
      fps: clip.fps,
      sequence: cycle.entries.map((e) => e.frame),
      frameDurationsMs: cycle.entries.map((e) => e.ms),
      cycleMs: cycle.totalMs,
      interpretation: PLAYBACK_INTERPRETATION,
    },
    godot: {
      animation: clip.name,
      fps: clip.fps,
      loop: clip.loop,
      frames: clip.frames.map((_, i) => i),
      sheet: imageFilename,
    },
  };
}

// ---------------------------------------------------------------------------
// export planning (scope × format → deterministic artifacts)
// ---------------------------------------------------------------------------

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

function frameNumber(i: number, pad: number): string {
  return pad > 0 ? String(i).padStart(pad, '0') : String(i);
}

/**
 * Build the deterministic export plan. Validates everything up-front — a
 * resolved plan either produces every artifact or throws before any bytes
 * exist (so callers can never end up half-planned).
 */
export function planExport(project: Project, request: ExportRequest): ExportPlan {
  if (!project || !Array.isArray(project.clips) || project.clips.length === 0) {
    throw new ExportError('EMPTY_PROJECT', 'the project has no clips to export');
  }
  const base = slugify(request.baseName || project.name);
  const zeroPad = request.zeroPadFrames === undefined ? 2 : intIn(request.zeroPadFrames, 0, 4, 'zeroPadFrames');
  const clips =
    request.scope === 'all-clips'
      ? project.clips
      : request.scope === 'frame'
        ? [clipForFrame(project, resolveClip(project, request), request.frameIndex ?? 0)]
        : [resolveClip(project, request)];
  // Duplicate clip names collide into one filename — reject with a helpful
  // message instead of silently overwriting (reliability §7).
  const seen = new Set<string>();
  for (const clip of clips) {
    const key = slugify(clip.name);
    if (seen.has(key)) {
      throw new ExportError(
        'DUPLICATE_FILENAME',
        `two clips are both named "${clip.name}" — rename one to export all clips`,
        { clipName: clip.name },
      );
    }
    seen.add(key);
  }

  const artifacts: PlannedArtifact[] = [];
  let totalPixels = 0;

  for (const clip of clips) {
    if (!Array.isArray(clip.frames) || clip.frames.length === 0) {
      throw new ExportError('EMPTY_CLIP', `clip "${clip.name}" has no frames to export`);
    }
    const clipBase = `${base}_${slugify(clip.name)}`;
    if (request.format === 'png-frames') {
      const indices =
        request.scope === 'frame'
          ? [Math.min(Math.max(0, request.frameIndex ?? 0), clip.frames.length - 1)]
          : clip.frames.map((_, i) => i);
      for (const i of indices) {
        const filename = `${clipBase}_frame${frameNumber(i, zeroPad)}.png`;
        artifacts.push({
          filename,
          kind: 'png',
          label: `${clip.name} · frame ${i}`,
          build: async () => {
            const rgba = composeFrameRgba(project, clip, clip.frames[i]);
            return encodeExportPng(project.width, project.height, rgba);
          },
        });
        totalPixels += project.width * project.height;
      }
    } else {
      const sheet = request.sheet ?? { columns: 0, padding: 0 };
      const layout = resolveSheetLayout(project, clip, sheet); // validates + guards
      const imageFilename = `${clipBase}_sheet.png`;
      artifacts.push({
        filename: imageFilename,
        kind: 'png',
        label: `${clip.name} · sheet ${layout.columns}×${layout.rows}`,
        build: async () => {
          const { rgba } = composeSheetRgba(project, clip, sheet);
          return encodeExportPng(layout.width, layout.height, rgba);
        },
      });
      totalPixels += layout.width * layout.height;
      if (request.includeJson) {
        const jsonFilename = `${clipBase}.json`;
        artifacts.push({
          filename: jsonFilename,
          kind: 'json',
          label: `${clip.name} · metadata`,
          build: async () => {
            const meta = buildClipMetadata(project, clip, sheet, imageFilename);
            return new TextEncoder().encode(JSON.stringify(meta, null, 2));
          },
        });
      }
    }
  }

  if (artifacts.length === 0) {
    throw new ExportError('INVALID_OPTIONS', 'the export request produces no files');
  }
  return { artifacts, clipCount: clips.length, totalPixels };
}

function resolveClip(project: Project, request: ExportRequest): Clip {
  const clip = request.clipId ? project.clips.find((c) => c.id === request.clipId) : project.clips[0];
  if (!clip) {
    throw new ExportError(
      'EMPTY_PROJECT',
      request.clipId ? `clip "${request.clipId}" was not found in the project` : 'the project has no clips to export',
    );
  }
  return clip;
}

function clipForFrame(project: Project, clip: Clip, frameIndex: number): Clip {
  if (typeof frameIndex !== 'number' || !Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new ExportError('INVALID_OPTIONS', 'frameIndex must be a non-negative integer');
  }
  if (frameIndex >= clip.frames.length) {
    throw new ExportError('INVALID_OPTIONS', `frame ${frameIndex} does not exist in clip "${clip.name}"`);
  }
  return clip;
}

/** PNG-encode via the package codec; PersistError is normalized to ExportError. */
export async function encodeExportPng(width: number, height: number, rgba: Uint8ClampedArray): Promise<Uint8Array> {
  try {
    return await encodePng(width, height, rgba);
  } catch (err) {
    throw new ExportError('ENCODE_FAILED', `PNG encode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Build every artifact's bytes up-front (all-or-nothing; nothing is written). */
export async function buildAllArtifacts(
  plan: ExportPlan,
): Promise<{ filename: string; bytes: Uint8Array; kind: 'png' | 'json' }[]> {
  const out: { filename: string; bytes: Uint8Array; kind: 'png' | 'json' }[] = [];
  for (const artifact of plan.artifacts) {
    out.push({ filename: artifact.filename, kind: artifact.kind, bytes: await artifact.build() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// atomic multi-file write (desktop destination; reuses Task 3 primitives)
// ---------------------------------------------------------------------------

export interface WriteExportOptions {
  /** false (default): preflight existing targets and refuse before writing. */
  overwrite?: boolean;
}

export type WriteExportResult =
  | { status: 'ok'; written: string[] }
  | { status: 'conflicts'; conflicts: string[] }
  | { status: 'partial'; written: string[]; failures: { filename: string; message: string }[] };

/**
 * Write export artifacts into `dir` over a core FileFs (bridge fs on
 * desktop, MemoryFs in tests). Per-file atomic write (`<name>.tmp` →
 * rename), so a failure mid-run never corrupts an existing export — the old
 * file either stays intact or the new one lands complete. Nothing is
 * written when `overwrite` is false and any target already exists.
 */
export async function writeExportPlan(
  fs: FileFs,
  dir: string,
  files: { filename: string; bytes: Uint8Array }[],
  options?: WriteExportOptions,
): Promise<WriteExportResult> {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new ExportError('INVALID_FILENAME', 'export destination directory is required');
  }
  const targets = files.map((f) => {
    assertExportFilename(f.filename);
    if (!(f.bytes instanceof Uint8Array)) {
      throw new ExportError('WRITE_FAILED', `artifact "${f.filename}" has no bytes`);
    }
    return { ...f, path: joinPath(dir, f.filename) };
  });

  if (!options?.overwrite) {
    const conflicts: string[] = [];
    for (const t of targets) {
      if (await fs.exists(t.path)) conflicts.push(t.filename);
    }
    if (conflicts.length > 0) return { status: 'conflicts', conflicts };
  }

  const written: string[] = [];
  const failures: { filename: string; message: string }[] = [];
  for (const t of targets) {
    const tmp = tmpPathFor(t.path);
    try {
      await fs.writeFile(tmp, t.bytes);
      await fs.rename(tmp, t.path);
      written.push(t.path);
    } catch (err) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* best-effort cleanup; the real target was never touched */
      }
      failures.push({ filename: t.filename, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (failures.length === 0) return { status: 'ok', written };
  return { status: 'partial', written, failures };
}
