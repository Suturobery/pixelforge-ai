import fsp from 'node:fs/promises';
import path from 'node:path';

import { BrowserWindow, app, dialog, ipcMain } from 'electron';

import type { Logger } from '../logger';
import type {
  BridgeAppInfo,
  BridgeDialogOpenOptions,
  BridgeDialogOpenResult,
  BridgeDialogSaveOptions,
  BridgeDialogSaveResult,
  BridgeExportDirResult,
  BridgeRegisterResult,
  BridgeStatResult,
} from '../shared/bridge-types';

const MAX_FILTERS = 8;
const MAX_EXTENSIONS_PER_FILTER = 16;
const EXT_RE = /^[a-z0-9]{1,8}$/i;
const MAX_PATH_LEN = 1024;
/** Single archive size cap (256 MB) — way beyond any legit sprite project. */
const MAX_WRITE_BYTES = 256 * 1024 * 1024;

/**
 * Session fs allowlist: directories whose files the renderer may touch via
 * pf:fs-*. Roots are added ONLY by dialog picks and explicit registerPath —
 * i.e. by flows where a human (or the dev harness) chose the location.
 * Every fs call re-resolves and re-checks, so `..` traversal and absolute
 * escapes cannot leave the registered roots.
 */
const allowedRoots = new Set<string>();

function registerRootForFile(filePath: string): string | null {
  const dir = path.resolve(path.dirname(filePath));
  allowedRoots.add(dir);
  return dir;
}

function isAllowed(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH_LEN) return null;
  const resolved = path.resolve(filePath);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  return null;
}

function assertAllowed(filePath: unknown): string {
  const resolved = isAllowed(filePath);
  if (!resolved) throw new Error(`path is outside the session-allowed directories: ${String(filePath).slice(0, 128)}`);
  return resolved;
}

function asUint8Array(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('file payload must be a Uint8Array');
  if (value.byteLength > MAX_WRITE_BYTES) throw new Error(`payload too large (max ${MAX_WRITE_BYTES} bytes)`);
  return value;
}

/**
 * ipcMain handlers for the Task-1 + Task-4 bridge surface (v3.1 §8.2).
 * Every payload is validated by hand (no new deps); invalid input rejects with
 * a thrown Error that the renderer receives as a rejected invoke promise.
 * Later tasks add namespaces here: settings (13a), ai (9), mcp (8).
 */
