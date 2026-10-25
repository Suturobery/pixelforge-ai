/**
 * Built-in structural commands (v3.1 §2.4/§2.7).
 *
 * Structural edits record shallow document snapshots with copy-on-write
 * buffers (prototype mechanism kept — §2.5), so undo/redo are exact.
 * Deletes are trash-backed (C5/C9, cap 20): frame/layer/clip deletion moves
 * the item into project.trash; `trash.restore` puts it back.
 *
 * All commands are pure: (document in) → (new document out).
 */
import type { LoopMode } from '../types/document';
import type { CommandDefinition } from '../types/commands';
interface RenamePayload {
    name: string;
}
export declare const projectRename: CommandDefinition<RenamePayload>;
export declare const clipAdd: CommandDefinition<{
    name?: string;
    fps?: number;
}>;
export declare const clipDelete: CommandDefinition<{
    clipId: string;
}>;
interface ClipSetPropsPayload {
    clipId: string;
    patch: {
        name?: string;
        fps?: number;
        loop?: boolean;
        loopMode?: LoopMode;
    };
}
export declare const clipSetProps: CommandDefinition<ClipSetPropsPayload>;
export declare const frameAdd: CommandDefinition<{
    clipId: string;
    afterIndex?: number;
    copy?: boolean;
}>;
export declare const frameDelete: CommandDefinition<{
    clipId: string;
    frameIndex: number;
}>;
export declare const frameMove: CommandDefinition<{
    clipId: string;
    from: number;
    to: number;
}>;
export declare const frameSetDuration: CommandDefinition<{
    clipId: string;
    frameId: string;
    durationMs: number;
}>;
export declare const layerAdd: CommandDefinition<{
    clipId: string;
    name?: string;
}>;
export declare const layerDelete: CommandDefinition<{
    clipId: string;
    layerId: string;
}>;
export declare const layerDuplicate: CommandDefinition<{
    clipId: string;
    layerId: string;
}>;
/**
 * Alpha compositing of the top cel onto the one below, per frame (ported
 * from the prototype store's mergeDown). The top layer is removed; the
 * operation is undoable via the structural snapshot, so it is not
 * trash-backed (documented deviation from delete semantics).
 */
export declare const layerMergeDown: CommandDefinition<{
    clipId: string;
    layerId: string;
}>;
export declare const layerMove: CommandDefinition<{
    clipId: string;
    layerId: string;
    dir: -1 | 1;
}>;
interface LayerSetPropsPayload {
    clipId: string;
    layerId: string;
    patch: {
        name?: string;
        visible?: boolean;
        opacity?: number;
    };
}
export declare const layerSetProps: CommandDefinition<LayerSetPropsPayload>;
/**
 * Linked-cel engine switch (C2/C19 — P0 engine support; UI toggle is P2).
 * ON  → pick the anchor frame's cel (first frame holding one) and share it
 *        across ALL frames (content of other frames collapses to the anchor).
 * OFF → break sharing: every frame gets an independent deep copy.
 */
export declare const layerSetLinked: CommandDefinition<{
    clipId: string;
    layerId: string;
    linked: boolean;
}>;
export declare const paletteAddColor: CommandDefinition<{
    hex: string;
}>;
export declare const paletteRemoveColor: CommandDefinition<{
    hex: string;
}>;
export declare const trashRestore: CommandDefinition<{
    entryId: string;
}>;
export declare const trashPurge: CommandDefinition<{
    entryId: string;
}>;
export declare const settingsSetOnion: CommandDefinition<{
    prev?: number;
    next?: number;
}>;
export declare function builtinCommands(): CommandDefinition<never>[];
export {};
