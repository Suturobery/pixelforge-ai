// PixelForge AI — AI candidate session store (Task 9).
//
// The shared surface for EVERYTHING that inspects or resolves AI candidates:
// the AI panel (React), the MCP executor (accept/reject/apply_normalize
// tools), and the normalize worker client. Provenance per plan §3.4:
//   {model, providerId, prompt, seed?, params, timestamp, jobDurationMs}
// is carried on every candidate and shown in the review UI.
//
// Generation history is persisted PER PROJECT (thumbnails + provenance —
// plan §3.2 "restorable") in localStorage; the raw full-res images are NOT
// persisted (thumbnails only) so the quota stays sane. The `.pixelforgeproj`
// provenance/ai/ section remains a file-format follow-up (documented).

import { createStore, useStore } from 'zustand'
import type { Normalize2Stats } from '@pixelforge/core'

export interface AiProvenance {
  prompt: string
  providerId: string
  providerLabel: string
  model: string
  seed: number | null
  requestSize: string
  width: number
  height: number
  createdAt: string
  jobDurationMs: number | null
  costEstimateUsd: number | null
  cacheHit: boolean
  /** recipe preset id ('character' | 'item' | 'tile' | 'free') */
  recipe: string
}

export interface AiCandidate extends AiProvenance {
  id: string
  /** data URL of the ORIGINAL generation (untouched) */
  originalSrc: string
  originalW: number
  originalH: number
  /** current normalize options (re-runnable — review workflow) */
  normalizeOpts: Record<string, unknown>
  normalized: {
    buffer: Uint8ClampedArray
    w: number
    h: number
    colors: number
    /** normalize-v2 stats (bgRemoved, trim, bgColor… — feeds the quality report) */
    stats?: Normalize2Stats
  } | null
  status: 'normalizing' | 'review' | 'accepted' | 'rejected' | 'error'
  error: string | null
}

export interface AiHistoryEntry extends AiProvenance {
  id: string
  thumbSrc: string
}

export interface AiCandidatesState {
  candidates: AiCandidate[]
  /** generation history for the ACTIVE project (thumbnails + provenance) */
  history: AiHistoryEntry[]
  upsert(candidate: AiCandidate): void
  patch(id: string, patch: Partial<AiCandidate>): AiCandidate | null
  get(id: string): AiCandidate | null
  remove(id: string): void
  replaceHistory(history: AiHistoryEntry[]): void
  recordHistory(entry: AiHistoryEntry): void
  clear(): void
}

const MAX_CANDIDATES = 8
const MAX_HISTORY = 24
const HISTORY_KEY_PREFIX = 'pixelforge-ai-history-v1:'

function storageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

function loadHistory(projectId: string): AiHistoryEntry[] {
  if (!storageAvailable()) return []
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY_PREFIX + projectId)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is AiHistoryEntry => typeof e === 'object' && e !== null && typeof (e as AiHistoryEntry).id === 'string')
      .slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

function saveHistory(projectId: string, history: AiHistoryEntry[]): void {
  if (!storageAvailable()) return
  try {
    window.localStorage.setItem(HISTORY_KEY_PREFIX + projectId, JSON.stringify(history.slice(0, MAX_HISTORY)))
  } catch {
    /* quota — history is best-effort */
  }
}

export const aiCandidateStore = createStore<AiCandidatesState>()((set, get) => ({
  candidates: [],
  history: [],
  upsert: (candidate) =>
    set((s) => ({
      candidates: [candidate, ...s.candidates.filter((c) => c.id !== candidate.id)].slice(0, MAX_CANDIDATES),
    })),
  patch: (id, patch) => {
    let updated: AiCandidate | null = null
    set((s) => ({
      candidates: s.candidates.map((c) => {
        if (c.id !== id) return c
        updated = { ...c, ...patch }
        return updated
      }),
    }))
    return updated
  },
  get: (id) => get().candidates.find((c) => c.id === id) ?? null,
  remove: (id) => set((s) => ({ candidates: s.candidates.filter((c) => c.id !== id) })),
  replaceHistory: (history) => set({ history: history.slice(0, MAX_HISTORY) }),
  recordHistory: (entry) =>
    set((s) => {
      const next = [entry, ...s.history.filter((h) => h.id !== entry.id)].slice(0, MAX_HISTORY)
      return { history: next }
    }),
  clear: () => set({ candidates: [] }),
}))

/** Load the persisted history for a project (call when the project changes). */
export function loadAiHistoryFor(projectId: string): void {
  aiCandidateStore.getState().replaceHistory(loadHistory(projectId))
}

export function persistAiHistory(projectId: string): void {
  saveHistory(projectId, aiCandidateStore.getState().history)
}

/** React binding for the AI panel. */
export function useAiCandidates<T>(selector: (s: AiCandidatesState) => T): T {
  return useStore(aiCandidateStore, selector)
}

// ---------------------------------------------------------------------------
// accepted-import reconciliation (undo / delete awareness)
// ---------------------------------------------------------------------------

/** Where a candidate's import landed in the document (one accept = one ref). */
export interface AcceptedRef {
  kind: 'layer' | 'frame'
  clipId: string
  targetId: string
}

/**
 * Accepting a candidate flips it to `accepted`, which disables re-import in
 * the review UI while that import EXISTS. When the import is removed again —
 * undo, redo, deleting the layer/frame, loading another project — the
 * candidate must become reviewable again, otherwise a single Ctrl+Z would
 * permanently brick the review card's "As layer"/"As frame" buttons.
 *
 * The registry maps candidateId → the document object its import created;
 * reconcile() flips 'accepted' candidates back to 'review' once their target
 * is gone. Wired into the bus change path (store.syncFromBus) so every
 * mutation origin (panel, MCP tools, keyboard undo) is covered.
 */
const acceptedTargets = new Map<string, AcceptedRef>()

export function registerAcceptedTarget(candidateId: string, ref: AcceptedRef): void {
  acceptedTargets.set(candidateId, ref)
}

/** Minimal structural view of the document (keeps this module core-free). */
interface ReconcileProject {
  clips: Array<{ id: string; layers: Array<{ id: string }>; frames: Array<{ id: string }> }>
}

export function reconcileAcceptedCandidates(project: ReconcileProject): void {
  if (acceptedTargets.size === 0) return
  const state = aiCandidateStore.getState()
  for (const [candidateId, ref] of acceptedTargets) {
    const candidate = state.get(candidateId)
    if (!candidate) {
      // candidate was discarded/replaced — prune the registry entry
      acceptedTargets.delete(candidateId)
      continue
    }
    const clip = project.clips.find((c) => c.id === ref.clipId)
    const exists =
      ref.kind === 'layer'
        ? !!clip?.layers.some((l) => l.id === ref.targetId)
        : !!clip?.frames.some((f) => f.id === ref.targetId)
    if (!exists) {
      acceptedTargets.delete(candidateId)
      if (candidate.status === 'accepted') state.patch(candidateId, { status: 'review' })
    }
  }
}

let seq = 0
export function newCandidateId(): string {
  seq += 1
  return `cand-${Date.now().toString(36)}-${seq}`
}
