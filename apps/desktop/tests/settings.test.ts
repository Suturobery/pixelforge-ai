/**
 * Task 13a — settings file + credential vault tests (pure modules).
 *
 * Drives SettingsStore with a fake fs + fake SecretBox so every security
 * property is asserted deterministically:
 *   • encryption/decryption round-trip; wrong-environment recovery;
 *   • NO plaintext API key ever written to disk (grep gate, C13);
 *   • IPC view contains no secret fields;
 *   • settings save/reload, invalid-file recovery, migration;
 *   • atomic writes (tmp + rename observed);
 *   • session-only credentials when encryption is unavailable.
 */

import { describe, expect, test } from 'bun:test';

import {
  SETTINGS_VERSION,
  defaultSettingsFile,
  validateAndMigrate,
} from '../src/settings/schema';
import { SettingsStore, type SecretBox, type SettingsFs } from '../src/settings/store';

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

// ------------------------------------------------------------- fake secretbox

/** Deterministic fake cipher: XOR + magic/checksum so foreign keys FAIL closed
 * (mirrors DPAPI/Keychain behavior — a different user account cannot decrypt). */
function cleanBox(available = true, secret = 'box-key-a'): SecretBox {
  const MAGIC = 'PFBOX1:';
  const apply = (bytes: Uint8Array): Uint8Array => {
    const key = new TextEncoder().encode(secret);
    return bytes.map((b, i) => b ^ key[i % key.length]) as Uint8Array;
  };
  const checksum = (bytes: Uint8Array): number => {
    let h = 2166136261;
    for (const b of bytes) h = ((h ^ b) * 16777619) >>> 0;
    return h;
  };
  return {
    isAvailable: () => available,
    backendLabel: () => (available ? 'TestBackend' : 'none'),
    encrypt: (plain) => {
      const plainBytes = new TextEncoder().encode(plain);
      const payload = apply(plainBytes);
      // checksum over the PLAINTEXT — a foreign secret un-XORs to a corrupted
      // candidate that fails this check (mirrors DPAPI/Keychain fail-closed)
      const head = new TextEncoder().encode(`${MAGIC}${checksum(plainBytes).toString(16)}:`);
      const out = new Uint8Array(head.length + payload.length);
      out.set(head);
      out.set(payload, head.length);
      return Buffer.from(out).toString('base64');
    },
    decrypt: (b64) => {
      try {
        const raw = new Uint8Array(Buffer.from(b64, 'base64'));
        const text = new TextDecoder().decode(raw);
        const sep = text.indexOf(':', MAGIC.length);
        if (!text.startsWith(MAGIC) || sep === -1) return null; // foreign/unknown blob
        const expected = Number.parseInt(text.slice(MAGIC.length, sep), 16);
        const candidate = apply(raw.slice(sep + 1));
        if (checksum(candidate) !== expected) return null; // wrong environment
        return new TextDecoder().decode(candidate);
      } catch {
        return null;
      }
    },
  };
}

const FILE = '/fake/userData/settings.json';

function makeStore(opts: { fs?: FakeFs; box?: SecretBox } = {}): { store: SettingsStore; fs: FakeFs; box: SecretBox } {
  const fs = opts.fs ?? new FakeFs();
  const box = opts.box ?? cleanBox();
  return { store: new SettingsStore({ file: FILE, fs, box }), fs, box };
}

// -------------------------------------------------------------------- tests

