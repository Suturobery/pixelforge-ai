/**
 * Task 13a — settings file tests (pure modules).
 *
 * Drives SettingsStore with a fake fs so every property is asserted
 * deterministically:
 *   • settings save/reload, invalid-file recovery, migration;
 *   • atomic writes (tmp + rename observed);
 *   • allowlist validation: unknown fields dropped, ranges clamped;
 *   • legacy AI-provider fields on disk are dropped by validation.
 */

import { describe, expect, test } from 'bun:test';

import {
  SETTINGS_VERSION,
  defaultSettingsFile,
  validateAndMigrate,
} from '../src/settings/schema';
import { SettingsStore, type SettingsFs } from '../src/settings/store';

// ------------------------------------------------------------------ fake fs

class FakeFs implements SettingsFs {
  files = new Map<string, string>();
  writeLog: Array<{ op: 'write' | 'rename'; path: string; data?: string }> = [];

  existsSync(path: string): boolean {
    return this.files.has(path);
  }
  readFileSync(path: string, _enc: 'utf8'): string {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  writeFileSync(path: string, data: string): void {
    this.files.set(path, data);
    this.writeLog.push({ op: 'write', path, data });
  }
  renameSync(from: string, to: string): void {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, v);
    this.writeLog.push({ op: 'rename', path: from });
  }
  unlinkSync(path: string): void {
    this.files.delete(path);
  }
  chmodSync(path: string, mode: number): void {
    this.files.set(`${path}::mode`, String(mode));
  }
}

const FILE = '/fake/userData/settings.json';

function makeStore(opts: { fs?: FakeFs } = {}): { store: SettingsStore; fs: FakeFs } {
  const fs = opts.fs ?? new FakeFs();
  return { store: new SettingsStore({ file: FILE, fs }), fs };
}

// -------------------------------------------------------------------- tests

