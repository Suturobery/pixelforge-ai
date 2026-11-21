/**
 * v1 compatibility boundary (v3.1 §2.4 "Migration" + §6).
 *
 * The web prototype's SerializedProject v1 shape is mirrored here so the
 * core can speak about v1 data without importing from the Next.js app.
 * v1 read support is permanent (v3.1 §2.4). The actual v1→v2 importer is
 * implemented in Task 3 against the V1ToV2Importer interface below.
 */

import type { LoopMode } from './document';
import type { StyleProfile } from '../style-profile';

/** v1 layer inside a per-frame layer stack, PNG encoded as a data URL. */
export interface V1SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  /** Optional v1.1 extension — classic v1 readers ignore it. */
  locked?: boolean;
  /** Optional v1.1 extension — compositing mode. */
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';
  png: string;
}

/** v1 frame — carries its OWN layer stack (the flaw v2 fixes with cels). */
export interface V1SerializedFrame {
  id: string;
  layers: V1SerializedLayer[];
  /**
   * OPTIONAL Task 6 extension (web-testbed persistence): per-frame duration
   * override in ms; 0/absent = inherit the clip fps. Pure v1 documents never
   * carry it; the exporter writes it only when non-zero so classic files
   * stay byte-compatible.
   */
  durationMs?: number;
}

export interface V1SerializedClip {
  id: string;
  name: string;
  fps: number;
  /** v1 has a bare loop flag; v2 adds loopMode (C3 mapping). */
  loop: boolean;
  frames: V1SerializedFrame[];
  /**
   * OPTIONAL Task 6 extension: playback direction. Absent = forward
   * (the C3 v1 mapping); the exporter writes it only when non-forward.
   */
  loopMode?: LoopMode;
  /**
   * OPTIONAL Task 10 extension: motion parts (v3.1 §4.1). Absent = no parts
   * (classic v1 files). The exporter writes them only when non-empty and the
   * importer adopts only well-formed entries (invalid ones warn + skip) —
   * classic v1 readers ignore the unknown field.
   */
  parts?: V1SerializedPart[];
}

/** Task 10 additive extension — the v1-carried form of a v2 `Part`. */
export interface V1SerializedPart {
  name: string;
  layerId: string;
  rect?: { x: number; y: number; w: number; h: number };
  anchorFrameId?: string;
  z?: number;
}

export interface V1SerializedProject {
  version: 1;
  name: string;
  width: number;
  height: number;
  palette: string[];
  clips: V1SerializedClip[];
  /**
   * OPTIONAL Task 6 extension: document onion-skin range. Absent = the
   * v2 shell default ({ prev: 1, next: 0 }).
   */
  settings?: {
    onion?: {
      prev?: number;
      next?: number;
    };
    /** Optional project style contract; classic v1 readers ignore this field. */
    styleProfile?: StyleProfile;
  };
}

export function isSerializedProjectV1(v: unknown): v is V1SerializedProject {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<V1SerializedProject>;
  return (
    p.version === 1 &&
    typeof p.name === 'string' &&
    typeof p.width === 'number' &&
    typeof p.height === 'number' &&
    Array.isArray(p.palette) &&
    Array.isArray(p.clips)
  );
}

/**
 * C3 loop mapping (v3.1): `loop: false` = play once through. loopMode only
 * gains meaning in v2, so every v1 clip maps to mode "forward".
 */
export function mapV1Loop(loop: boolean): { loop: boolean; loopMode: LoopMode } {
  return { loop, loopMode: 'forward' };
}

/**
 * Resolves a serialized cel source into a runtime RGBA buffer.
 * Task 3 provides implementations: PNG data URL decoder (v1) and
 * .pixelforgeproj ZIP entry reader (v2).
 */
export interface CelSourceResolver {
  resolve(src: string, width: number, height: number): Promise<Uint8ClampedArray>;
}

export interface V1ImportResult {
  /** Converted v2 runtime document. */
  project: import('./document').Project;
  /** Non-fatal notes (e.g. missing layers matched by fallback, dropped cel). */
  warnings: string[];
}

/**
 * Contract implemented by Task 3 (`@pixelforge/core` file-format module):
 * convert a v1 serialized project to the v2 cel model by matching layer ids
 * across frames (v3.1 §2.4 "Migration"), mapping loop per C3, and building
 * one cel per (frame, layer) pair. Unknown/unknown-shaped input must be
 * rejected, never half-converted.
 */
export interface V1ToV2Importer {
  import(
    raw: unknown,
    resolver: CelSourceResolver,
    opts?: { name?: string; id?: string | null }
  ): Promise<V1ImportResult>;
}
