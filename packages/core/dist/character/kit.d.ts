export declare const CHARACTER_KIT_VERSION = "kit-1";
export declare const KIT_CANVAS = 32;
/** Rows the standing poses' feet touch; row 31 must stay transparent (margin). */
export declare const KIT_FOOT_BASELINE_Y = 30;
export declare const KIT_ROLE_HEX: Readonly<Record<string, string>>;
/** Snap a hex to the nearest project-palette entry (weighted RGB, stable tie-break). */
export declare function snapToPalette(hex: string, palette: readonly string[]): string;
export interface KitPartDef {
    id: string;
    label: string;
    grid: string[];
}
export declare const KIT_HEADS: readonly KitPartDef[];
export declare const KIT_OUTFITS: readonly KitPartDef[];
export declare const KIT_ITEMS: readonly KitPartDef[];
export interface KitPreset {
    id: string;
    label: string;
    headId: string;
    outfitId: string;
    itemId: string;
}
export declare const KIT_PRESETS: readonly KitPreset[];
export interface KitSelection {
    headId: string;
    outfitId: string;
    itemId: string;
}
export declare const KIT_DEFAULT_SELECTION: KitSelection;
/**
 * Layer + motion-part layout the character is inserted with. Part names are
 * the motion preset roles (unique per `part.set`); rects cover every opaque
 * pixel of their region so nothing on the Body layer is left static.
 */
export declare const KIT_LAYERS: readonly {
    name: string;
    grid: 'body' | 'outfit' | 'head' | 'item';
    parts: readonly {
        name: string;
        rect?: {
            x: number;
            y: number;
            w: number;
            h: number;
        };
    }[];
}[];
/** Fixed attachment points (pixels) shared by every part variant. */
export declare const KIT_ATTACHMENTS: Readonly<{
    headNeck: {
        x: number;
        y: number;
    };
    hand: {
        x: number;
        y: number;
    };
    footBaselineY: 30;
}>;
/** Throws a plain-language error for an unknown part id. */
export declare function validateKitSelection(selection: KitSelection): void;
export interface KitBuffers {
    body: Uint8ClampedArray;
    outfit: Uint8ClampedArray;
    head: Uint8ClampedArray;
    item: Uint8ClampedArray;
}
/** Compose the four layer buffers for a selection against a project palette. */
export declare function composeKitBuffers(selection: KitSelection, palette: readonly string[]): KitBuffers;
/** Full composited 32×32 RGBA preview (body → outfit → head → item). */
export declare function composeKitPreviewRgba(selection: KitSelection, palette: readonly string[]): Uint8ClampedArray;
export declare function kitSelectionFromPreset(presetId: string): KitSelection | null;
/** The clip name an inserted character uses (preset label or generic). */
export declare function kitSelectionLabel(selection: KitSelection): string;
export type KitBriefMatch = {
    kind: 'match';
    presetId: string;
    label: string;
} | {
    kind: 'none';
};
/** Match a free-text brief/prompt against the bundled characters. */
export declare function matchKitCharacter(prompt: string): KitBriefMatch;
/** What the kit supports — shown when a brief names an unsupported character. */
export declare function describeKit(): string;