describe('settings schema — validation & recovery', () => {
  test('missing file → defaults, not recovered', () => {
    const { store } = makeStore();
    const res = store.load();
    expect(res.recovered).toBe(false);
    const strip = (f: unknown): string => {
      const { updatedAt: _u, ...rest } = f as Record<string, unknown>;
      return JSON.stringify(rest);
    };
    expect(strip(store.getInternal())).toBe(strip(defaultSettingsFile()));
  });

  test('malformed JSON → recovered to defaults + corrupt backup kept', () => {
    const fs = new FakeFs();
    fs.files.set(FILE, '{ this is not json !!!');
    const { store } = makeStore({ fs });
    const res = store.load();
    expect(res.recovered).toBe(true);
    expect(res.notes.some((n) => n.includes('not valid JSON'))).toBe(true);
    const backups = [...fs.files.keys()].filter((k) => k.includes('.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.files.get(backups[0])).toBe('{ this is not json !!!');
  });

  test('unknown fields are dropped; ranges are clamped to safe values', () => {
    const res = validateAndMigrate({
      version: 1,
      app: { autosaveDelay: 999_999, historyLimit: -5, evilField: 'x', defaultSize: 5000, onionOpacity: 42 },
      window: { x: 10, y: 20, width: 100, height: 50 },
      panels: { palette: { pos: { x: 5, y: 6 } }, 'evil key': { pos: { x: 1, y: 2 } } },
      mcp: { agentApiEnabled: 'yes' },
    });
    expect(res.ok).toBe(false); // had to repair
    expect(res.file.app.autosaveDelay).toBe(60_000); // clamped to the max
    expect(res.file.app.historyLimit).toBe(8); // clamped to the min
    expect(res.file.app.defaultSize).toBe(256);
    expect(res.file.app.onionOpacity).toBe(0.8);
    expect(res.file.panels['palette']).toBeDefined();
    expect(res.file.panels['evil key']).toBeUndefined();
    expect((res.file.app as unknown as Record<string, unknown>)['evilField']).toBeUndefined();
    // window 100×50 is clamped up to the 400×300 floor (recovery, not rejection)
    expect(res.file.window).toEqual({ x: 10, y: 20, width: 400, height: 300, isMaximized: false });
  });

  test('legacy AI-provider sections are dropped by validation', () => {
    const res = validateAndMigrate({
      version: 1,
      app: { autosaveDelay: 1000 },
      mcp: { agentApiEnabled: true, bridgeAutoConnect: true },
      ai: { monthlyLimitUsd: 5, warnUsd: 1, cacheEnabled: true },
      aiProviders: [
        { id: 'zai', kind: 'zai', apiKeyEnc: 'bm90IGJhc2U2NCEh', enabled: true },
        { bogus: true },
      ],
      activeProviderId: 'zai',
      brainProviderId: 'groq',
    });
    const file = res.file as unknown as Record<string, unknown>;
    expect(file['ai']).toBeUndefined();
    expect(file['aiProviders']).toBeUndefined();
    expect(file['activeProviderId']).toBeUndefined();
    expect(file['brainProviderId']).toBeUndefined();
    // the surviving sections are intact
    expect(res.file.app.autosaveDelay).toBe(1000);
    expect(res.file.mcp.agentApiEnabled).toBe(true);
  });

  test('legacy unversioned file migrates forward to v1', () => {
    const res = validateAndMigrate({
      app: { autosaveDelay: 1000, defaultPaletteId: 'forge16' },
    });
    expect(res.file.version).toBe(SETTINGS_VERSION);
    expect(res.notes.some((n) => n.includes('migrated'))).toBe(true);
    expect(res.file.app.autosaveDelay).toBe(1000);
    expect(res.file.mcp.agentApiEnabled).toBe(true); // defaults filled in
  });

  test('forward (newer) version is refused → defaults, never interpreted', () => {
    const res = validateAndMigrate({ version: 99, app: { autosaveDelay: 1234 } });
    expect(res.ok).toBe(false);
    expect(res.file.app.autosaveDelay).toBe(2500); // defaults, not the file's value
    expect(res.notes[0]).toContain('newer than supported');
  });

  test('valid v1 file passes through unchanged', () => {
    const file = defaultSettingsFile();
    file.app.autosaveDelay = 5000;
    const res = validateAndMigrate(JSON.parse(JSON.stringify(file)));
    expect(res.ok).toBe(true);
    expect(res.file.app.autosaveDelay).toBe(5000);
  });
});

describe('settings store — persistence', () => {
  test('update → atomic write (tmp + rename) → reload keeps values', () => {
    const { store, fs } = makeStore();
    store.load();
    store.update({ app: { autosaveDelay: 10000, floatBtnSize: 'lg', uiTextScale: 'large' } });

    // atomic write shape: a .tmp write followed by a rename onto the real file
    const lastWrite = fs.writeLog.filter((e) => e.op === 'write').at(-1);
    const lastRename = fs.writeLog.filter((e) => e.op === 'rename').at(-1);
    expect(lastWrite?.path).toBe(`${FILE}.tmp`);
    expect(lastRename?.path).toBe(`${FILE}.tmp`);

    // fresh instance reads the same values back
    const { store: store2 } = makeStore({ fs });
    const loaded = store2.load();
    expect(loaded.recovered).toBe(false);
    expect(store2.getPublic().app.autosaveDelay).toBe(10000);
    expect(store2.getPublic().app.floatBtnSize).toBe('lg');
    expect(store2.getPublic().app.uiTextScale).toBe('large');
  });

  test('file is restricted (chmod 0600 requested on POSIX)', () => {
    const { store, fs } = makeStore();
    store.load();
    store.update({ app: { autosaveDelay: 1000 } });
    expect(fs.files.get(`${FILE}::mode`)).toBe('384'); // 0o600 = 384
  });

  test('window layout save + restore round-trip', () => {
    const { store, fs } = makeStore();
    store.load();
    store.saveWindow({ x: 12, y: 34, width: 1280, height: 800, isMaximized: false });
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.getInternal().window).toEqual({ x: 12, y: 34, width: 1280, height: 800, isMaximized: false });
  });

  test('a legacy file with vaulted AI fields is scrubbed on the next write', () => {
    const fs = new FakeFs();
    fs.writeFileSync(
      FILE,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        app: defaultSettingsFile().app,
        window: null,
        panels: {},
        mcp: { agentApiEnabled: true, bridgeAutoConnect: true },
        ai: { monthlyLimitUsd: 5, warnUsd: 1, cacheEnabled: true },
        aiProviders: [
          { id: 'zai', label: 'Z.AI', kind: 'zai', baseUrl: '', model: 'auto', enabled: true, apiKeyEnc: 'ZmFrZQ==' },
        ],
        activeProviderId: 'zai',
        brainProviderId: 'groq',
      }),
    );
    const { store } = makeStore({ fs });
    store.load();
    store.update({ app: { autosaveDelay: 2000 } }); // triggers a persist
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    expect(onDisk['ai']).toBeUndefined();
    expect(onDisk['aiProviders']).toBeUndefined();
    expect(onDisk['activeProviderId']).toBeUndefined();
    expect(onDisk['brainProviderId']).toBeUndefined();
    expect((onDisk['app'] as Record<string, unknown>)['autosaveDelay']).toBe(2000);
  });
});

describe('settings store — other sections', () => {
  test('mcp prefs update round-trips (master switch lives in the settings file)', () => {
    const { store, fs } = makeStore();
    store.load();
    store.update({ mcp: { agentApiEnabled: false, bridgeAutoConnect: true } });
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.getPublic().mcp.agentApiEnabled).toBe(false);
    expect(store2.getPublic().mcp.bridgeAutoConnect).toBe(true);
  });

  test('panels replace + reload', () => {
    const { store, fs } = makeStore();
    store.load();
    store.replacePanels({ 'palette-panel': { pos: { x: 10, y: 20 }, open: true } });
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.getPublic().panels['palette-panel']?.pos).toEqual({ x: 10, y: 20 });
  });
});