describe('settings schema — validation & recovery', () => {
  test('defaults include the dedicated Cloudflare Workers AI profile', () => {
    const cloudflare = defaultSettingsFile().aiProviders.find((provider) => provider.id === 'cloudflare');
    expect(cloudflare).toMatchObject({
      label: 'Cloudflare · Workers AI',
      kind: 'custom',
      model: '@cf/black-forest-labs/flux-1-schnell',
      enabled: false,
    });
  });

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
      aiProviders: [{ id: 'openai', kind: 'openai', apiKeyEnc: 'not base64!!' }, { bogus: true }],
      activeProviderId: 'does-not-exist',
    });
    expect(res.ok).toBe(false); // had to repair
    expect(res.file.app.autosaveDelay).toBe(60_000); // clamped to the max
    expect(res.file.app.historyLimit).toBe(8); // clamped to the min
    expect(res.file.app.defaultSize).toBe(256);
    expect(res.file.app.onionOpacity).toBe(0.8);
    expect(res.file.panels['palette']).toBeDefined();
    expect(res.file.panels['evil key']).toBeUndefined();
    expect((res.file.app as unknown as Record<string, unknown>)['evilField']).toBeUndefined();
    // invalid ciphertext dropped fail-closed
    const openai = res.file.aiProviders.find((p) => p.id === 'openai');
    expect(openai?.apiKeyEnc).toBeUndefined();
    expect(res.file.aiProviders.some((p) => p.id === 'bogus')).toBe(false);
    expect(res.file.activeProviderId).toBe(res.file.aiProviders[0].id);
    // unknown brainProviderId resets to the default reasoning profile
    expect(res.file.brainProviderId).toBe('groq');
    // window 100×50 is clamped up to the 400×300 floor (recovery, not rejection)
    expect(res.file.window).toEqual({ x: 10, y: 20, width: 400, height: 300, isMaximized: false });
  });

  test('brainProviderId mirrors through update and persists', () => {
    const { store, fs } = makeStore();
    store.load();
    store.update({ brainProviderId: 'openai' });
    expect(store.getPublic().brainProviderId).toBe('openai');
    // unknown profile id is ignored, value stays
    store.update({ brainProviderId: 'does-not-exist' });
    expect(store.getPublic().brainProviderId).toBe('openai');
    // survives a reload from disk
    const reloaded = makeStore({ fs });
    reloaded.store.load();
    expect(reloaded.store.getPublic().brainProviderId).toBe('openai');
  });

  test('legacy unversioned file migrates forward to v1', () => {
    const res = validateAndMigrate({
      app: { autosaveDelay: 1000, defaultPaletteId: 'forge16' },
      aiProviders: [{ id: 'zai', kind: 'zai', enabled: true }],
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
    store.update({ app: { autosaveDelay: 10000, floatBtnSize: 'lg', uiTextScale: 'large' }, activeProviderId: 'openai' });

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
    expect(store2.getPublic().activeProviderId).toBe('openai');
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

  test('update rejects smuggled secret fields (runtime cast attempt)', () => {
    const { store } = makeStore();
    store.load();
    const patch = {
      aiProviders: [{ id: 'openai', apiKeyEnc: 'SWJldGFwbGFpbnRleHQ=' }], // smuggled via cast
    } as unknown as Parameters<SettingsStore['update']>[0];
    store.update(patch);
    // the vault is the only writer of apiKeyEnc — the update path must not persist it
    const openai = store.getInternal().aiProviders.find((p) => p.id === 'openai');
    expect(openai?.apiKeyEnc).toBeUndefined();
  });
});

describe('credential vault (C13) — encryption available', () => {
  test('setApiKey → hasKey → reveal round-trip (in-process only)', () => {
    const { store } = makeStore();
    store.load();
    const key = 'sk-test-abc123SECRET';
    const res = store.setApiKey('openai', key);
    expect(res.ok).toBe(true);
    expect(res.sessionOnly).toBe(false);
    expect(store.hasKey('openai')).toBe(true);
    // revealApiKey is for the in-process job runner — never an IPC surface
    expect(store.revealApiKey('openai')).toBe(key);
  });

  test('NO plaintext API key is ever written to disk (grep gate)', () => {
    const { store, fs } = makeStore();
    store.load();
    const key = 'sk-gate-PLAINTEXT-MUST-NOT-PERSIST-42';
    store.setApiKey('openai', key);
    // scan EVERY file the fake fs holds — settings file, tmp files, backups
    for (const [path, content] of fs.files) {
      if (path.endsWith('::mode')) continue;
      expect(content.includes(key)).toBe(false); // plaintext leak
    }
    // and the ciphertext IS there
    const openai = store.getInternal().aiProviders.find((p) => p.id === 'openai');
    expect(typeof openai?.apiKeyEnc).toBe('string');
    expect(openai?.apiKeyEnc?.includes('sk-gate')).toBe(false);
    // ciphertext survives a reload and still decrypts
    const { store: store2, box } = makeStore({ fs, box: cleanBox(true, 'box-key-a') });
    store2.load();
    expect(store2.hasKey('openai')).toBe(true);
    expect(store2.revealApiKey('openai')).toBe(key);
  });

  test('ciphertext from a foreign environment decrypts to null → key scrubbed', () => {
    const fs = new FakeFs();
    const { store } = makeStore({ fs, box: cleanBox(true, 'machine-A') });
    store.load();
    store.setApiKey('openai', 'sk-foreign-key');
    // simulate a different machine/user account (DPAPI would throw)
    const { store: store2 } = makeStore({ fs, box: cleanBox(true, 'machine-B') });
    store2.load();
    expect(store2.hasKey('openai')).toBe(true); // ciphertext still present
    expect(store2.revealApiKey('openai')).toBeNull(); // undecryptable
    expect(store2.hasKey('openai')).toBe(false); // scrubbed after failed decrypt
    // and the scrub persisted
    const { store: store3 } = makeStore({ fs, box: cleanBox(true, 'machine-A') });
    store3.load();
    expect(store3.hasKey('openai')).toBe(false);
  });

  test('removeKey persists; re-keying replaces the old ciphertext', () => {
    const { store, fs } = makeStore();
    store.load();
    expect(store.setApiKey('openai', 'sk-first').ok).toBe(true);
    expect(store.setApiKey('openai', 'sk-second').ok).toBe(true);
    expect(store.revealApiKey('openai')).toBe('sk-second');
    expect(store.removeKey('openai')).toBe(true);
    expect(store.hasKey('openai')).toBe(false);
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.hasKey('openai')).toBe(false);
    expect(store2.removeKey('openai')).toBe(false);
  });

  test('getPublic() view contains no secret fields — deep scan', () => {
    const { store } = makeStore();
    store.load();
    store.setApiKey('openai', 'sk-deep-scan-SECRET');
    const view = store.getPublic() as unknown as Record<string, unknown>;
    const scan = (v: unknown): void => {
      if (typeof v !== 'object' || v === null) return;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        expect(['apiKeyEnc', 'apiKey', 'plaintext'].includes(k)).toBe(false); // secret field leaked into the IPC view
        scan(val);
      }
    };
    scan(view);
    expect(JSON.stringify(view).includes('sk-deep-scan-SECRET')).toBe(false);
    // provider view exposes only the boolean + metadata
    const p = view['aiProviders'] as Array<Record<string, unknown>>;
    expect(p.find((x) => x['id'] === 'openai')?.['hasKey']).toBe(true);
  });

  test('validation input limits: empty key, long key, bad provider id', () => {
    const { store } = makeStore();
    store.load();
    expect(store.setApiKey('openai', '   ').ok).toBe(false);
    expect(store.setApiKey('openai', 'x'.repeat(513)).ok).toBe(false);
    expect(store.setApiKey('bad id!', 'sk-x').ok).toBe(false);
    expect(store.hasKey('openai')).toBe(false);
  });
});

