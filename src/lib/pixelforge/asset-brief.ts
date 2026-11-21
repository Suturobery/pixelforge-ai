// PixelForge AI — Asset Brief builder (subscription-only product).
//
// Turns artist-facing form fields + active-project context (canvas, palette,
// Style Lock, learned avoid-cues) into a deterministic, structured work brief
// for the task board. NO model call, NO provider request: the brief is plain
// text handed to a connected IDE agent via brain-push (or clipboard
// fallback). The agent executes it with the normal editor tools, so every
// resulting edit stays on the canvas and undoable.

import type { SecondBrainMemory } from '@/lib/pixelforge/second-brain-intelligence'

export interface AssetBriefFields {
  assetType: string
  cameraAngle: string
  facing: string
  poseGoal: string
  colorLimit: number
  outline: string
  lighting: string
  detailLevel: string
  references: string[]
  requiredDetails: string
  avoid: string
  notes: string
}

/** Minimal project slice the brief needs (structural — avoids a store import). */
export interface BriefProject {
  name: string
  width: number
  height: number
  palette: readonly string[]
  clips: ReadonlyArray<{ name: string; frames: readonly unknown[] }>
  settings: {
    styleProfile?: {
      enabled?: boolean
      artDirection?: string
      lighting?: string
      outline?: string
      transparentBackground?: boolean
      notes?: string
    }
  }
}

/** Field defaults from the active project + Style Lock (+ learned avoid cues). */
export function defaultBriefFields(
  project: BriefProject,
  memory: Pick<SecondBrainMemory, 'avoid'>,
): AssetBriefFields {
  const sp = project.settings.styleProfile
  const enabled = sp?.enabled === true
  return {
    assetType: '',
    cameraAngle: 'side view',
    facing: 'right',
    poseGoal: 'single frame',
    colorLimit: project.palette.length,
    outline: enabled ? String(sp?.outline ?? 'dark 1px') : 'dark 1px',
    lighting: enabled ? String(sp?.lighting ?? 'top-left') : 'top-left',
    detailLevel: 'medium',
    references: [],
    requiredDetails: '',
    avoid: memory.avoid.slice(0, 4).join(', '),
    notes: '',
  }
}

/** Compose the task-board payload. Deterministic; detail is capped at 2000
 * chars to match the board's storage cap (truncation is marked in-text). */
export function buildAssetBrief(
  fields: AssetBriefFields,
  project: BriefProject,
  memory: Pick<SecondBrainMemory, 'avoid' | 'prefer'>,
): { title: string; detail: string; truncated: boolean } {
  const sp = project.settings.styleProfile
  const styleLock =
    sp?.enabled === true
      ? [
          sp.artDirection,
          `${sp.lighting} light`,
          sp.outline && sp.outline !== 'none' ? `${sp.outline} outline` : 'no forced outline',
          sp.transparentBackground ? 'transparent background' : '',
          sp.notes,
        ]
          .filter(Boolean)
          .join('; ')
      : 'off (follow the constraints above)'

  // split comma-separated form cues so they dedupe individually against the
  // learned memory cues (case-insensitive), then cap the list
  const avoidItems = [
    ...fields.avoid.split(',').map((a) => a.trim()),
    ...memory.avoid.map((a) => a.trim()),
  ]
    .filter((a, i, arr) => a && arr.findIndex((x) => x.toLowerCase() === a.toLowerCase()) === i)
    .slice(0, 6)

  const lines = [
    `ASSET BRIEF — ${fields.assetType || 'unspecified asset'}`,
    `Project "${project.name}" ${project.width}×${project.height} · palette: project (${project.palette.length} colors, limit ${fields.colorLimit})`,
    `Camera: ${fields.cameraAngle} · Facing: ${fields.facing} · Pose/Animation: ${fields.poseGoal}`,
    `Outline: ${fields.outline} · Lighting: ${fields.lighting} · Detail level: ${fields.detailLevel}`,
    `References: ${fields.references.length ? fields.references.join(', ') : 'none — create fresh'}`,
    `Must include: ${fields.requiredDetails || '—'}`,
    `Avoid: ${avoidItems.join('; ') || '—'}`,
    `Style Lock: ${styleLock}`,
    fields.notes ? `Notes: ${fields.notes}` : '',
    '',
    'Workflow (PixelForge MCP tools ONLY — no image generation exists):',
    '1. get_project_state; treat ids/stateHash as binding.',
    '2. Draw with set_pixels / beautify_layer on a dedicated layer; use the project palette only.',
    fields.poseGoal.toLowerCase().includes('frame') || /animation|cycle|walk|idle|attack/.test(fields.poseGoal)
      ? '3. Animate with set_parts + apply_motion_preset (or explicit frames); verify with preview_animation invariants.'
      : '3. If the asset is a procedural effect, use list_vfx + generate_vfx (seeded, project palette).',
    '4. validate_style before finishing; then brain_complete_task with a short summary.',
    'All edits are undoable; the artist reviews on-canvas.',
  ].filter((l) => l !== '')

  const detail = lines.join('\n')
  const LIMIT = 2000
  if (detail.length <= LIMIT) return { title: `Asset brief: ${fields.assetType || 'asset'}`, detail, truncated: false }
  return {
    title: `Asset brief: ${fields.assetType || 'asset'}`,
    detail: detail.slice(0, LIMIT - 30) + '\n[brief truncated at 2000 chars — see artist notes]',
    truncated: true,
  }
}
