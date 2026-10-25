/**
 * .pixelforgeproj container build/read (v3.1 §6).
 *
 * Layout (deterministic entry order):
 *   manifest.json            { formatVersion, appVersion, createdAt, updatedAt,
 *                              journalSeq, checksums: { entry → sha256 } }
 *   project.json             SerializedProjectV2
 *   cels/…, trash/…          cel PNGs (from serializeProjectV2)
 *   history/journal.jsonl    recent commands (crash recovery / provenance)
 *
 * Read path enforces: formatVersion gate (forward-read refusal, §13),
 * per-entry SHA-256 checksums (C5), required entries, and hands the raw
 * project.json to the schema validator before materialization.
 */
import type { SerializedProjectV2 } from '../types/serialized';
export declare const FORMAT_VERSION: 2;
export interface ManifestJson {
    formatVersion: typeof FORMAT_VERSION;
    appVersion: string;
    createdAt: string;
    updatedAt: string;
    /** Sequence number of the last journal record embedded at save time. */
    journalSeq: number;
    checksums: Record<string, string>;
}
export interface BuiltContainer {
    bytes: Uint8Array;
    manifest: ManifestJson;
    projectJson: SerializedProjectV2;
}
export interface BuildContainerOptions {
    projectJson: SerializedProjectV2;
    celPngs: Map<string, Uint8Array>;
    /** Journal records (JSONL lines, newest last) to embed. */
    journalLines?: string[];
    /** Sequence of the last journal record embedded (0 when none). */
    journalSeq?: number;
    now?: Date;
    appVersion?: string;
}
export declare function buildPixelforgeproj(opts: BuildContainerOptions): Promise<BuiltContainer>;
export interface ReadContainerResult {
    manifest: ManifestJson;
    projectJson: SerializedProjectV2;
    /** Returns PNG bytes for a cel src, or undefined when absent. */
    celBytes: (src: string) => Uint8Array | undefined;
    journalLines: string[];
}
/**
 * Parse + verify a .pixelforgeproj byte blob. Throws PersistError with a
 * precise code for every corruption class (BAD_ZIP / BAD_CHECKSUM /
 * UNSUPPORTED_VERSION / MISSING_ENTRY). Schema validation of project.json is
 * performed by the caller (schema.validateSerializedProjectV2OrThrow).
 */
export declare function readPixelforgeproj(bytes: Uint8Array): Promise<ReadContainerResult>;
