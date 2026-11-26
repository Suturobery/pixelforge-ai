/**
 * PixelForge AI — editor document model v2 (v3.1 Plan §2.4 / §6).
 *
 * Architecture (approved v3.1):
 *   Project
 *   ├─ settings, palette, trash[]                ← trash: deleted frames/layers/clips (C5)
 *   └─ Clip (id, name, fps, loop, loopMode, tags[])
 *      ├─ layers: Layer[] (bottom→top)           ← stack defined ONCE PER CLIP (C1)
 *      ├─ parts: Part[] (optional motion regions, C4)
 *      └─ frames[] — each holds a Cel per layer
 *          Cel { buffer, linked }                ← missing cel = fully transparent (C2)
 *
 * Runtime model: layers/cels are Uint8ClampedArray RGBA buffers (prototype
 * type kept); the JSON in §6 is the serialized form and maps cel src paths
 * ⇄ in-memory cels 1:1 (see types/serialized.ts). Linked cels share the SAME
 * buffer object across every frame of the clip — "edit once applies
 * everywhere" (C2; engine support P0, UI toggle P2 per C19).
 *
 * This module is pure TypeScript: no React, no Electron, no DOM (§8.3).
 */

import type { SCHEMA_VERSION } from '../version';
import type { StyleProfile } from '../style-profile';

/** RGBA tuple, channels 0–255 (matches prototype color.ts). */
export type RGBA = [number, number, number, number];

/** Playback direction (v3.1 C3). `loop: false` = play once through, stopping on the last frame in the mode's direction. */
export type LoopMode = 'forward' | 'reverse' | 'pingpong';

/** RGBA pixel buffer, length = width * height * 4. */
export type CellBuffer = Uint8ClampedArray;

/** 2D integer canvas coordinate for an editable pixel-perfect vector node. */
export interface VectorPoint {
  x: number;
  y: number;
}

/** Supported pixel-perfect editable vector primitives. */
export type VectorShapeKind = 'line' | 'curve' | 'rect' | 'ellipse' | 'polygon';

/** Non-destructive, pixel-perfect editable vector shape stored on a cel. */
export interface VectorShape {
  id: string;
  kind: VectorShapeKind;
  /**
   * Anchor & control points in canvas pixel coordinates:
   * - line / rect / ellipse: [start, end] (2 points)
   * - curve: [p0, ctrl, p1] (quadratic, 3 pts) or [p0, c1, c2, p1] (cubic, 4 pts)
   * - polygon: 2..64 vertices
   */
  points: VectorPoint[];
  /** Crisp stroke hex color (#rrggbb), or null/undefined for no stroke. */
  stroke?: string | null;
  /** Crisp fill hex color (#rrggbb) for rect / ellipse / closed polygon, or null/undefined. */
  fill?: string | null;
  /** Stroke thickness in canvas pixels (1..4, default 1). */
  strokeWidth?: number;
  /** For polygon shapes: true (default) closes the loop; false renders an open pixel polyline. */
  closed?: boolean;
}

/**
 * A cel = the pixels of one layer on one frame.
 * Absent entry in `Frame.cels` means fully transparent (C2) — cels do NOT
 * have to exist for every layer of every frame.
 */
export interface Cel {
  buffer: CellBuffer;
  /**
   * True when this cel is the shared cel of a linked layer: every frame of
   * the clip references the same buffer object for that layer.
   */
  linked: boolean;
  /**
   * Optional non-destructive pixel-perfect vector shapes rendered on top of
   * `buffer` before LayerModifiers. Omitted when empty.
   */
  vectors?: VectorShape[];
}

/** One frame of animation. Cels are keyed by layer id. */
export interface Frame {
  id: string;
  /** Per-frame duration override; 0 = inherit the clip fps (v3.1 §2.6). */
  durationMs: number;
  /** Cel per layer id; absent key = fully transparent. Keys ⊆ clip layer ids. */
  cels: Record<string, Cel>;
}

/** Pixel blend modes for layer compositing (canvas globalCompositeOperation names). */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';

/** Non-destructive 1px outline / sel-out modifier applied at composite time. */
export interface LayerOutlineModifier {
  enabled: boolean;
  mode: 'solid' | 'sel-out';
  color: string;
  connectivity?: 4 | 8;
}

/** Non-destructive crisp pixel drop-shadow modifier applied behind the layer. */
export interface LayerShadowModifier {
  enabled: boolean;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
}

