/**
 * Cel source path helpers (v3.1 §6 layout):
 *
 *   cels/<clipId>/<frameId>/<layerId>.png        — per-frame cel
 *   cels/<clipId>/shared/<layerId>.png           — linked cel, stored once (C2)
 *   trash/<entryIndex>/…                          — trash payload cels
 *
 * Paths are always forward-slash, always relative, and validated on read —
 * the same traversal rules as ZIP entry names apply (§9.4).
 */
/** True when the id is safe to embed in a cel path. */
export declare function isSafeId(id: string): boolean;
export declare function celSrc(clipId: string, frameId: string, layerId: string): string;
export declare function sharedCelSrc(clipId: string, layerId: string): string;
export declare function trashCelSrc(entryIndex: number, frameId: string, layerId: string): string;
export declare function trashClipCelSrc(entryIndex: number, clipId: string, frameId: string, layerId: string): string;
export declare const JOURNAL_ENTRY = "history/journal.jsonl";
export declare const PROJECT_ENTRY = "project.json";
export declare const MANIFEST_ENTRY = "manifest.json";
/** Validate a cel src from an untrusted document (read path). */
export declare function assertSafeCelSrc(src: string): void;
