/**
 * Immutable document access & update helpers.
 *
 * Every helper takes a document and returns a NEW document — inputs are
 * never mutated. This is the copy-on-write discipline that lets structural
 * history entries hold cheap shallow snapshots (prototype mechanism, kept)
 * while buffers are only ever replaced wholesale (which is what keeps tile
 * diffs consistent with snapshots).
 */

import { uid } from '../id';
import type {
  Cel,
  CellBuffer,
  Clip,
  Frame,
  Layer,
  Project,
  TrashEntry,
} from '../types/document';
import { TRASH_CAP } from '../types/document';

export function findClip(project: Project, clipId: string): Clip | undefined {
  return project.clips.find((c) => c.id === clipId);
}

export function findFrame(clip: Clip, frameId: string): Frame | undefined {
  return clip.frames.find((f) => f.id === frameId);
}

export function findLayer(clip: Clip, layerId: string): { layer: Layer; index: number } | undefined {
  const index = clip.layers.findIndex((l) => l.id === layerId);
  return index < 0 ? undefined : { layer: clip.layers[index], index };
}

export interface CelLocation {
  clip: Clip;
  frame: Frame;
  layer: Layer;
  /** Undefined when the cel is absent (= fully transparent, C2). */
  cel?: Cel;
}

/** Locate a cel without creating it. Returns null when clip/frame/layer is missing. */
export function locateCel(
  project: Project,
  clipId: string,
  frameId: string,
  layerId: string
): CelLocation | null {
  const clip = findClip(project, clipId);
  if (!clip) return null;
  const frame = findFrame(clip, frameId);
  if (!frame) return null;
  const found = findLayer(clip, layerId);
  if (!found) return null;
  return { clip, frame, layer: found.layer, cel: frame.cels[layerId] };
}

/** Immutably map a single clip. */
export function mapClip(project: Project, clipId: string, fn: (clip: Clip) => Clip): Project {
  return {
    ...project,
    clips: project.clips.map((c) => (c.id === clipId ? fn(c) : c)),
  };
}

/** Immutably map every frame of a clip (layer ops are clip-wide, C1). */
export function mapFrames(
  project: Project,
  clipId: string,
  fn: (frame: Frame, index: number) => Frame
): Project {
  return mapClip(project, clipId, (c) => ({ ...c, frames: c.frames.map(fn) }));
}

/** Set (or replace) one cel. Missing frame/layer → document unchanged. */
export function setCel(
  project: Project,
  clipId: string,
  frameId: string,
  layerId: string,
  cel: Cel
): Project {
  return mapFrames(project, clipId, (f) =>
    f.id !== frameId ? f : { ...f, cels: { ...f.cels, [layerId]: cel } }
  );
}

/**
 * Install the same cel object into EVERY frame of the clip for a layer —
 * the linked-cel propagation path (C2: "every frame references the same
 * src"). Frames missing the cel gain it.
 */
export function setCelEverywhere(
  project: Project,
  clipId: string,
  layerId: string,
  cel: Cel
): Project {
  return mapFrames(project, clipId, (f) => ({ ...f, cels: { ...f.cels, [layerId]: cel } }));
}

/**
 * Replace a cel's buffer, handling linked-cel propagation:
 *  - layer.linked → the new buffer is installed into all frames of the clip;
 *  - otherwise only the target frame's cel is replaced (created if absent).
 * Returns the new document, or null when clip/frame/layer no longer exist.
 */
export function replaceCelBuffer(
  project: Project,
  clipId: string,
  frameId: string,
  layerId: string,
  buffer: CellBuffer,
  linked: boolean
): Project | null {
  const loc = locateCel(project, clipId, frameId, layerId);
  if (!loc) return null;
  const cel: Cel = { buffer, linked };
  return loc.layer.linked
    ? setCelEverywhere(project, clipId, layerId, cel)
    : setCel(project, clipId, frameId, layerId, cel);
}

/** Push a trash entry, evicting the oldest beyond the cap (C5/C9, cap 20). */
export function pushTrash(project: Project, entry: TrashEntry): Project {
  const trash = [...project.trash, entry];
  while (trash.length > TRASH_CAP) trash.shift();
  return { ...project, trash };
}

/** Remove a trash entry by id. Returns null when not found. */
export function takeTrash(project: Project, entryId: string): { project: Project; entry: TrashEntry } | null {
  const idx = project.trash.findIndex((t) => t.id === entryId);
  if (idx < 0) return null;
  const entry = project.trash[idx];
  return { project: { ...project, trash: project.trash.filter((_, i) => i !== idx) }, entry };
}

/** Fresh ids for structural commands. */
export const newLayerId = () => uid('ly');
export const newFrameId = () => uid('fr');
export const newClipId = () => uid('cl');
export const newPartId = () => uid('pt');
export const newTrashId = () => uid('tr');
