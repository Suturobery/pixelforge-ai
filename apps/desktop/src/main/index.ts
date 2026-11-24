import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { registerBridgeHandlers } from '../bridge/handlers';
import { registerSettingsHandlers } from '../bridge/settings-handlers';
import { SMOKE, RENDERER_PORT } from '../config';
import { createLogger, type Logger } from '../logger';
import { RenderServer } from '../render-server';
import { McpSupervisor } from '../mcp/supervisor-core';
import { createServiceLauncher, resolveServiceDir } from '../mcp/launcher';
import { installApplicationMenu } from './menu';
import { runSmokeTest } from '../smoke';
import { installSessionHardening } from '../security';
import { SettingsStore } from '../settings/store';
import { UpdateService } from '../update/service';
import { closeStartupSplash, showStartupSplash } from '../startup-splash';
import { createMainWindow, getMainWindow, loadRenderer, persistWindowLayout } from '../window';

// Fix the product name before anything reads userData paths (logs live there).
app.setName('PixelForge AI');

// Linux dev/CI containers often run without user namespaces; never applied to
// packaged builds. PF_DISABLE_GPU is for headless xvfb runs (screenshots still work).
if (process.platform === 'linux' && !app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
if (process.env.PF_DISABLE_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu');
}

// Force the Chromium sandbox for ALL renderers (defense in depth beyond the
// per-window webPreferences; must run before app ready).
app.enableSandbox();

const logger: Logger = createLogger();

/**
 * Settings file — one instance for the app lifetime.
 * app.getPath('userData') is valid before `ready` once app.setName ran.
 */
const settingsStore: SettingsStore = new SettingsStore({
  file: path.join(app.getPath('userData'), 'settings.json'),
  fs: fs as unknown as import('../settings/store').SettingsFs,
});
const settingsLoad = settingsStore.load();
if (settingsLoad.recovered) {
  logger.warn('settings.load.recovered', { notes: settingsLoad.notes });
}

/** Task 8 (embed v1): MCP mini-service supervisor — created in whenReady. */
let mcpSupervisor: McpSupervisor | null = null;
let mcpPort = 3030;
let packagedRendererAvailable = true;

/** Packaging milestone: guarded electron-updater service (no-op without a feed). */
const updateService: UpdateService = new UpdateService(logger);

/**
 * A packaged app must not adopt whichever process happens to own :3030.  Use
 * that familiar port when it is free, otherwise select a private loopback
 * port for this launch. The actual endpoint is supplied to the renderer via
 * the trusted preload bridge, so pairing screens always show the right value.
 */
async function chooseMcpPort(): Promise<number> {
  const forced = Number(process.env.PF_MCP_PORT);
  if (Number.isInteger(forced) && forced > 0 && forced < 65_536) return forced;
  if (!app.isPackaged) return 3030;

  const available = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(3030, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  if (available) return 3030;

  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('could not reserve MCP port'))));
    });
  });
}

async function loadTrustedRenderer(win: BrowserWindow): Promise<void> {
  if (app.isPackaged && !packagedRendererAvailable) {
    const fallback = path.join(app.getAppPath(), 'static', 'shell.html');
    try {
      await win.loadFile(fallback);
      logger.info('renderer.loaded', { kind: 'shell-fallback' });
    } catch (err) {
      logger.error('renderer.fallback.failed', { error: String(err) });
    }
    return;
  }
  await loadRenderer(win, logger);
}

