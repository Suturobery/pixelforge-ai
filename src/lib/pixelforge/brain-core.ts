// PixelForge AI — Brain Core facade (shared-Brain evolution, Phase 1).
//
// One stable contract for Brain operations shared by the Brain Panel, the
// built-in Agent, and future MCP adapters. Phase 1 is behavior-preserving:
//   • provider readiness (key-presence logic previously duplicated in the
//     Brain Panel and the Agent Console) now lives here;
//   • project-context assembly moves out of the Brain Panel component;
//   • the bridge-or-fetch request transport is centralized;
//   • the deterministic interpreter and learning memory are re-exported
//     unchanged so callers depend on THIS module, not the internals.
// Server-side Groq execution/validation moved verbatim to brain-server.ts;
// the web route is now a thin delegate over the same functions.

import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import type { AIProviderConfig } from '@/lib/pixelforge/settings'
import type { SecondBrainMemory } from '@/lib/pixelforge/second-brain-intelligence'

// --- shared deterministic Brain service (interpreter + learning memory) ----

export {
  interpretAndEnhancePrompt,
  resolveMotionPresetSynonym,
  fuzzyFindByName,
  readBrainMemory,
  writeBrainMemory,
  recordBrainFeedback,
  recordAgentContextEvent,
  addBrainPreference,
  removeBrainPreference,
  subscribeBrainMemory,
  clearBrainSessionContext,
  resetBrainMemory,
  exportBrainMemory,
} from '@/lib/pixelforge/second-brain-intelligence'

export type {
  InterpretedPrompt,
  PromptCorrection,
  DetectedIntent,
  BrainProjectContext,
  BrainFeedbackEntry,
  AgentContextEvent,
  SecondBrainMemory,
} from '@/lib/pixelforge/second-brain-intelligence'

// --- reasoning-provider readiness ------------------------------------------

/**
 * Resolve the reasoning ("second brain") provider profile plus key presence,
 * shared by every caller. `hasKey` is key-presence only (Brain Panel badge
 * semantics); callers that gate execution add their own `enabled` check —
 * policy stays with the caller, key logic lives here. Web keys sit in the
 * profile itself; desktop secure mode reads the vault mirror instead.
 */
export function resolveBrainProvider(
  aiProviders: AIProviderConfig[],
  secureMode: boolean,
  keyStatus: Record<string, { hasKey: boolean } | undefined>,
  providerId = 'groq',
): { provider: AIProviderConfig | null; hasKey: boolean } {
  const provider = aiProviders.find((p) => p.id === providerId) ?? null
  if (!provider) return { provider: null, hasKey: false }
  const hasKey = Boolean(provider.apiKey.trim() || (secureMode && keyStatus[providerId]?.hasKey))
  return { provider, hasKey }
}

// --- project context assembly ----------------------------------------------

/** Structural slice of the editor project the Brain context payload needs. */
export interface BrainContextProject {
  name: string
  width: number
  height: number
  palette: readonly string[]
  clips: ReadonlyArray<{ name: string; frames: readonly unknown[] }>
  settings: { styleProfile?: { enabled?: boolean; artDirection?: string } }
}

/** Project identity attached to plans so execution can detect staleness.
 * `projectId` is the persistence id (null while unsaved); `revision` is the
 * deterministic document fingerprint (`computeStateHash`). */
export interface BrainProjectIdentity {
  projectId?: string | null
  revision?: string
}

/**
 * The project/memory context payload sent with every Brain request.
 * Moved verbatim from the Brain Panel so all callers send identical context.
 * When `identity` is given (plans), projectId/revision ride along.
 */
