/**
 * Agent chat types + the instructions builder for external IDE agents.
 * Subscription-only product: there is NO in-app provider loop (no API-key
 * LLM calls). Agents reason in the artist's own IDE and connect to
 * PixelForge through MCP; the Agent Panel keeps the manual tool runner.
 */

import { MCP_TOOLS, type McpToolInfo } from '@/lib/pixelforge/mcp-tool-catalog'

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
  for (const tier of ['L0', 'L1', 'L2'] as const) {
    const label = { L0: 'read-only', L1: 'editors', L2: 'destructive' }[tier]
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
