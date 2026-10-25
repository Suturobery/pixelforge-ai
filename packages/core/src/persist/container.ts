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

import { CORE_VERSION } from '../version';
import type { SerializedProjectV2 } from '../types/serialized';
import { PersistError } from './errors';
import { sha256Hex } from './digest';
import { JOURNAL_ENTRY, MANIFEST_ENTRY, PROJECT_ENTRY } from './paths';
import { zipRead, zipWrite, type ZipEntry } from './zip';

export const FORMAT_VERSION = 2 as const;

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

export async function buildPixelforgeproj(opts: BuildContainerOptions): Promise<BuiltContainer> {
  const now = (opts.now ?? new Date()).toISOString();
  const projectBytes = new TextEncoder().encode(JSON.stringify(opts.projectJson));

  const checksumItems: { name: string; data: Uint8Array }[] = [
    { name: PROJECT_ENTRY, data: projectBytes },
  ];
  for (const [src, png] of opts.celPngs) {
    checksumItems.push({ name: src, data: png });
  }
  const journalLines = opts.journalLines ?? [];
  if (journalLines.length > 0) {
    checksumItems.push({ name: JOURNAL_ENTRY, data: new TextEncoder().encode(journalLines.join('\n') + '\n') });
  }

  const checksums: Record<string, string> = {};
  for (const item of checksumItems) {
    checksums[item.name] = await sha256Hex(item.data);
  }

  const manifest: ManifestJson = {
    formatVersion: FORMAT_VERSION,
    appVersion: opts.appVersion ?? CORE_VERSION,
    createdAt: now,
    updatedAt: now,
    journalSeq: opts.journalSeq ?? 0,
    checksums,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const entries: ZipEntry[] = [
    { name: MANIFEST_ENTRY, data: manifestBytes },
    { name: PROJECT_ENTRY, data: projectBytes },
    ...[...opts.celPngs.entries()].map(([name, data]) => ({ name, data })),
    ...(journalLines.length > 0
      ? [{ name: JOURNAL_ENTRY, data: new TextEncoder().encode(journalLines.join('\n') + '\n') }]
      : []),
  ];

  return { bytes: zipWrite(entries), manifest, projectJson: opts.projectJson };
}

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
export async function readPixelforgeproj(bytes: Uint8Array): Promise<ReadContainerResult> {
  const archive = await zipRead(bytes);

  const manifestBytes = archive.get(MANIFEST_ENTRY);
  if (!manifestBytes) {
    throw new PersistError('MISSING_ENTRY', `"${MANIFEST_ENTRY}" is not in the archive`, { entry: MANIFEST_ENTRY });
  }
  let manifest: ManifestJson;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ManifestJson;
  } catch (err) {
    throw new PersistError('INVALID_SCHEMA', 'manifest.json is not valid JSON', { entry: MANIFEST_ENTRY, cause: err });
  }
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new PersistError(
      'UNSUPPORTED_VERSION',
      `file declares formatVersion ${String(manifest.formatVersion)}; this build reads ${FORMAT_VERSION} (and imports v1 projects via the importer)`,
      { entry: MANIFEST_ENTRY }
    );
  }

  const projectRaw = archive.get(PROJECT_ENTRY);
  if (!projectRaw) {
    throw new PersistError('MISSING_ENTRY', `"${PROJECT_ENTRY}" is not in the archive`, { entry: PROJECT_ENTRY });
  }

  // Verify every declared checksum (C5). Entries in the archive but missing
  // from the manifest are suspicious too.
  const declared = manifest.checksums ?? {};
  for (const name of archive.names) {
    if (name === MANIFEST_ENTRY) continue;
    const expected = declared[name];
    if (!expected) {
      throw new PersistError('BAD_CHECKSUM', `entry "${name}" has no manifest checksum`, { entry: name });
    }
  }
  for (const [name, expected] of Object.entries(declared)) {
    const data = archive.get(name);
    if (!data) {
      throw new PersistError('MISSING_ENTRY', `manifest lists "${name}" but it is absent`, { entry: name });
    }
    const actual = await sha256Hex(data);
    if (actual !== expected) {
      throw new PersistError('BAD_CHECKSUM', `entry "${name}" failed SHA-256 verification`, { entry: name });
    }
  }

  let projectJson: SerializedProjectV2;
  try {
    projectJson = JSON.parse(new TextDecoder().decode(projectRaw)) as SerializedProjectV2;
  } catch (err) {
    throw new PersistError('INVALID_SCHEMA', 'project.json is not valid JSON', { entry: PROJECT_ENTRY, cause: err });
  }

  const journalRaw = archive.get(JOURNAL_ENTRY);
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
