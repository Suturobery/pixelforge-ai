import type { PartRole, PixelGrid, Rect, Rig, SpritePart } from './types'
import { isOpaque } from './sprite'

/** Canonical z-order: far limbs behind torso/head, near limbs in front (R2). */
export const DEFAULT_Z: Record<PartRole, number> = {
  armR: 0, // far arm
  legR: 1, // far leg
  torso: 2,
  head: 3,
  legL: 4, // near leg
  armL: 5, // near arm
  custom: 2,
}

export const PART_LABELS: Record<PartRole, string> = {
  head: 'Head',
  torso: 'Torso',
  armL: 'Near arm',
  armR: 'Far arm',
  legL: 'Near leg',
  legR: 'Far leg',
  custom: 'Custom',
}

export interface RigValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Validate a rig for motion use. Warnings do not block; errors indicate a rig
 * that cannot produce sane translation-based motion.
 */
export function validateRig(rig: Rig, grid: PixelGrid): RigValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const roles = new Set(rig.parts.map((p) => p.role))

  for (const p of rig.parts) {
    const r = p.rect
    if (r.w <= 0 || r.h <= 0) errors.push(`${p.label}: empty rectangle`)
    if (r.x < 0 || r.y < 0 || r.x + r.w > grid.width || r.y + r.h > grid.height) {
      errors.push(`${p.label}: rectangle outside canvas`)
    }
    let opaque = 0
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (isOpaque(grid, x, y)) opaque++
      }
    }
    if (opaque === 0) warnings.push(`${p.label}: rectangle contains no opaque pixels`)
  }

  // Duplicate role check (one part per canonical role, except custom)
  const seen = new Set<PartRole>()
  for (const p of rig.parts) {
    if (p.role === 'custom') continue
    if (seen.has(p.role)) errors.push(`Duplicate part role: ${p.role}`)
    seen.add(p.role)
  }

  if (!roles.has('torso')) warnings.push('No torso part — upper-body motion has no anchor')
  if (!roles.has('legL') && !roles.has('legR')) {
    warnings.push('No leg parts — locomotion presets will look like sliding')
  }
  if (!roles.has('head')) warnings.push('No head part — head will stay static relative to canvas')

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Heuristic auto-rig for a standing humanoid silhouette.
 * Columns/rows are derived from the opaque bounding box. This is a convenience
 * starting point only — users are expected to adjust rectangles.
 */
export function autoRig(grid: PixelGrid): Rig {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (isOpaque(grid, x, y)) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }
  if (maxX < 0) return { parts: [] }

  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const headH = Math.max(2, Math.round(bh * 0.24))
  const legH = Math.max(2, Math.round(bh * 0.42))
  const torsoH = bh - headH - legH
  const torsoW = Math.max(2, Math.round(bw * 0.5))
  const torsoX = minX + Math.round((bw - torsoW) / 2)

  const mk = (role: PartRole, rect: Rect): SpritePart => ({
    id: role,
    role,
    label: PART_LABELS[role],
    rect,
    zOrder: DEFAULT_Z[role],
  })

  const headY = minY
  const torsoY = minY + headH
  const legsY = torsoY + torsoH

  return {
    parts: [
      mk('armR', { x: Math.max(0, torsoX - Math.max(1, Math.round(bw * 0.15))), y: torsoY, w: Math.max(1, Math.round(bw * 0.15)), h: torsoH }),
      mk('legR', { x: torsoX, y: legsY, w: Math.max(1, Math.round(torsoW / 2)), h: legH }),
      mk('torso', { x: torsoX, y: torsoY, w: torsoW, h: torsoH }),
      mk('head', { x: torsoX, y: headY, w: torsoW, h: headH }),
      mk('legL', { x: torsoX + Math.floor(torsoW / 2), y: legsY, w: Math.max(1, Math.ceil(torsoW / 2)), h: legH }),
      mk('armL', { x: torsoX + torsoW, y: torsoY, w: Math.max(1, Math.round(bw * 0.15)), h: torsoH }),
    ],
  }
}
