// PixelForge AI — Second Brain Intelligence Layer.
//
// Provides:
//   1. Intelligent Prompt Understanding & Typo/Error Correction
//   2. Project & Session Context Awareness (clips, layers, canvas, palette, Style Lock)
//   3. Automatic Prompt Enhancement for pixel art, sprites, VFX, and animation
//   4. Continuous Improvement Memory (learned user preferences, corrections,
//      and recent IDE/agent intent history persisted locally without mutating models)

export interface BrainProjectContext {
  name: string
  width: number
  height: number
  palette: readonly string[]
  clips: ReadonlyArray<{
    id: string
    name: string
    layers: ReadonlyArray<{ id: string; name: string }>
    frames: readonly unknown[]
  }>
  settings: {
    styleProfile?: {
      enabled?: boolean
      artDirection?: string
      lighting?: string
      outline?: string
      transparentBackground?: boolean
      notes?: string
      feedback?: {
        prefer?: string[]
        avoid?: string[]
      }
    }
  }
}

export type DetectedIntent =
  | 'sprite-generation'
  | 'animation-motion'
  | 'procedural-vfx'
  | 'palette-style'
  | 'layer-pixel-edit'
  | 'project-workflow'

export interface PromptCorrection {
  from: string
  to: string
  reason: string
}

export interface InterpretedPrompt {
  originalPrompt: string
  correctedPrompt: string
  enhancedPrompt: string
  detectedIntent: DetectedIntent
  confidence: 'high' | 'medium'
  corrections: PromptCorrection[]
  inferredContext: {
    canvasSize: string
    targetClipId: string | null
    targetClipName: string | null
    targetLayerId: string | null
    targetLayerName: string | null
    recommendedTools: string[]
    motionPreset: string | null
    vfxEffect: string | null
    styleNotes: string[]
  }
  pixelArtGuidance: string[]
  reasoningSummary?: string
}

export interface BrainFeedbackEntry {
  id: string
  createdAt: string
  prompt: string
  enhancedPrompt: string
  rating: 'up' | 'down'
  note?: string
}

export interface AgentContextEvent {
  id: string
  ts: string
  source: string
  toolOrAction: string
  summary: string
}

export interface SecondBrainMemory {
  version: 1 | 2
  prefer: string[]
  avoid: string[]
  customAliases: Record<string, string>
  feedbackHistory: BrainFeedbackEntry[]
  recentContext: AgentContextEvent[]
  autoEnhancePrompts: boolean
}

const MEMORY_KEY = 'pixelforge:second-brain:memory:v1'
const MEMORY_VERSION = 2
const MAX_FEEDBACK = 40
const MAX_RECENT_CONTEXT = 25
const LEGACY_DEFAULT_PREFERENCES = [
  'crisp 1px pixel clusters',
  'clear readable silhouette',
  'consistent top-left lighting',
] as const

function defaultMemory(): SecondBrainMemory {
  return {
    version: MEMORY_VERSION,
    prefer: [
      'crisp 1px pixel clusters',
      'clear readable silhouette',
    ],
    avoid: [
      'pillow shading',
      'blurry anti-aliased edges',
      'noisy stray single pixels',
    ],
    customAliases: {},
    feedbackHistory: [],
    recentContext: [],
    autoEnhancePrompts: true,
  }
}

/**
 * Migrates the original built-in lighting preference out of saved v1 memory.
 *
 * The v1 default list always contained all three entries below. Requiring that
 * complete signature avoids removing a later, deliberate top-left preference
 * from a user whose memory has already been written in the v2 format.
 */
export function migrateSecondBrainMemory(parsed: Partial<SecondBrainMemory>): SecondBrainMemory {
  const fallback = defaultMemory()
  const prefer = Array.isArray(parsed.prefer)
    ? parsed.prefer.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 16)
    : fallback.prefer
  const isLegacyDefaultSet =
    parsed.version !== MEMORY_VERSION &&
    LEGACY_DEFAULT_PREFERENCES.every((preference) =>
      prefer.some((item) => item.toLowerCase() === preference),
    )

  return {
    version: MEMORY_VERSION,
    prefer: isLegacyDefaultSet
      ? prefer.filter((item) => item.toLowerCase() !== 'consistent top-left lighting')
      : prefer,
    avoid: Array.isArray(parsed.avoid)
      ? parsed.avoid.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 16)
      : fallback.avoid,
    customAliases:
      parsed.customAliases && typeof parsed.customAliases === 'object' && !Array.isArray(parsed.customAliases)
        ? (parsed.customAliases as Record<string, string>)
        : {},
    feedbackHistory: Array.isArray(parsed.feedbackHistory) ? parsed.feedbackHistory.slice(0, MAX_FEEDBACK) : [],
    recentContext: Array.isArray(parsed.recentContext) ? parsed.recentContext.slice(0, MAX_RECENT_CONTEXT) : [],
    autoEnhancePrompts: parsed.autoEnhancePrompts !== false,
  }
}

