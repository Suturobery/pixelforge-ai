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
  suitableAssetTypes: readonly string[]
  placeholder: string
}

export const PIXEL_ART_RECIPES: readonly PixelArtRecipe[] = [
  {
    id: 'character',
    label: 'Character',
    description: 'Readable hero silhouette and idle loop',
    defaults: {
      assetType: 'player hero / character sprite',
      cameraAngle: 'side view',
      facing: 'right',
      poseGoal: '4-frame idle loop',
      detailLevel: 'medium',
      requiredDetails: 'readable silhouette and clear pose',
      avoid: 'muddy silhouette, pillow shading',
    },
    suitableAssetTypes: [
      'player hero / character sprite',
      'friendly NPC / villager',
      'side-scroller platformer hero',
      'top-down RPG adventurer',
      'turn-based battle battler',
    ],
    placeholder: 'e.g. knight hero / rogue / wizard / villager',
  },
  {
    id: 'enemy',
    label: 'Enemy',
    description: 'Threat shape with an attack-ready pose',
    defaults: {
      assetType: 'enemy threat sprite',
      cameraAngle: 'side view',
      facing: 'left',
      poseGoal: '4-frame idle / attack-ready loop',
      detailLevel: 'medium',
      requiredDetails: 'distinct threat silhouette and readable weak point',
      avoid: 'unclear threat shape, low contrast against background',
    },
    suitableAssetTypes: [
      'melee grunt / minion',
      'ranged / flying threat',
      'boss monster',
      'dungeon crawler / beast',
      'static hazard / sentry',
    ],
    placeholder: 'e.g. slime minion / skeleton archer / dragon boss',
  },
  {
    id: 'item',
    label: 'Item',
    description: 'Iconic single-frame collectible or prop',
    defaults: {
      assetType: 'game item / collectible',
      cameraAngle: '3/4 view',
      facing: 'right',
      poseGoal: 'single frame',
      detailLevel: 'medium',
      requiredDetails: 'recognizable shape at 1x size',
      avoid: 'overly complex interior lines at small scale',
    },
    suitableAssetTypes: [
      'consumable potion / food',
      'weapon / sword / staff',
      'armor / shield / helmet',
      'treasure chest / gold key',
      'quest artifact / relic',
    ],
    placeholder: 'e.g. health potion / iron broadsword / gold key',
  },
  {
    id: 'tileset',
    label: 'Tileset',
    description: 'Repeatable center, edges, and corners',
    defaults: {
      assetType: 'environment tileset (wall & floor)',
      cameraAngle: 'top-down',
      facing: 'front',
      poseGoal: 'single frame tile sheet',
      detailLevel: 'medium',
      requiredDetails: 'seamless center, edge, inner-corner, and outer-corner tiles',
      avoid: 'visible seams, noisy isolated pixels',
    },
    suitableAssetTypes: [
      'dungeon wall & floor autotile',
      'platformer ground & ledges',
      'overworld terrain (grass, dirt, water)',
      'interior building & furniture tiles',
      'sci-fi / metal facility tiles',
    ],
    placeholder: 'e.g. dungeon brick wall & floor / platformer grass ledge',
  },
  {
    id: 'vfx',
    label: 'VFX',
    description: 'Anticipation, impact peak, then decay',
    defaults: {
      assetType: 'gameplay VFX sprite',
      cameraAngle: 'front',
      facing: 'front',
      poseGoal: '6-frame anticipation, peak, and decay animation',
      detailLevel: 'medium',
      requiredDetails: 'clear impact frame and clean decay',
      outline: 'selective dark outline',
      avoid: 'static lingering frames, inconsistent light burst',
    },
    suitableAssetTypes: [
      'impact & hit spark',
      'explosion & blast burst',
      'melee slash & swipe trail',
      'magic spell & fireball projectile',
      'smoke puff / jump dust',
    ],
    placeholder: 'e.g. fireball burst / sword slash / jump dust',
  },
  {
    id: 'ui-icon',
    label: 'UI Icon',
    description: 'Centered, high-contrast, low-detail symbol',
    defaults: {
      assetType: 'UI icon / status badge',
      cameraAngle: 'front',
      facing: 'front',
      poseGoal: 'single frame',
      detailLevel: 'low',
      requiredDetails: 'centered high-contrast symbol readable at 1x size',
      outline: 'dark 1px',
      avoid: 'subtle low-contrast borders, unreadable shapes at 1x',
    },
    suitableAssetTypes: [
      'health / heart container',
      'mana / energy crystal',
      'ability / skill spell badge',
      'currency / gold coin',
      'inventory item glyph',
    ],
    placeholder: 'e.g. heart life / shield armor / gold coin',
  },
] as const

export function detectRecipeSuitability(assetType: string): PixelArtRecipeId | null {
  const lower = assetType.toLowerCase()
  if (!lower.trim()) return null
  if (/tile|terrain|wall|floor|ledge|autotile|scenery|brick|platform/i.test(lower)) return 'tileset'
  if (/vfx|fx|explosion|spark|burst|slash|smoke|fireball|spell|flame|impact|blast/i.test(lower)) return 'vfx'
  if (/icon|ui|badge|heart|mana|coin|glyph|button|inventory|currency/i.test(lower)) return 'ui-icon'
  if (/enemy|boss|monster|beast|threat|minion|slime|crawler|hazard|sentry/i.test(lower)) return 'enemy'
  if (/item|weapon|sword|potion|prop|chest|key|loot|relic|armor|shield|staff|consumable|food/i.test(lower)) return 'item'
  if (/hero|character|player|npc|villager|protagonist|warrior|rogue|wizard|knight|battler/i.test(lower)) return 'character'
  return null
}