export function buildBrainProjectContext(
  project: BrainContextProject,
  memory: Pick<SecondBrainMemory, 'prefer' | 'avoid' | 'recentContext'>,
  identity?: BrainProjectIdentity,
): Record<string, unknown> {
  const clipsSummary = project.clips.map((cl) => `${cl.name}(${cl.frames.length}f)`).join(', ')
  return {
    name: project.name,
    width: project.width,
    height: project.height,
    paletteSize: project.palette.length,
    clips: project.clips.map((c) => ({ name: c.name, frames: c.frames.length })),
    clipsSummary,
    styleLock: project.settings.styleProfile?.enabled ?? false,
    styleDirection: project.settings.styleProfile?.artDirection ?? '',
    prefer: memory.prefer,
    avoid: memory.avoid,
    recentContext: memory.recentContext.slice(0, 6).map((c) => `${c.source}:${c.toolOrAction} (${c.summary})`),
    ...(identity ? { projectId: identity.projectId ?? null, revision: identity.revision ?? null } : {}),
  }
}

/**
 * Freshness gate for executing a plan made from an earlier context snapshot.
 * A plan without a recorded revision (legacy callers) is allowed; a plan
 * whose revision differs from the CURRENT document is stale and must be
 * re-planned rather than applied silently.
 */
export function checkPlanFreshness(
  planRevision: string | null | undefined,
  currentRevision: string | null | undefined,
): { stale: false; reason?: undefined } | { stale: true; reason: string } {
  if (!planRevision) return { stale: false }
  if (!currentRevision) return { stale: true, reason: 'Could not read the current project revision — re-plan before running.' }
  if (planRevision !== currentRevision) {
    return { stale: true, reason: 'Project changed since this plan was created — re-plan to refresh before running.' }
  }
  return { stale: false }
}

// --- execution dispatch (shared-Brain phase 6) ------------------------------

/** UI view of one validated plan step (status/result are execution state). */
export interface PlanStep {
  kind: 'app-vfx' | 'app-palette' | 'agent'
  title: string
  effect?: string
  seed?: number
  light?: number
  palette?: string
  colors?: string[]
  detail?: string
  status?: 'pending' | 'done' | 'failed' | 'queued'
  result?: string
}

/**
 * Map a deterministic plan step onto the SHARED executor (executeMcpTool) so
 * panel, built-in Agent and MCP agents run the same handler, validation,
 * state-hash stamping and audit for identical work. `agent` steps are NOT
 * dispatched locally — they belong on the task board. Returns null for
 * anything that must not execute in-process.
 */
export function planStepToToolCall(step: PlanStep): { tool: 'generate_vfx' | 'set_palette'; args: Record<string, unknown> } | null {
  if (step.kind === 'app-vfx') {
    return {
      tool: 'generate_vfx',
      args: {
        effect: step.effect ?? step.title,
        ...(step.seed !== undefined ? { seed: step.seed } : {}),
        ...(step.light !== undefined ? { light: step.light } : {}),
        palette: 'project',
        name: step.title.slice(0, 120),
      },
    }
  }
  if (step.kind === 'app-palette' && Array.isArray(step.colors) && step.colors.length > 0) {
    return { tool: 'set_palette', args: { colors: step.colors.slice(0, 256) } }
  }
  return null
}

// --- request transport ------------------------------------------------------

export interface BrainCallPayload {
  action?: 'interpret' | 'plan'
  prompt?: string
  goal?: string
  question?: string
  provider: { id: string; baseUrl?: string; apiKey?: string; model?: string }
  project?: Record<string, unknown>
}

/**
 * One transport for every Brain request: desktop bridge v5 (main injects the
 * vault key in-process) when available, otherwise the local Next route with
 * the agent guard header. Returns the route's raw JSON envelope — callers
 * own error interpretation.
 */
export async function callBrain<T>(payload: BrainCallPayload): Promise<T> {
  if (typeof window !== 'undefined' && window.pixelforge?.ai?.brain) {
    return (await window.pixelforge.ai.brain(payload)) as T
  }
  const res = await fetch('/api/ai/brain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AGENT_FETCH_HEADERS },
    body: JSON.stringify(payload),
  })
  return (await res.json()) as T
}