let cachedMemory: SecondBrainMemory | null = null
const memoryListeners = new Set<() => void>()

function notifyMemoryListeners(): void {
  for (const fn of memoryListeners) {
    try {
      fn()
    } catch {
      /* ignore listener errors */
    }
  }
}

export function subscribeBrainMemory(listener: () => void): () => void {
  memoryListeners.add(listener)
  return () => {
    memoryListeners.delete(listener)
  }
}

export function readBrainMemory(): SecondBrainMemory {
  if (cachedMemory) return cachedMemory
  if (typeof window === 'undefined') return defaultMemory()
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY)
    if (!raw) {
      cachedMemory = defaultMemory()
      return cachedMemory
    }
    const parsed = JSON.parse(raw) as Partial<SecondBrainMemory>
    cachedMemory = migrateSecondBrainMemory(parsed)
    // Persist the migration so it runs only once for this browser profile.
    // Storage quota failures must not discard the valid in-memory migration.
    try {
      window.localStorage.setItem(MEMORY_KEY, JSON.stringify(cachedMemory))
    } catch {
      /* ignore quota errors */
    }
    return cachedMemory
  } catch {
    cachedMemory = defaultMemory()
    return cachedMemory
  }
}

export function writeBrainMemory(patch: Partial<SecondBrainMemory>): SecondBrainMemory {
  const current = readBrainMemory()
  const next: SecondBrainMemory = {
    ...current,
    ...patch,
    version: MEMORY_VERSION,
    prefer: (patch.prefer ?? current.prefer).map((s) => s.trim()).filter(Boolean).slice(0, 16),
    avoid: (patch.avoid ?? current.avoid).map((s) => s.trim()).filter(Boolean).slice(0, 16),
    feedbackHistory: (patch.feedbackHistory ?? current.feedbackHistory).slice(0, MAX_FEEDBACK),
    recentContext: (patch.recentContext ?? current.recentContext).slice(0, MAX_RECENT_CONTEXT),
  }
  cachedMemory = next
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(MEMORY_KEY, JSON.stringify(next))
    } catch {
      /* ignore quota errors */
    }
  }
  notifyMemoryListeners()
  return next
}

export function addBrainPreference(kind: 'prefer' | 'avoid', cue: string): SecondBrainMemory {
  const clean = cue.trim().slice(0, 80)
  if (!clean) return readBrainMemory()
  const mem = readBrainMemory()
  const list = mem[kind]
  if (list.some((item) => item.toLowerCase() === clean.toLowerCase())) return mem
  return writeBrainMemory({ [kind]: [clean, ...list].slice(0, 16) })
}

export function removeBrainPreference(kind: 'prefer' | 'avoid', cue: string): SecondBrainMemory {
  const mem = readBrainMemory()
  return writeBrainMemory({
    [kind]: mem[kind].filter((item) => item !== cue),
  })
}

export function recordBrainFeedback(entry: Omit<BrainFeedbackEntry, 'id' | 'createdAt'>): SecondBrainMemory {
  const mem = readBrainMemory()
  const item: BrainFeedbackEntry = {
    id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    prompt: entry.prompt.slice(0, 300),
    enhancedPrompt: entry.enhancedPrompt.slice(0, 500),
    rating: entry.rating,
    ...(entry.note ? { note: entry.note.slice(0, 200) } : {}),
  }
  const nextPrefer = [...mem.prefer]
  const nextAvoid = [...mem.avoid]
  if (entry.note && entry.note.trim()) {
    const cleanNote = entry.note.trim().slice(0, 72)
    if (entry.rating === 'up' && !nextPrefer.some((x) => x.toLowerCase() === cleanNote.toLowerCase())) {
      nextPrefer.unshift(cleanNote)
    } else if (entry.rating === 'down' && !nextAvoid.some((x) => x.toLowerCase() === cleanNote.toLowerCase())) {
      nextAvoid.unshift(cleanNote)
    }
  }
  return writeBrainMemory({
    prefer: nextPrefer.slice(0, 16),
    avoid: nextAvoid.slice(0, 16),
    feedbackHistory: [item, ...mem.feedbackHistory].slice(0, MAX_FEEDBACK),
  })
}

