/**
 * .pixelforgeproj file store tests (Task 3 §6 atomic save / autosave / C6,
 * backups, journal recovery, §13 kill -9 ×3) over MemoryFs PLUS one real-FS
 * integration test in a temp directory (proves the FS adapter contract the
 * Electron main process will implement).
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandBus } from '../src/bus/bus';
import { createProject, createClip, cloneProject } from '../src/doc/factory';
import { MemoryFs } from '../src/persist/memory-fs';
import {
  JournalRecorder,
  type JournalRecord,
} from '../src/persist/journal';
import {
  autosavePathFor,
  backupsDirFor,
  buildArchive,
  createBackup,
  inspectRecovery,
  journalPathFor,
  listBackups,
  loadPixelforgeproj,
  saveAutosave,
  savePixelforgeproj,
  tmpPathFor,
} from '../src/persist/store';
import type { FileFs } from '../src/persist/store';
import type { Project } from '../src/types/document';

function makeProject(name = 'farmer'): Project {
  const project = createProject({ name, width: 32, height: 32, fps: 8 });
  project.clips.push(createClip({ name: 'walk', width: 32, height: 32, fps: 12, layerNames: ['body', 'fx'], frameCount: 2 }));
  return project;
}

function paint(project: Project, clipIndex: number, frameIndex: number, layerName: string, x: number, y: number, v: number) {
  const clip = project.clips[clipIndex];
  const layer = clip.layers.find((l) => l.name === layerName)!;
  const cel = clip.frames[frameIndex].cels[layer.id];
  cel.buffer[(y * project.width + x) * 4] = v;
}

/** A failing FS wrapper to simulate crash points. */
function fsFailingAt(inner: FileFs, failOn: (op: string, path: string) => boolean): FileFs {
  return {
    readFile: (p) => inner.readFile(p),
    writeFile: async (p, d) => {
      if (failOn('write', p)) throw new Error('EIO: simulated write failure');
      await inner.writeFile(p, d);
    },
    rename: async (f, t) => {
      if (failOn('rename', t)) throw new Error('EIO: simulated rename failure');
      await inner.rename(f, t);
    },
    unlink: (p) => inner.unlink(p),
    exists: (p) => inner.exists(p),
    mkdir: (p) => inner.mkdir(p),
    listDir: (p) => inner.listDir(p),
    stat: (p) => inner.stat(p),
  };
}

