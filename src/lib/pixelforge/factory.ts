// PixelForge AI — document factories (Task 4: v2 model via @pixelforge/core).
// The core owns id generation and defaults; this module keeps the small
// renderer-facing helpers (uid for non-document ids, slugify for exports).

import { createProject as coreCreateProject } from '@pixelforge/core'
import type { Project } from './types'
import { DEFAULT_PALETTE } from './palettes'

let counter = 0
export function uid(prefix = 'id'): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`
}

export function createProject(opts: {
  name?: string
  width?: number
  height?: number
  palette?: string[]
  fps?: number
} = {}): Project {
  return coreCreateProject({
    name: opts.name ?? 'untitled',
    width: opts.width ?? 32,
    height: opts.height ?? 32,
    palette: opts.palette ?? DEFAULT_PALETTE,
    fps: opts.fps ?? 8,
    id: null,
  })
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'sprite'
  )
}
