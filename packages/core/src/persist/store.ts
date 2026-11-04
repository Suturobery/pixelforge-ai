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
import { PersistError } from './errors';
import { buildPixelforgeproj, readPixelforgeproj, type ManifestJson } from './container';
import { JOURNAL_ENTRY } from './paths';
import { validateSerializedProjectV2OrThrow } from './schema';
import { serializeProjectV2, projectFromSerialized } from './serialize';
import {
  JournalRecorder,
  linesToRecords,
  recordsToLines,
  replayJournal,
  type JournalRecord,
  type ReplayResult,
} from './journal';

// ---------------------------------------------------------------------------
// filesystem adapter
// ---------------------------------------------------------------------------

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
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
}

function lastSepIndex(path: string): number {
  // Windows accepts both separators; derive dirs/stems from either
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

export function dirnameOf(path: string): string {
  const i = lastSepIndex(path);
  return i <= 0 ? '.' : path.slice(0, i);
}

function basenameOf(path: string): string {
  const i = lastSepIndex(path);
  return i >= 0 ? path.slice(i + 1) : path;
}

function stemOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

async function fsCall<T>(op: string, path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PersistError) throw err;
    throw new PersistError('FS_ERROR', `${op} failed for "${path}"`, { entry: path, cause: err });
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export function tmpPathFor(path: string): string {
  return `${path}.tmp`;
}
export function autosavePathFor(path: string): string {
  return `${path}.autosave.pixelforgeproj`;
}
export function journalPathFor(path: string): string {
  return `${path}.journal`;
}
export function backupsDirFor(path: string): string {
  return `${dirnameOf(path)}/backups`;
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

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
export async function buildArchive(
  project: Project,
  opts: SaveOptions = {}
): Promise<{ bytes: Uint8Array; manifest: ManifestJson; records: JournalRecord[] }> {
  const { projectJson, celPngs } = await serializeProjectV2(project);
  if (opts.validate !== false) {
    validateSerializedProjectV2OrThrow(projectJson);
  }
  const records = opts.recorder ? opts.recorder.all() : (opts.journalRecords ?? []);
  const journalLines = recordsToLines(records);
  const built = await buildPixelforgeproj({
    projectJson,
    celPngs,
    journalLines,
    journalSeq: opts.recorder ? opts.recorder.lastSeq : (records.at(-1)?.seq ?? 0),
    now: opts.now,
    appVersion: opts.appVersion,
  });
  return { bytes: built.bytes, manifest: built.manifest, records };
}

/**
 * Atomic save with backup rotation. The document is serialized first so a
 * serialization failure never touches the file.
 */
export async function savePixelforgeproj(
  fs: FileFs,
  path: string,
  project: Project,
  opts: SaveOptions = {}
): Promise<SaveResult> {
  const { bytes, manifest, records } = await buildArchive(project, opts);

  let backupPath: string | undefined;
  if (!opts.noBackup && (opts.keepBackups ?? 5) > 0 && (await fsCall('exists', path, () => fs.exists(path)))) {
    backupPath = await createBackup(fs, path, { keep: opts.keepBackups ?? 5, now: opts.now });
  }

  const tmp = tmpPathFor(path);
  await fsCall('write', tmp, () => fs.writeFile(tmp, bytes));
  await fsCall('rename', tmp, () => fs.rename(tmp, path));

  // Sidecar journal mirrors the embedded ring (recovery source for commands
  // issued AFTER this save).
  const sidecar = journalPathFor(path);
  if (records.length > 0) {
    await fsCall('write', sidecar, () =>
      fs.writeFile(sidecar, new TextEncoder().encode(recordsToLines(records).join('\n') + '\n'))
    );
  } else if (await fsCall('exists', sidecar, () => fs.exists(sidecar))) {
    await fsCall('unlink', sidecar, () => fs.unlink(sidecar));
  }

  return { bytes: bytes.length, manifest, backupPath };
}

/** Autosave (C6): same atomic path, no backups, never touches the sidecar. */
export async function saveAutosave(
  fs: FileFs,
  path: string,
  project: Project,
  opts: SaveOptions = {}
): Promise<SaveResult> {
  const target = autosavePathFor(path);
  const { bytes, manifest } = await buildArchive(project, opts);
  const tmp = tmpPathFor(target);
  await fsCall('write', tmp, () => fs.writeFile(tmp, bytes));
  await fsCall('rename', tmp, () => fs.rename(tmp, target));
  return { bytes: bytes.length, manifest };
}

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

export async function createBackup(
  fs: FileFs,
  path: string,
  opts: { keep?: number; now?: Date } = {}
): Promise<string> {
  const dir = backupsDirFor(path);
  await fsCall('mkdir', dir, () => fs.mkdir(dir));
  const current = await fsCall('read', path, () => fs.readFile(path));
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dir}/${stemOf(path)}-${stamp}.pixelforgeproj`;
  await fsCall('write', backupPath, () => fs.writeFile(backupPath, current));
  await rotateBackups(fs, path, opts.keep ?? 5);
  return backupPath;
}

/** Delete the oldest backups beyond `keep` (sorted by name = timestamp). */
export async function rotateBackups(fs: FileFs, path: string, keep: number): Promise<void> {
  if (keep <= 0) return;
  const dir = backupsDirFor(path);
  if (!(await fsCall('exists', dir, () => fs.exists(dir)))) return;
  const prefix = `${stemOf(path)}-`;
  const names = (await fsCall('listDir', dir, () => fs.listDir(dir)))
    .filter((n) => n.startsWith(prefix) && n.endsWith('.pixelforgeproj'))
    .sort();
  const excess = names.length - keep;
  for (let i = 0; i < excess; i++) {
    await fsCall('unlink', `${dir}/${names[i]}`, () => fs.unlink(`${dir}/${names[i]}`));
  }
}

export async function listBackups(fs: FileFs, path: string): Promise<string[]> {
  const dir = backupsDirFor(path);
  if (!(await fsCall('exists', dir, () => fs.exists(dir)))) return [];
  const prefix = `${stemOf(path)}-`;
  return (await fsCall('listDir', dir, () => fs.listDir(dir)))
    .filter((n) => n.startsWith(prefix) && n.endsWith('.pixelforgeproj'))
    .sort();
}

// ---------------------------------------------------------------------------
// load + recovery
// ---------------------------------------------------------------------------

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
export async function inspectRecovery(fs: FileFs, path: string): Promise<RecoveryInfo> {
  const mainExists = await fsCall('exists', path, () => fs.exists(path));
  const autosavePath = autosavePathFor(path);
  const autosaveExists = await fsCall('exists', autosavePath, () => fs.exists(autosavePath));
  const mainStat = mainExists ? await fsCall('stat', path, () => fs.stat(path)) : null;
  const autosaveStat = autosaveExists ? await fsCall('stat', autosavePath, () => fs.stat(autosavePath)) : null;

  let pendingRecords: JournalRecord[] = [];
  let sidecarCorruptLines = 0;
  const sidecarPath = journalPathFor(path);
  if (await fsCall('exists', sidecarPath, () => fs.exists(sidecarPath))) {
    const raw = await fsCall('read', sidecarPath, () => fs.readFile(sidecarPath));
    const parsed = linesToRecords(new TextDecoder().decode(raw).split('\n'));
    sidecarCorruptLines = parsed.corruptLines;
    let horizon = 0;
    if (mainExists) {
      try {
        const bytes = await fsCall('read', path, () => fs.readFile(path));
        const container = await readPixelforgeproj(bytes);
        horizon = container.manifest.journalSeq;
      } catch {
        horizon = 0; // main unreadable → every sidecar record is pending
      }
    }
    pendingRecords = parsed.records.filter((r) => r.seq > horizon);
  }

  return {
    mainExists,
    autosaveExists,
    autosaveNewerThanMain: !!autosaveStat && !!mainStat && autosaveStat.mtimeMs > mainStat.mtimeMs,
    mainMtimeMs: mainStat?.mtimeMs,
    autosaveMtimeMs: autosaveStat?.mtimeMs,
    pendingRecords,
    sidecarCorruptLines,
  };
}

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
export async function loadPixelforgeproj(fs: FileFs, path: string, opts: LoadOptions = {}): Promise<LoadResult> {
  if (!(await fsCall('exists', path, () => fs.exists(path)))) {
    throw new PersistError('NOT_FOUND', path, { entry: path });
  }
  const bytes = await fsCall('read', path, () => fs.readFile(path));
  const container = await readPixelforgeproj(bytes);
  if (opts.validate !== false) {
    validateSerializedProjectV2OrThrow(container.projectJson);
  }
  const project = await projectFromSerialized(container.projectJson, container.celBytes, { id: opts.id ?? null });
  const recovery = await inspectRecovery(fs, path);

  const warnings: string[] = [];
  if (recovery.pendingRecords.length > 0) {
    warnings.push(
      `journal holds ${recovery.pendingRecords.length} command(s) newer than the file — replay available`
    );
  }
  if (recovery.autosaveExists && recovery.autosaveNewerThanMain) {
    warnings.push('an autosave newer than the main file exists');
  }
  if (recovery.sidecarCorruptLines > 0) {
    warnings.push(`${recovery.sidecarCorruptLines} corrupt journal line(s) skipped`);
  }

  return {
    project,
    manifest: container.manifest,
    warnings,
    recovery,
    replayPending: () => {
      const result = replayJournal(project, recovery.pendingRecords);
      recovery.pendingRecords = [];
      return result;
    },
  };
}

/** Load the embedded journal (history/journal.jsonl) — provenance foundation. */
export async function readEmbeddedJournal(
  fs: FileFs,
  path: string
): Promise<{ records: JournalRecord[]; corruptLines: number }> {
  const bytes = await fsCall('read', path, () => fs.readFile(path));
  const container = await readPixelforgeproj(bytes);
  if (!container.celBytes(JOURNAL_ENTRY) && !container.journalLines.length) {
    return { records: [], corruptLines: 0 };
  }
  return linesToRecords(container.journalLines);
}