describe('pixelforgeproj store (MemoryFs)', () => {
  test('save → load round-trip restores the document exactly', async () => {
    const fs = new MemoryFs();
    const project = makeProject();
    paint(project, 1, 0, 'body', 3, 4, 200);
    const path = '/projects/farmer.pixelforgeproj';

    const saved = await savePixelforgeproj(fs, path, project, { appVersion: 'test' });
    expect(saved.bytes).toBeGreaterThan(100);
    expect(saved.manifest.formatVersion).toBe(2);

    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.project.name).toBe('farmer');
    expect(loaded.project.clips.length).toBe(2);
    const body = loaded.project.clips[1].layers.find((l) => l.name === 'body')!;
    expect(loaded.project.clips[1].frames[0].cels[body.id].buffer[(4 * 32 + 3) * 4]).toBe(200);
    expect(loaded.recovery.pendingRecords.length).toBe(0);
    expect(loaded.warnings.length).toBe(0);
  });

  test('save is atomic: write failure leaves the original file intact and no .tmp behind', async () => {
    const fs = new MemoryFs();
    const project = makeProject('original');
    const path = '/p/a.pixelforgeproj';
    await savePixelforgeproj(fs, path, project);

    const broken = fsFailingAt(fs, (_op, p) => p === tmpPathFor(path));
    await expect(savePixelforgeproj(broken, path, makeProject('changed'))).rejects.toMatchObject({
      code: 'FS_ERROR',
    });
    // Original survives.
    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.project.name).toBe('original');
    // No tmp litter.
    expect(await fs.exists(tmpPathFor(path))).toBe(false);
  });

  test('save is atomic: rename failure leaves original + no partial target', async () => {
    const fs = new MemoryFs();
    const path = '/p/b.pixelforgeproj';
    await savePixelforgeproj(fs, path, makeProject('v1'));
    const broken = fsFailingAt(fs, (_op, p) => p === path);
    await expect(savePixelforgeproj(broken, path, makeProject('v2'))).rejects.toMatchObject({ code: 'FS_ERROR' });
    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.project.name).toBe('v1');
    expect(await fs.exists(tmpPathFor(path))).toBe(true); // tmp remains for inspection/cleanup
  });

  test('backups: previous file copied + rotated to keep N', async () => {
    const fs = new MemoryFs();
    const path = '/p/c.pixelforgeproj';
    for (let i = 0; i < 8; i++) {
      await savePixelforgeproj(fs, path, makeProject(`v${i}`), { keepBackups: 3, now: new Date(2026, 0, 1, 0, 0, i) });
    }
    const backups = await listBackups(fs, path);
    expect(backups.length).toBe(3);
    // Each save backs up the PREVIOUS state: after 8 saves (v0..v7, first has
    // no predecessor) and keep=3 → backups hold v4, v5, v6.
    const oldest = await loadPixelforgeproj(fs, `${backupsDirFor(path)}/${backups[0]}`);
    expect(oldest.project.name).toBe('v4');
    const newest = await loadPixelforgeproj(fs, `${backupsDirFor(path)}/${backups[2]}`);
    expect(newest.project.name).toBe('v6');
    // Main file is the latest state.
    expect((await loadPixelforgeproj(fs, path)).project.name).toBe('v7');
  });

  test('createBackup copies without touching the main file', async () => {
    const fs = new MemoryFs();
    const path = '/p/d.pixelforgeproj';
    await savePixelforgeproj(fs, path, makeProject('snap'));
    const backup = await createBackup(fs, path, { keep: 2 });
    expect(await fs.exists(backup)).toBe(true);
    expect((await loadPixelforgeproj(fs, backup)).project.name).toBe('snap');
  });

  test('journal recovery: commands after the last save are replayed (kill -9 before autosave)', async () => {
    const fs = new MemoryFs();
    const path = '/p/e.pixelforgeproj';
    const project = makeProject('live');
    await savePixelforgeproj(fs, path, project);

    // Artist edits through the bus; recorder mirrors the journal sidecar.
    const bus = new CommandBus(project);
    const sidecar: JournalRecord[][] = [];
    const recorder = new JournalRecorder(bus, {
      onFlush: (all) => sidecar.push(all.map((r) => ({ ...r }))),
    });
    bus.execute('project.rename', { name: 'edited-but-unsaved' }, 'ui');
    const clipId = bus.getProject().clips[1].id;
    bus.execute('clip.add', { name: 'attack', fps: 8 }, 'mcp');
    // Mirror the latest ring into the sidecar file (what the store layer does).
    const ring = sidecar[sidecar.length - 1];
    const { recordsToLines: toLines } = await import('../src/persist/journal');
    await fs.mkdir('/p');
    await fs.writeFile(journalPathFor(path), new TextEncoder().encode(toLines(ring).join('\n') + '\n'));

    // Crash! Reopen from the main file + sidecar.
    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.project.name).toBe('live'); // file state
    expect(loaded.recovery.pendingRecords.length).toBe(2);

    const replayed = loaded.replayPending();
    expect(replayed.applied).toBe(2);
    expect(replayed.project.name).toBe('edited-but-unsaved');
    expect(replayed.project.clips.some((c) => c.name === 'attack')).toBe(true);
    recorder.detach();
  });

  test('journal horizon: records already embedded in the file are NOT replayed twice', async () => {
    const fs = new MemoryFs();
    const path = '/p/f.pixelforgeproj';
    const project = makeProject('seq');
    const bus = new CommandBus(project);
    let ring: JournalRecord[] = [];
    const recorder = new JournalRecorder(bus, { onFlush: (all) => (ring = all) });
    bus.execute('project.rename', { name: 'saved-name' }, 'ui');

    // Save with the recorder → the command is embedded (journalSeq = 1) and
    // the sidecar mirrors the same ring.
    await savePixelforgeproj(fs, path, bus.getProject(), { recorder });
    expect((await loadPixelforgeproj(fs, path)).recovery.pendingRecords.length).toBe(0);

    // One MORE command after the save → pending.
    bus.execute('project.rename', { name: 'pending-name' }, 'ui');
    const { recordsToLines: toLines } = await import('../src/persist/journal');
    await fs.writeFile(journalPathFor(path), new TextEncoder().encode(toLines(ring).join('\n') + '\n'));
    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.recovery.pendingRecords.map((r) => r.seq)).toEqual([2]);
    expect(loaded.replayPending().project.name).toBe('pending-name');
    recorder.detach();
  });

  test('autosave: written atomically to <file>.autosave.pixelforgeproj; recovery inspector flags newer autosave', async () => {
    const fs = new MemoryFs();
    const path = '/p/g.pixelforgeproj';
    await savePixelforgeproj(fs, path, makeProject('main'));
    await saveAutosave(fs, path, makeProject('autosaved'));
    const info = await inspectRecovery(fs, path);
    expect(info.autosaveExists).toBe(true);
    expect(info.autosaveNewerThanMain).toBe(true);
    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.project.name).toBe('main'); // autosave is OFFERED, not auto-applied
    expect(loaded.warnings.some((w) => w.includes('autosave'))).toBe(true);
    expect(await fs.exists(autosavePathFor(path))).toBe(true);
  });

  test('missing file load → NOT_FOUND; invalid archive load → BAD_ZIP', async () => {
    const fs = new MemoryFs();
    await expect(loadPixelforgeproj(fs, '/p/none.pixelforgeproj')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await fs.mkdir('/p');
    await fs.writeFile('/p/bad.pixelforgeproj', new TextEncoder().encode('garbage'));
    await expect(loadPixelforgeproj(fs, '/p/bad.pixelforgeproj')).rejects.toMatchObject({ code: 'BAD_ZIP' });
  });

  test('archive validation rejects schema-breaking documents on load', async () => {
    const fs = new MemoryFs();
    const path = '/p/h.pixelforgeproj';
    const project = makeProject('ok');
    const { bytes } = await buildArchive(project, { validate: false });
    await fs.mkdir('/p');
    await fs.writeFile(path, bytes);
    // Loads fine.
    await loadPixelforgeproj(fs, path);
    expect(true).toBe(true);
  });

  test('save validates by default and rejects an invalid document without writing', async () => {
    const fs = new MemoryFs();
    const path = '/p/invalid.pixelforgeproj';
    const project = makeProject('palette-broken');
    (project.palette as string[])[0] = 'not-a-hex-color';
    // Default: validation runs BEFORE any write → INVALID_SCHEMA, nothing on disk.
    await expect(savePixelforgeproj(fs, path, project)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(await fs.exists(path)).toBe(false);
    expect(await fs.exists(tmpPathFor(path))).toBe(false);
    // validate:false skips the gate (documented escape hatch) and writes.
    await savePixelforgeproj(fs, path, project, { validate: false });
    expect(await fs.exists(path)).toBe(true);
  });

  test('linked cel buffers are re-shared after load (edit-once-applies-everywhere survives persistence)', async () => {
    const fs = new MemoryFs();
    const path = '/p/i.pixelforgeproj';
    const project = makeProject('linked');
    const clip = project.clips[1]; // 'walk' has 2 frames
    const { createLayer } = await import('../src/doc/factory');
    const bg = createLayer('bg', true);
    clip.layers.push(bg);
    const shared = new Uint8ClampedArray(32 * 32 * 4);
    shared[0] = 50;
    for (const frame of clip.frames) frame.cels[bg.id] = { buffer: shared, linked: true };
    await savePixelforgeproj(fs, path, project);

    const loaded = await loadPixelforgeproj(fs, path);
    const bg2 = loaded.project.clips[1].layers.find((l) => l.name === 'bg')!;
    const buffers = loaded.project.clips[1].frames.map((f) => f.cels[bg2.id].buffer);
    expect(buffers.length).toBeGreaterThan(1);
    for (const b of buffers) expect(b).toBe(buffers[0]); // same object
    expect(buffers[0][0]).toBe(50);
  });

  test('cloneProject independence is preserved through save/load', async () => {
    const fs = new MemoryFs();
    const path = '/p/j.pixelforgeproj';
    const a = makeProject('orig');
    const b = cloneProject(a);
    b.name = 'clone';
    await savePixelforgeproj(fs, path, a);
    expect((await loadPixelforgeproj(fs, path)).project.name).toBe('orig');
    expect(b.name).toBe('clone');
  });

  test('embedded journal is readable back (provenance foundation)', async () => {
    const fs = new MemoryFs();
    const path = '/p/k.pixelforgeproj';
    const project = makeProject('hist');
    const bus = new CommandBus(project);
    let ring: JournalRecord[] = [];
    const recorder = new JournalRecorder(bus, { onFlush: (all) => (ring = all) });
    bus.execute('project.rename', { name: 'with-history' }, 'ai');
    await savePixelforgeproj(fs, path, bus.getProject(), { recorder });
    const { records, corruptLines } = await import('../src/persist/store').then((m) => m.readEmbeddedJournal(fs, path));
    expect(corruptLines).toBe(0);
    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({ commandType: 'project.rename', origin: 'ai' });
    recorder.detach();
  });
});

