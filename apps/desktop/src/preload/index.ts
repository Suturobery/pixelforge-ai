/**
 * PixelForge AI — secure preload bridge (v3.1 §8.2; Task 1 + 4 + 7 + 13a + 9).
 *
 * Runs in the isolated bridge context (contextIsolation: true, sandbox: true).
 * Exposes ONE small typed allowlist object as `window.pixelforge`. The renderer
 * never receives `ipcRenderer`, Node primitives, file paths it did not pick,
 * or key material (Task 13a: API keys are write-only; main holds/encrypts;
 * Task 9: generation runs in main — the renderer only sees job views).
 * Later tasks extend this SAME object — never via raw channel strings.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type { PixelForgeBridge } from '../shared/bridge-types';

const bridge: PixelForgeBridge = {
  bridgeVersion: 5,
  ping: () => ipcRenderer.invoke('pf:ping'),
  app: {
    getInfo: () => ipcRenderer.invoke('pf:app-info'),
    /** OS notification (background events while minimized). Click focuses. */
    notify: (title, body) => ipcRenderer.invoke('pf:notify', { title, body }),
    /** Read-only tail of today's main log (diagnostics in bug reports). */
    logsTail: () => ipcRenderer.invoke('pf:logs-tail'),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('pf:clipboard-write', text),
  },
  mcp: {
    status: () => ipcRenderer.invoke('pf:mcp-status'),
    detectClients: () => ipcRenderer.invoke('pf:mcp-detect-clients'),
    installClient: (input) => ipcRenderer.invoke('pf:mcp-install-client', input),
    uninstallClient: (input) => ipcRenderer.invoke('pf:mcp-uninstall-client', input),
  },
  dialog: {
    openFile: (options) => ipcRenderer.invoke('pf:dialog-open', options ?? {}),
    saveFile: (options) => ipcRenderer.invoke('pf:dialog-save', options ?? {}),
  },
  project: {
    pickOpen: (options) => ipcRenderer.invoke('pf:project-pick-open', options ?? {}),
    pickSave: (options) => ipcRenderer.invoke('pf:project-pick-save', options ?? {}),
    openRecent: (path) => ipcRenderer.invoke('pf:project-open-recent', path),
    forgetRecent: (path) => ipcRenderer.invoke('pf:project-forget-recent', path),
    trashRecent: (path) => ipcRenderer.invoke('pf:project-trash-recent', path),
    rememberCurrentPath: (path) => ipcRenderer.invoke('pf:project-remember-current', path),
    confirm: (message, detail) => ipcRenderer.invoke('pf:confirm', { message, detail }),
    fs: {
      readFile: (path) => ipcRenderer.invoke('pf:fs-read', path),
      writeFile: (path, data) => ipcRenderer.invoke('pf:fs-write', path, data),
      rename: (from, to) => ipcRenderer.invoke('pf:fs-rename', from, to),
      unlink: (path) => ipcRenderer.invoke('pf:fs-unlink', path),
      exists: (path) => ipcRenderer.invoke('pf:fs-exists', path),
      mkdir: (path) => ipcRenderer.invoke('pf:fs-mkdir', path),
      listDir: (path) => ipcRenderer.invoke('pf:fs-listdir', path),
      stat: (path) => ipcRenderer.invoke('pf:fs-stat', path),
    },
  },
  exports: {
    pickDir: () => ipcRenderer.invoke('pf:export-pick-dir'),
  },
  settings: {
    getAll: () => ipcRenderer.invoke('pf:settings-get'),
    update: (patch) => ipcRenderer.invoke('pf:settings-update', patch ?? {}),
  },
  updates: {
    status: () => ipcRenderer.invoke('pf:app-update-status'),
    check: () => ipcRenderer.invoke('pf:app-update-check'),
    install: () => ipcRenderer.invoke('pf:app-update-install'),
    onStatus: (listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload as Parameters<typeof listener>[0]);
      ipcRenderer.on('pf:app-update-status', wrapped);
      return () => ipcRenderer.removeListener('pf:app-update-status', wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('pixelforge', bridge);
