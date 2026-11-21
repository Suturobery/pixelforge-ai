import type { CommandBus } from '../bus/bus';
import type { CommandOrigin } from '../types/commands';
import { type KitSelection } from './kit';
export type KitLayerSlot = 'body' | 'outfit' | 'head' | 'item';
export interface CharacterInsertResult {
    clipId: string;
    layerIds: Record<KitLayerSlot, string>;
}
export interface CharacterInsertOptions {
    /** Clip name; defaults to the preset label (or "Character" for custom mixes). */
    clipName?: string;
    fps?: number;
    origin?: CommandOrigin;
}
/**
 * Insert the character as a new clip. Throws (document untouched) when the
 * selection is invalid or the canvas is not the kit's 32×32.
 */
export declare function insertCharacter(bus: CommandBus, selection: KitSelection, opts?: CharacterInsertOptions): CharacterInsertResult;
