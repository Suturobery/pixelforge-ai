// PixelForge AI - deterministic Pixel Art Recipe builder.
// The paired IDE agent draws through MCP, not through image generation.

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

export type PixelArtRecipeId = 'character' | 'enemy' | 'item' | 'tileset' | 'vfx' | 'ui-icon'

export interface PixelArtRecipe {
  id: PixelArtRecipeId
  label: string
  description: string
  defaults: Partial<AssetBriefFields>
}

export const PIXEL_ART_RECIPES: readonly PixelArtRecipe[] = [
  {
    id: 'character', label: 'Character', description: 'Readable hero silhouette and idle loop',
    defaults: { assetType: 'game character sprite', cameraAngle: 'side view', facing: 'right', poseGoal: '4-frame idle loop', detailLevel: 'medium', requiredDetails: 'readable silhouette and clear pose' },
  },
  {
    id: 'enemy', label: 'Enemy', description: 'Threat shape with an attack-ready pose',
    defaults: { assetType: 'enemy sprite', cameraAngle: 'side view', facing: 'left', poseGoal: '4-frame idle / attack-ready loop', detailLevel: 'medium', requiredDetails: 'distinct threat silhouette and readable weak point' },
  },
  {
    id: 'item', label: 'Item', description: 'Iconic single-frame collectible or prop',
    defaults: { assetType: 'game item sprite', cameraAngle: '3/4 view', facing: 'right', poseGoal: 'single frame', detailLevel: 'medium', requiredDetails: 'recognizable shape at 1x size' },
  },
  {
    id: 'tileset', label: 'Tileset', description: 'Repeatable center, edges, and corners',
    defaults: { assetType: 'environment tileset', cameraAngle: 'top-down', facing: 'front', poseGoal: 'single frame tile sheet', detailLevel: 'medium', requiredDetails: 'seamless center, edge, inner-corner, and outer-corner tiles', avoid: 'visible seams, noisy isolated pixels' },
  },
  {
    id: 'vfx', label: 'VFX', description: 'Anticipation, impact peak, then decay',
    defaults: { assetType: 'gameplay VFX sprite', cameraAngle: 'front', facing: 'front', poseGoal: '6-frame anticipation, peak, and decay animation', detailLevel: 'medium', requiredDetails: 'clear impact frame and clean decay', outline: 'selective dark outline' },
  },
  {
    id: 'ui-icon', label: 'UI Icon', description: 'Centered, high-contrast, low-detail symbol',
    defaults: { assetType: 'UI icon', cameraAngle: 'front', facing: 'front', poseGoal: 'single frame', detailLevel: 'low', requiredDetails: 'centered high-contrast symbol readable at 1x size', outline: 'dark 1px' },
  },
] as const

export function applyPixelArtRecipe(fields: AssetBriefFields, recipeId: PixelArtRecipeId): AssetBriefFields {
  const recipe = PIXEL_ART_RECIPES.find((item) => item.id === recipeId)
  return recipe ? { ...fields, ...recipe.defaults } : fields
}

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

export function defaultBriefFields(project: BriefProject, memory: Pick<SecondBrainMemory, 'avoid'>): AssetBriefFields {
  const sp = project.settings.styleProfile
  const enabled = sp?.enabled === true
  return {
    assetType: '', cameraAngle: 'side view', facing: 'right', poseGoal: 'single frame',
    colorLimit: project.palette.length,
    outline: enabled ? String(sp?.outline ?? 'dark 1px') : 'dark 1px',
    lighting: enabled ? String(sp?.lighting ?? 'top-left') : 'top-left',
    detailLevel: 'medium', references: [], requiredDetails: '',
    avoid: memory.avoid.slice(0, 4).join(', '), notes: '',
  }
}