describe('credential vault (C13) — encryption UNAVAILABLE (session-only)', () => {
  test('key is kept in memory only — nothing written to disk, gone after restart', () => {
    const { store, fs } = makeStore({ box: cleanBox(false) });
    store.load();
    // force a baseline file so we can prove the key adds nothing to disk
    store.update({ app: { autosaveDelay: 1000 } });
    const snapshot = new Map(fs.files);

    const res = store.setApiKey('openai', 'sk-session-only-KEY');
    expect(res.ok).toBe(true);
    expect(res.sessionOnly).toBe(true);
    expect(store.hasKey('openai')).toBe(true);
    expect(store.revealApiKey('openai')).toBe('sk-session-only-KEY');

    // the only files changed are the settings file marking sessionOnly — and
    // its content must NOT contain the plaintext
    for (const [path, content] of fs.files) {
      if (path.endsWith('::mode')) continue;
      expect(content.includes('sk-session-only-KEY')).toBe(false);
    }
    // no NEW files appeared (no fallback file, no obfuscated sidecar)
    for (const path of fs.files.keys()) {
      expect(snapshot.has(path)).toBe(true); // no new file created
    }
    const openai = store.getInternal().aiProviders.find((p) => p.id === 'openai');
    expect(openai?.apiKeySessionOnly).toBe(true);
    expect(openai?.apiKeyEnc).toBeUndefined();

    // "restart" → the key is gone (session-only by design, C13)
    const { store: store2 } = makeStore({ fs, box: cleanBox(false) });
    store2.load();
    expect(store2.hasKey('openai')).toBe(false);
    // credentialStatus reports the session-only key + unavailable encryption
    const status = store.credentialStatus();
    expect(status.encryptionAvailable).toBe(false);
    expect(status.sessionOnlyKeys).toBe(1);
  });

  test('adding encryption later does not resurrect session keys', () => {
    const fs = new FakeFs();
    const { store } = makeStore({ fs, box: cleanBox(false) });
    store.load();
    store.setApiKey('openai', 'sk-temp-session');
    // session ends; new machine run HAS encryption
    const { store: store2 } = makeStore({ fs, box: cleanBox(true) });
    store2.load();
    expect(store2.hasKey('openai')).toBe(false);
    expect(store2.revealApiKey('openai')).toBeNull();
  });
});

