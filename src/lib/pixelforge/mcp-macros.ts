// PixelForge AI — MCP macro tools: save a named sequence of tool calls and
// replay it against the live document. Stored in localStorage (per browser).
//
// KNOWN LIMIT: macro_run executes whatever steps were saved under the
// CALLER's identity without re-checking per-step tiers — a macro saved from
// an L2/L3 session runs destructive/paid steps for an L1 caller too. Only
// share macros you wrote yourself. Upgrade: per-step tier check against the
// caller identity when the approval center lands.

import { getBus, useEditor } from './store'

export interface MacroStep {
  tool: string
  args: Record<string, unknown>
}

export interface Macro {
  name: string
  steps: MacroStep[]
  savedAt: string
}

const KEY = 'pixelforge:macros'

function load(): Record<string, Macro> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Macro>
  } catch {
    return {}
  }
}

function save(all: Record<string, Macro>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}

export function macroList(): Macro[] {
  return Object.values(load()).sort((a, b) => a.name.localeCompare(b.name))
}

export function macroGet(name: string): Macro | null {
  return load()[name] ?? null
}

export function macroSave(name: string, steps: MacroStep[]): Macro {
  const all = load()
  const macro: Macro = { name, steps, savedAt: new Date().toISOString() }
  all[name] = macro
  save(all)
  return macro
}

export function macroDelete(name: string): boolean {
  const all = load()
  if (!all[name]) return false
  delete all[name]
  save(all)
  return true
}

export interface MacroRunResult {
  ok: boolean
  step: number
  tool: string
  summary?: string | null
  error?: { code: string; message: string }
}

export interface StepListOutcome {
  results: MacroRunResult[]
  completed: number
  ok: boolean
  /** true when the bus transaction rolled every step back (nothing applied) */
  rolledBack?: boolean
}

/** Thrown inside the bus transaction so it rolls the whole step list back. */
class StepListFailed extends Error {
  outcome: { results: MacroRunResult[]; completed: number; ok: boolean }
  constructor(outcome: { results: MacroRunResult[]; completed: number; ok: boolean }) {
    super(`step ${outcome.results.find((r) => !r.ok)?.step ?? '?'} failed`)
    this.outcome = outcome
  }
}

/**
 * Run a list of tool steps as ONE undoable bus transaction: all-or-nothing.
 * Any failing step (with stopOnError) or any failure at all (collected when
 * stopOnError=false) rolls the document back to the pre-run state.
 */
export async function runStepsInTransaction(
  label: string,
  steps: MacroStep[],
  run: (tool: string, args: Record<string, unknown>) => Promise<{
    ok: boolean
    summary?: string | null
    error?: { code: string; message: string }
  }>,
  stopOnError = true,
): Promise<StepListOutcome> {
  // undo/redo would corrupt the open transaction; batch would nest
  const FORBIDDEN = new Set(['undo', 'redo', 'batch'])
  const badStep = steps.find((s) => FORBIDDEN.has(s.tool))
  if (badStep) throw new Error(`"${badStep.tool}" cannot run inside a transaction (step list)`)
  const runSteps = async (): Promise<{ results: MacroRunResult[]; completed: number; ok: boolean }> => {
    const results: MacroRunResult[] = []
    let completed = 0
    let ok = true
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (stopOnError && !ok) {
        results.push({ ok: false, step: i, tool: step.tool, error: { code: 'skipped', message: 'Skipped — earlier step failed.' } })
        continue
      }
      try {
        const r = await run(step.tool, step.args ?? {})
        results.push({ ok: r.ok, step: i, tool: step.tool, summary: r.summary ?? null, error: r.error })
        if (!r.ok) ok = false
        else completed++
      } catch (err) {
        results.push({ ok: false, step: i, tool: step.tool, error: { code: 'exception', message: err instanceof Error ? err.message : String(err) } })
        ok = false
      }
    }
    if (!ok) throw new StepListFailed({ results, completed, ok })
    return { results, completed, ok }
  }

  const docBefore = getBus().getProject()
  try {
    const out = await getBus().transaction(label, 'mcp', runSteps)
    void docBefore
    useEditor.getState().bump()
    return out
  } catch (err) {
    // bus already rolled the document back to docBefore
    useEditor.getState().bump()
    if (err instanceof StepListFailed) return { ...err.outcome, rolledBack: true }
    throw err
  }
}

/** Replay a saved macro via the injected executor (same plane the server relay uses). */
export async function macroRun(
  name: string,
  run: (tool: string, args: Record<string, unknown>) => Promise<{
    ok: boolean
    summary?: string | null
    error?: { code: string; message: string }
  }>,
  stopOnError = true,
): Promise<StepListOutcome> {
  const macro = macroGet(name)
  if (!macro) throw new Error(`macro "${name}" not found`)
  return runStepsInTransaction(`Macro "${name}"`, macro.steps, run, stopOnError)
}