export function buildAssetBrief(
  fields: AssetBriefFields,
  project: BriefProject,
  memory: Pick<SecondBrainMemory, 'avoid' | 'prefer'>,
): { title: string; detail: string; truncated: boolean } {
  const sp = project.settings.styleProfile
  const styleLock = sp?.enabled === true
    ? [sp.artDirection, `${sp.lighting} light`, sp.outline && sp.outline !== 'none' ? `${sp.outline} outline` : 'no forced outline', sp.transparentBackground ? 'transparent background' : '', sp.notes].filter(Boolean).join('; ')
    : 'off; follow the recipe constraints'
  const avoidItems = [...fields.avoid.split(',').map((item) => item.trim()), ...memory.avoid.map((item) => item.trim())]
    .filter((item, index, all) => item && all.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, 6)
  const animated = !/^single frame(?:\s|$)/i.test(fields.poseGoal)
    && /\d+\s*[- ]?frame|animation|cycle|walk|idle|attack|loop|vfx|effect/i.test(fields.poseGoal)
  const short = (value: string, max = 180) => value.length > max ? `${value.slice(0, max - 1)}…` : value

  const lines = [
    `PIXEL ART RECIPE - ${short(fields.assetType || 'unspecified asset', 100)}`,
    `Project "${short(project.name, 80)}" ${project.width}x${project.height}; project palette only (${project.palette.length} colors, limit ${fields.colorLimit}).`,
    `Camera ${short(fields.cameraAngle, 60)}; facing ${short(fields.facing, 30)}; goal ${short(fields.poseGoal)}.`,
    `Outline ${short(fields.outline, 80)}; light ${short(fields.lighting, 80)}; detail ${short(fields.detailLevel, 40)}.`,
    `References: ${fields.references.length ? short(fields.references.join(', ')) : 'none; create fresh'}.`,
    `Must include: ${short(fields.requiredDetails || 'clear readable form')}. Avoid: ${short(avoidItems.join('; ') || 'uncontrolled noise')}.`,
    `Style Lock: ${short(styleLock, 220)}.`,
    '',
    'EXECUTION CONTRACT - actually draw in the active PixelForge project; do not only describe or return code. No image generation or imported generated PNG.',
    '1. INSPECT: get_project_state, get_palette, and get_frame_png; bind to current ids/stateHash.',
    '2. SILHOUETTE: use fill_rect + set_pixels on a dedicated layer. Establish proportion, pose, and negative space first.',
    '3. REVIEW: inspect get_frame_png at native 1x size; revise until the silhouette reads without interior detail.',
    '4. COLOR: add compact base, shadow, and highlight clusters using project-palette colors only; avoid pillow shading and stray pixels.',
    '5. POLISH: apply controlled outline, consistent light, selective details, and clean clusters.',
    animated
      ? '6. ANIMATE: use whole-pixel movement; create frames, set_frame_duration, and set_clip_tags. Check arcs, spacing, and loop continuity.'
      : '6. COMPOSE: keep it centered/balanced and recognizable at native 1x; preserve intentional transparent space.',
    animated
      ? '7. REVIEW: run preview_animation plus get_frame_png, then validate_style. Fix timing, flicker, tangents, palette, and readability issues.'
      : '7. REVIEW: run get_frame_png and validate_style. Fix tangents, palette, composition, and 1x readability issues.',
    '8. REFINE: repeat preview and fixes until clean, then brain_complete_task with a short change summary.',
    'All canvas edits must use PixelForge MCP tools and remain undoable.',
    fields.notes ? `Artist notes: ${short(fields.notes, 300)}` : '',
  ].filter(Boolean)

  const detail = lines.join('\n')
  const LIMIT = 2000
  if (detail.length <= LIMIT) return { title: `Pixel art recipe: ${fields.assetType || 'asset'}`, detail, truncated: false }
  const marker = '\n[recipe truncated at 2000 chars; preserve execution contract]'
  return {
    title: `Pixel art recipe: ${fields.assetType || 'asset'}`,
    detail: detail.slice(0, LIMIT - marker.length) + marker,
    truncated: true,
  }
}
