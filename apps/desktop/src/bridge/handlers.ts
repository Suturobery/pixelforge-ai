import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from 'electron';

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
// Electron accepts long extensions ('pixelforgeproj' = 14 chars) and the
// '*' all-files wildcard; the old 8-char cap rejected valid project filters.
const EXT_RE = /^\*$|^[a-z0-9][a-z0-9.]{0,31}$/i;
const MAX_PATH_LEN = 1024;
const MAX_CLIPBOARD_TEXT_LEN = 1024 * 1024;
/** Single archive size cap (256 MB) — way beyond any legit sprite project. */
const MAX_WRITE_BYTES = 256 * 1024 * 1024;
const MAX_TRUSTED_PROJECTS = 32;

/**
 * Session fs allowlist: directories whose files the renderer may touch via
 * pf:fs-*. Roots are added only by native picker results or a persisted,
 * picker-approved recent project capability.
 * Every fs call re-resolves and re-checks, so `..` traversal and absolute
 * escapes cannot leave the registered roots.
 */
const allowedRoots = new Set<string>();
const trustedProjectPaths = new Set<string>();
let trustedProjectsLoaded = false;

function trustedProjectsFile(): string {
  return path.join(app.getPath('userData'), 'trusted-project-paths.json');
}

function validProjectPath(value: string): boolean {
  return value.toLowerCase().endsWith('.pixelforgeproj');
}

function loadTrustedProjects(): void {
  if (trustedProjectsLoaded) return;
  trustedProjectsLoaded = true;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(trustedProjectsFile(), 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const item of parsed.slice(0, MAX_TRUSTED_PROJECTS)) {
      if (typeof item === 'string' && item.length <= MAX_PATH_LEN && validProjectPath(item)) {
        trustedProjectPaths.add(path.resolve(item));
      }
    }
  } catch {
    // Missing/corrupt recents are a convenience failure, never a file-access bypass.
  }
}

function rememberTrustedProject(filePath: string): void {
  if (!validProjectPath(filePath)) return;
  loadTrustedProjects();
  const resolved = path.resolve(filePath);
  trustedProjectPaths.delete(resolved);
  trustedProjectPaths.add(resolved);
  const recent = [...trustedProjectPaths].slice(-MAX_TRUSTED_PROJECTS).reverse();
  trustedProjectPaths.clear();
  for (const item of recent) trustedProjectPaths.add(item);
  persistTrustedProjects();
}

function persistTrustedProjects(): void {
  try {
    fs.mkdirSync(path.dirname(trustedProjectsFile()), { recursive: true });
    fs.writeFileSync(trustedProjectsFile(), JSON.stringify([...trustedProjectPaths], null, 2), { mode: 0o600 });
  } catch {
    // Keep the in-memory capability for this run if persistence is unavailable.
  }
}

function requireTrustedProjectPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LEN) {
    throw new Error('recent project path is invalid');
  }
  loadTrustedProjects();
  const resolved = path.resolve(raw);
  if (!trustedProjectPaths.has(resolved)) {
    throw new Error('recent project was not approved through a native file picker');
  }
  return resolved;
}