export function registerBridgeHandlers(logger: Logger): void {
  ipcMain.handle('pf:ping', () => 'pong' as const);

  ipcMain.handle('pf:app-info', (): BridgeAppInfo => ({
    name: 'PixelForge AI',
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    platform: process.platform,
    isDev: !app.isPackaged,
    locale: app.getLocale(),
  }));

  // --- dialogs (Task 1 surface kept; Task 4 pick flows add registration) ---

  ipcMain.handle(
    'pf:dialog-open',
    async (event, raw: unknown): Promise<BridgeDialogOpenResult> => {
      const options = parseOpenOptions(raw);
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      logger.info('dialog.open', { options });
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            properties: ['openFile', ...(options.multiSelections ? ['multiSelections' as const] : [])],
            filters: options.filters,
            defaultPath: options.defaultPath,
          })
        : await dialog.showOpenDialog({
            properties: ['openFile', ...(options.multiSelections ? ['multiSelections' as const] : [])],
            filters: options.filters,
            defaultPath: options.defaultPath,
          });
      return { canceled: result.canceled, paths: result.filePaths };
    },
  );

  ipcMain.handle(
    'pf:dialog-save',
    async (event, raw: unknown): Promise<BridgeDialogSaveResult> => {
      const options = parseSaveOptions(raw);
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      logger.info('dialog.save', { options });
      const result = parent
        ? await dialog.showSaveDialog(parent, {
            filters: options.filters,
            defaultPath: options.defaultPath,
          })
        : await dialog.showSaveDialog({
            filters: options.filters,
            defaultPath: options.defaultPath,
          });
      return { canceled: result.canceled, path: result.canceled ? null : (result.filePath ?? null) };
    },
  );

  // --- Task 4: project file flows -----------------------------------------

  ipcMain.handle(
    'pf:project-pick-open',
    async (event, raw: unknown): Promise<BridgeDialogOpenResult> => {
      const options = parseOpenOptions(raw);
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            properties: ['openFile'],
            filters: options.filters,
            defaultPath: options.defaultPath,
          })
        : await dialog.showOpenDialog({ properties: ['openFile'], filters: options.filters, defaultPath: options.defaultPath });
      if (!result.canceled && result.filePaths[0]) {
        const root = registerRootForFile(result.filePaths[0]);
        logger.info('project.pickOpen', { path: result.filePaths[0], root });
      }
      return { canceled: result.canceled, paths: result.filePaths };
    },
  );

  ipcMain.handle(
    'pf:project-pick-save',
    async (event, raw: unknown): Promise<BridgeDialogSaveResult> => {
      const options = parseSaveOptions(raw);
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = parent
        ? await dialog.showSaveDialog(parent, { filters: options.filters, defaultPath: options.defaultPath })
        : await dialog.showSaveDialog({ filters: options.filters, defaultPath: options.defaultPath });
      const picked = result.canceled ? null : (result.filePath ?? null);
      if (picked) {
        const root = registerRootForFile(picked);
        logger.info('project.pickSave', { path: picked, root });
      }
      return { canceled: result.canceled, path: picked };
    },
  );

  ipcMain.handle('pf:project-register-path', (_event, raw: unknown): BridgeRegisterResult => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LEN) {
      throw new Error('registerPath requires a path string');
    }
    const resolved = path.resolve(raw);
    const root = registerRootForFile(resolved);
    logger.info('project.registerPath', { path: resolved, root });
    return { ok: true, root };
  });

  // --- Task 7: export destinations -----------------------------------------

  // Native directory picker for multi-file exports. The picked directory
  // joins the SAME session allowlist the project flows use — writes then ride
  // the validated pf:fs-* transport (no new I/O surface, traversal-proof).
  ipcMain.handle('pf:export-pick-dir', async (event): Promise<BridgeExportDirResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    logger.info('export.pickDir');
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const dir = result.canceled ? null : (result.filePaths[0] ?? null);
    if (dir) {
      allowedRoots.add(path.resolve(dir));
      logger.info('export.pickDir.registered', { dir });
    }
    return { canceled: result.canceled, dir };
  });

  // --- Task 4: allowlisted primitive fs transport (core FileFs adapter) ----

  ipcMain.handle('pf:fs-read', async (_event, raw: unknown): Promise<Uint8Array> => {
    const p = assertAllowed(raw);
    return new Uint8Array(await fsp.readFile(p));
  });

  ipcMain.handle('pf:fs-write', async (_event, rawPath: unknown, rawData: unknown): Promise<void> => {
    const p = assertAllowed(rawPath);
    const data = asUint8Array(rawData);
    await fsp.writeFile(p, data);
  });

  ipcMain.handle('pf:fs-rename', async (_event, rawFrom: unknown, rawTo: unknown): Promise<void> => {
    const from = assertAllowed(rawFrom);
    const to = assertAllowed(rawTo);
    await fsp.rename(from, to);
  });

  ipcMain.handle('pf:fs-unlink', async (_event, raw: unknown): Promise<void> => {
    const p = assertAllowed(raw);
    try {
      await fsp.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  });

  ipcMain.handle('pf:fs-exists', async (_event, raw: unknown): Promise<boolean> => {
    const p = assertAllowed(raw);
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('pf:fs-mkdir', async (_event, raw: unknown): Promise<void> => {
    const p = assertAllowed(raw);
    await fsp.mkdir(p, { recursive: true });
  });

  ipcMain.handle('pf:fs-listdir', async (_event, raw: unknown): Promise<string[]> => {
    const p = assertAllowed(raw);
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.filter((d) => d.isFile() || d.isSymbolicLink()).map((d) => d.name);
  });

  ipcMain.handle('pf:fs-stat', async (_event, raw: unknown): Promise<BridgeStatResult | null> => {
    const p = assertAllowed(raw);
    try {
      const st = await fsp.stat(p);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  });

  logger.info('bridge.handlers.registered', {
    channels: [
      'pf:ping', 'pf:app-info', 'pf:dialog-open', 'pf:dialog-save',
      'pf:project-pick-open', 'pf:project-pick-save', 'pf:project-register-path',
      'pf:export-pick-dir',
      'pf:fs-read', 'pf:fs-write', 'pf:fs-rename', 'pf:fs-unlink',
      'pf:fs-exists', 'pf:fs-mkdir', 'pf:fs-listdir', 'pf:fs-stat',
    ],
  });
}

// --- payload validation (allowlist style; fail closed) -----------------------

function parseOpenOptions(raw: unknown): BridgeDialogOpenOptions {
  if (raw === undefined || raw === null) return {};
  assertPlainObject(raw);
  const o = raw as Record<string, unknown>;
  const out: BridgeDialogOpenOptions = {};
  if (o['filters'] !== undefined) out.filters = sanitizeFilters(o['filters']);
  if (o['multiSelections'] === true) out.multiSelections = true;
  if (o['defaultPath'] !== undefined) out.defaultPath = sanitizePathLike(o['defaultPath']);
  return out;
}

function parseSaveOptions(raw: unknown): BridgeDialogSaveOptions {
  if (raw === undefined || raw === null) return {};
  assertPlainObject(raw);
  const o = raw as Record<string, unknown>;
  const out: BridgeDialogSaveOptions = {};
  if (o['filters'] !== undefined) out.filters = sanitizeFilters(o['filters']);
  if (o['defaultPath'] !== undefined) out.defaultPath = sanitizePathLike(o['defaultPath']);
  return out;
}

function assertPlainObject(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('bridge payload must be an object');
  }
}

function sanitizeFilters(raw: unknown): { name: string; extensions: string[] }[] {
  if (!Array.isArray(raw) || raw.length > MAX_FILTERS) {
    throw new Error(`filters must be an array of at most ${MAX_FILTERS} items`);
  }
  return raw.map((item) => {
    assertPlainObject(item);
    const rec = item as Record<string, unknown>;
    const name = rec['name'];
    const extensions = rec['extensions'];
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
      throw new Error('invalid filter name');
    }
    if (
      !Array.isArray(extensions) ||
      extensions.length === 0 ||
      extensions.length > MAX_EXTENSIONS_PER_FILTER ||
      !extensions.every((e) => typeof e === 'string' && EXT_RE.test(e))
    ) {
      throw new Error('invalid filter extensions');
    }
    return { name, extensions: [...extensions] as string[] };
  });
}

function sanitizePathLike(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LEN) {
    throw new Error('invalid path-like option');
  }
  return value;
}
