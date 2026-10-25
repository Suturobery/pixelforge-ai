/**
 * Immutable document access & update helpers.
 *
 * Every helper takes a document and returns a NEW document — inputs are
 * never mutated. This is the copy-on-write discipline that lets structural
 * history entries hold cheap shallow snapshots (prototype mechanism, kept)
 * while buffers are only ever replaced wholesale (which is what keeps tile
 * diffs consistent with snapshots).
 */
import type { Cel, CellBuffer, Clip, Frame, Layer, Project, TrashEntry } from '../types/document';
export declare function findClip(project: Project, clipId: string): Clip | undefined;
export declare function findFrame(clip: Clip, frameId: string): Frame | undefined;
export declare function findLayer(clip: Clip, layerId: string): {
    layer: Layer;
    index: number;
} | undefined;
export interface CelLocation {
    clip: Clip;
    frame: Frame;
    layer: Layer;
    /** Undefined when the cel is absent (= fully transparent, C2). */
    cel?: Cel;
}
/** Locate a cel without creating it. Returns null when clip/frame/layer is missing. */
export declare function locateCel(project: Project, clipId: string, frameId: string, layerId: string): CelLocation | null;
/** Immutably map a single clip. */
export declare function mapClip(project: Project, clipId: string, fn: (clip: Clip) => Clip): Project;
/** Immutably map every frame of a clip (layer ops are clip-wide, C1). */
export declare function mapFrames(project: Project, clipId: string, fn: (frame: Frame, index: number) => Frame): Project;
/** Set (or replace) one cel. Missing frame/layer → document unchanged. */
export declare function setCel(project: Project, clipId: string, frameId: string, layerId: string, cel: Cel): Project;
/**
 * Install the same cel object into EVERY frame of the clip for a layer —
 * the linked-cel propagation path (C2: "every frame references the same
 * src"). Frames missing the cel gain it.
 */
export declare function setCelEverywhere(project: Project, clipId: string, layerId: string, cel: Cel): Project;
/**
 * Replace a cel's buffer, handling linked-cel propagation:
 *  - layer.linked → the new buffer is installed into all frames of the clip;
 *  - otherwise only the target frame's cel is replaced (created if absent).
 * Returns the new document, or null when clip/frame/layer no longer exist.
 */
export declare function replaceCelBuffer(project: Project, clipId: string, frameId: string, layerId: string, buffer: CellBuffer, linked: boolean): Project | null;
/** Push a trash entry, evicting the oldest beyond the cap (C5/C9, cap 20). */
export declare function pushTrash(project: Project, entry: TrashEntry): Project;
/** Remove a trash entry by id. Returns null when not found. */
export declare function takeTrash(project: Project, entryId: string): {
    project: Project;
    entry: TrashEntry;
} | null;
/** Fresh ids for structural commands. */
export declare const newLayerId: () => string;
export declare const newFrameId: () => string;
export declare const newClipId: () => string;
export declare const newPartId: () => string;
export declare const newTrashId: () => string;