function forgetTrustedProject(filePath: string): void {
  trustedProjectPaths.delete(filePath);
  persistTrustedProjects();
}

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

  // The renderer runs in an isolated, loopback-served context where the web
  // Clipboard API is not consistently available. Keep native clipboard access
  // narrow: text only, capped in size, and write-only.
  ipcMain.handle('pf:clipboard-write', (_event, raw: unknown): void => {
    if (typeof raw !== 'string' || raw.length > MAX_CLIPBOARD_TEXT_LEN) {
      throw new Error('clipboard text must be a string up to 1 MB');
    }
    clipboard.writeText(raw);
  });

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
        rememberTrustedProject(result.filePaths[0]);
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
        rememberTrustedProject(picked);
        logger.info('project.pickSave', { path: picked, root });
      }
      return { canceled: result.canceled, path: picked };
    },
  );

  // Task 8: native confirm — Electron does NOT support window.confirm in the
  // renderer, so desktop flows needing a yes/no guard call this instead.
  ipcMain.handle(
    'pf:confirm',
    (event, raw: unknown): boolean => {
      const p = (raw ?? {}) as { message?: unknown; detail?: unknown };
      const message = typeof p.message === 'string' && p.message ? p.message : 'Are you sure?';
      const detail = typeof p.detail === 'string' ? p.detail : undefined;
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const opts = {
        type: 'warning' as const,
        buttons: ['Cancel', 'OK'],
        defaultId: 1,
        cancelId: 0,
        message,
        ...(detail ? { detail } : {}),
      };
      const choice = parent ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
      return choice === 1;
    },
  );

  // OS notification for background events the user would otherwise miss while
  // the window is minimized (AI approval requests, finished generation jobs).
  ipcMain.handle('pf:notify', (event, raw: unknown): { ok: boolean; reason?: string } => {
    const p = (raw ?? {}) as { title?: unknown; body?: unknown };
    const title = typeof p.title === 'string' && p.title ? p.title.slice(0, 120) : 'PixelForge AI';
    const body = typeof p.body === 'string' ? p.body.slice(0, 300) : '';
    if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };
    try {
      const n = new Notification({ title, body: body || undefined });
      n.on('click', () => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
      n.show();
      return { ok: true };
    } catch (err) {
      logger.warn('notify.failed', { err: String(err) });
      return { ok: false, reason: 'failed' };
    }
  });

  // Read-only tail of today's main log — powers "attach app logs" in the
  // Help & feedback report. Hard-capped so a chatty log can't balloon the
  // report or the IPC payload.
  ipcMain.handle('pf:logs-tail', (): { ok: boolean; text?: string; file?: string; error?: string } => {
    try {
      const file = logger.file;
      const MAX = 48 * 1024;
      const stat = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(stat.size, MAX);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - MAX));
        const text = buf.toString('utf8').split(/\r?\n/).slice(-200).join('\n');
        return { ok: true, text, file: path.basename(file) };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 120) };
    }
  });

  // Recents are capabilities, not arbitrary renderer paths. Only files the
  // user previously selected through a native picker are accepted after a
  // restart; this prevents a compromised renderer from granting itself access
  // to any directory on the machine.
  ipcMain.handle('pf:project-open-recent', (_event, raw: unknown): BridgeRegisterResult => {
    const resolved = requireTrustedProjectPath(raw);
    const root = registerRootForFile(resolved);
    logger.info('project.openRecent', { path: resolved, root });
    return { ok: true, root };
  });

  // Remove only the convenience/capability entry. The user's project file
  // remains untouched on disk and can always be picked again later.
  ipcMain.handle('pf:project-forget-recent', (_event, raw: unknown): void => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LEN || !validProjectPath(raw)) {
      throw new Error('recent project path is invalid');
    }
    // Forgetting only REDUCES local access; permit it even for an old/stale
    // renderer recent that predates the trusted-path file. Opening/deleting
    // still require a native-picker capability.
    loadTrustedProjects();
    const resolved = path.resolve(raw);
    forgetTrustedProject(resolved);
    logger.info('project.forgetRecent', { path: resolved });
  });

  // Disk deletion is deliberately recoverable and independently confirmed in
  // the MAIN process. A renderer cannot permanently unlink an arbitrary path:
  // this accepts only a prior native-picker capability and sends it to the OS
  // Recycle Bin/Trash rather than bypassing recovery.
  ipcMain.handle('pf:project-trash-recent', async (event, raw: unknown): Promise<{ trashed: boolean }> => {
    const resolved = requireTrustedProjectPath(raw);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new Error('The project file no longer exists. Remove it from Recents instead.');
    }
    if (!stat.isFile()) throw new Error('Only a saved project file can be moved to the Recycle Bin.');
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = parent
      ? await dialog.showMessageBox(parent, {
          type: 'warning',
          buttons: ['Cancel', 'Move to Recycle Bin'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: 'Move this project to the Recycle Bin?',
          detail: resolved,
        })
      : await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Move to Recycle Bin'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: 'Move this project to the Recycle Bin?',
          detail: resolved,
        });
    if (result.response !== 1) return { trashed: false };
    await shell.trashItem(resolved);
    forgetTrustedProject(resolved);
    logger.info('project.trashRecent', { path: resolved });
    return { trashed: true };
  });

  // A Save/rename can produce a new filename inside an already picker-approved
  // root. Persist only such an existing capability; this never grants a new
  // folder or lets renderer code choose an arbitrary disk location.
  ipcMain.handle('pf:project-remember-current', (_event, raw: unknown): BridgeRegisterResult => {
    const resolved = assertAllowed(raw);
    if (!validProjectPath(resolved)) throw new Error('project file must use the .pixelforgeproj extension');
    rememberTrustedProject(resolved);
    return { ok: true, root: path.dirname(resolved) };
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
      'pf:ping', 'pf:app-info', 'pf:clipboard-write', 'pf:dialog-open', 'pf:dialog-save',
      'pf:project-pick-open', 'pf:project-pick-save', 'pf:project-open-recent', 'pf:project-forget-recent', 'pf:project-trash-recent', 'pf:project-remember-current',
      'pf:confirm', 'pf:notify', 'pf:logs-tail', 'pf:export-pick-dir',
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