describe('credential vault — other settings interactions', () => {
  test('provider metadata patch keeps the stored credential', () => {
    const { store } = makeStore();
    store.load();
    store.setApiKey('openai', 'sk-keep-me');
    store.update({ aiProviders: [{ id: 'openai', label: 'OpenAI · GPT (renamed)', model: 'gpt-image-1' }] });
    expect(store.getInternal().aiProviders.find((p) => p.id === 'openai')?.apiKeyEnc).toBeDefined();
    expect(store.revealApiKey('openai')).toBe('sk-keep-me');
    expect(store.getPublic().aiProviders.find((p) => p.id === 'openai')?.label).toBe('OpenAI · GPT (renamed)');
  });

  test('setApiKey on a provider missing from a legacy file (e.g. groq) creates the entry and persists apiKeyEnc', () => {
    const fs = new FakeFs();
    // Simulate a legacy v1 file written before 'groq' was added to defaultProviders
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
        aiProviders: [{ id: 'zai', label: 'Z.AI', kind: 'zai', baseUrl: '', model: 'auto', enabled: true }],
        activeProviderId: 'zai',
      }),
    );
    const { store } = makeStore({ fs });
    store.load();
    expect(store.getInternal().aiProviders.find((p) => p.id === 'groq')).toBeUndefined();

    const res = store.setApiKey('groq', 'gsk_test_groq_key_123');
    expect(res.ok).toBe(true);
    expect(store.hasKey('groq')).toBe(true);
    expect(store.getPublic().aiProviders.find((p) => p.id === 'groq')?.hasKey).toBe(true);

    // Reload from disk: groq entry and encrypted key survive
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.hasKey('groq')).toBe(true);
    expect(store2.revealApiKey('groq')).toBe('gsk_test_groq_key_123');
    expect(store2.getPublic().aiProviders.find((p) => p.id === 'groq')?.hasKey).toBe(true);
  });

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

// ------------------------------------------- Task 9: AI spend-control prefs

describe('settings — ai spend-control section (Task 9)', () => {
  test('ai prefs round-trip and survive a reload', () => {
    const { store, fs } = makeStore();
    store.load();
    store.update({ ai: { monthlyLimitUsd: 12.5, warnUsd: 2, cacheEnabled: false } });
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.getPublic().ai).toEqual({ monthlyLimitUsd: 12.5, warnUsd: 2, cacheEnabled: false });
  });

  test('ai prefs are clamped and typed (garbage → defaults)', () => {
    const { store } = makeStore();
    store.load();
    store.update({ ai: { monthlyLimitUsd: -5, warnUsd: 99_999, cacheEnabled: 'yes' as unknown as boolean } });
    const ai = store.getPublic().ai;
    expect(ai.monthlyLimitUsd).toBe(0); // clamped to the minimum
    expect(ai.warnUsd).toBe(10_000); // clamped to the maximum
    expect(ai.cacheEnabled).toBe(true); // wrong type → default
  });

  test('legacy files without an ai section gain the defaults (additive v1)', () => {
    const { store, fs } = makeStore();
    store.load();
    store.update({ ai: { monthlyLimitUsd: 3, warnUsd: 1, cacheEnabled: true } }); // persist something
    const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8')) as Record<string, unknown>;
    delete raw['ai'];
    fs.writeFileSync(store.filePath, JSON.stringify(raw));
    const { store: store2 } = makeStore({ fs });
    store2.load();
    expect(store2.getPublic().ai).toEqual({ monthlyLimitUsd: 5, warnUsd: 1, cacheEnabled: true });
  });
});
