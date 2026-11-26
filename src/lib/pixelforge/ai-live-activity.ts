// PixelForge AI — Live AI Artist activity bus (visual overlay, progressive reveal,
// activity feed, Artist Priority pause, auto-follow toggle, and Before/After compare).
//
// Keeps 60fps canvas animation state OUTSIDE Zustand so AI brush trails,
// progressive pixel reveals, and the moving AI artist cursor never re-render the
// editor tree. Zero effect on CommandBus, undo history, or document bytes.

export interface AiPixelPoint {
  x: number
  y: number
}

export interface AiPixelBBox {
  x: number
  y: number
  w: number
  h: number
}

export interface AiRevealData {
  clipId: string
  frameId: string
  width: number
  height: number
  before: Uint8ClampedArray
  after: Uint8ClampedArray
  /** Full serpentine-ordered linear pixel indices (y * width + x) for progressive reveal. */
  orderedIndices: Uint32Array
}

export interface AiDrawPulse {
  id: number
  clientName: string
  tool: string
  label: string
  clipId?: string
  frameId?: string
  pixels: AiPixelPoint[]
  totalChanged: number
  bbox: AiPixelBBox | null
  startedAt: number
  durationMs: number
  /** Progressive reveal payload (cleared automatically once revealed, superseded, or cancelled). */
  reveal?: AiRevealData
  /** True for region-focus flashes (e.g. clicking an activity row) — renders brackets only, no cursor. */
  highlightOnly?: boolean
}

export type AiBannerTone = 'live' | 'waiting' | 'error'

export interface AiLiveBanner {
  clientName: string
  tool: string
  label: string
  busy: boolean
  tone: AiBannerTone
  totalChanged?: number
  clipId?: string
  frameId?: string
  clipName?: string
  frameNumber?: number
  /** True when the edit landed on a clip/frame the artist is not currently viewing. */
  offView?: boolean
  /** Feed entry id linked to this finished action (enables 1-click Undo / Compare on the pill). */
  entryId?: number
  updatedAt: number
  expiresAt: number
}

export interface AiCompareSnapshot {
  clipId: string
  frameId: string
  width: number
  height: number
  before: Uint8ClampedArray
  /** Kept alongside `before` on the latest 3 visual edits for 1-click live stroke replay. */
  after?: Uint8ClampedArray
  orderedIndices?: Uint32Array
  pixels?: AiPixelPoint[]
}

export interface AiActivityEntry {
  id: number
  clientName: string
  tool: string
  label: string
  ok: boolean
  status: 'ok' | 'error' | 'paused' | 'busy'
  at: number
  totalChanged: number
  clipId?: string
  frameId?: string
  clipName?: string
  frameNumber?: number
  bbox: AiPixelBBox | null
  /** CommandBus undo depth right after this edit landed (for safe per-step Undo). */
  undoDepthAfter?: number
  /** Editor loadEpoch when this edit landed (prevents cross-project undo). */
  loadEpoch?: number
  /** True once a newer edit branched the history stack past this entry or project reset. */
  undoInvalidated?: boolean
  /** Kept only on the 3 most recent visual edits for instant Before/After canvas peek. */
  compare?: AiCompareSnapshot
}

export interface AiComparePreview {
  entryId: number
  clipId: string
  frameId: string
  width: number
  height: number
  before: Uint8ClampedArray
  label: string
}

export interface AiLiveSnapshot {
  banner: AiLiveBanner | null
  pulses: readonly AiDrawPulse[]
  feed: readonly AiActivityEntry[]
  paused: boolean
  autoFollow: boolean
  comparePreview: AiComparePreview | null
}

const MAX_SAMPLED_PIXELS = 900
const MAX_ACTIVE_PULSES = 8
const MAX_FEED_ENTRIES = 16
const MAX_COMPARE_SNAPSHOTS = 3
const IDLE_BANNER_MS = 3_600
const NOTICE_BANNER_MS = 2_400

let nextPulseId = 1
let nextEntryId = 1
let activeBanner: AiLiveBanner | null = null
let activePulses: AiDrawPulse[] = []
let activityFeed: AiActivityEntry[] = []
let aiPaused = false
let aiAutoFollow = true
let activeCompare: AiComparePreview | null = null
let bannerClearTimer: ReturnType<typeof setTimeout> | null = null
let lastBusyNoticeAt = 0
const listeners = new Set<() => void>()

