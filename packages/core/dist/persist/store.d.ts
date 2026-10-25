/**
 * .pixelforgeproj file store (v3.1 §6 "Atomic save / Autosave (C6) / Backups",
 * §9.3 recovery) over an injectable, minimal file-system adapter.
 *
 * The core stays environment-neutral (§8.3): Electron main supplies a
 * node:fs adapter, tests supply MemoryFs. Every write is atomic:
 *   1. build the full archive bytes,
 *   2. write to <path>.tmp,
 *   3. rename over the target — a crash at ANY point leaves either the old
 *      or the new file intact, never a half-written one.
 *
 * Backups: before an overwrite, the previous file is copied to
 * <dir>/backups/<stem>-<timestamp>.pixelforgeproj and rotation keeps the
 * newest N (default 5, §6).
 *
 * Journal: a sidecar <file>.journal mirrors the recorder ring (JSONL). At
 * save time the ring is embedded (history/journal.jsonl, manifest.journalSeq
 * stamps the embedded horizon); recovery = sidecar records with
 * seq > manifest.journalSeq, replayed through the bus.
 *
 * Autosave: <file>.autosave.pixelforgeproj via the same temp+rename path;
 * recovery inspection reports whether it is newer than the main file.
 */
import type { Project } from '../types/document';
import { type ManifestJson } from './container';
import { JournalRecorder, type JournalRecord, type ReplayResult } from './journal';
export interface FileFs {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Recursive mkdir. */
    mkdir(path: string): Promise<void>;
    /** Names of entries in a directory (files only is acceptable). */
    listDir(path: string): Promise<string[]>;
    stat(path: string): Promise<{
        mtimeMs: number;
        size: number;
    } | null>;
}
export declare function dirnameOf(path: string): string;
export declare function tmpPathFor(path: string): string;
export declare function autosavePathFor(path: string): string;
export declare function journalPathFor(path: string): string;
export declare function backupsDirFor(path: string): string;
export interface SaveOptions {
    appVersion?: string;
    /** Recorder whose ring is embedded + flushed to the sidecar. */
    recorder?: JournalRecorder;
    /** Explicit records override (when no recorder is attached). */
    journalRecords?: JournalRecord[];
    /** Keep N backups (default 5, 0 disables backups). */
    keepBackups?: number;
    now?: Date;
    /** Validate the serialized document before writing (default true). */
    validate?: boolean;
    /** Skip the pre-overwrite backup (used by autosave). */
    noBackup?: boolean;
}
export interface SaveResult {
    bytes: number;
    manifest: ManifestJson;
    backupPath?: string;
}
/** Build archive bytes for a project (shared by save + autosave). */
export declare function buildArchive(project: Project, opts?: SaveOptions): Promise<{
    bytes: Uint8Array;
    manifest: ManifestJson;
    records: JournalRecord[];
}>;
/**
 * Atomic save with backup rotation. The document is serialized first so a
 * serialization failure never touches the file.
 */
export declare function savePixelforgeproj(fs: FileFs, path: string, project: Project, opts?: SaveOptions): Promise<SaveResult>;
/** Autosave (C6): same atomic path, no backups, never touches the sidecar. */
export declare function saveAutosave(fs: FileFs, path: string, project: Project, opts?: SaveOptions): Promise<SaveResult>;
export declare function createBackup(fs: FileFs, path: string, opts?: {
    keep?: number;
    now?: Date;
}): Promise<string>;
/** Delete the oldest backups beyond `keep` (sorted by name = timestamp). */
export declare function rotateBackups(fs: FileFs, path: string, keep: number): Promise<void>;
export declare function listBackups(fs: FileFs, path: string): Promise<string[]>;
export interface RecoveryInfo {
    mainExists: boolean;
    autosaveExists: boolean;
    autosaveNewerThanMain: boolean;
    mainMtimeMs?: number;
    autosaveMtimeMs?: number;
    /** Journal records newer than the embedded horizon (candidates for replay). */
    pendingRecords: JournalRecord[];
    sidecarCorruptLines: number;
}
export interface LoadResult {
    project: Project;
    manifest: ManifestJson;
    warnings: string[];
    recovery: RecoveryInfo;
    /** Convenience one-call replay of pendingRecords (empty → no-op). */
    replayPending(): ReplayResult;
}
/** Inspect a project file's recovery state without decoding cels twice. */
export declare function inspectRecovery(fs: FileFs, path: string): Promise<RecoveryInfo>;
export interface LoadOptions {
    id?: string | null;
    /** Validate schema strictly before materializing (default true). */
    validate?: boolean;
}
/**
 * Load + fully decode a .pixelforgeproj. Corruption surfaces as typed
 * PersistError codes; recovery state is returned for the caller to act on
 * (replay pending commands, offer the autosave, offer backups).
 */
export declare function loadPixelforgeproj(fs: FileFs, path: string, opts?: LoadOptions): Promise<LoadResult>;
/** Load the embedded journal (history/journal.jsonl) — provenance foundation. */
export declare function readEmbeddedJournal(fs: FileFs, path: string): Promise<{
    records: JournalRecord[];
    corruptLines: number;
}>;
