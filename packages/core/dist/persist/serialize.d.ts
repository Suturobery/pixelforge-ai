/**
 * Runtime ⇄ serialized v2 conversion (v3.1 §6 "project.json" + cel PNGs).
 *
 * serializeProjectV2: runtime Project → { projectJson, celPngs }.
 *   - Linked layers (C2) encode ONE shared PNG per layer
 *     (cels/<clipId>/shared/<layerId>.png); every frame references it.
 *   - Trash payloads (C5/C9) serialize under trash/<entryIndex>/….
 *   - Buffer identity is deduped (same Uint8ClampedArray object encodes once).
 *
 * projectFromSerialized: { projectJson, celBytes } → runtime Project.
 *   - Decodes each PNG once per unique src (cache).
 *   - RE-SHARES linked cels: every frame of a linked layer receives the SAME
 *     buffer object, restoring "edit once applies everywhere" exactly.
 *
 * Both directions are lossless: save → load deep-equals the original
 * (verified by persist-format tests), including trash and linked identity.
 */
import type { Project } from '../types/document';
import type { SerializedProjectV2 } from '../types/serialized';
export interface SerializedWithCels {
    projectJson: SerializedProjectV2;
    /** src path → PNG bytes (every src referenced by projectJson is present). */
    celPngs: Map<string, Uint8Array>;
}
export declare function serializeProjectV2(project: Project): Promise<SerializedWithCels>;
/** Supplies PNG bytes for a cel src (from a ZIP archive or any source). */
export type CelBytesProvider = (src: string) => Uint8Array | undefined;
export declare function projectFromSerialized(doc: SerializedProjectV2, celBytes: CelBytesProvider, opts?: {
    id?: string | null;
}): Promise<Project>;