let cachedSnapshot: AiLiveSnapshot = {
  banner: null,
  pulses: [],
  feed: [],
  paused: false,
  autoFollow: true,
  comparePreview: null,
}

function notify(): void {
  const now = Date.now()
  activePulses = activePulses.filter((p) => now - p.startedAt < p.durationMs + 250)
  if (activeBanner && !activeBanner.busy && now >= activeBanner.expiresAt) {
    activeBanner = null
  }
  cachedSnapshot = {
    banner: activeBanner ? { ...activeBanner } : null,
    pulses: activePulses.slice(),
    feed: activityFeed.slice(),
    paused: aiPaused,
    autoFollow: aiAutoFollow,
    comparePreview: activeCompare ? { ...activeCompare } : null,
  }
  for (const fn of listeners) fn()
}

export function subscribeAiActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAiActivitySnapshot(): AiLiveSnapshot {
  return cachedSnapshot
}

const TOOL_VERBS: Record<string, string> = {
  set_pixels: 'Painting pixels',
  fill_rect: 'Drawing rectangle',
  draw_line: 'Drawing line',
  draw_ellipse: 'Drawing ellipse',
  draw_polygon: 'Drawing shape',
  flood_fill: 'Flood filling',
  replace_color: 'Swapping color',
  remap_palette: 'Remapping palette',
  beautify_layer: 'Polishing pixel art',
  generate_template: 'Placing starter template',
  generate_vfx: 'Generating pixel VFX',
  apply_motion_preset: 'Animating motion preset',
  import_image_as_layer: 'Importing sprite layer',
  import_frame_strip: 'Importing animation strip',
  create_skin_variants: 'Generating skin variants',
  resize_canvas: 'Resizing canvas',
  auto_trim: 'Trimming canvas',
  merge_down: 'Merging layer down',
  set_layer_props: 'Updating layer & Live FX',
  delete_layer: 'Deleting layer',
  set_vectors: 'Editing pixel-perfect vectors',
  bake_vectors: 'Baking vectors to pixels',
  generate_hue_ramp: 'Generating hue-shifted ramp',
  batch: 'Running drawing batch',
  macro_run: 'Running macro',
  get_project_state: 'Inspecting canvas',
  get_frame_png: 'Reviewing sprite',
  validate_style: 'Checking style rules',
  analyze_pixel_craft: 'Checking pixel craft',
  validate_asset_set: 'Checking asset set',
}

export function describeAiTool(tool: string): string {
  return TOOL_VERBS[tool] ?? tool.replace(/_/g, ' ')
}

export function isAiPaused(): boolean {
  return aiPaused
}

export function setAiPaused(paused: boolean): void {
  if (aiPaused === paused) return
  aiPaused = paused
  notify()
}

export function isAiAutoFollow(): boolean {
  return aiAutoFollow
}

export function setAiAutoFollow(follow: boolean): void {
  if (aiAutoFollow === follow) return
  aiAutoFollow = follow
  notify()
}

export function setAiComparePreview(entryId: number | null): void {
  if (entryId === null) {
    if (!activeCompare) return
    activeCompare = null
    notify()
    return
  }
  const entry = activityFeed.find((e) => e.id === entryId)
  if (!entry?.compare) return
  activeCompare = {
    entryId: entry.id,
    clipId: entry.compare.clipId,
    frameId: entry.compare.frameId,
    width: entry.compare.width,
    height: entry.compare.height,
    before: entry.compare.before,
    label: entry.label,
  }
  notify()
}

export function clearAiActivityFeed(): void {
  activityFeed = []
  activeCompare = null
  notify()
}

/** Immediately finish any active progressive pixel reveals & before/after peeks. */
export function finishActiveReveals(): void {
  let changed = false
  if (activeCompare) {
    activeCompare = null
    changed = true
  }
  for (const p of activePulses) {
    if (p.reveal) {
      p.reveal = undefined
      changed = true
    }
  }
  if (changed) notify()
}

export function beginAiToolActivity(clientName: string, tool: string): void {
  if (bannerClearTimer) {
    clearTimeout(bannerClearTimer)
    bannerClearTimer = null
  }
  const now = Date.now()
  activeBanner = {
    clientName: clientName.trim() || 'AI Agent',
    tool,
    label: `${describeAiTool(tool)}…`,
    busy: true,
    tone: 'live',
    updatedAt: now,
    expiresAt: now + 30_000,
  }
  notify()
}

