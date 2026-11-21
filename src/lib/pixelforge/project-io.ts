// PixelForge AI — project I/O adapters (Task 4).
//
// Two persistence worlds, one document model:
//   • Web testbed  — the existing SQLite/Prisma rows store the v1 JSON
//     contract (per-frame layer stacks, PNG data URLs, loop:boolean). The
//     server API and the MCP tools are v1-native and stay untouched this
//     task, so the renderer converts: v1 JSON → v2 runtime on load (core
//     importer — never hand-rolled here), v2 runtime → v1 JSON on save.
//   • Desktop      — .pixelforgeproj files are v2-native via core
//     persistence (see project-files.ts). No conversion involved.
//
// v2→v1 web-testbed storage: v1 JSON keeps its exact original shape for
// classic readers, and Task 6 adds OPTIONAL metadata fields (per-frame
// durationMs, clip loopMode, document onion range) that classic v1 readers
// ignore and the v1 importer round-trips. Task 10 extends the same pattern
// to clip motion parts (v3.1 §4.1 — written only when non-empty, adopted
// only when well-formed). Still NOT representable: tags and trash (desktop
// files keep everything).
// Server payloads are v1-typed; the optional fields ride along harmlessly.

import {
  V1ProjectImporter,
  isSerializedProjectV1,
  pngDataUrlResolver,
  PersistError,
  type Project,
} from '@pixelforge/core'
import { celToPngDataUrl } from './render'
import type { SerializedProject } from './types'

/** v1 JSON (DB row) → v2 runtime document via the core importer. */
export async function importLegacyProjectJson(
  raw: unknown,
  id: string | null = null
): Promise<{ project: Project; warnings: string[] }> {
  const result = await new V1ProjectImporter().import(raw, pngDataUrlResolver, { id })
  return { project: result.project, warnings: result.warnings }
}

/**
 * v2 runtime document → v1 JSON for the web-testbed DB. Absent cels become
 * transparent PNGs so old readers never choke. Task 6 optional fields are
 * written ONLY when non-default (durationMs > 0, loopMode ≠ forward, onion
 * ≠ {1,0}) so legacy documents serialize byte-compatibly as before.
 */
export function exportLegacyProjectJson(project: Project): SerializedProject {
  const { width, height } = project
  const transparent = new Uint8ClampedArray(width * height * 4)
  const { prev, next } = project.settings.onion
  const settings =
    prev !== 1 || next !== 0 || project.settings.styleProfile
      ? {
          settings: {
            onion: { prev, next },
            ...(project.settings.styleProfile ? { styleProfile: { ...project.settings.styleProfile } } : {}),
          },
        }
      : {}
  return {
    version: 1,
    name: project.name,
    width,
    height,
    palette: [...project.palette],
    clips: project.clips.map((c) => ({
      id: c.id,
      name: c.name,
      fps: c.fps,
      loop: c.loop,
      ...(c.loopMode !== 'forward' ? { loopMode: c.loopMode } : {}),
      // OPTIONAL Task 10 extension: motion parts ride along when present
      ...(c.parts.length > 0
        ? {
            parts: c.parts.map((p) => ({
              name: p.name,
              layerId: p.layerId,
              ...(p.rect ? { rect: { ...p.rect } } : {}),
              anchorFrameId: p.anchorFrameId,
              z: p.z,
            })),
          }
        : {}),
      frames: c.frames.map((f) => ({
        id: f.id,
        ...(f.durationMs > 0 ? { durationMs: f.durationMs } : {}),
        layers: c.layers.map((l) => ({
          id: l.id,
          name: l.name,
          visible: l.visible,
          opacity: l.opacity,
          ...(l.locked ? { locked: true } : {}),
          ...(l.blend && l.blend !== 'normal' ? { blend: l.blend } : {}),
          png: celToPngDataUrl(f.cels[l.id]?.buffer ?? transparent, width, height),
        })),
      })),
    })),
    ...settings,
  } as SerializedProject
}

/** Loose v1-shape guard (server routes + dialogs) — same contract as the old serialize.ts. */
export function isSerializedProject(v: unknown): boolean {
  return isSerializedProjectV1(v)
}

/** Human-readable message for persistence failures (toasts). */
export function describePersistError(err: unknown): string {
  if (err instanceof PersistError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return 'File not found'
      case 'BAD_ZIP':
        return 'Not a valid .pixelforgeproj archive'
      case 'BAD_CHECKSUM':
        return 'File is corrupted (checksum mismatch) — try a backup'
      case 'UNSUPPORTED_VERSION':
        return 'File was written by a newer PixelForge version'
      case 'MISSING_ENTRY':
        return 'File is missing required content (cels or manifest)'
      case 'INVALID_SCHEMA':
        return 'File structure is not a PixelForge project'
      case 'DECODE_FAILED':
        return 'Pixel data could not be decoded'
      default:
        return err.message
    }
  }
  return err instanceof Error ? err.message : 'Unknown error'
}
