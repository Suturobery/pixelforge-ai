"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORMAT_VERSION = void 0;
exports.buildPixelforgeproj = buildPixelforgeproj;
exports.readPixelforgeproj = readPixelforgeproj;
const version_1 = require("../version");
const errors_1 = require("./errors");
const digest_1 = require("./digest");
const paths_1 = require("./paths");
const zip_1 = require("./zip");
exports.FORMAT_VERSION = 2;
async function buildPixelforgeproj(opts) {
    const now = (opts.now ?? new Date()).toISOString();
    const projectBytes = new TextEncoder().encode(JSON.stringify(opts.projectJson));
    const checksumItems = [
        { name: paths_1.PROJECT_ENTRY, data: projectBytes },
    ];
    for (const [src, png] of opts.celPngs) {
        checksumItems.push({ name: src, data: png });
    }
    const journalLines = opts.journalLines ?? [];
    if (journalLines.length > 0) {
        checksumItems.push({ name: paths_1.JOURNAL_ENTRY, data: new TextEncoder().encode(journalLines.join('\n') + '\n') });
    }
    const checksums = {};
    for (const item of checksumItems) {
        checksums[item.name] = await (0, digest_1.sha256Hex)(item.data);
    }
    const manifest = {
        formatVersion: exports.FORMAT_VERSION,
        appVersion: opts.appVersion ?? version_1.CORE_VERSION,
        createdAt: now,
        updatedAt: now,
        journalSeq: opts.journalSeq ?? 0,
        checksums,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const entries = [
        { name: paths_1.MANIFEST_ENTRY, data: manifestBytes },
        { name: paths_1.PROJECT_ENTRY, data: projectBytes },
        ...[...opts.celPngs.entries()].map(([name, data]) => ({ name, data })),
        ...(journalLines.length > 0
            ? [{ name: paths_1.JOURNAL_ENTRY, data: new TextEncoder().encode(journalLines.join('\n') + '\n') }]
            : []),
    ];
    return { bytes: (0, zip_1.zipWrite)(entries), manifest, projectJson: opts.projectJson };
}
/**
 * Parse + verify a .pixelforgeproj byte blob. Throws PersistError with a
 * precise code for every corruption class (BAD_ZIP / BAD_CHECKSUM /
 * UNSUPPORTED_VERSION / MISSING_ENTRY). Schema validation of project.json is
 * performed by the caller (schema.validateSerializedProjectV2OrThrow).
 */
async function readPixelforgeproj(bytes) {
    const archive = await (0, zip_1.zipRead)(bytes);
    const manifestBytes = archive.get(paths_1.MANIFEST_ENTRY);
    if (!manifestBytes) {
        throw new errors_1.PersistError('MISSING_ENTRY', `"${paths_1.MANIFEST_ENTRY}" is not in the archive`, { entry: paths_1.MANIFEST_ENTRY });
    }
    let manifest;
    try {
        manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    }
    catch (err) {
        throw new errors_1.PersistError('INVALID_SCHEMA', 'manifest.json is not valid JSON', { entry: paths_1.MANIFEST_ENTRY, cause: err });
    }
    if (manifest.formatVersion !== exports.FORMAT_VERSION) {
        throw new errors_1.PersistError('UNSUPPORTED_VERSION', `file declares formatVersion ${String(manifest.formatVersion)}; this build reads ${exports.FORMAT_VERSION} (and imports v1 projects via the importer)`, { entry: paths_1.MANIFEST_ENTRY });
    }
    const projectRaw = archive.get(paths_1.PROJECT_ENTRY);
    if (!projectRaw) {
        throw new errors_1.PersistError('MISSING_ENTRY', `"${paths_1.PROJECT_ENTRY}" is not in the archive`, { entry: paths_1.PROJECT_ENTRY });
    }
    // Verify every declared checksum (C5). Entries in the archive but missing
    // from the manifest are suspicious too.
    const declared = manifest.checksums ?? {};
    for (const name of archive.names) {
        if (name === paths_1.MANIFEST_ENTRY)
            continue;
        const expected = declared[name];
        if (!expected) {
            throw new errors_1.PersistError('BAD_CHECKSUM', `entry "${name}" has no manifest checksum`, { entry: name });
        }
    }
    for (const [name, expected] of Object.entries(declared)) {
        const data = archive.get(name);
        if (!data) {
            throw new errors_1.PersistError('MISSING_ENTRY', `manifest lists "${name}" but it is absent`, { entry: name });
        }
        const actual = await (0, digest_1.sha256Hex)(data);
        if (actual !== expected) {
            throw new errors_1.PersistError('BAD_CHECKSUM', `entry "${name}" failed SHA-256 verification`, { entry: name });
        }
    }
    let projectJson;
    try {
        projectJson = JSON.parse(new TextDecoder().decode(projectRaw));
    }
    catch (err) {
        throw new errors_1.PersistError('INVALID_SCHEMA', 'project.json is not valid JSON', { entry: paths_1.PROJECT_ENTRY, cause: err });
    }
    const journalRaw = archive.get(paths_1.JOURNAL_ENTRY);
    const journalLines = journalRaw
        ? new TextDecoder()
            .decode(journalRaw)
            .split('\n')
            .filter((line) => line.trim().length > 0)
        : [];
    return {
        manifest,
        projectJson,
        celBytes: (src) => archive.get(src),
        journalLines,
    };
}