export function emitAiNotice(
  clientName: string,
  tool: string,
  label: string,
  tone: 'waiting' | 'error' = 'waiting',
): void {
  const now = Date.now()
  if (tone === 'waiting' && now - lastBusyNoticeAt < 900) return
  if (tone === 'waiting') lastBusyNoticeAt = now
  if (bannerClearTimer) {
    clearTimeout(bannerClearTimer)
    bannerClearTimer = null
  }
  activeBanner = {
    clientName: clientName.trim() || 'AI Agent',
    tool,
    label,
    busy: false,
    tone,
    updatedAt: now,
    expiresAt: now + NOTICE_BANNER_MS,
  }
  bannerClearTimer = setTimeout(() => {
    bannerClearTimer = null
    notify()
  }, NOTICE_BANNER_MS + 40)
  notify()
}

export function emitAiDrawPulse(input: {
  clientName: string
  tool: string
  label: string
  clipId?: string
  frameId?: string
  pixels: AiPixelPoint[]
  totalChanged?: number
  bbox: AiPixelBBox | null
  durationMs?: number
  reveal?: AiRevealData
  highlightOnly?: boolean
}): void {
  if (input.pixels.length === 0 && !input.bbox) return
  const now = Date.now()
  // Supersede any in-flight reveal on the same frame so rapid staged strokes chain cleanly
  if (input.reveal) {
    for (const prev of activePulses) {
      if (
        prev.reveal &&
        prev.reveal.clipId === input.reveal.clipId &&
        prev.reveal.frameId === input.reveal.frameId
      ) {
        prev.reveal = undefined
      }
    }
  }
  const durationMs =
    input.durationMs ??
    Math.min(1_050, Math.max(520, 460 + Math.round(Math.sqrt(input.pixels.length) * 18)))
  const pulse: AiDrawPulse = {
    id: nextPulseId++,
    clientName: input.clientName.trim() || 'AI Agent',
    tool: input.tool,
    label: input.label,
    clipId: input.clipId ?? input.reveal?.clipId,
    frameId: input.frameId ?? input.reveal?.frameId,
    pixels: input.pixels,
    totalChanged: input.totalChanged ?? input.pixels.length,
    bbox: input.bbox,
    startedAt: now,
    durationMs,
    reveal: input.reveal,
    highlightOnly: input.highlightOnly,
  }
  activePulses = [...activePulses.slice(-(MAX_ACTIVE_PULSES - 1)), pulse]
  notify()
}

/** Briefly flash corner brackets around a historical AI edit's bbox on the canvas. */
export function flashAiRegion(entryId: number): void {
  const entry = activityFeed.find((e) => e.id === entryId)
  if (!entry?.bbox) return
  emitAiDrawPulse({
    clientName: entry.clientName,
    tool: entry.tool,
    label: entry.label,
    clipId: entry.clipId,
    frameId: entry.frameId,
    pixels: [],
    totalChanged: entry.totalChanged,
    bbox: entry.bbox,
    durationMs: 780,
    highlightOnly: true,
  })
}

/** Replay the progressive brush-sweep animation for a recent visual AI edit. */
export function replayAiActivityEntry(entryId: number): boolean {
  const entry = activityFeed.find((e) => e.id === entryId)
  const cmp = entry?.compare
  if (!entry || !cmp || !cmp.after || !cmp.orderedIndices || !cmp.pixels) return false
  activeCompare = null
  emitAiDrawPulse({
    clientName: entry.clientName,
    tool: entry.tool,
    label: entry.label,
    clipId: cmp.clipId,
    frameId: cmp.frameId,
    pixels: cmp.pixels,
    totalChanged: entry.totalChanged,
    bbox: entry.bbox,
    reveal: {
      clipId: cmp.clipId,
      frameId: cmp.frameId,
      width: cmp.width,
      height: cmp.height,
      before: cmp.before,
      after: cmp.after,
      orderedIndices: cmp.orderedIndices,
    },
  })
  return true
}

