/**
 * PixelForge AI — settings IPC handlers (v3.1 §8.2; Task 13a).
 *
 * The settings namespace is the renderer's ONLY access to the settings file.
 * Security properties enforced here:
 *   • payloads are hand-validated (allowlist style, fail closed) — invalid
 *     input rejects with a thrown Error like the rest of the bridge;
 *   • the IPC view only ever contains preference data (no secret fields
 *     exist in the settings file anymore — the legacy credential vault was
 *     removed with the in-app AI provider stack).
 */

import { ipcMain } from 'electron';

import type { Logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import type {
  BridgeSettingsUpdate,
  BridgeSettingsView,
} from '../shared/bridge-types';

const MAX_PATCH_JSON = 256 * 1024; // settings patches are tiny; hard cap anyway

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
  if (r['panels'] !== undefined) {
    if (!isPlainObject(r['panels'])) fail('panels must be an object');
    out.panels = r['panels'] as BridgeSettingsUpdate['panels'];
  }
  return out;
}

export function registerSettingsHandlers(
  store: SettingsStore,
  logger: Logger,
  onUpdated?: (patch: BridgeSettingsUpdate) => void,
): void {
  ipcMain.handle('pf:settings-get', (): BridgeSettingsView => {
    return store.getPublic();
  });

  ipcMain.handle('pf:settings-update', (_event, raw: unknown): BridgeSettingsView => {
    const patch = parseUpdate(raw);
    store.update(patch);
    onUpdated?.(patch);
    logger.info('settings.update', { sections: Object.keys(patch) });
    return store.getPublic();
  });

  logger.info('settings.handlers.registered', {
    channels: ['pf:settings-get', 'pf:settings-update'],
  });
}
