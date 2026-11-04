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

/**
 * Copy text in both runtimes. Packaged Electron builds use the allowlisted
 * native clipboard bridge; browsers use the Clipboard API with a legacy
 * selection fallback for contexts where that API is unavailable.
 */
export async function copyText(text: string): Promise<void> {
  const bridge = getBridge()
  if (bridge?.clipboard?.writeText) {
    await bridge.clipboard.writeText(text)
    return
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard is unavailable')
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

/**
 * Destructive-action confirm that works on BOTH runtimes: Electron has no
 * window.confirm (it silently fails), so desktop routes to the native
 * warning dialog over the bridge; web uses the normal browser confirm.
 */
export async function desktopConfirm(message: string, detail?: string): Promise<boolean> {
  if (isDesktop()) {
    const bridge = getBridge()
    if (bridge?.project.confirm) return bridge.project.confirm(message, detail)
    return false // desktop without bridge: never guess yes on destructive ops
  }
  return window.confirm(message)
}

/**
 * OS notification for background events (approval requests, finished AI
 * jobs) the user would miss while the window is minimized/hidden. No-op on
 * web (the in-app toast already covers the foreground case) and when the
 * page is visible — never nag what the user is already looking at.
 */
export function notifyInBackground(title: string, body?: string): void {
  if (typeof document !== 'undefined' && !document.hidden) return
  const bridge = getBridge()
  if (bridge?.app?.notify) void bridge.app.notify(title, body).catch(() => undefined)
}

/**
 * Tail of today's desktop main log for bug reports (last 200 lines, capped).
 * Returns null on web or when unavailable.
 */
export async function desktopLogsTail(): Promise<{ text: string; file: string } | null> {
  const bridge = getBridge()
  if (!bridge?.app?.logsTail) return null
  try {
    const r = await bridge.app.logsTail()
    return r.ok && r.text ? { text: r.text, file: r.file ?? 'main.log' } : null
  } catch {
    return null
  }
}
