// PixelForge AI — Electron bridge adapter (renderer side).
//
// Detects the desktop preload bridge (`window.pixelforge`, contextIsolation
// on) and adapts its allowlisted fs transport onto @pixelforge/core's FileFs
// interface. All persistence intelligence (atomic write, backups, journal,
// recovery inspection) stays in core — this file only shuttles bytes.

import type { FileFs } from '@pixelforge/core'

/** True when running inside the PixelForge Electron shell (bridge v2+). */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false
  const b = window.pixelforge
  return !!b && b.bridgeVersion >= 2 && !!b.project?.fs
}

export function getBridge(): PixelForgeBridge | null {
  if (typeof window === 'undefined') return null
  const b = window.pixelforge
  return b && b.bridgeVersion >= 2 && b.project?.fs ? b : null
}

/** Core FileFs over the session-allowlisted bridge fs transport. */
export function makeBridgeFs(): FileFs {
  const fs = getBridge()!.project.fs
  return {
    readFile: (path) => fs.readFile(path),
    writeFile: (path, data) => fs.writeFile(path, new Uint8Array(data)),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    exists: (path) => fs.exists(path),
    mkdir: (path) => fs.mkdir(path),
    listDir: (path) => fs.listDir(path),
    stat: async (path) => await fs.stat(path),
  }
}

/** Shared file-picker filters for .pixelforgeproj files. */
export const PROJECT_FILE_FILTERS = [{ name: 'PixelForge Project', extensions: ['pixelforgeproj'] }]