/** Non-destructive live palette/skin remap modifier applied per layer. */
export interface LayerColorRemapModifier {
  enabled: boolean;
  /** Optional built-in skin preset id (e.g. 'fire', 'ice') for UI dropdown persistence. */
  presetId?: string;
  palette: string[];
  mode?: 'ramp' | 'nearest';
}

/** Non-destructive modifier stack attached to a layer (persisted in project.json). */
export interface LayerModifiers {
  outline?: LayerOutlineModifier;
  shadow?: LayerShadowModifier;
  colorRemap?: LayerColorRemapModifier;
}

/** A layer of the clip's stack (bottom → top). Pixels live in cels, not here. */
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  /** Linked layer: all frames share one cel (backgrounds; C2/C19). */
  linked: boolean;
  /** Paint-locked: pixel tools refuse to mutate this layer. */
  locked?: boolean;
  /** Compositing mode against the layers below; omitted = normal. */
  blend?: BlendMode;
  /** Optional non-destructive live modifiers (outline / sel-out / shadow / color remap). */
  modifiers?: LayerModifiers;
}

/** Region rectangle in canvas pixels. */
export interface PartRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Motion region (v3.1 C4/C14). Parts serialize as regions, never as cuts;
 * overlap pixels are owned by the highest-z part (§4.1.1).
 */
export interface Part {
  id: string;
  name: string;
  layerId: string;
  /** Undefined = whole layer. */
  rect?: PartRect;
  anchorFrameId: string;
  /** Higher z wins overlap ownership. */
  z: number;
}

/** Frame-range tag (P1 feature, part of the v2 schema). Indices are frame positions. */
export interface ClipTag {
  name: string;
  from: number;
  to: number;
}

/** An animation clip with its own layer stack (C1). */
export interface Clip {
  id: string;
  name: string;
  /** Frames per second, 1..60. */
  fps: number;
  /** false = play once through (C3). */
  loop: boolean;
  loopMode: LoopMode;
  /** Layer stack, bottom → top, defined ONCE PER CLIP (C1). */
  layers: Layer[];
  parts: Part[];
  frames: Frame[];
  tags: ClipTag[];
}

/** What was deleted and where it came from — enough to restore it exactly. */
export type TrashItem =
  | { kind: 'frame'; clipId: string; frameIndex: number; frame: Frame }
  | {
      kind: 'layer';
      clipId: string;
      layerIndex: number;
      layer: Layer;
      /** Cel per frame id (linked frames share one Cel object by reference). */
      celsByFrameId: Record<string, Cel>;
    }
  | { kind: 'clip'; clipIndex: number; clip: Clip };

/** Trash entry (v3.1 C5/C9): trash-backed deletes with cap 20 (oldest evicted). */
export interface TrashEntry {
  id: string;
  label: string;
  deletedAt: number;
  item: TrashItem;
}

/** Document-level settings serialized in project.json (v3.1 §6). */
export interface DocumentSettings {
  paletteEnforce: boolean;
  /** Optional so older v2 and v1 projects remain readable without migration. */
  styleProfile?: StyleProfile;
  onion: {
    /** How many previous frames to onion-skin (0–3). */
    prev: number;
    /** How many next frames to onion-skin (0–3). */
    next: number;
  };
}

/**
 * Palette = ordered hex colors (#rrggbb / #rrggbbaa). The v2 schema keeps the
 * v1 `string[]` shape (§6 allows optional per-color metadata later — that
 * extension belongs to the file-format task, Task 3).
 */
export type Palette = string[];

/** The editor document. Runtime form; see types/serialized.ts for the JSON form. */
export interface Project {
  /** Persistence id (web testbed row id); null while unsaved — prototype compat. */
  id: string | null;
  /** Marks the runtime document as schema v2 (`2`). */
  schemaVersion: typeof SCHEMA_VERSION;
  name: string;
  width: number;
  height: number;
  palette: Palette;
  settings: DocumentSettings;
  clips: Clip[];
  trash: TrashEntry[];
}

/** Canvas bounds (v3.1 §2: pixel canvas 16–256). */
export const CANVAS_MIN = 16 as const;
export const CANVAS_MAX = 256 as const;

/** Trash capacity (v3.1 C5/C9). */
export const TRASH_CAP = 20 as const;

/** Onion-skin depth bounds (§2.6: previous/next N, 1–3 configured; 0 disables). */
export const ONION_MAX = 3 as const;