export function recordAiActivityEntry(input: {
  clientName: string
  tool: string
  label: string
  ok: boolean
  status?: 'ok' | 'error' | 'paused' | 'busy'
  totalChanged?: number
  clipId?: string
  frameId?: string
  clipName?: string
  frameNumber?: number
  bbox?: AiPixelBBox | null
  undoDepthAfter?: number
  loadEpoch?: number
  compare?: AiCompareSnapshot
}): number {
  const entry: AiActivityEntry = {
    id: nextEntryId++,
    clientName: input.clientName.trim() || 'AI Agent',
    tool: input.tool,
    label: input.label.trim() || describeAiTool(input.tool),
    ok: input.ok,
    status: input.status ?? (input.ok ? 'ok' : 'error'),
    at: Date.now(),
    totalChanged: input.totalChanged ?? 0,
    clipId: input.clipId,
    frameId: input.frameId,
    clipName: input.clipName,
    frameNumber: input.frameNumber,
    bbox: input.bbox ?? null,
    undoDepthAfter: input.undoDepthAfter,
    loadEpoch: input.loadEpoch,
    compare: input.compare,
  }
  activityFeed = [entry, ...activityFeed].slice(0, MAX_FEED_ENTRIES)
  // Keep raw RGBA before-buffers only on the newest visual entries to keep RAM tiny
  let compareKept = 0
  for (const item of activityFeed) {
    if (!item.compare) continue
    compareKept += 1
    if (compareKept > MAX_COMPARE_SNAPSHOTS) {
      item.compare = undefined
    }
  }
  notify()
  return entry.id
}

/**
 * Sync activity-feed undo eligibility with CommandBus history transitions.
 * When a new command pushes at `prevUndoDepth`, any feed entry whose
 * `undoDepthAfter > prevUndoDepth` belonged to the overwritten redo branch
 * and is marked invalidated so we never undo the wrong step.
 */
export function notifyAiHistoryChanged(
  kind: 'push' | 'undone' | 'redone' | 'reset',
  prevUndoDepth: number,
  nextUndoDepth: number,
  loadEpoch: number,
): void {
  if (activityFeed.length === 0 && !activeCompare) return
  let changed = false
  if (kind === 'reset') {
    for (const item of activityFeed) {
      if (!item.undoInvalidated) {
        item.undoInvalidated = true
        item.compare = undefined
        changed = true
      }
    }
    if (activeCompare) {
      activeCompare = null
      changed = true
    }
  } else if (kind === 'push') {
    // A new command branched history at prevUndoDepth (or trimmed old entries)
    for (const item of activityFeed) {
      if (item.undoInvalidated || item.undoDepthAfter === undefined) continue
      if (item.loadEpoch !== loadEpoch || item.undoDepthAfter > prevUndoDepth) {
        item.undoInvalidated = true
        changed = true
      }
    }
    if (nextUndoDepth <= prevUndoDepth) {
      // History budget evicted oldest entries; depths shifted
      for (const item of activityFeed) {
        if (item.undoDepthAfter !== undefined && !item.undoInvalidated) {
          item.undoInvalidated = true
          changed = true
        }
      }
    }
  }
  if (changed) notify()
}

/**
 * Return how many CommandBus `undo()` steps are needed to revert `entry`
 * (including any newer edits stacked above it), or `null` if not safely undoable.
 */
export function getUndoStepsForAiEntry(
  entry: AiActivityEntry,
  currentUndoDepth: number,
  currentLoadEpoch: number,
): number | null {
  if (entry.undoInvalidated || entry.undoDepthAfter === undefined) return null
  if (entry.loadEpoch !== currentLoadEpoch) return null
  if (entry.undoDepthAfter <= 0 || entry.undoDepthAfter > currentUndoDepth) return null
  return currentUndoDepth - entry.undoDepthAfter + 1
}

export function endAiToolActivity(
  clientName: string,
  tool: string,
  summary?: string | null,
  meta?: {
    tone?: AiBannerTone
    totalChanged?: number
    clipId?: string
    frameId?: string
    clipName?: string
    frameNumber?: number
    offView?: boolean
    entryId?: number
  },
): void {
  const now = Date.now()
  activeBanner = {
    clientName: clientName.trim() || 'AI Agent',
    tool,
    label: summary?.trim() || describeAiTool(tool),
    busy: false,
    tone: meta?.tone ?? 'live',
    totalChanged: meta?.totalChanged,
    clipId: meta?.clipId,
    frameId: meta?.frameId,
    clipName: meta?.clipName,
    frameNumber: meta?.frameNumber,
    offView: meta?.offView,
    entryId: meta?.entryId,
    updatedAt: now,
    expiresAt: now + IDLE_BANNER_MS,
  }
  if (bannerClearTimer) clearTimeout(bannerClearTimer)
  bannerClearTimer = setTimeout(() => {
    bannerClearTimer = null
    notify()
  }, IDLE_BANNER_MS + 40)
  notify()
}

