/**
 * AI agent chat — provider call with tool calling over OpenAI-compatible
 * APIs (zai/openai/custom). Client-safe: the Agent panel imports the
 * schema/instructions builders; the API route imports callProvider (no DOM
 * here).
 */

import { MCP_TOOLS, type McpToolInfo } from '@/lib/pixelforge/mcp-tool-catalog'

export interface AgentProviderConfig {
  kind: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface AgentToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface AgentMsg {
  role: 'user' | 'assistant'
  text?: string
  toolCalls?: AgentToolCall[]
  toolResults?: Array<{ id: string; name: string; ok: boolean; content: string }>
}

/** Loose JSON schema derived from the catalog example's key names — the
 *  descriptions carry the semantics; the schema only names the arguments. */
export function toolJsonSchema(t: McpToolInfo): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(t.example ?? {})) {
    const type = Array.isArray(v)
      ? 'array'
      : typeof v === 'number'
        ? 'number'
        : typeof v === 'boolean'
          ? 'boolean'
          : typeof v === 'object' && v !== null
            ? 'object'
            : 'string'
    properties[k] = { type }
  }
  return { type: 'object', properties, required: [] }
}

export function agentTools(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: `[${t.tier}] ${t.description}`,
    parameters: toolJsonSchema(t),
  }))
}

function resolveModel(cfg: AgentProviderConfig): string {
  if (cfg.model && cfg.model !== 'auto') return cfg.model
  if (cfg.kind === 'zai') return 'glm-4.6'
  if (cfg.kind === 'openai') return 'gpt-4o-mini'
  return 'gpt-4o-mini'
}

// --- OpenAI-compatible (zai / openai / custom) -----------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export function toOpenAIMessages(system: string, messages: AgentMsg[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }]
  // Harmony (gpt-oss) correlates each tool result to its call by id; some
  // providers emit tool_calls WITHOUT ids. Backfill stable ids here so
  // turn-2+ history always pairs assistant tool_calls with their results —
  // otherwise Groq 400s with harmony "Tools should have a name!".
  let pendingIds: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.toolResults) {
        m.toolResults.forEach((r, i) => {
          const id = r.id || pendingIds[i] || `call_${out.length}_${i}`
          out.push({ role: 'tool', tool_call_id: id, content: r.content })
        })
        pendingIds = []
      } else {
        out.push({ role: 'user', content: m.text ?? '' })
      }
    } else {
      pendingIds = []
      const calls = (m.toolCalls ?? [])
        .filter((tc) => Boolean(tc.name))
        .map((tc, i) => {
          const id = tc.id || `call_${out.length}_${i}`
          pendingIds.push(id)
          return { id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.args) } }
        })
      out.push({
        role: 'assistant',
        content: m.text ?? null,
        ...(calls.length > 0
          ? { tool_calls: calls }
          : {}),
      })
    }
  }
  return out
}

// --- entry -------------------------------------------------------------------

export async function callProvider(
  cfg: AgentProviderConfig,
  system: string,
  messages: AgentMsg[],
): Promise<{ text: string; toolCalls: AgentToolCall[] }> {
  const base =
    cfg.baseUrl.replace(/\/$/, '') ||
    (cfg.kind === 'zai'
      ? 'https://api.z.ai/api/paas/v4'
      : cfg.kind === 'openai'
        ? 'https://api.openai.com/v1'
        : '')
  if (!base) throw new Error('Provider has no base URL — set it in Settings → AI & MCP.')
  const model = resolveModel(cfg)

  // OpenAI-compatible
  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(system, messages),
        tools: agentTools().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        // reasoning models burn most of the wall-clock thinking before the
        // giant pixel-batch tool call; low effort keeps agent turns snappy
        ...(model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
      }),
      // big pixel batches + reasoning models routinely exceed 60 s
      signal: AbortSignal.timeout(180_000),
    })
  } catch (err) {
    if (err instanceof Error && /abort|timeout/i.test(err.message)) {
      throw new Error(
        'Provider call timed out after 180 s — the model was still generating its tool batch. Retry, or make the goal smaller (fewer pixels per turn).',
      )
    }
    throw err
  }
  if (!res.ok) throw new Error(`Provider ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
  }
  const msg = json.choices?.[0]?.message
  const toolCalls: AgentToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>
    } catch {
      args = {}
    }
    // harmony providers (gpt-oss) sometimes omit tool_call ids — backfill so
    // result correlation in toOpenAIMessages always has an anchor
    return { id: tc.id || `call_resp_${i}`, name: tc.function.name, args }
  })
  return { text: msg?.content ?? '', toolCalls }
}

/** Instructions block for external agents (Claude Desktop / Cline / ChatGPT)
 *  — generated from the LIVE in-process catalog at click time. */
export function buildAgentInstructions(endpoint: string): string {
  const lines: string[] = [
    '# PixelForge AI — MCP agent instructions',
    '',
    `Endpoint: ${endpoint} (Streamable HTTP)`,
    'Auth: pair once — Settings → MCP in the app shows a pairing code; call `pair_client {name}` with it to receive your client token. Include it as a Bearer token afterward.',
    'Tiers: L0 tools are read-only (safe to call freely). L1 tools EDIT the document — confirm with the user before running them. Deleted work is trash-restorable; merges/resizes are NOT undoable via trash.',
    'All pixel coordinates are canvas pixels. Absent clip/frame/layer refs resolve to the ACTIVE ones.',
    'Coordinates MUST be whole integers — never fractions or arithmetic expressions (compute and round first: Math.round). String numbers like "16" are tolerated, but prefer plain numbers.',
    '',
    '## Tools',
    '',
  ]
  for (const tier of ['L0', 'L1', 'L2', 'L3'] as const) {
    const label = { L0: 'read-only', L1: 'editors', L2: 'destructive', L3: 'paid / AI' }[tier]
    const tools = MCP_TOOLS.filter((t) => t.tier === tier)
    lines.push(`### ${tier} — ${label} (${tools.length})`)
    lines.push('')
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- **${t.name}** — ${t.description}`)
      lines.push(`  example args: \`${JSON.stringify(t.example)}\``)
    }
    lines.push('')
  }
  return lines.join('\n')
}