export function applyPixelArtRecipe(fields: AssetBriefFields, recipeId: PixelArtRecipeId): AssetBriefFields {
  const recipe = PIXEL_ART_RECIPES.find((item) => item.id === recipeId)
  if (!recipe) return fields

  // When switching recipe, always ensure assetType is updated to a suitable type for the new recipe
  // if current assetType is empty, generic, or belongs to a different recipe category.
  const currentCategory = detectRecipeSuitability(fields.assetType)
  const isGeneric =
    !fields.assetType.trim() ||
    fields.assetType === 'game character sprite' ||
    fields.assetType === 'enemy sprite' ||
    fields.assetType === 'game item sprite' ||
    fields.assetType === 'environment tileset' ||
    fields.assetType === 'gameplay VFX sprite' ||
    fields.assetType === 'UI icon' ||
    PIXEL_ART_RECIPES.some((r) => r.defaults.assetType === fields.assetType)

  const shouldReplaceAssetType = isGeneric || (currentCategory !== null && currentCategory !== recipeId)
  const targetAssetType = shouldReplaceAssetType
    ? (recipe.defaults.assetType ?? fields.assetType)
    : fields.assetType

  return {
    ...fields,
    ...recipe.defaults,
    assetType: targetAssetType,
  }
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
      anchor?: {
        label: string
        spriteWidth: number
        spriteHeight: number
        bottomMargin: number
        outlineStyle: string
      }
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
  const detectedRecipe = detectRecipeSuitability(fields.assetType)
  const knowledgeTopic =
    detectedRecipe === 'tileset' ? 'tileset'
    : detectedRecipe === 'vfx' ? 'vfx'
    : detectedRecipe === 'character' || detectedRecipe === 'enemy' ? 'characters'
    : 'methodology'
  const short = (value: string, max = 180) => value.length > max ? `${value.slice(0, max - 1)}…` : value

  const anchorLine = sp?.anchor
    ? `Hero Style Anchor "${short(sp.anchor.label, 48)}": match ${sp.anchor.spriteWidth}x${sp.anchor.spriteHeight}px silhouette, ground margin ${sp.anchor.bottomMargin}px, ${sp.anchor.outlineStyle} outline.`
    : ''
  const headerLines = [
    `PIXEL ART RECIPE - ${short(fields.assetType || 'unspecified asset', 100)}`,
    `Project "${short(project.name, 80)}" ${project.width}x${project.height}; project palette only (${project.palette.length} colors, limit ${fields.colorLimit}).`,
    `Camera ${short(fields.cameraAngle, 60)}; facing ${short(fields.facing, 30)}; goal ${short(fields.poseGoal)}.`,
    `Outline ${short(fields.outline, 80)}; light ${short(fields.lighting, 80)}; detail ${short(fields.detailLevel, 40)}.`,
    `References: ${fields.references.length ? short(fields.references.join(', '), 120) : 'none; create fresh'}.`,
    `Must include: ${short(fields.requiredDetails || 'clear readable form', 140)}. Avoid: ${short(avoidItems.join('; ') || 'uncontrolled noise', 140)}.`,
    `Style Lock: ${short(styleLock, 180)}.`,
    ...(anchorLine ? [anchorLine] : []),
  ]
  const contractLines = [
    'EXECUTION CONTRACT - actually draw in the active PixelForge project; do not only describe or return code. No image generation or imported generated PNG.',
    `1. INSPECT: get_project_state, get_palette, get_frame_png, get_knowledge (${knowledgeTopic}, shade); bind ids/stateHash.`,
    '2. SILHOUETTE: block organic forms with draw_ellipse, draw_polygon, draw_line, flood_fill, set_pixels on dedicated layers (avoid boxy shapes).',
    '3. REVIEW: inspect get_frame_png(scale=8, showGrid=true) and get_frame_png at native 1x size; revise silhouette before shading.',
    '4. COLOR: add hue-shifted base, shadow, and warm top-left highlight clusters using project-palette colors only; avoid pillow shading and stray pixels.',
    '5. POLISH: apply selective colored outlines (beautify_layer selOut=true, cleanDoubles=true, paletteLock=true) and run analyze_pixel_craft.',
    animated
      ? '6. ANIMATE: use whole-pixel movement & follow-through; create frames, set_frame_duration, set_clip_tags. Check arcs, spacing, and loop continuity.'
      : '6. COMPOSE: keep it centered/balanced and recognizable at native 1x; preserve intentional transparent space.',
    animated
      ? '7. REVIEW: run preview_animation + get_frame_png(scale=8), analyze_pixel_craft, validate_style. Fix timing, flicker, doubles, palette, readability.'
      : '7. REVIEW: run get_frame_png(scale=8), analyze_pixel_craft, validate_style. Fix doubles, jaggies, palette, and 1x readability.',
    '8. REFINE: repeat preview and fixes until clean, then brain_complete_task with a short change summary.',
    'All canvas edits must use PixelForge MCP tools and remain undoable.',
  ]
  const notesLine = fields.notes ? `Artist notes: ${short(fields.notes, 300)}` : ''
  const lines = [...headerLines, '', ...contractLines, ...(notesLine ? [notesLine] : [])]

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
