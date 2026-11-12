# Connecting AI agents to PixelForge AI

PixelForge owns the art rules; IDE agents (Codex, Claude, Cursor, ZCode, any
MCP client) plan the work. Every client gets the same tools, the same style
contract, and the same deterministic validation — output stays consistent no
matter which model is connected.

## What agents can do

- **Free (L0–L2):** read project state, draw pixels, layers, frames, clips,
  palettes, animation presets, macros, export (PNG sheet, GIF), trash/restore,
  knowledge topics. Deterministic and unlimited within per-tier rate limits.
- **Paid (L3):** `generate_sprite` only. It parks in the Approval Center — a
  human clicks Approve/Deny inside PixelForge before anything is spent.
- **Never exposed:** API keys, files outside the project, undo/redo inside
  transactions, approval of its own paid calls.

## Connect (2 minutes)

1. Open PixelForge → **Settings → MCP** → pick a permission tier →
   **Generate pairing code** (6 words, single-use, expires in 15 minutes).
2. In your IDE, add an MCP server:
   - Endpoint: `http://127.0.0.1:3030/mcp` (Streamable HTTP, localhost only)
   - Authorization: `Bearer <the 6-word code>` (temporary, for pairing only)
3. Call `pair_client { name: "your-client" }` — you get a persistent
   `pfm_…` token. **Replace** the temporary Authorization header with it.
4. Start every session with `get_project_state` — its ids and `stateHash`
   feed every other tool. The in-app guide (`Settings → MCP → IDE guide`)
   copies these steps with the live endpoint filled in.

Desktop app: it supervises the MCP service itself — no terminal needed.
Web/dev: `bun src/index.ts` inside `mini-services/mcp-server`.

## The workflow agents are asked to follow

PixelForge ships this to every client via `get_knowledge { topic: "agent" }`:

1. **Read first** — `get_project_state` includes the Style Lock profile
   (art direction, lighting, outline, palette mode, notes, feedback cues).
   Treat it as binding.
2. **Draw or generate** — pixel tools are free; `generate_sprite` merges the
   Style Lock into the prompt and normalizes the result to the project
   palette. The response's `styleLock` object reports what was enforced.
3. **Validate before presenting** — `validate_style` (any frame) and
   `validate_candidate` (an AI candidate, before accepting) run the
   deterministic checks: size, crisp alpha, palette membership, transparent
   background, margins. Free (L0). Fix warnings first.
4. **Animation** — `suggest_motion_preset` (free) → `apply_motion_preset`
   (atomic, new clip by default) → `preview_animation` returns `invariants`
   (`emptyFrames` = a pose was never drawn; `uniformTiming`).
5. **Let the human judge** — silhouette, readability, pose clarity and style
   are decided by the artist in candidate review. Deterministic checks are
   facts; aesthetics are opinions. Agents never claim both.

## Second Brain tools (shared reasoning layer)

The artist's configured reasoning provider (default Groq, set in
Settings → AI) powers a small brain surface you can call — planning and
advice come from it; **execution always stays in PixelForge**:

- `brain_get_status` (L0) — editor connection, board counts. No secrets.
- `brain_get_capabilities` (L0) — the tool catalog **filtered to your
  tier**; plans must only reference tools listed here.
- `brain_get_tasks` / `brain_get_task` (L0) — read the task board the
  artist's plans queued.
- `brain_interpret_prompt { prompt }` (L0, free) — deterministic
  correction + enhancement: fixes typos, expands shorthand, infers
  intent, target clip/layer, and a recommended tool chain filtered to
  the real editor catalog.
- `brain_ask { question }` (L1) — project-aware advisory Q&A. Read-only;
  costs a small amount of the artist's provider quota.
- `brain_plan_goal { goal }` (L1) — returns a validated plan proposal
  (app-vfx / app-palette / agent steps). **Planning only — nothing is
  executed or queued.**
- Task loop: `brain_claim_task` (exclusive) → do the work with normal
  tools → `brain_update_task_progress` (refreshes your claim lease) →
  `brain_complete_task` / `brain_fail_task`. Only the owner reports the
  outcome; long work should emit progress or the lease requeues it.
- Read-only resources: `pixelforge://capabilities` (tier-filtered
  catalog) and `pixelforge://project/active` (live project summary).

`live-client-test.ts` in the MCP server folder is a ready-made external
client that exercises this whole sequence against a running app
(`PF_PAIR_CODE=<code> bun live-client-test.ts`).

## Measuring consistency (benchmark)

`mini-services/mcp-server/benchmark/` holds a fixed brief list and a runner:

```bash
bun benchmark/run-benchmark.mjs <pairing-code>          # dry — free baseline
PF_BENCH_ONLY=potion-item bun benchmark/run-benchmark.mjs <code> --live
PF_BENCH_TOKEN=pfm_… bun benchmark/run-benchmark.mjs x --live  # reuse token
```

Dry records the style contract + per-clip checks of the open project.
Live runs every brief through paid generation (each waits for a human
approval click) and scores the normalized candidate with
`validate_candidate` — without ever touching the document. Results land in
`results-<timestamp>.json`; run the same briefs from each client and diff.

## Troubleshooting

- **editor_not_connected** — keep the PixelForge app open; it is the tool
  executor.
- **stale_document** — your `expectedStateHash` is old; re-read state.
- **dirty_project** — `create_project`/`open_project` are blocked while the
  document has unsaved changes; ask the human to save first.
- **rate_limited** — per tool tier per minute (L0 60, L1 120, L2 60, L3 20).
  Failed calls count. Check `get_quota`.
- **Auth failure from an IDE** — its token was revoked or expired; pair again.
- **generation_failed: no image engine** — image generation is optional;
  add provider credentials in Settings → AI (or a `.z-ai-config`) only if
  you want in-app/AI generation. All other tools work without it.