export function recordAgentContextEvent(source: string, toolOrAction: string, summary: string): void {
  const mem = readBrainMemory()
  const evt: AgentContextEvent = {
    id: `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    ts: new Date().toISOString(),
    source: source.slice(0, 40),
    toolOrAction: toolOrAction.slice(0, 60),
    summary: summary.slice(0, 200),
  }
  writeBrainMemory({
    recentContext: [evt, ...mem.recentContext].slice(0, MAX_RECENT_CONTEXT),
  })
}

// --- memory lifecycle controls (shared-Brain phase 3) -----------------------
// User preferences (prefer/avoid/aliases) are durable learned state; the
// session context (recent agent activity) and feedback history are ephemeral
// records. Users get explicit, separate controls for each.

/** Wipe session context + feedback history, keeping learned preferences. */
export function clearBrainSessionContext(): SecondBrainMemory {
  return writeBrainMemory({ recentContext: [], feedbackHistory: [] })
}

/** Full reset: back to factory defaults (preferences included). */
export function resetBrainMemory(): SecondBrainMemory {
  const fresh = defaultMemory()
  cachedMemory = fresh
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(MEMORY_KEY, JSON.stringify(fresh))
    } catch {
      /* ignore quota errors */
    }
  }
  notifyMemoryListeners()
  return fresh
}

/** Inspectable export of the whole memory record (privacy/portability). */
export function exportBrainMemory(): string {
  return JSON.stringify(readBrainMemory(), null, 2)
}

// ---------------------------------------------------------------------------
// Dictionary of common pixel-art, animation, & IDE prompt typos / shorthand
// ---------------------------------------------------------------------------

const TYPO_MAP: Record<string, { replacement: string; reason: string }> = {
  sprit: { replacement: 'sprite', reason: 'Corrected spelling of "sprite"' },
  spirt: { replacement: 'sprite', reason: 'Corrected spelling of "sprite"' },
  spirte: { replacement: 'sprite', reason: 'Corrected spelling of "sprite"' },
  charcter: { replacement: 'character', reason: 'Corrected spelling of "character"' },
  charater: { replacement: 'character', reason: 'Corrected spelling of "character"' },
  charecter: { replacement: 'character', reason: 'Corrected spelling of "character"' },
  chracter: { replacement: 'character', reason: 'Corrected spelling of "character"' },
  aniamtion: { replacement: 'animation', reason: 'Corrected spelling of "animation"' },
  animaton: { replacement: 'animation', reason: 'Corrected spelling of "animation"' },
  animtion: { replacement: 'animation', reason: 'Corrected spelling of "animation"' },
  idlee: { replacement: 'idle', reason: 'Corrected motion preset name "idle"' },
  idel: { replacement: 'idle', reason: 'Corrected motion preset name "idle"' },
  wlak: { replacement: 'walk', reason: 'Corrected motion preset name "walk"' },
  wakl: { replacement: 'walk', reason: 'Corrected motion preset name "walk"' },
  atack: { replacement: 'attack', reason: 'Corrected motion preset name "attack"' },
  attak: { replacement: 'attack', reason: 'Corrected motion preset name "attack"' },
  attck: { replacement: 'attack', reason: 'Corrected motion preset name "attack"' },
  jmup: { replacement: 'jump', reason: 'Corrected motion preset name "jump"' },
  jupm: { replacement: 'jump', reason: 'Corrected motion preset name "jump"' },
  deth: { replacement: 'death', reason: 'Corrected motion preset name "death"' },
  daeth: { replacement: 'death', reason: 'Corrected motion preset name "death"' },
  palete: { replacement: 'palette', reason: 'Corrected spelling of "palette"' },
  pallette: { replacement: 'palette', reason: 'Corrected spelling of "palette"' },
  pallate: { replacement: 'palette', reason: 'Corrected spelling of "palette"' },
  tranparent: { replacement: 'transparent', reason: 'Corrected spelling of "transparent"' },
  transparant: { replacement: 'transparent', reason: 'Corrected spelling of "transparent"' },
  transperent: { replacement: 'transparent', reason: 'Corrected spelling of "transparent"' },
  symetry: { replacement: 'symmetry', reason: 'Corrected spelling of "symmetry"' },
  simmetry: { replacement: 'symmetry', reason: 'Corrected spelling of "symmetry"' },
  outlne: { replacement: 'outline', reason: 'Corrected spelling of "outline"' },
  outlien: { replacement: 'outline', reason: 'Corrected spelling of "outline"' },
  shadng: { replacement: 'shading', reason: 'Corrected spelling of "shading"' },
  pixle: { replacement: 'pixel', reason: 'Corrected spelling of "pixel"' },
  pxiel: { replacement: 'pixel', reason: 'Corrected spelling of "pixel"' },
   chibbi: { replacement: 'chibi', reason: 'Corrected style term "chibi"' },
  isometic: { replacement: 'isometric', reason: 'Corrected style term "isometric"' },
  warroir: { replacement: 'warrior', reason: 'Corrected spelling of "warrior"' },
  knigth: { replacement: 'knight', reason: 'Corrected spelling of "knight"' },
  kngiht: { replacement: 'knight', reason: 'Corrected spelling of "knight"' },
  skelenton: { replacement: 'skeleton', reason: 'Corrected spelling of "skeleton"' },
  exploson: { replacement: 'explosion', reason: 'Corrected VFX term "explosion"' },
  lightining: { replacement: 'lightning', reason: 'Corrected VFX term "lightning"' },
}

const SHORTHAND_EXPANSIONS: Array<{ pattern: RegExp; expand: string; reason: string }> = [
  { pattern: /\bno\s+bg\b/gi, expand: 'transparent background', reason: 'Expanded shorthand "no bg" → "transparent background"' },
  { pattern: /\btrans\s+bg\b/gi, expand: 'transparent background', reason: 'Expanded shorthand "trans bg" → "transparent background"' },
  { pattern: /\btop\s*down\b/gi, expand: 'top-down RPG view', reason: 'Clarified camera angle "top-down RPG view"' },
  { pattern: /\bside\s*view\b/gi, expand: 'side-scroller profile view', reason: 'Clarified camera angle "side-scroller profile view"' },
]

const MOTION_SYNONYMS: Array<{ preset: string; regex: RegExp }> = [
  { preset: 'idle', regex: /\b(idle|idling|breathe|breathing|stand|standing|wait|waiting|resting)\b/i },
  { preset: 'walk', regex: /\b(walk|walking|stroll|strolling|march|marching|step|stepping)\b/i },
  { preset: 'run', regex: /\b(run|running|sprint|sprinting|dash|dashing|jog|jogging|rush)\b/i },
  { preset: 'attack', regex: /\b(attack|attacking|slash|slashing|swing|swinging|strike|striking|hit|hitting|punch|punching|shoot|shooting|cast|casting)\b/i },
  { preset: 'jump', regex: /\b(jump|jumping|leap|leaping|hop|hopping|bounce|bouncing)\b/i },
  { preset: 'spin', regex: /\b(spin|spinning|twirl|twirling|rotate|rotating|whirl)\b/i },
  { preset: 'duck', regex: /\b(duck|ducking|crouch|crouching|kneel|kneeling|dodge|dodging)\b/i },
  { preset: 'hurt', regex: /\b(hurt|hurting|damage|damaged|flinch|flinching|recoil|pain)\b/i },
  { preset: 'swim', regex: /\b(swim|swimming|float|floating|dive|diving)\b/i },
  { preset: 'death', regex: /\b(death|die|dying|dead|ko|collapse|collapsing|defeat)\b/i },
]

const VFX_HINTS: Array<{ effect: string; regex: RegExp }> = [
  { effect: 'fire/campfire', regex: /\b(campfire|flame|fire|bonfire|torch)\b/i },
  { effect: 'explosions/big-explosion', regex: /\b(explosion|explode|blast|boom|bomb)\b/i },
  { effect: 'lightning/lightning-strike', regex: /\b(lightning|thunder|zap|electric|shock)\b/i },
  { effect: 'ice/frost-nova', regex: /\b(ice|frost|freeze|blizzard|snow)\b/i },
  { effect: 'arcane/portal', regex: /\b(portal|magic|arcane|spell|aura|vortex)\b/i },
  { effect: 'nature/poison-cloud', regex: /\b(poison|smoke|cloud|gas|spore)\b/i },
  { effect: 'pickups/coin-spin', regex: /\b(sparkle|coin|pickup|loot|heal|buff)\b/i },
]

export interface StarterTemplateHint {
  id:
    | 'chibi-humanoid'
    | 'slime'
    | 'rpg-sword'
    | 'potion-flask'
    | 'treasure-chest'
    | 'stone-pedestal'
    | 'topdown-tree'
    | 'dungeon-tile'
  label: string
}

const STARTER_TEMPLATE_HINTS: Array<StarterTemplateHint & { regex: RegExp }> = [
  { id: 'slime', label: 'Slime', regex: /\b(slime|blob|ooze|jelly)\b/i },
  { id: 'rpg-sword', label: 'RPG Sword', regex: /\b(sword|blade|dagger|katana|claymore|weapon)\b/i },
  { id: 'potion-flask', label: 'Potion Flask', regex: /\b(potion|flask|elixir|bottle|vial)\b/i },
  { id: 'treasure-chest', label: 'Treasure Chest', regex: /\b(chest|crate|lootbox|treasure)\b/i },
  { id: 'stone-pedestal', label: 'Stone Pedestal', regex: /\b(pedestal|altar|pillar|statue)\b/i },
  { id: 'topdown-tree', label: 'Top-down Tree', regex: /\b(tree|bush|foliage|forest|oak|pine)\b/i },
  { id: 'dungeon-tile', label: 'Dungeon Tile', regex: /\b(dungeon|brick|floor\s*tile|wall\s*tile|tileset|cobble)\b/i },
  { id: 'chibi-humanoid', label: 'Chibi Character', regex: /\b(knight|hero|warrior|mage|archer|ninja|rogue|chibi|character|humanoid|adventurer|npc|player)\b/i },
]

/** Match a rough prompt to one of PixelForge's 8 built-in hand-crafted starter templates. */
export function detectStarterTemplateHint(prompt: string): StarterTemplateHint | null {
  const clean = prompt.trim()
  if (!clean) return null
  for (const item of STARTER_TEMPLATE_HINTS) {
    if (item.regex.test(clean)) return { id: item.id, label: item.label }
  }
  return null
}

/**
 * Build a crisp, copy-paste-ready prompt for an external MCP IDE agent
 * (Claude Code, Codex, Cursor, Antigravity) carrying live project context.
 */
export function buildIdeAgentHandoffPrompt(input: {
  enhancedPrompt: string
  projectName: string
  width: number
  height: number
  clipName: string | null
  frameNumber: number
  selection: { x: number; y: number; w: number; h: number } | null
  paletteCount: number
  recommendedTools: readonly string[]
}): string {
  const lines = [
    `PixelForge AI live MCP task (project "${input.projectName}", ${input.width}x${input.height}px, ${input.paletteCount}-color palette):`,
    input.enhancedPrompt,
    '',
    `Target: clip "${input.clipName ?? 'active'}" · frame ${input.frameNumber}` +
      (input.selection
        ? ` · focus inside artist selection x:${input.selection.x} y:${input.selection.y} (${input.selection.w}x${input.selection.h})`
        : ''),
    'Workflow: call get_project_state first, stay strictly within the project palette, and draw in visible stages (silhouette → base colors → shading → outline) so I can watch live on the canvas.',
  ]
  if (input.recommendedTools.length > 0) {
    lines.push(`Suggested tools: ${input.recommendedTools.join(' -> ')}`)
  }
  return lines.join('\n')
}

export function resolveMotionPresetSynonym(input: string): string | null {
  const clean = input.trim().toLowerCase()
  for (const m of MOTION_SYNONYMS) {
    if (m.preset === clean || m.regex.test(clean)) return m.preset
  }
  return null
}

/**
 * Per-intent recommended tool chains (capability-registry-lite): curated
 * orderings over the REAL MCP tool names. When a caller passes
 * `availableTools` to interpretAndEnhancePrompt, chains are filtered against
 * it so recommendations can never name a tool the editor does not expose.
 */
export const RECOMMENDED_TOOL_CHAINS: Record<DetectedIntent, readonly string[]> = {
  'animation-motion': ['set_parts', 'apply_motion_preset', 'preview_animation'],
  'procedural-vfx': ['list_vfx', 'generate_vfx', 'preview_animation'],
  'palette-style': ['get_knowledge', 'apply_library_palette', 'set_palette'],
  'layer-pixel-edit': ['batch', 'set_pixels', 'beautify_layer', 'validate_style'],
  'sprite-generation': ['set_pixels', 'beautify_layer', 'validate_style'],
  'project-workflow': [],
}

/**
 * Case-insensitive + fuzzy lookup for clips and layers so IDE agents that pass
 * slightly different casing, extra spaces, or partial names still resolve cleanly.
 */
export function fuzzyFindByName<T extends { id: string; name: string }>(
  items: readonly T[],
  query: string,
): { item: T; corrected: boolean } | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const exact = items.find((i) => i.name === trimmed)
  if (exact) return { item: exact, corrected: false }

  const lower = trimmed.toLowerCase()
  const ci = items.find((i) => i.name.trim().toLowerCase() === lower)
  if (ci) return { item: ci, corrected: true }

  const byId = items.find((i) => i.id.toLowerCase() === lower)
  if (byId) return { item: byId, corrected: true }

  const contains = items.find(
    (i) => i.name.toLowerCase().includes(lower) || lower.includes(i.name.toLowerCase()),
  )
  if (contains) return { item: contains, corrected: true }

  return null
}

/**
 * Core deterministic + context-aware prompt interpreter and enhancer.
 * Works instantaneously for both UI and MCP tools, and pairs with Groq
 * deep analysis when the user runs "Analyze & Enhance" or "Plan".
 */
export function interpretAndEnhancePrompt(
  rawPrompt: string,
  project: BrainProjectContext,
  activePointers?: { clipId?: string; layerId?: string; frameIndex?: number },
  memoryOverride?: SecondBrainMemory,
  availableTools?: readonly string[],
): InterpretedPrompt {
  const mem = memoryOverride ?? readBrainMemory()
  const corrections: PromptCorrection[] = []
  let working = rawPrompt.trim()

  // 1. Apply custom user aliases from memory
  for (const [alias, target] of Object.entries(mem.customAliases)) {
    const rx = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    if (rx.test(working)) {
      working = working.replace(rx, target)
      corrections.push({ from: alias, to: target, reason: 'Applied learned vocabulary alias' })
    }
  }

  // 2. Token-level typo correction
  const tokens = working.split(/(\s+|[,.;:!?()[\]{}"']+)/)
  const fixedTokens = tokens.map((tok) => {
    const lower = tok.toLowerCase()
    const match = TYPO_MAP[lower]
    if (match) {
      corrections.push({ from: tok, to: match.replacement, reason: match.reason })
      return match.replacement
    }
    // Check bare 6-char hex codes missing '#'
    if (/^[0-9a-f]{6}$/i.test(tok) && !/[g-z]/i.test(tok) && /[0-9]/.test(tok) && /[a-f]/i.test(tok)) {
      const hex = `#${tok.toLowerCase()}`
      corrections.push({ from: tok, to: hex, reason: 'Normalized bare hex color to #rrggbb' })
      return hex
    }
    return tok
  })
  working = fixedTokens.join('')

  // 3. Shorthand expansions
  let expanded = working
  for (const rule of SHORTHAND_EXPANSIONS) {
    if (rule.pattern.test(expanded)) {
      const before = expanded
      expanded = expanded.replace(rule.pattern, rule.expand)
      if (expanded !== before) {
        corrections.push({ from: rule.pattern.source.replace(/\\b|\\s\+/g, ' ').trim(), to: rule.expand, reason: rule.reason })
      }
    }
  }

  // 4. Resolve explicit pronouns ("it", "this", "that", "him", "her", "them") only when a reliable project subject exists
  const wordCount = expanded.split(/\s+/).filter(Boolean).length
  const hasPronoun = /\b(it|this|that|him|her|them)\b/i.test(expanded)
  const rawProjectName = typeof project.name === 'string' ? project.name.trim() : ''
  const isGenericProjectName =
    !rawProjectName ||
    /^(untitled(\s+project|\s+sprite)?|new\s+project|default|project|sprite)$/i.test(rawProjectName)
  const projectSubject = isGenericProjectName ? null : rawProjectName
  const shouldResolveSubject = Boolean(
    hasPronoun && projectSubject && !expanded.toLowerCase().includes(projectSubject.toLowerCase()),
  )

  if (shouldResolveSubject && projectSubject) {
    corrections.push({
      from: expanded,
      to: `${expanded} (subject: "${projectSubject}")`,
      reason: `Resolved implicit subject from project context ("${projectSubject}")`,
    })
  }

  // 5. Infer active clip / layer and detect motion preset / VFX / intent
  const activeClip =
    project.clips.find((c) => c.id === activePointers?.clipId) ??
    project.clips[0] ??
    null
  const activeLayer =
    activeClip?.layers.find((l) => l.id === activePointers?.layerId) ??
    activeClip?.layers[activeClip.layers.length - 1] ??
    null

  let matchedClip = activeClip
  for (const clip of project.clips) {
    if (expanded.toLowerCase().includes(clip.name.toLowerCase())) {
      matchedClip = clip
      break
    }
  }

  const motionPreset = resolveMotionPresetSynonym(expanded)
  const vfxMatch = VFX_HINTS.find((v) => v.regex.test(expanded))?.effect ?? null

  const isClearMotionCommand =
    Boolean(motionPreset) &&
    (/\b(make|apply|animate|cycle|preset|do|play|run|start|add|create|preview|loop)\b/i.test(expanded) ||
      /^(idle|idling|walk|walking|run|running|attack|attacking|slash|slashing|jump|jumping|spin|spinning|duck|ducking|crouch|crouching|hurt|hurting|swim|swimming|death|die|dying)(\s+(cycle|preset|anim|animation|motion|loop|frames))?$/i.test(
        expanded.trim(),
      ))

  let detectedIntent: DetectedIntent = 'sprite-generation'
  if (/\b(animate|animation|motion|cycle|frames|rig|parts)\b/i.test(expanded) || isClearMotionCommand) {
    detectedIntent = 'animation-motion'
  } else if (vfxMatch && /\b(vfx|effect|particle|add|spawn|generate)\b/i.test(expanded)) {
    detectedIntent = 'procedural-vfx'
  } else if (/\b(palette|colors|colour|swatch|ramp|theme|lospec)\b/i.test(expanded)) {
    detectedIntent = 'palette-style'
  } else if (/\b(layer|pixel|outline|beautify|shade|flip|rotate|shift|mirror|erase|fill)\b/i.test(expanded)) {
    detectedIntent = 'layer-pixel-edit'
  }

  // 6. Build context-aware style notes & enhanced prompt
  const styleProfile = project.settings.styleProfile
  const styleNotes: string[] = []
  const canvasSize = `${project.width}×${project.height}`

  if (!/\b\d+\s*[x×]\s*\d+\b/i.test(expanded)) {
    styleNotes.push(`${canvasSize} pixel art canvas`)
  }
  if (styleProfile?.enabled) {
    if (styleProfile.artDirection) styleNotes.push(styleProfile.artDirection)
    styleNotes.push(`${styleProfile.lighting} lighting`)
    if (styleProfile.outline !== 'none') styleNotes.push(`${styleProfile.outline} outline`)
    if (styleProfile.transparentBackground) styleNotes.push('transparent background')
    if (styleProfile.notes) styleNotes.push(styleProfile.notes)
    if (styleProfile.feedback?.prefer?.length) {
      styleNotes.push(...styleProfile.feedback.prefer.slice(0, 3))
    }
  }

  for (const pref of mem.prefer.slice(0, 3)) {
    if (!styleNotes.some((n) => n.toLowerCase().includes(pref.toLowerCase()))) {
      styleNotes.push(pref)
    }
  }
  const avoidItems = [
    ...(styleProfile?.enabled && styleProfile.feedback?.avoid ? styleProfile.feedback.avoid : []),
    ...mem.avoid,
  ].filter(
    (item, idx, arr) => Boolean(item) && arr.findIndex((x) => x.toLowerCase() === item.toLowerCase()) === idx,
  )
  const avoidClause =
    avoidItems.length > 0 ? `avoid: ${avoidItems.slice(0, 4).join(', ')}` : ''

  const subjectPrefix =
    shouldResolveSubject && projectSubject
      ? `${projectSubject} — ${expanded}`
      : expanded

  const deduplicatedNotes = styleNotes.filter(
    (note) => !subjectPrefix.toLowerCase().includes(note.toLowerCase()),
  )

  const enhancedPrompt = [
    subjectPrefix,
    ...deduplicatedNotes,
    `palette: ${project.palette.length} colors`,
    ...(avoidClause ? [avoidClause] : []),
  ]
    .filter(Boolean)
    .join(', ')

  // 7. Recommend MCP tools & Pixel Art / Animation accuracy guidance
  // chains come from RECOMMENDED_TOOL_CHAINS; when a real catalog is passed,
  // unknown names are dropped so recommendations never invent capabilities
  const recommendedTools: string[] = availableTools
    ? RECOMMENDED_TOOL_CHAINS[detectedIntent].filter((t) => availableTools.includes(t))
    : [...RECOMMENDED_TOOL_CHAINS[detectedIntent]]
  const pixelArtGuidance: string[] = []

  if (project.width <= 32 && project.height <= 32) {
    pixelArtGuidance.push(
      `Small canvas (${canvasSize}): prioritize bold silhouette and 2–3 shade ramps per material; avoid noisy 1px details inside the body.`,
    )
  } else if (styleProfile?.enabled) {
    pixelArtGuidance.push(
      `Medium/large canvas (${canvasSize}): group pixels into clean clusters${styleProfile.outline !== 'none' ? `, keep a ${styleProfile.outline} outer outline,` : ''} and maintain consistent ${styleProfile.lighting} light.`,
    )
  } else {
    pixelArtGuidance.push(
      `Medium/large canvas (${canvasSize}): group pixels into clean clusters and maintain readable value contrast across materials.`,
    )
  }

  if (detectedIntent === 'animation-motion') {
    pixelArtGuidance.push(
      `Animation accuracy: tag body parts (head, body, armL, armR, legL, legR) on "${matchedClip?.name ?? 'idle'}", then apply preset "${motionPreset ?? 'walk'}" with edge-extend gap fill.`,
    )
  } else if (detectedIntent === 'procedural-vfx') {
    pixelArtGuidance.push(
      `VFX accuracy: use generate_vfx with effect="${vfxMatch ?? 'arcane/rune-circle'}", target="current_clip", depth="split", crispPixelArt=true, palette="project", and light=0.72 so built-in pixelfx wraps behind and in front of your sprite in your ${project.palette.length}-color palette.`,
    )
  } else if (detectedIntent === 'palette-style') {
    pixelArtGuidance.push(
      `Palette accuracy: order colors dark-to-bright and keep high value contrast between adjacent ramp steps.`,
    )
  } else if (detectedIntent === 'layer-pixel-edit') {
    pixelArtGuidance.push(
      `Layer accuracy: draw on a dedicated layer ("${activeLayer?.name ?? 'layer 1'}"), run beautify_layer for 1px outline + bottom/right shading, then verify with validate_style.`,
    )
  } else {
    pixelArtGuidance.push(
      `Sprite accuracy: center the character with a ≥1px clear border margin so animations and outlines never clip at the canvas edge.`,
    )
  }

  return {
    originalPrompt: rawPrompt,
    correctedPrompt: subjectPrefix,
    enhancedPrompt,
    detectedIntent,
    confidence: corrections.length === 0 && wordCount >= 4 ? 'high' : 'medium',
    corrections,
    inferredContext: {
      canvasSize,
      targetClipId: matchedClip?.id ?? null,
      targetClipName: matchedClip?.name ?? null,
      targetLayerId: activeLayer?.id ?? null,
      targetLayerName: activeLayer?.name ?? null,
      recommendedTools,
      motionPreset,
      vfxEffect: vfxMatch,
      styleNotes: deduplicatedNotes,
    },
    pixelArtGuidance,
  }
}