export function resetAiActivityForTests(): void {
  if (bannerClearTimer) {
    clearTimeout(bannerClearTimer)
    bannerClearTimer = null
  }
  activeBanner = null
  activePulses = []
  activityFeed = []
  aiPaused = false
  aiAutoFollow = true
  activeCompare = null
  lastBusyNoticeAt = 0
  cachedSnapshot = {
    banner: null,
    pulses: [],
    feed: [],
    paused: false,
    autoFollow: true,
    comparePreview: null,
  }
}

/**
 * Diff two same-size RGBA buffers and return:
 *  - `pixels`: serpentine-ordered coordinates (sampled to MAX_SAMPLED_PIXELS) for glow/cursor
 *  - `orderedIndices`: FULL serpentine-ordered linear indices (y * width + x) for 100% progressive reveal
 *  - `totalChanged` & `bbox`
 */
export function diffChangedPixels(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
): {
  pixels: AiPixelPoint[]
  orderedIndices: Uint32Array
  totalChanged: number
  bbox: AiPixelBBox | null
} {
  if (before.length !== after.length || width <= 0 || height <= 0) {
    return { pixels: [], orderedIndices: new Uint32Array(0), totalChanged: 0, bbox: null }
  }
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const all: AiPixelPoint[] = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2] ||
        before[i + 3] !== after[i + 3]
      ) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        all.push({ x, y })
      }
    }
  }

  const totalChanged = all.length
  if (totalChanged === 0) {
    return { pixels: [], orderedIndices: new Uint32Array(0), totalChanged: 0, bbox: null }
  }

  const bbox: AiPixelBBox = {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  }

  // Serpentine row order makes the brush reveal left→right then right→left like a real hand
  const ordered: AiPixelPoint[] = []
  const orderedIndices = new Uint32Array(totalChanged)
  let outIdx = 0
  let rowStart = 0
  let rowToggle = false
  while (rowStart < all.length) {
    const y = all[rowStart]!.y
    let rowEnd = rowStart + 1
    while (rowEnd < all.length && all[rowEnd]!.y === y) rowEnd++
    if (!rowToggle) {
      for (let k = rowStart; k < rowEnd; k++) {
        const pt = all[k]!
        ordered.push(pt)
        orderedIndices[outIdx++] = pt.y * width + pt.x
      }
    } else {
      for (let k = rowEnd - 1; k >= rowStart; k--) {
        const pt = all[k]!
        ordered.push(pt)
        orderedIndices[outIdx++] = pt.y * width + pt.x
      }
    }
    rowToggle = !rowToggle
    rowStart = rowEnd
  }

  if (ordered.length <= MAX_SAMPLED_PIXELS) {
    return { pixels: ordered, orderedIndices, totalChanged, bbox }
  }

  const sampled: AiPixelPoint[] = []
  const step = ordered.length / MAX_SAMPLED_PIXELS
  for (let i = 0; i < MAX_SAMPLED_PIXELS; i++) {
    sampled.push(ordered[Math.min(ordered.length - 1, Math.floor(i * step))]!)
  }
  return { pixels: sampled, orderedIndices, totalChanged, bbox }
}

/**
 * Pure RGBA compositor for progressive pixel reveal:
 *   sweep <= 0 → exact `before`
 *   sweep >= 1 → exact `after`
 *   0 < sweep < 1 → `before` with the first `floor(sweep * N)` serpentine pixels replaced by `after`.
 */
export function composeProgressiveReveal(
  reveal: AiRevealData,
  sweep: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const dest = out && out.length === reveal.before.length ? out : new Uint8ClampedArray(reveal.before.length)
  if (sweep <= 0) {
    dest.set(reveal.before)
    return dest
  }
  if (sweep >= 1) {
    dest.set(reveal.after)
    return dest
  }
  dest.set(reveal.before)
  const indices = reveal.orderedIndices
  const count = Math.min(indices.length, Math.max(0, Math.floor(sweep * indices.length)))
  const after = reveal.after
  for (let k = 0; k < count; k++) {
    const off = indices[k]! * 4
    dest[off] = after[off]!
    dest[off + 1] = after[off + 1]!
    dest[off + 2] = after[off + 2]!
    dest[off + 3] = after[off + 3]!
  }
  return dest
}
