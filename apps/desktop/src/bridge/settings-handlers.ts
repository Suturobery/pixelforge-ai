/**
 * PixelForge AI — settings IPC handlers (v3.1 §8.2; Task 13a).
 *
 * The settings namespace is the renderer's ONLY access to the settings file
 * and the credential vault. Security properties enforced here:
 *   • the public view NEVER contains apiKeyEnc / plaintext — secrets are
 *     stripped in store.getPublic() and re-checked by `assertNoSecret`
 *     before every reply;
 *   • `pf:settings-set-api-key` is WRITE-ONLY: the plaintext arrives once,
 *     is encrypted (or session-held), and is never reflected back;
 *   • payloads are hand-validated (allowlist style, fail closed) — invalid
 *     input rejects with a thrown Error like the rest of the bridge;
 *   • nothing secret is ever logged (ids + booleans only).
 */

import { ipcMain } from 'electron';

import type { Logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import type {
  BridgeCredentialStatus,
  BridgeSettingsUpdate,
  BridgeSettingsView,
} from '../shared/bridge-types';

const MAX_PATCH_JSON = 256 * 1024; // settings patches are tiny; hard cap anyway

/** Defense in depth: no secret-looking field may appear in an IPC reply. */
function assertNoSecret(value: unknown, depth = 0): void {
  if (depth > 6 || typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === 'apiKeyEnc' || key === 'apiKey' || key === 'plaintext') {
      throw new Error('internal error: secret field leaked into the IPC view');
    }
    assertNoSecret((value as Record<string, unknown>)[key], depth + 1);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Validate the update patch shape (allowlist; deeper validation in the store). */
function parseUpdate(raw: unknown): BridgeSettingsUpdate {
  if (!isPlainObject(raw)) fail('settings update must be an object');
  if (JSON.stringify(raw).length > MAX_PATCH_JSON) fail('settings update too large');
  const r = raw as Record<string, unknown>;
  const out: BridgeSettingsUpdate = {};

  if (r['app'] !== undefined) {
    if (!isPlainObject(r['app'])) fail('app must be an object');
    out.app = r['app'] as BridgeSettingsUpdate['app'];
  }
  if (r['mcp'] !== undefined) {
    if (!isPlainObject(r['mcp'])) fail('mcp must be an object');
    const m = r['mcp'] as Record<string, unknown>;
    const mcp: NonNullable<BridgeSettingsUpdate['mcp']> = {};
    if (m['agentApiEnabled'] !== undefined) {
      if (typeof m['agentApiEnabled'] !== 'boolean') fail('mcp.agentApiEnabled must be boolean');
      mcp.agentApiEnabled = m['agentApiEnabled'];
    }
    if (m['bridgeAutoConnect'] !== undefined) {
      if (typeof m['bridgeAutoConnect'] !== 'boolean') fail('mcp.bridgeAutoConnect must be boolean');
      mcp.bridgeAutoConnect = m['bridgeAutoConnect'];
    }
    out.mcp = mcp;
  }
  if (r['ai'] !== undefined) {
    if (!isPlainObject(r['ai'])) fail('ai must be an object');
    const a = r['ai'] as Record<string, unknown>;
    const ai: NonNullable<BridgeSettingsUpdate['ai']> = {};
    if (a['monthlyLimitUsd'] !== undefined) {
      if (typeof a['monthlyLimitUsd'] !== 'number' || !Number.isFinite(a['monthlyLimitUsd'])) fail('ai.monthlyLimitUsd must be a number');
      ai.monthlyLimitUsd = a['monthlyLimitUsd'];
    }
    if (a['warnUsd'] !== undefined) {
      if (typeof a['warnUsd'] !== 'number' || !Number.isFinite(a['warnUsd'])) fail('ai.warnUsd must be a number');
      ai.warnUsd = a['warnUsd'];
    }
    if (a['cacheEnabled'] !== undefined) {
      if (typeof a['cacheEnabled'] !== 'boolean') fail('ai.cacheEnabled must be boolean');
      ai.cacheEnabled = a['cacheEnabled'];
    }
    out.ai = ai;
  }
  if (r['panels'] !== undefined) {
    if (!isPlainObject(r['panels'])) fail('panels must be an object');
    out.panels = r['panels'] as BridgeSettingsUpdate['panels'];
  }
  if (r['activeProviderId'] !== undefined) {
    if (typeof r['activeProviderId'] !== 'string') fail('activeProviderId must be a string');
    out.activeProviderId = r['activeProviderId'];
  }
  if (r['aiProviders'] !== undefined) {
    if (!Array.isArray(r['aiProviders'])) fail('aiProviders must be an array');
    out.aiProviders = r['aiProviders'] as BridgeSettingsUpdate['aiProviders'];
  }
  return out;
}

export function registerSettingsHandlers(store: SettingsStore, logger: Logger): void {
  ipcMain.handle('pf:settings-get', (): BridgeSettingsView => {
    const view: BridgeSettingsView = { ...store.getPublic(), credentials: statusPayload(store) };
    assertNoSecret(view);
    return view;
  });

  ipcMain.handle('pf:settings-update', (_event, raw: unknown): BridgeSettingsView => {
    const patch = parseUpdate(raw);
    store.update(patch);
    logger.info('settings.update', {
      sections: Object.keys(patch),
      activeProviderId: patch.activeProviderId ?? undefined,
    });
    const view: BridgeSettingsView = { ...store.getPublic(), credentials: statusPayload(store) };
    assertNoSecret(view);
    return view;
  });

  ipcMain.handle('pf:settings-set-api-key', (_event, rawProviderId: unknown, rawKey: unknown) => {
    if (typeof rawProviderId !== 'string' || rawProviderId.length === 0 || rawProviderId.length > 64) {
      fail('setApiKey requires a provider id');
    }
    if (typeof rawKey !== 'string' || rawKey.length === 0 || rawKey.length > 512) {
      fail('setApiKey requires a 1–512 char key');
    }
    const res = store.setApiKey(rawProviderId, rawKey);
    // NEVER log the key or any slice of it
    logger.info('settings.apiKey.set', {
      providerId: rawProviderId,
      ok: res.ok,
      sessionOnly: res.sessionOnly || undefined,
      error: res.error ?? undefined,
    });
    if (!res.ok) fail(res.error ?? 'could not store the API key');
    return { ok: true, sessionOnly: res.sessionOnly };
  });

  ipcMain.handle('pf:settings-has-key', (_event, rawProviderId: unknown): boolean => {
    if (typeof rawProviderId !== 'string' || rawProviderId.length === 0 || rawProviderId.length > 64) {
      fail('hasKey requires a provider id');
    }
    return store.hasKey(rawProviderId);
  });

  ipcMain.handle('pf:settings-remove-key', (_event, rawProviderId: unknown): boolean => {
    if (typeof rawProviderId !== 'string' || rawProviderId.length === 0 || rawProviderId.length > 64) {
      fail('removeKey requires a provider id');
    }
    const removed = store.removeKey(rawProviderId);
    logger.info('settings.apiKey.removed', { providerId: rawProviderId, removed });
    return removed;
  });

  ipcMain.handle('pf:settings-credential-status', (): BridgeCredentialStatus => {
    const payload = statusPayload(store);
    assertNoSecret(payload);
    return payload;
  });

  logger.info('settings.handlers.registered', {
    channels: [
      'pf:settings-get',
      'pf:settings-update',
      'pf:settings-set-api-key',
      'pf:settings-has-key',
      'pf:settings-remove-key',
      'pf:settings-credential-status',
    ],
  });
}

function statusPayload(store: SettingsStore): BridgeCredentialStatus {
  const status = store.credentialStatus();
  return {
    encryptionAvailable: status.encryptionAvailable,
    backend: status.backend,
    sessionOnlyKeys: status.sessionOnlyKeys,
    providers: status.providers.map((p) => ({
      id: p.id,
      hasKey: p.hasKey,
      sessionOnly: p.sessionOnly,
      apiKeyStoredAt: p.apiKeyStoredAt,
    })),
  };
}
