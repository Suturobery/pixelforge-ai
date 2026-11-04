import path from 'node:path';

import { app, BrowserWindow, screen, shell } from 'electron';

import { OPEN_DEVTOOLS, resolveRendererTarget, type RendererTarget } from './config';
import type { Logger } from './logger';
import type { SettingsStore } from './settings/store';

/**
 * Absolute preload path, anchored to the app root (layout-independent):
 * <app>/dist/preload/index.js. Compiling src/window.js → dist/window.js made
 * a __dirname-relative path fragile; the app root is deterministic.
 */
function preloadPath(): string {
  return path.join(app.getAppPath(), 'dist', 'preload', 'index.js');
}

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Keep a stored window layout only when it is visible on a CURRENTLY attached
 * display (≥ 120 px of the title bar reachable). Guards against monitor
 * changes stranding the window off-screen.
 */
function sanitizeBounds(
  stored: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!stored) return null;
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const a = d.workArea;
      const overlapX = Math.min(stored.x + stored.width, a.x + a.width) - Math.max(stored.x, a.x);
      const overlapY = Math.min(stored.y + stored.height, a.y + a.height) - Math.max(stored.y, a.y);
      return overlapX > 120 && overlapY > 80;
    });
    return visible ? { ...stored } : null;
  } catch {
    return null;
  }
}

/**
 * Task 13a: persist the window layout into the settings file. Called on
 * before-quit (bounds are read live from the window).
 */
export function persistWindowLayout(settings: SettingsStore, logger: Logger): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    settings.saveWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    });
    logger.info('window.layout.persisted', { ...bounds, maximized: win.isMaximized() });
  } catch (err) {
    logger.warn('window.layout.persist.failed', { error: String(err) });
  }
}

/** Origin/prefix the window may navigate within (dev server dir or the shell dir). */
function allowedNavigationPrefix(target: RendererTarget): string {
  if (target.kind === 'dev-server') {
    const u = new URL(target.url);
    return `${u.protocol}//${u.host}/`;
  }
  return `file://${path.dirname(target.file)}/`;
}

/**
 * Create the main window with the v3.1 §8.2 security posture:
 * contextIsolation + sandbox + no Node in the renderer, navigation guards,
 * no popups, no <webview>. Does NOT start loading — call loadRenderer()
 * after session hardening so handlers precede the first navigation.
 *
 * Task 13a: when the settings file holds a persisted window layout, it is
 * applied here — validated against the CURRENT display work areas so a
 * disconnected monitor can never strand the window off-screen.
 */
export function createMainWindow(logger: Logger, settings?: SettingsStore): BrowserWindow {
  const target = resolveRendererTarget();
  const stored = settings?.getInternal().window ?? null;
  const bounds = sanitizeBounds(stored);
  const win = new BrowserWindow({
    // stored bounds win; defaults apply only when nothing valid is stored
    ...(bounds
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : { width: 1280, height: 800 }),
    minWidth: 960,
    minHeight: 600,
    show: false, // show on ready-to-show to avoid a white flash
    title: 'PixelForge AI',
    backgroundColor: '#09090b', // zinc-950 studio dark
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  if (stored?.isMaximized) {
    win.maximize();
  }

  // --- window management ---
  win.once('ready-to-show', () => {
    win.show();
    logger.info('window.shown');
  });
  win.on('closed', () => {
    mainWindow = null;
  });

  // --- navigation & popup hardening ---
  win.webContents.setWindowOpenHandler(({ url }) => {
    // No renderer-initiated popups; http(s) and mailto links go to the OS.
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    logger.warn('window.open.denied', { url });
    return { action: 'deny' };
  });

  const allowedPrefix = allowedNavigationPrefix(target);
  win.webContents.on('will-navigate', (event, url) => {
    // mailto: feedback links open in the OS mail client — never in-app
    if (/^mailto:/i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url);
      return;
    }
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
      logger.warn('navigation.blocked', { url, allowedPrefix });
    }
  });

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault(); // <webview> is not part of the product
    logger.warn('webview.blocked');
  });

  // --- desktop error-handling hooks (v3.1 §9.3, shell scope) ---
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) {
      logger.error('render.did-fail-load', { code, description, url });
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('render-process-gone', { ...details });
  });

  if (OPEN_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  logger.info('window.created', { target: target.kind });
  return win;
}

/** Start loading the resolved renderer target. Call AFTER installSessionHardening. */
export async function loadRenderer(win: BrowserWindow, logger: Logger): Promise<void> {
  const target = resolveRendererTarget();
  try {
    if (target.kind === 'dev-server') {
      logger.info('renderer.load', { kind: 'dev-server', url: target.url });
      await win.loadURL(target.url);
    } else {
      logger.info('renderer.load', { kind: 'shell', file: target.file });
      await win.loadFile(target.file);
    }
    logger.info('renderer.loaded', { kind: target.kind });
  } catch (err) {
    // Common cause in dev: web dev server not running on :3000.
    logger.error('renderer.load.failed', { error: String(err) });
  }
}
