"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.dirnameOf = dirnameOf;
exports.tmpPathFor = tmpPathFor;
exports.autosavePathFor = autosavePathFor;
exports.journalPathFor = journalPathFor;
exports.backupsDirFor = backupsDirFor;
exports.buildArchive = buildArchive;
exports.savePixelforgeproj = savePixelforgeproj;
exports.saveAutosave = saveAutosave;
exports.createBackup = createBackup;
exports.rotateBackups = rotateBackups;
exports.listBackups = listBackups;
exports.inspectRecovery = inspectRecovery;
exports.loadPixelforgeproj = loadPixelforgeproj;
exports.readEmbeddedJournal = readEmbeddedJournal;
const errors_1 = require("./errors");
const container_1 = require("./container");
const paths_1 = require("./paths");
const schema_1 = require("./schema");
const serialize_1 = require("./serialize");
const journal_1 = require("./journal");
function dirnameOf(path) {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '.' : path.slice(0, i);
}
function basenameOf(path) {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}
function stemOf(path) {
    const base = basenameOf(path);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}
async function fsCall(op, path, fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (err instanceof errors_1.PersistError)
            throw err;
        throw new errors_1.PersistError('FS_ERROR', `${op} failed for "${path}"`, { entry: path, cause: err });
    }
}
// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------
function tmpPathFor(path) {
    return `${path}.tmp`;
}
function autosavePathFor(path) {
    return `${path}.autosave.pixelforgeproj`;
}
function journalPathFor(path) {
    return `${path}.journal`;
}
function backupsDirFor(path) {
    return `${dirnameOf(path)}/backups`;
}
/** Build archive bytes for a project (shared by save + autosave). */
async function buildArchive(project, opts = {}) {
    const { projectJson, celPngs } = await (0, serialize_1.serializeProjectV2)(project);
    if (opts.validate !== false) {
        (0, schema_1.validateSerializedProjectV2OrThrow)(projectJson);
    }
    const records = opts.recorder ? opts.recorder.all() : (opts.journalRecords ?? []);
    const journalLines = (0, journal_1.recordsToLines)(records);
    const built = await (0, container_1.buildPixelforgeproj)({
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
async function savePixelforgeproj(fs, path, project, opts = {}) {
    const { bytes, manifest, records } = await buildArchive(project, opts);
    let backupPath;
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
        await fsCall('write', sidecar, () => fs.writeFile(sidecar, new TextEncoder().encode((0, journal_1.recordsToLines)(records).join('\n') + '\n')));
    }
    else if (await fsCall('exists', sidecar, () => fs.exists(sidecar))) {
        await fsCall('unlink', sidecar, () => fs.unlink(sidecar));
    }
    return { bytes: bytes.length, manifest, backupPath };
}
/** Autosave (C6): same atomic path, no backups, never touches the sidecar. */
async function saveAutosave(fs, path, project, opts = {}) {
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
async function createBackup(fs, path, opts = {}) {
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
async function rotateBackups(fs, path, keep) {
    if (keep <= 0)
        return;
    const dir = backupsDirFor(path);
    if (!(await fsCall('exists', dir, () => fs.exists(dir))))
        return;
    const prefix = `${stemOf(path)}-`;
    const names = (await fsCall('listDir', dir, () => fs.listDir(dir)))
        .filter((n) => n.startsWith(prefix) && n.endsWith('.pixelforgeproj'))
        .sort();
    const excess = names.length - keep;
    for (let i = 0; i < excess; i++) {
        await fsCall('unlink', `${dir}/${names[i]}`, () => fs.unlink(`${dir}/${names[i]}`));
    }
}
async function listBackups(fs, path) {
    const dir = backupsDirFor(path);
    if (!(await fsCall('exists', dir, () => fs.exists(dir))))
        return [];
    const prefix = `${stemOf(path)}-`;
    return (await fsCall('listDir', dir, () => fs.listDir(dir)))
        .filter((n) => n.startsWith(prefix) && n.endsWith('.pixelforgeproj'))
        .sort();
}
/** Inspect a project file's recovery state without decoding cels twice. */
async function inspectRecovery(fs, path) {
    const mainExists = await fsCall('exists', path, () => fs.exists(path));
    const autosavePath = autosavePathFor(path);
    const autosaveExists = await fsCall('exists', autosavePath, () => fs.exists(autosavePath));
    const mainStat = mainExists ? await fsCall('stat', path, () => fs.stat(path)) : null;
    const autosaveStat = autosaveExists ? await fsCall('stat', autosavePath, () => fs.stat(autosavePath)) : null;
    let pendingRecords = [];
    let sidecarCorruptLines = 0;
    const sidecarPath = journalPathFor(path);
    if (await fsCall('exists', sidecarPath, () => fs.exists(sidecarPath))) {
        const raw = await fsCall('read', sidecarPath, () => fs.readFile(sidecarPath));
        const parsed = (0, journal_1.linesToRecords)(new TextDecoder().decode(raw).split('\n'));
        sidecarCorruptLines = parsed.corruptLines;
        let horizon = 0;
        if (mainExists) {
            try {
                const bytes = await fsCall('read', path, () => fs.readFile(path));
                const container = await (0, container_1.readPixelforgeproj)(bytes);
                horizon = container.manifest.journalSeq;
            }
            catch {
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
/**
 * Load + fully decode a .pixelforgeproj. Corruption surfaces as typed
 * PersistError codes; recovery state is returned for the caller to act on
 * (replay pending commands, offer the autosave, offer backups).
 */
async function loadPixelforgeproj(fs, path, opts = {}) {
    if (!(await fsCall('exists', path, () => fs.exists(path)))) {
        throw new errors_1.PersistError('NOT_FOUND', path, { entry: path });
    }
    const bytes = await fsCall('read', path, () => fs.readFile(path));
    const container = await (0, container_1.readPixelforgeproj)(bytes);
    if (opts.validate !== false) {
        (0, schema_1.validateSerializedProjectV2OrThrow)(container.projectJson);
    }
    const project = await (0, serialize_1.projectFromSerialized)(container.projectJson, container.celBytes, { id: opts.id ?? null });
    const recovery = await inspectRecovery(fs, path);
    const warnings = [];
    if (recovery.pendingRecords.length > 0) {
        warnings.push(`journal holds ${recovery.pendingRecords.length} command(s) newer than the file — replay available`);
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
            const result = (0, journal_1.replayJournal)(project, recovery.pendingRecords);
            recovery.pendingRecords = [];
            return result;
        },
    };
}
/** Load the embedded journal (history/journal.jsonl) — provenance foundation. */
async function readEmbeddedJournal(fs, path) {
    const bytes = await fsCall('read', path, () => fs.readFile(path));
    const container = await (0, container_1.readPixelforgeproj)(bytes);
    if (!container.celBytes(paths_1.JOURNAL_ENTRY) && !container.journalLines.length) {
        return { records: [], corruptLines: 0 };
    }
    return (0, journal_1.linesToRecords)(container.journalLines);
}
