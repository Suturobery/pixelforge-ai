/**
 * v1 compatibility runtime helpers (v3.1 §2.4 "Migration", §6).
 *
 * Boundary for Task 3's importer: v1 documents are read permanently; the
 * conversion matches layer ids across frames to build the v2 cel model, and
 * maps `loop: boolean` per C3. This module provides the loop mapping and the
 * shared conversion scaffolding; the full importer (PNG decode via resolver,
 * per-frame cel grouping, warnings) lands in Task 3.
 */

import type { Clip, Frame, Layer, Project } from '../types/document';
import type { V1SerializedClip, V1SerializedProject } from '../types/v1';
import { mapV1Loop } from '../types/v1';

export { isSerializedProjectV1, mapV1Loop } from '../types/v1';
export type {
  CelSourceResolver,
  V1ImportResult,
  V1SerializedClip,
  V1SerializedFrame,
  V1SerializedLayer,
  V1SerializedProject,
  V1ToV2Importer,
} from '../types/v1';

/**
 * Convert v1 loop semantics to the v2 pair (C3):
 *   v1 loop:true  → v2 { loop: true,  loopMode: 'forward' }
 *   v1 loop:false → v2 { loop: false, loopMode: 'forward' }  (play once)
 */
export const convertV1Loop = mapV1Loop;

/**
 * Convert a v1 clip's metadata (id/name/fps/loop) to a v2 clip skeleton
 * WITHOUT cels — Task 3 fills frames/cels from decoded PNGs. Kept here so
 * the importer's shape is pinned by tests before its implementation lands.
 */
export function v1ClipSkeleton(v1: V1SerializedClip): Clip {
  return {
    id: v1.id,
    name: v1.name,
    fps: Math.min(60, Math.max(1, Math.round(v1.fps))),
    ...mapV1Loop(v1.loop),
    layers: [],
    parts: [],
    frames: [],
    tags: [],
  };
}

/**
 * Build a v2 runtime document shell for an imported project. Task 3 layers
 * converted clips into it (and computes trash from unused material, if any).
 */
export function v2ProjectShell(v1: V1SerializedProject, opts: { id?: string | null } = {}): Project {
  return {
    id: opts.id ?? null,
    schemaVersion: 2,
    name: v1.name,
    width: v1.width,
    height: v1.height,
    palette: [...v1.palette],
    settings: { paletteEnforce: true, onion: { prev: 1, next: 0 } },
    clips: [],
    trash: [],
  };
}

/** Re-exported types for importer implementations (Task 3). */
export type { Layer, Frame, Clip, Project };