function installProcessErrorHandlers(): void {
  let fatalDialogShown = false;
  process.on('uncaughtException', (err) => {
    logger.error('main.uncaughtException', { stack: err?.stack ?? String(err) });
    if (!fatalDialogShown && !SMOKE) {
      fatalDialogShown = true;
      dialog.showErrorBox('PixelForge AI — unexpected error', String(err?.message ?? err));
    }
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('main.unhandledRejection', { reason: String(reason) });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch just focuses the running instance (standard desktop behavior).
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady()
    .then(async () => {
    logger.info('app.ready', {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      isDev: !app.isPackaged,
      logFile: logger.file,
    });
    installProcessErrorHandlers();
    registerBridgeHandlers(logger);
    ipcMain.handle('pf:mcp-status', () => {
      // In development the supervisor deliberately adopts an already healthy
      // local PixelForge MCP process instead of spawning another listener on
      // the same loopback port.  An adopted service is just as usable by the
      // renderer as one this Electron process started itself; reporting it as
      // unavailable prevented the editor WebSocket from ever connecting.
      const supervisorState = mcpSupervisor?.state.kind;
      const ready = supervisorState === 'running' || supervisorState === 'adopted';
      return { ready, endpoint: ready ? `http://127.0.0.1:${mcpPort}/mcp` : null };
    });
    registerSettingsHandlers(settingsStore, logger);
    updateService.register();
    updateService.scheduleStartupCheck();
    installApplicationMenu();
    // The embedded Next renderer has a noticeable cold-start cost. Present a
    // native, local splash immediately rather than exposing a black window
    // while the renderer server boots. Smoke mode skips this extra window.
    const startupSplash = SMOKE ? null : showStartupSplash(logger);

    // Task 8 (embed v1): supervise the bundled MCP mini-service so the
    // desktop app offers MCP tools without a separate terminal. Packaged
    // builds own their endpoint and move off :3030 if a different process is
    // using it; dev keeps the conventional :3030 adoption flow.
    const serviceDir = resolveServiceDir(app.getAppPath(), process.resourcesPath, app.isPackaged);
    mcpPort = await chooseMcpPort();
    logger.info('mcp.port.selected', { port: mcpPort, dynamic: app.isPackaged && mcpPort !== 3030 });
    mcpSupervisor = new McpSupervisor({
      port: mcpPort,
      adoptExisting: !app.isPackaged,
      logger: {
        log: (msg, data) => logger.info(`mcp.supervisor ${msg}`, data),
        warn: (msg, data) => logger.warn(`mcp.supervisor ${msg}`, data),
        error: (msg, data) => logger.error(`mcp.supervisor ${msg}`, data),
      },
      fetchImpl: (url, init) => fetch(url, init),
      startService: createServiceLauncher(
        serviceDir,
        app.isPackaged,
        path.join(app.getPath('userData'), 'mcp-data'),
        mcpPort,
        (err) => logger.error('mcp.launcher.error', { err: String(err) }),
      ),
    });
    void mcpSupervisor.start().then((state) => logger.info('mcp.supervisor.state', state));

    // editor-auth + mcp data dir parity: the render server (editor page) and
    // the MCP child must resolve the SAME data dir for the editor auth key
    process.env.PF_MCP_DATA_DIR ??= app.isPackaged
      ? path.join(app.getPath('userData'), 'mcp-data')
      : path.resolve(app.getAppPath(), '..', '..', 'db');

    const win = createMainWindow(logger, settingsStore, {
      onReadyToShow: () => closeStartupSplash(startupSplash, logger),
    });
    installSessionHardening(win, logger); // must precede the first navigation
    win.once('closed', () => closeStartupSplash(startupSplash, logger));

    // Task 4: packaged builds serve the REAL editor from the embedded Next
    // standalone server before the window navigates to it. PF_RENDERER=shell
    // loads static/shell.html instead — don't boot a server nothing uses.
    if (app.isPackaged && process.env.PF_RENDERER !== 'shell') {
      const renderServer = new RenderServer({
        packaged: true,
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        logger,
        port: RENDERER_PORT,
        mcpPort,
      });
      const rendererUp = await renderServer.startIfPackaged();
      packagedRendererAvailable = rendererUp;
      if (!rendererUp) {
        logger.error('render-server.unavailable', {
          fallback: 'static shell will load instead',
        });
      }
      app.on('before-quit', () => renderServer.stop());
    }

    if (SMOKE) {
      // Attaches did-finish-load/did-fail-load race BEFORE loading starts.
      void runSmokeTest(win, logger);
    }
    void loadTrustedRenderer(win);
  }).catch((err: unknown) => {
    // startup must never strand the user on the always-on-top splash —
    // surface the failure and exit instead of an unresponsive app
    logger.error('app.ready.failed', { err: String(err) });
    try {
      dialog.showErrorBox('PixelForge AI — startup failed', String((err as Error)?.message ?? err));
    } catch {
      /* headless */
    }
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Task 13a: persist the window layout before the process goes down.
  // Task 8: stop the MCP child we own (an adopted server stays with its owner).
  app.on('before-quit', () => {
    persistWindowLayout(settingsStore, logger);
    void mcpSupervisor?.stop();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
      const win = createMainWindow(logger, settingsStore);
      installSessionHardening(win, logger);
      void loadTrustedRenderer(win);
    }
  });

  logger.info('main.boot', { entry: path.basename(__filename) });
}
