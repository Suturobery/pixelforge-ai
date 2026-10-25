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
  },
  dialog: {
    openFile: (options) => ipcRenderer.invoke('pf:dialog-open', options ?? {}),
    saveFile: (options) => ipcRenderer.invoke('pf:dialog-save', options ?? {}),
  },
  project: {
    pickOpen: (options) => ipcRenderer.invoke('pf:project-pick-open', options ?? {}),
    pickSave: (options) => ipcRenderer.invoke('pf:project-pick-save', options ?? {}),
    registerPath: (path) => ipcRenderer.invoke('pf:project-register-path', path),
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
    // WRITE-ONLY key submission: the plaintext is forwarded once and never
    // comes back — hasKey/credentialStatus expose only booleans/metadata.
    setApiKey: (providerId, plaintext) => ipcRenderer.invoke('pf:settings-set-api-key', providerId, plaintext),
    hasKey: (providerId) => ipcRenderer.invoke('pf:settings-has-key', providerId),
    removeKey: (providerId) => ipcRenderer.invoke('pf:settings-remove-key', providerId),
    credentialStatus: () => ipcRenderer.invoke('pf:settings-credential-status'),
  },
  ai: {
    submit: (request) => ipcRenderer.invoke('pf:ai-submit', request),
    cancel: (jobId) => ipcRenderer.invoke('pf:ai-cancel', jobId),
    status: (jobId) => ipcRenderer.invoke('pf:ai-status', jobId),
    list: () => ipcRenderer.invoke('pf:ai-list'),
    usage: () => ipcRenderer.invoke('pf:ai-usage'),
    onEvent: (listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload as Parameters<typeof listener>[0]);
      ipcRenderer.on('pf:ai-event', wrapped);
      return () => ipcRenderer.removeListener('pf:ai-event', wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('pixelforge', bridge);