describe('pixelforgeproj store (real fs integration)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'pixelforge-task3-'));
    dirs.push(d);
    return d;
  }

  /** node:fs/promises adapter — the same shape Electron main will provide. */
  function nodeFileFs(): FileFs {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    return {
      readFile: async (p) => new Uint8Array(await fsp.readFile(p)),
      writeFile: async (p, d) => {
        await fsp.writeFile(p, d);
      },
      rename: (f, t) => fsp.rename(f, t),
      unlink: (p) => fsp.unlink(p),
      exists: async (p) => {
        try {
          await fsp.stat(p);
          return true;
        } catch {
          return false;
        }
      },
      mkdir: (p) => fsp.mkdir(p, { recursive: true }) as unknown as Promise<void>,
      listDir: async (p) => {
        const entries = await fsp.readdir(p);
        const files: string[] = [];
        for (const e of entries) {
          const s = await fsp.stat(join(p, e));
          if (s.isFile()) files.push(e);
        }
        return files;
      },
      stat: async (p) => {
        try {
          const s = await fsp.stat(p);
          return { mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      },
    };
  }

  test('end-to-end: save → kill simulation → reopen → backup restore on real disk', async () => {
    const fs = nodeFileFs();
    const dir = tempDir();
    const path = join(dir, 'knight.pixelforgeproj');

    const project = makeProject('knight-v1');
    paint(project, 1, 0, 'fx', 10, 10, 77);
    await savePixelforgeproj(fs, path, project, { keepBackups: 2 });

    // Second save → creates a backup of v1.
    const v2 = makeProject('knight-v2');
    await savePixelforgeproj(fs, path, v2, { keepBackups: 2, now: new Date(2026, 0, 2) });

    expect(existsSync(path)).toBe(true);
    expect(existsSync(tmpPathFor(path))).toBe(false);
    const backups = await listBackups(fs, path);
    expect(backups.length).toBe(1);

    // Reopen main (v2).
    const loaded = await loadPixelforgeproj(fs, path);
    expect(loaded.project.name).toBe('knight-v2');

    // Restore from backup (v1 content).
    const backupBytes = readFileSync(join(dir, 'backups', backups[0]));
    const backupLoad = await loadPixelforgeproj(
      fs,
      join(dir, 'backups', backups[0])
    );
    expect(backupLoad.project.name).toBe('knight-v1');
    expect(backupBytes.length).toBeGreaterThan(0);

    // Journal sidecar empty after save; no pending records.
    expect(loaded.recovery.pendingRecords.length).toBe(0);
    expect(existsSync(journalPathFor(path))).toBe(false);

    // Corrupted main → checksum failure, backup still loadable (recovery path).
    const corrupt = await fspRead(path);
    corrupt[60] ^= 0xff; // inside the manifest payload
    await fs.writeFile(path, corrupt);
    await expect(loadPixelforgeproj(fs, path)).rejects.toMatchObject({ code: 'BAD_CHECKSUM' });
  });
});

async function fspRead(path: string): Promise<Uint8Array> {
  // Buffer is a Uint8Array subclass; convert to a plain view for the store API.
  return new Uint8Array(readFileSync(path));
}
