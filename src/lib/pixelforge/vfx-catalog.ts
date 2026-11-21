/**
 * PixelForge AI — pixelfx effect catalog access WITHOUT the editor bus.
 * Extracted from vfx.ts so server contexts (AI routes) can validate planner
 * output against the REAL effect list — the planner may only request
 * capabilities PixelForge actually has.
 */

import * as index from 'pixelfx/fx/index'

export interface VfxEffectInfo {
  id: string
  name: string
  category: string
  desc: string
  tags: string[]
  size: [number, number]
  duration: number
}

type FxModule = {
  meta?: { name?: string; desc?: string; tags?: string[]; size?: number[]; origin?: number[]; duration?: number }
}

const VFX_ID_RE = /^[a-z][a-z0-9]*(?:\/[a-z0-9][a-z0-9-]*)*$/

export async function loadCatalog(): Promise<Record<string, FxModule>> {
  return (index as unknown as { effects?: Record<string, FxModule> }).effects ?? {}
}

export async function listVfx(category?: string): Promise<VfxEffectInfo[]> {
  const effects = await loadCatalog()
  const out: VfxEffectInfo[] = []
  for (const [key, mod] of Object.entries(effects)) {
    if (!VFX_ID_RE.test(key) || typeof mod?.meta !== 'object' || mod.meta === null) continue
    const meta = mod.meta
    const cat = key.split('/')[0] ?? 'misc'
    if (category && cat !== category.toLowerCase()) continue
    out.push({
      id: key,
      name: meta.name ?? key,
      category: cat,
      desc: (meta.desc ?? '').slice(0, 200),
      tags: (meta.tags ?? []).slice(0, 6),
      size: [meta.size?.[0] ?? 64, meta.size?.[1] ?? 64],
      duration: meta.duration ?? 1,
    })
  }
  out.sort((a, b) => (a.category + a.id).localeCompare(b.category + b.id))
  return out
}

/** Fuzzy-resolve a vague effect query ("campfire", "coin") to a catalog id.
 * The APP owns accuracy: agents/planners may send anything. */
export async function resolveVfxEffect(query: string): Promise<{ id: string; suggestions?: string[] }> {
  const effects = await listVfx()
  const q = query.toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').trim()
  if (!q) throw new Error('Empty effect name — call list_vfx for ids.')
  const exact = effects.find((e) => e.id.toLowerCase() === q || e.id.split('/').pop() === q.replace(/\s+/g, '-'))
  if (exact) return { id: exact.id }
  const words = q.split(/\s+/)
  const scored: Array<{ e: VfxEffectInfo; score: number }> = []
  let best: { e: VfxEffectInfo; score: number } | null = null
  for (const e of effects) {
    const hay = `${e.id} ${e.name} ${e.tags.join(' ')}`.toLowerCase()
    let score = 0
    if (e.id.toLowerCase().includes(q.replace(/\s+/g, ''))) score += 5
    if (e.name.toLowerCase().includes(q)) score += 4
    for (const w of words) {
      if (w.length < 3) continue
      if (e.id.toLowerCase().includes(w)) score += 2
      if (e.name.toLowerCase().includes(w)) score += 2
      if (e.tags.some((t) => t.toLowerCase().includes(w))) score += 1
    }
    if (hay.includes(q)) score += 1
    if (score > 0) scored.push({ e, score })
    if (score > (best?.score ?? 0)) best = { e, score }
  }
  if (best && best.score >= 2) return { id: best.e.id }
  scored.sort((a, b) => b.score - a.score)
  return { id: '', suggestions: (scored.length ? scored : effects).slice(0, 5).map((s) => s.e.id) }
}

/** Compact catalog text for planner prompts: every id + name, grouped. */
export async function catalogPromptText(): Promise<string> {
  const effects = await listVfx()
  const byCat = new Map<string, string[]>()
  for (const e of effects) {
    const arr = byCat.get(e.category) ?? []
    arr.push(e.id)
    byCat.set(e.category, arr)
  }
  return [...byCat.entries()].map(([cat, ids]) => `${cat}: ${ids.join(', ')}`).join('\n')
}
