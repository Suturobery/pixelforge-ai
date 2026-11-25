# Connecting AI agents to PixelForge AI

The IDE model plans and draws through MCP. PixelForge supplies the canvas, art guides,
project palette, undo history, motion presets and procedural effects. Pair at L0 for
review, L1 for drawing and animation, or L2 for project saves and disk exports.

## Connect (2 minutes)

1. Open PixelForge → **Settings → AI connection** → choose your IDE and permission tier →
   **Generate pairing code** (6 words, single-use, expires in 15 minutes).
2. In your IDE, add an MCP server:
   - Endpoint: `http://127.0.0.1:3030/mcp` (Streamable HTTP, localhost only)
   - Authorization: `Bearer <the 6-word code>` (temporary, for pairing only)
3. Call `pair_client { name: "your-client" }` — you get a persistent
   `pfm_…` token. **Replace** the temporary Authorization header with it.
4. Start every session with `get_project_state` — its ids and `stateHash`
   feed every other tool. The in-app guide (`Settings → AI connection → IDE guide`)
   copies these steps with the live endpoint filled in.
5. Ask the IDE agent to call `get_project_state`, then run **Check connection** in PixelForge.

Desktop app: it supervises the MCP service itself — no terminal needed.
Web/dev: `bun src/index.ts` inside `mini-services/mcp-server`.

## The workflow agents are asked to follow

1. Call `get_project_state` for the current document, target IDs and Style Lock.
2. For a sprite, read `get_knowledge` on `methodology` and `grids`. For a character,
   also read `characters`. Start with its silhouette, then add color clusters and details.
3. Call `get_frame_png` at native size. Inspect the pose and silhouette, revise unclear
   shapes, and run `validate_style` for technical checks such as palette and margins.
4. For motion, read the `animation` topic and use `suggest_motion_preset` and
   `apply_motion_preset` where appropriate. For effects, read `vfx`, then use
   `list_vfx` and `generate_vfx`.
5. Call `preview_animation` to inspect the rendered frames in order. Use its schedule
   for playback order and timing, and its invariants to identify empty frames.

Both preview tools return native MCP PNG images alongside the original result envelope.
Visual review requires an IDE that forwards image content to a model with vision.
Text-only clients can still read frame metadata, timing and technical checks.

## Task board

- `brain_get_status` (L0) — editor connection, board counts. No secrets.
- `brain_get_capabilities` (L0) — the tool catalog **filtered to your
  tier**; plans must only reference tools listed here.
- `brain_get_tasks` / `brain_get_task` (L0) — read the task board the
  artist's plans queued.
- `brain_interpret_prompt { prompt }` (L0, free) — deterministic
  correction + enhancement: fixes typos, expands shorthand, infers
  intent, target clip/layer, and a recommended tool chain filtered to
  the real editor catalog.
- Task loop: `brain_claim_task` (exclusive) → do the work with normal
  tools → `brain_update_task_progress` (refreshes your claim lease) →
  `brain_complete_task` / `brain_fail_task`. Only the owner reports the
  outcome; long work should emit progress or the lease requeues it.
- Read-only resources: `pixelforge://capabilities` (tier-filtered
  catalog) and `pixelforge://project/active` (live project summary).

**In-app Pixel Art Recipe (artist-side):** the Brain panel composes a staged
drawing contract from the active project + Style Lock. The agent draws via MCP,
then reviews the PNG and technical checks. After a task finishes, the artist
can open **Review**, approve a frame, or queue a revision with specific feedback.
`validate_asset_set` checks palette consistency across clips; provide
`actorClipIds` for hero-based height, ground line and outline comparisons.

## Troubleshooting

- **editor_not_connected** — keep the PixelForge app open; it is the tool
  executor.
- **stale_document** — your `expectedStateHash` is old; re-read state.
- **dirty_project** — `create_project`/`open_project` are blocked while the
  document has unsaved changes; ask the human to save first.
- **rate_limited** — per tool tier per minute (L0 60, L1 120, L2 60, L3 20).
  Failed calls count. Check `get_quota`.
- **Auth failure from an IDE** — its token was revoked or expired; pair again.
