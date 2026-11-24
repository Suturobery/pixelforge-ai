// PixelForge AI — IDE connection guide (Copy IDE guide button).
//
// The guide MUST describe the tier the pairing code was actually generated
// for — a hardcoded "full control" guide would misrepresent a read-only L0
// pairing. Permission lines mirror mini-services/mcp-server/src/tools-catalog.ts:
//   L0 read · L1 undoable writes · L2 destructive/disk · L3 full
// `generate_sprite` is deliberately unregistered (paid tool parked behind the
// approval flow) — noted once, honestly, instead of implied per tier.

export type PairingTier = 'L0' | 'L1' | 'L2' | 'L3';

export const TIER_PERMISSIONS: Readonly<Record<PairingTier, string>> = Object.freeze({
  L0:
    'Permission: L0 — read-only. Inspect project state, frames, palette, style validation, animation preview, the task board and the operation log. Tools that modify anything are unavailable at this tier.',
  L1:
    'Permission: L1 — read + undoable edits. Everything in L0, plus painting (set_pixels, fill_rect), frame/layer/clip edits, palette colors, motion presets, batch ops, and undo/redo. Every change is reversible via the undo tool.',
  L2:
    'Permission: L2 — full edit + destructive/disk ops. Everything in L1, plus deletes (frame/layer/clip), canvas resize, export to disk (sheet/GIF), project save, and permanent trash purge.',
  L3:
    'Permission: L3 — full project control: everything in L2 with no further restrictions.',
});

/** The exact tier summary shown next to the pairing code. */
export function tierSummary(tier: PairingTier): string {
  switch (tier) {
    case 'L0': return 'L0 — read-only'
    case 'L1': return 'L1 — read + undoable edits'
    case 'L2': return 'L2 — edits + destructive ops'
    case 'L3': return 'L3 — full project control'
  }
}

export interface IdeGuideInput {
  tier: PairingTier
  endpoint: string
  token: string
}

/** Build the clipboard guide for ONE pairing — tier-accurate, deterministic. */
export function buildIdeGuide({ tier, endpoint, token }: IdeGuideInput): string {
  return [
    `PixelForge AI MCP — pairing tier ${tier} (${tierSummary(tier).replace(/^L\d — /, '')})`,
    `Endpoint: ${endpoint}`,
    'Transport: Streamable HTTP',
    `Temporary Authorization header: Bearer ${token}`,
    '',
    'Connect steps:',
    '1. Add the endpoint as an MCP server in your IDE assistant.',
    '2. Call pair_client with a friendly name (for example "Codex" or "Claude Desktop").',
    '3. Replace the temporary Authorization value with the returned persistent token.',
    '4. Call get_project_state first, then use the returned ids/stateHash for tools.',
    '5. Read get_knowledge for the task (methodology and grids for drawing, animation for motion, vfx for effects).',
    '6. Review the PNG from get_frame_png or the sequence from preview_animation. Inspect readability and run validate_style.',
    '',
    TIER_PERMISSIONS[tier],
    'No image generation tool exists (generate_sprite is not registered) and none is planned.',
  ].join('\n')
}
