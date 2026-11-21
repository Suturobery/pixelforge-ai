// PixelForge AI — project (de)serialization: JSON + PNG data URLs
//
// NOTE: the save/load pipeline lives in project-io.ts (v2 runtime ⇄ v1 JSON
// through the core importer). This module keeps the original direct helpers
// for callers that want a plain PNG-data-URL round-trip without the importer:
//   serializeProject   — v2 runtime document → v1 JSON (PNG data URL layers)
//   deserializeProject — v1 JSON → v2 runtime document (decodes the PNGs)
// Both are browser-side (PNG codec uses the canvas).

import { parseStyleProfile, SCHEMA_VERSION, type Project } from '@pixelforge/core'
import type {
  SerializedClip,
  SerializedFrame,
  SerializedLayer,
  SerializedProject,
} from './types'
import { celToPngDataUrl, pngToBuffer } from './render'

/** v2 runtime document → v1 JSON contract (PNG data URL per frame layer). */
export function serializeProject(p: Project): SerializedProject {
  const { width, height } = p
  const transparent = new Uint8ClampedArray(width * height * 4)
  const { prev, next } = p.settings.onion
  const settings = prev !== 1 || next !== 0 || p.settings.styleProfile
    ? { settings: { onion: { prev, next }, ...(p.settings.styleProfile ? { styleProfile: { ...p.settings.styleProfile } } : {}) } }
    : {}
  return {
    version: 1,
    name: p.name,
    width,
    height,
    palette: [...p.palette],
    clips: p.clips.map<SerializedClip>((c) => ({
      id: c.id,
      name: c.name,
      fps: c.fps,
      loop: c.loop,
      ...(c.loopMode !== 'forward' ? { loopMode: c.loopMode } : {}),
      ...(c.parts.length > 0
        ? {
            parts: c.parts.map((part) => ({
              name: part.name,
              layerId: part.layerId,
              ...(part.rect ? { rect: { ...part.rect } } : {}),
              anchorFrameId: part.anchorFrameId,
              z: part.z,
            })),
          }
        : {}),
      frames: c.frames.map<SerializedFrame>((f) => ({
        id: f.id,
        ...(f.durationMs > 0 ? { durationMs: f.durationMs } : {}),
        layers: c.layers.map<SerializedLayer>((l) => ({
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
  }
}

/** v1 JSON contract → v2 runtime document (PNG data URLs decoded to cels). */
export async function deserializeProject(s: SerializedProject): Promise<Project> {
  const styleProfile = parseStyleProfile(s.settings?.styleProfile)
  const clips = await Promise.all(
    s.clips.map(async (c) => {
      // classic v1 documents repeat the same layer stack on every frame —
      // the clip's v2 stack comes from the first frame that has one
      const stack = c.frames.find((f) => f.layers.length > 0)?.layers ?? []
      const layers = stack.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        linked: false,
        ...(l.locked === true ? { locked: true } : {}),
        ...(l.blend && l.blend !== 'normal' ? { blend: l.blend } : {}),
      }))
      const frames = await Promise.all(
        c.frames.map(async (f) => ({
          id: f.id,
          durationMs: f.durationMs ?? 0,
          cels: Object.fromEntries(
            await Promise.all(
              f.layers.map(async (l) => {
                const buffer = await pngToBuffer(l.png, s.width, s.height)
                return [l.id, { buffer, linked: false }] as const
              })
            )
          ),
        }))
      )
      return {
        id: c.id,
        name: c.name,
        fps: c.fps,
        loop: c.loop,
        loopMode: c.loopMode ?? ('forward' as const),
        layers,
        parts: [],
        tags: [],
        frames,
      }
    })
  )
  return {
    id: null,
    schemaVersion: SCHEMA_VERSION,
    name: s.name,
    width: s.width,
    height: s.height,
    palette: [...s.palette],
    settings: {
      paletteEnforce: false,
      ...(styleProfile ? { styleProfile } : {}),
      onion: { ...(s.settings?.onion ?? { prev: 1, next: 0 }) },
    },
    clips,
    trash: [],
  }
}

export function isSerializedProject(v: unknown): v is SerializedProject {
  const p = v as SerializedProject
  return (
    !!p &&
    typeof p === 'object' &&
    p.version === 1 &&
    typeof p.name === 'string' &&
    typeof p.width === 'number' &&
    typeof p.height === 'number' &&
    Array.isArray(p.palette) &&
    Array.isArray(p.clips)
  )
}
