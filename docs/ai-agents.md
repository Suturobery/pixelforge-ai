# PixelForge AI — AI and Agents

This is the reference for everything an AI assistant can do in PixelForge, and for the in-app
panels that work with assistants. For a two-minute connect guide aimed at the agent itself, see
[Connecting AI agents](connect-agents.md).

## How AI works in PixelForge

| Piece | Runs where | Uses a model? | What it does |
| --- | --- | --- | --- |
| IDE agent over MCP | Your IDE | Yes — your IDE's model | Reasons, plans, then calls tools. PixelForge executes each call on the editor's CommandBus |
| MCP server | Local sidecar | No | Authenticates, authorizes, rate-limits, audits, relays, serves knowledge and the task board |
| Second Brain | Editor page | No | Interprets prompts, remembers preferences, builds asset briefs, manages the task board |
| Agent Console | Editor page | No | Runs the same tools by hand inside the app |
| Knowledge base | MCP server | No | Craft guidance the agent reads before drawing |

There is no image generation. An agent draws with `set_pixels`, `fill_rect`, motion presets and
procedural VFX. To use an image from an external model, import it through the Reference panel or
the `import_image_as_layer` tool.

## Connecting an assistant

### Pair

1. In PixelForge open **Settings → AI connection**, turn on **Enable MCP server**, and check that the
   status line shows the server and a connected editor.
2. Press **Connect AI Assistant**, pick a permission tier, and generate a pairing code. The code
   is six hyphenated words, single-use, and expires after 15 minutes.
3. In your IDE add an MCP server:
   - URL: the endpoint shown in Settings (`http://127.0.0.1:3030/mcp` unless the app moved to
     another port)
   - Transport: Streamable HTTP
   - Header: `Authorization: Bearer <the six-word code>`
4. Call `pair_client { name: "your-client" }`. The reply contains a persistent token starting
   with `pfm_`.
5. Replace the temporary Authorization value with that token. It is shown once.
6. Call `get_project_state`. Every other tool uses the ids and `stateHash` it returns.

**Copy IDE connection guide** puts these steps, the live endpoint, the code and an accurate
description of the chosen tier on the clipboard. Tokens can be revoked at any time from
**Connected clients**. A revoked client can be removed from the list.

### What the server checks on every request

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. Connect directly to the
  loopback endpoint, not through a proxy that rewrites the host.
- `Content-Length` is required on POST and the body is capped at 2 MB.
- 30 failed authentications within 60 seconds trip a 429 for the rest of the window.

### Spawn-based clients: the stdio proxy

Clients that launch MCP servers as a child process can use
`mini-services/mcp-server/src/stdio-proxy.ts`. It forwards line-delimited JSON-RPC from stdin
to the Streamable HTTP endpoint.

| Variable | Meaning |
| --- | --- |
| `PF_MCP_URL` | Endpoint. Defaults to `http://127.0.0.1:3030/mcp`. Must be loopback http(s) |
| `PF_MCP_TOKEN` | Required. The paired client token |

### Verify a pairing

`mini-services/mcp-server/zcode-live-verify.mjs` pairs a client named `ZCode` with a code and
runs a short sequence of checks: `bun zcode-live-verify.mjs <code>`.

## Permission tiers

The tier is fixed when the pairing code is generated. A higher tier includes everything below it.

| Tier | Name in the UI | Grants | Tools |
| --- | --- | --- | --- |
| `L0` | Read-only | Inspect state, frames, palette, style validation, asset set consistency, animation preview, knowledge, the task board, the operation log | 23 |
| `L1` | Read + undoable edits | Painting, editable pixel-perfect vectors, frame/layer/clip edits, non-destructive layer modifiers, timing and tags, palette colors & hue-shifted ramps, imports, VFX, motion presets, macros, batch, undo/redo, claiming and finishing tasks | 57 |
| `L2` | Edits + destructive and disk operations | Deletes, canvas resize, `replace_color`, `set_palette`, library palettes, exports, `save_project`, trash purge | 13 |
| `L3` | Full project control | Same as `L2`. No tool is registered at `L3` today | 0 |

A tier is checked twice: by the server before relaying, and by argument validation in the
editor.

## Rate limits

Budgets are per client and per **tool tier**, in one-minute windows. Failed calls count.

| Tool tier | Calls per minute |
| --- | --- |
| `L0` | 60 |
| `L1` | 120 |
| `L2` | 60 |
| `L3` | 20 |

A client at `L2` therefore has four separate budgets to spend. Call `get_quota` before a long
job. `batch` counts as one call for up to 50 steps.

## The result envelope

Every tool returns the same shape, as JSON text and as `structuredContent`:

```jsonc
{
  "ok": true,
  "data": { },            // tool-specific
  "undoable": true,       // present when the call changed the document
  "stateHash": "…",       // present after most document tools
  "summary": "…"          // short human-readable line
}
```

On failure `ok` is `false`, the MCP result has `isError: true`, and `error` is
`{ code, message, hint? }`. `get_frame_png` and `preview_animation` also return native PNG
image content, so a client with vision can inspect pixels. A text-only client should say that
visual review is pending.

## Argument conventions

Several tools share these parameters:

| Group | Parameters | Behaviour |
| --- | --- | --- |
| Clip reference | `clipId` or `clipName` | Omit both to use the active clip |
| Frame reference | `frameId` or `frameIndex` (0-based) | Omit both to use the active frame. `frameId` wins |
| Layer reference | `layerId` or `layerName` | Omit both to use the active layer. `layerId` wins |
| Staleness guard | `expectedStateHash` | When supplied, the call fails with `stale_document` if the document changed |

The editor also matches clip and layer names case-insensitively and by partial match.
Coordinates are whole canvas pixels.

## Tool catalog

93 tools: 78 are relayed to the editor and 15 are answered by the server. **Where** is *Editor*
(needs the app open) or *Server* (no editor needed).

### Reading the project

| Tool | Tier | Where | Parameters | Result |
| --- | --- | --- | --- | --- |
| `get_project_state` | L0 | Editor | — | Name, size, palette, Style Lock, clips with layers, frames and durations, `activePointers`, live `artistContext` (selection rect, primary/secondary colors, active tool, mirrorX/Y, tiledWrap, `aiPaused`), trash count, dirty flag, `stateHash` |
| `list_projects` | L0 | Editor | — | Saved projects: id, name, size, timestamps |
| `get_clip` | L0 | Editor | clip reference | Layer stack, every frame with its duration and which layers have cels, tags, loop settings |
| `get_frame_png` | L0 | Editor | clip, frame, `scale` 1 / 0.5 / 0.25 | One composited frame as a PNG image and data URL |
| `get_palette` | L0 | Editor | — | Palette and the enforcement flag |
| `validate_style` | L0 | Editor | clip, frame, `allowEdgeTouch` | Technical checks: size, crisp alpha, palette membership, transparent background, margins |
| `analyze_pixel_craft` | L0 | Editor | clip, frame | Pixel craft score and exact locations of common artifacts |
| `validate_asset_set` | L0 | Editor | optional `actorClipIds` | Checks each clip's representative frame against the project palette; selected actors are compared with the pinned hero's height, ground line and outline |
| `preview_animation` | L0 | Editor | clip, `maxFrames` (1–64, default 32) | Ordered frame PNGs, the playback schedule and empty-frame invariants |
| `subscribe_events` | L0 | Editor | — | Current `stateHash` and how `projectChanged` notifications arrive |
| `suggest_motion_preset` | L0 | Editor | `prompt` (≤500 chars) | A preset and parameters, from keyword matching. No model call |
| `macro_list` | L0 | Editor | — | Saved macros |

### Server-side reads

| Tool | Tier | Where | Parameters | Result |
| --- | --- | --- | --- | --- |
| `get_knowledge` | L0 | Server | `topic`, optional `style` | A knowledge topic as Markdown. See [Knowledge base](knowledge-base.md) |
| `get_quota` | L0 | Server | — | This client's budget per tier |
| `get_operation_log` | L0 | Server | `limit` (1–200, default 20) | Audit entries, newest first; arguments are hashes |
| `brain_interpret_prompt` | L0 | Editor | `prompt` (≤2000 chars) | Corrected and enhanced prompt, detected intent, target clip and layer, recommended tool sequence |

### Pairing

| Tool | Tier | Where | Parameters | Result |
| --- | --- | --- | --- | --- |
| `pair_client` | L0 | Server | `name` (1–60 chars) | `clientId`, `clientName`, `tier`, `token`, a note. The only tool a pairing code may call |

### Task board

| Tool | Tier | Where | Parameters | Result |
| --- | --- | --- | --- | --- |
| `brain_get_status` | L0 | Server | — | Master switch, editor connection, last project, session and client counts, board counts |
| `brain_get_capabilities` | L0 | Server | — | The whole catalog filtered to your tier. Plans must only name tools listed here |
| `brain_get_tasks` | L0 | Server | — | `pending`, `claimed` and the last 10 `finished` tasks |
| `brain_get_task` | L0 | Server | `id` | One task record |
| `brain_claim_task` | L1 | Server | `id` | Exclusive claim. Fails unless the task's project is active in the editor |
| `brain_update_task_progress` | L1 | Server | `id`, `progress` (≤200 chars) | Owner-only note; moves `claimed` to `running` and refreshes the lease |
| `brain_complete_task` | L1 | Server | `id`, `result` (≤2000 chars) | Marks the task done and reports whether the document changed |
| `brain_fail_task` | L1 | Server | `id`, `reason` (≤2000 chars) | Marks the task failed |
| `brain_cancel_task` | L1 | Server | `id` | Cancels a task you claimed. Pending tasks belong to the artist |

### Projects and files

| Tool | Tier | Where | Parameters | Notes |
| --- | --- | --- | --- | --- |
| `create_project` | L1 | Editor | `name`, `width`, `height` (16–256), `fps` (default 8), `palette`, `confirm: true` | Replaces the active document. Refused with `dirty_project` while there are unsaved changes |
| `open_project` | L1 | Editor | `projectId` | Same dirty guard |
| `rename_project` | L1 | Editor | `name` | Renames the active document without changing artwork |
| `save_project` | L2 | Editor | — | Saves to the current file. With no file yet, the app opens a native Save As dialog and waits for the human |
| `resize_canvas` | L2 | Editor | `width`, `height`, `anchor` `top-left` or `center` | Content is shifted, never rescaled |
| `set_style_profile` | L1 | Editor | `profile` | Sets Style Lock. The whole profile object is required |

### Frames

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `add_frame` | L1 | clip, `afterIndex`, `copyContent` | Appends, or inserts after `afterIndex`. `copyContent` duplicates that frame's pixels |
| `duplicate_frame` | L1 | clip, `frameIndex` | Exact copy inserted after the frame |
| `reorder_frames` | L1 | clip, `from`, `to` | Moves a frame |
| `set_frame_duration` | L1 | clip, frame, `durationMs` | `0` inherits the clip FPS; otherwise duration is milliseconds |
| `delete_frame` | L2 | clip, `frameIndex` | Goes to the project trash |
| `restore_from_trash` | L1 | `entryId` | Restores a deleted frame, layer or clip |
| `purge_trash` | L2 | optional `entryId` | Permanently removes one entry, or the whole trash |

### Clips

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `add_clip` | L1 | `name`, `fps`, `frameCount` (1–64) | New clip with its own layer stack |
| `set_clip_props` | L1 | clip, `name`, `fps`, `loop`, `loopMode` | `loopMode` is `forward`, `reverse` or `pingpong` |
| `set_clip_tags` | L1 | clip, `tags` | Replaces named inclusive frame ranges such as `walk: 0–3` |
| `delete_clip` | L2 | clip | Goes to the project trash |

### Layers

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `add_layer` | L1 | clip, `name` | Added on top of the stack |
| `duplicate_layer` | L1 | clip, layer | Copy inserted above, with all its cels |
| `delete_layer` | L2 | clip, layer | Goes to the project trash |
| `set_layer_props` | L1 | clip, layer, `name`, `visible`, `opacity` (0–1), `locked`, `blend`, `modifiers` | `modifiers` attaches/clears non-destructive Live FX (`outline`, `shadow`, `colorRemap`) |
| `reorder_layers` | L1 | clip, layer, `direction` `up` or `down` | One position |
| `set_layer_linked` | L1 | clip, layer, `linked` | Shares one cel across all frames, or unlinks into independent cels |
| `merge_down` | L1 | clip, layer | Composites onto the layer below |

### Painting and transforms

All of these take clip, frame and layer references and are one undo step.

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `set_pixels` | L1 | `color`, `pixels` (1–2000 of `{ x, y, color? }`) | Per-pixel colour overrides the fallback. Out-of-canvas pixels are rejected |
| `fill_rect` | L1 | `from`, `to`, `color`, `filled` | Filled by default |
| `replace_color` | L2 | `from`, `to` | Exact RGBA match on the cel |
| `flip_frame` | L1 | `axis` `horizontal` or `vertical`, optional `rect` | Mirror a cel or a region |
| `rotate_frame` | L1 | `direction` `cw` or `ccw`, optional square `rect` | 90° rotation |
| `shift_frame` | L1 | `dx`, `dy` | Vacated pixels become transparent |
| `beautify_layer` | L1 | `outline`, `shade` | 1 px outline plus directional shading on bottom and right edges |
| `set_vectors` | L1 | clip, frame, layer, `vectors` (0–64 shapes: `line`/`curve`/`rect`/`ellipse`/`polygon`) | Non-destructive pixel-perfect editable shapes rendered before Live FX modifiers |
| `bake_vectors` | L1 | clip, frame, layer | Rasterizes editable vectors on the cel into permanent crisp pixels |

### Palettes and Style Lock

| Tool | Tier | Where | Parameters | Notes |
| --- | --- | --- | --- | --- |
| `add_palette_color` | L1 | Editor | `hex` | No-op if present |
| `remove_palette_color` | L1 | Editor | `hex` | Removes a palette entry; it does not recolor pixels |
| `generate_hue_ramp` | L1 | Editor | `baseColor`, `steps` (3–9), `autoShift`, `shadowHueShift`, `highlightHueShift`, `contrast`, `addToPalette` | Automatic Hue Shifter: builds a cool-shadow / warm-highlight ramp and optionally adds new swatches in one undoable step |
| `set_palette` | L2 | Editor | `colors` (1–256) | Replaces the whole palette |
| `apply_library_palette` | L2 | Server | `id` | Resolves a library palette, then performs `set_palette` on the editor |
| `harvest_palette` | L1 | Editor | `pngBase64`, `maxColors` (2–32, default 16) | Median-cut colours from any PNG, dark to light |

### Imports

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `import_image_as_layer` | L1 | clip, frame, `name`, `pngBase64` | The image must match the canvas size exactly |
| `import_frame_strip` | L1 | `name`, `columns`, `rows`, `fps`, `pngBase64` | A sheet of canvas-sized cells becomes a new clip, one layer per frame. Up to 32×32 cells |

### VFX

| Tool | Tier | Where | Parameters | Notes |
| --- | --- | --- | --- | --- |
| `list_vfx` | L0 | Editor | optional `category` | The effect catalog |
| `generate_vfx` | L1 | Editor | `effect`, `seed`, `frames` (≤64), `fps` (default 12), `fit`, `light`, `x`, `y`, `palette`, `name` | Renders a seeded effect into a new clip. `palette` is `project` or a dark-to-bright ramp |

### Motion

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `set_parts` | L1 | clip, `parts` (0–32 of `{ name, layerId or layerName, rect, anchorFrameIndex, z }`) | Replaces the clip's parts. Parts are regions, never cuts |
| `apply_motion_preset` | L1 | `preset`, `sourceClipId`, `amplitude` (0.25–3), `frameCount`, `gapFill`, `smear`, `anchorFrameIndex`, `overwrite`, `targetClipId`, `targetName` | Writes a new clip, or overwrites the target's leading frames with `overwrite: true`. Returns a report, QA issues and a preview PNG |

Presets: `idle`, `walk`, `run`, `attack`, `jump`, `spin`, `duck`, `hurt`, `swim`, `death`.

### Macros and batch

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `macro_save` | L1 | `name`, `steps` (1–50 of `{ tool, args }`) | Stored in the editor's browser storage |
| `macro_run` | L1 | `name`, `stopOnError` | Replays the steps |
| `macro_delete` | L1 | `name` | — |
| `batch` | L1 | `steps` (1–50), `stopOnError` | One undo entry. Any failure rolls the document back to the pre-batch state |

> **Trust note.** `macro_run` and `batch` execute their steps under your identity without a
> per-step tier check. Only run macros and batches whose steps you have read.

### Exports and history

| Tool | Tier | Parameters | Notes |
| --- | --- | --- | --- |
| `export_sheet` | L2 | clip, `padding`, `spacing` (0–64) | A horizontal sheet at native size, returned as a base64 data URL. It is not written to disk |
| `export_gif` | L2 | clip, `scale` 1 / 2 / 4 / 8, `bg` | Animated GIF data URL; transparency is flattened on `bg` |
| `undo` | L1 | — | One shared history with manual edits |
| `redo` | L1 | — | — |

### Learning

| Tool | Tier | Where | Parameters | Notes |
| --- | --- | --- | --- | --- |
| `study_reference` | L1 | Server | `pngBase64` (1–512 px per side), `styleName`, `notes` | Measures a sprite and appends a learned style doc. Analysis only; nothing enters the canvas |

## Error codes

| Code | Where | Meaning and fix |
| --- | --- | --- |
| `unauthorized` | HTTP 401 | Missing bearer token. Pair in Settings |
| `unknown_token`, `token_revoked` | HTTP 401 | Bad or revoked token. Pair again |
| `pairing_used`, `pairing_expired` | HTTP 401 | Ask for a fresh code |
| `auth_throttled` | HTTP 429 | Too many failed auths; wait a minute |
| `dns_rebind_host` | HTTP 403 | Wrong `Host` header. Connect to the loopback endpoint directly |
| `untrusted_origin` | HTTP 403 | Cross-origin MCP access is rejected |
| `length_required` | HTTP 411 | Send `Content-Length` |
| `payload_too_large` | HTTP 413 | Body over 2 MB |
| `session_not_found` | HTTP 404 | Re-initialize the session |
| `permission_denied` | Tool | Your tier does not grant the tool. Ask for a higher tier when pairing |
| `mcp_disabled` | Tool | MCP is switched off in Settings |
| `rate_limited` | Tool | Budget exhausted. Check `get_quota` and slow down |
| `task_project_mismatch` | Tool | A claimed task targets another project. Open that project in the editor |
| `editor_not_connected` | Tool | The app is not attached to the MCP server. Open it and enable MCP |
| `editor_timeout`, `editor_disconnected` | Tool | The editor did not answer within 30 s, or went away mid-call |
| `editor_busy` | Tool | A manual stroke is in progress (HUD shows a waiting notice). Retry in a moment |
| `artist_paused` | Tool | The artist toggled **Pause AI** on the live HUD to hold canvas writes; read-only `L0` tools still work. Ask the artist before retrying |
| `stale_document` | Tool | `expectedStateHash` is old. Re-read `get_project_state` |
| `dirty_project` | Tool | Unsaved changes block replacing the document. Ask the user to save |
| `unknown_tool` | Tool | Not implemented by this editor |
| `bad_request` | Tool | Invalid arguments; the message says which |
| `internal_error`, `mcp_transport` | Tool / HTTP 500 | Unexpected failure |

Validation failures raised inside the editor arrive lower-cased from the core's codes:
`validation_failed`, `not_found`, `invalid_state`, `unknown_command`,
`transaction_conflict`.

## Notifications and resources

| Kind | Name | Payload |
| --- | --- | --- |
| Notification | `notifications/pixelforge/projectChanged` | `{ stateHash, name, dirty }` — sent to every live session when the document changes |
| Notification | `notifications/tools/list_changed` | Sent only on request; the catalog is static today |
| Resource | `pixelforge://capabilities` | The catalog filtered to the reader's tier |
| Resource | `pixelforge://project/active` | The result of `get_project_state` for the active project |

## Server instructions

The server sends these instructions with `initialize`:

> PixelForge AI pixel art & animation editor. Read get_project_state first; ids and stateHash
> from it feed the other tools. Follow the project palette and Style Lock. For drawing, read
> get_knowledge on methodology and grids, plus characters for character sprites. Block in the
> silhouette, draw, then inspect get_frame_png at native size and revise unclear shapes. For
> animation read the animation topic; for effects read vfx and use list_vfx. Inspect the ordered
> frames from preview_animation and check timing and emptyFrames. Run validate_style for
> technical checks. If your client cannot display images, report that visual review is pending.
> Respect dirty_project when replacing a document.

## The workflow agents are asked to follow

1. Read `get_knowledge` on `agent`, then `methodology` and `grids`. For a character, also
   `characters`.
2. Call `get_project_state`. Treat its ids and `stateHash` as binding.
3. Read `get_frame_png` at native size. Start from the silhouette, then colour clusters, then
   details.
4. Draw on a dedicated layer with `set_pixels`. Group steps in `batch` so that one call is one
   undo step.
5. For motion: `set_parts`, then `apply_motion_preset`. For effects: `list_vfx`, then
   `generate_vfx`.
6. Inspect `preview_animation`, then run `validate_style` before presenting the work.

## Task board

The task board hands work from the artist to connected agents. It lives in the MCP server
(`brain-tasks.json`) and is shared by every paired agent.

```text
             brain-push (editor)                brain-claim (agent, exclusive)
   [ queued ] ───────────────► pending ───────────────────────────────────► claimed
                                 ▲    │                                          │
              lease expired or    │    │ claimed for another project             │ progress
              project switched     │    ▼                                          ▼
                                 └── blocked ◄────────────────────────────── running
                                                                              │        │
                                                    complete: done ◄────────────┘        └─ fail: failed
   cancelled ◄── agent cancels its own, or the artist cancels any unfinished task
```

**Rules**

- A push adds up to 20 tasks. The board keeps the 100 newest. New tasks are appended by
  default; `replacePending` supersedes tasks that are still pending and keeps history.
- `idempotencyKey` prevents a re-sent plan step from duplicating active or finished work.
- A task queued without a target is stamped with the editor's active project at push time.
- Only pending tasks can be claimed, and only by one agent.
- Claiming, progress and finishing are refused unless the editor's active project is the task's
  target. On a project switch mid-task, the task returns to the board.
- Progress doubles as a heartbeat. A claim with no progress for 10 minutes
  (`PF_BRAIN_CLAIM_TIMEOUT_MS`) is swept back to pending.
- Completion is verified: `verified` is `true` when the document hash changed between claim and
  finish, `false` when it did not, and `null` when either hash is unknown.
- While an agent holds a claimed task, its edits are restricted to that project, and it cannot
  replace the document with `create_project` or `open_project`.
- The artist may cancel any unfinished task and retry failed ones from the Brain panel.
- A corrupt board file is quarantined as `brain-tasks.corrupt-<timestamp>.json`, never wiped.

**Task record**

| Field | Meaning |
| --- | --- |
| `id`, `title`, `detail` | `bt_…`; title up to 200 chars, detail up to 2000 |
| `status` | `pending`, `claimed`, `running`, `done`, `failed`, `cancelled` |
| `claimedBy`, `claimedByClient`, `claimedAt` | Owner display name, stable client id, lease anchor |
| `progress`, `result` | Owner's progress note; the completion or failure text |
| `planId`, `idempotencyKey` | Plan grouping and de-duplication |
| `stateHashAtClaim`, `stateHashAtFinish`, `verified` | Completion verification |
| `targetProjectKey`, `targetProjectName` | The project the task must run in |
| `reviewStatus`, `reviewClipId`, `reviewFrameIndex`, `reviewStateHash`, `reviewedAt` | Artist's approval or revision request for a completed task, tied to the reviewed project state and frame |

A project key is `db:<id>` for a database project, `file:<path>` for a file, or
`unsaved:<session>:<epoch>` for an untitled document.

## Live AI Artist Co-Pilot HUD

While an IDE agent is connected or actively editing over MCP, PixelForge renders a lightweight live collaboration HUD directly on the canvas stage (zero document side-effects, zero 60fps React re-renders):

- **Progressive Pixel Reveal, Rim Glow & AI Cursor:** While an agent tool is running (`busy`), the pixel board pulses with a soft teal rim glow; when pixels commit, they sweep onto the canvas progressively along a serpentine brush path with glowing corner brackets and a moving agent cursor badge. Starting a manual brush stroke or pressing Undo immediately snaps the reveal to the real pixels.
- **Connected Presence & Status Pill:** Shows connected IDE agent count (`N AI live`), active tool verb, and pixel delta (`+N px`).
- **Hold-to-Compare (`Before`) & Stroke Replay:** Hold **Before** on the pill or an activity row to peek at the pre-edit frame with a `BEFORE` tag; click **Replay** on a recent feed row to re-watch the brush sweep live.
- **1-Click & Per-Step Undo:** Undo the latest AI edit from the pill, or expand the **AI Activity Feed** (up to 16 recent steps) to jump to any edited clip/frame, flash its region, or safely undo to a specific step. Press `Escape` or click outside to close the feed.
- **Artist Priority Pause & Smart Auto-Follow / Auto-Pan:** Click **Pause** on the pill to hold mutating MCP writes (`artist_paused`) while keeping `L0` inspection available. When **Follow** is ON, PixelForge switches to the edited clip/frame and pans the viewport if an edit lands off-screen while zoomed in; toggle **Follow** off to stay put and use the clickable **Jump** button instead.
- **Two-Way `artistContext`:** `get_project_state` includes `artistContext` (`selection`, `primaryColor`, `secondaryColor`, `tool`, `mirrorX`, `mirrorY`, `tiledWrap`, `aiPaused`) so an agent can respect the artist's marquee selection and active canvas settings.
- **Auto-Eyes Self-Critique:** Every pixel-writing MCP call (including `batch`, `macro_run`, `resize_canvas`, `auto_trim`, `merge_down`, and hidden-layer edits) automatically returns a native zoomed gridded `image/png` preview block with crisp X/Y coordinate rulers (`0, 8, 16…`, dark checkerboard at `scale >= 2`, base64 stripped from text JSON) PLUS `visualCheck` (exact sprite bounds, margins, 4-connected parts, tiny floating fragment coordinates, horizontal symmetry %, off-palette color count, a cropped color-indexed `asciiGrid` — 1:1 up to 48×48 and cleanly downsampled for larger sprites — and common-sense warnings including hidden/occluded layer alerts). `preview_animation` also auto-zooms with checkerboard and reports per-frame `frameBounds` plus `consistencyWarnings` for ground-line or height jumps.

## Second Brain panel

Open it with the **Brain** tab or Ctrl+Shift+B. Everything here is deterministic and local.

**Prompt interpreter.** Type a short, incomplete or misspelled prompt. The interpreter:

1. applies your learned vocabulary aliases;
2. corrects known typos (`wlak` → `walk`) and normalises bare hex colours;
3. expands shorthand (`no bg` → `transparent background`);
4. resolves "it" or "this" against the project name;
5. detects an intent — sprite, animation, VFX, palette, layer edit or project workflow — and
   names the target clip, layer, matching VFX effect, Motion preset, and Starter Template;
6. writes an enhanced prompt from the canvas size, Style Lock and your preferences;
7. recommends a tool sequence, filtered against the real tool catalog.

Right below the enhanced prompt, Second Brain provides **direct actions**:
- **Instant local execution:** 1-click **Run VFX** (when a `pixelfx` effect matches), **Drop Starter Base** (when one of the 8 built-in starter templates matches), or **Open Motion**.
- **Copy for IDE AI:** Copies a structured handoff prompt containing the enhanced prompt, canvas dimensions, active clip/frame, active marquee selection (if any), palette size, and staged live MCP drawing instructions ready to paste into Claude Code, Codex, Cursor, or Antigravity.
- **Queue + Trigger:** Pushes the task onto the **Agent Task Board** and copies a 1-line wake trigger. Because MCP servers cannot force-wake an idle LLM chat without a human turn, pasting that 1-line trigger into your IDE agent starts the queued work immediately.

Thumbs up or down saves the interpretation, with an optional note, as a learned preference.

**Learning memory.** Stored in the browser (`localStorage` key `pixelforge:second-brain:memory:v1`,
format version 2):

| Field | Cap | Meaning |
| --- | --- | --- |
| `prefer`, `avoid` | 16 each | Standing cues added to every enhanced prompt |
| `customAliases` | — | Your vocabulary, alias → replacement |
| `feedbackHistory` | 40 | Past interpretations and ratings |
| `recentContext` | 25 | Recent agent tool activity, used as context |

Controls: clear recent activity and feedback while keeping preferences; factory reset; copy
the whole record as JSON.

**Pixel Art Recipe.** Choose a sprite recipe, set camera, pose, palette limit, lighting and
references, then compose an editable drawing contract. **Queue & Copy Trigger** puts the contract
on the task board and copies a short wake prompt to paste into your IDE agent; **Copy brief**
copies the full contract directly.

**Artwork proof.** Open **Review** on a completed task to inspect the live selected clip at
native 1× and enlarged size, play its frames with their saved timing, and see technical craft
and Style Lock warnings. **Approve frame** stores a human verdict. **Request revision** queues
a project-bound task with your feedback and the selected clip/frame. A warning appears if the
project changes after approval; the proof is a live view, not a saved snapshot of agent output.

**Board controls.** Copy a wake trigger for all pending tasks (**Copy wake trigger**), cancel a
task, re-queue failed tasks, remove finished tasks, and revoke an agent's token.

## MCP Tools panel (Agent tab)

The **Agent** tab (**MCP Tools**) is a local MCP tool runner and 1×/3× Before/After style inspector backed by `src/lib/pixelforge/mcp-tool-catalog.ts` — it executes calls in-process on the shared CommandBus and shows live remote edits from connected IDE agents:

- **Quick actions:** Run deterministic tools locally (`Outline + shade`, `Create 4 empty frames`, `Preview Idle Animation`).
- **Review Result:** For pixel tools (`set_pixels`, `fill_rect`, `replace_color`, transforms, `beautify_layer`, `resize_canvas`) it renders 1× and 3× before/after canvases plus Style Lock checks and a 1-click Undo button.
- **Session log:** Lists local runs and live relayed edits tagged with the real connected client name (e.g. `Claude Code (MCP)`, `Codex (MCP)`).
- **Manual tools:** Filter and run any MCP tool with JSON arguments or plain-English quick commands (`flip h`, `rotate ccw`, `opacity 50`).
- **Copy brief:** Copies a Markdown briefing with the live endpoint and tool examples.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Settings shows the server but "editor not connected" | The editor bridge could not attach. Another window may hold the slot; close it, or press **Take over the bridge** |
| `403 dns_rebind_host` | The `Host` header is not the loopback host. Remove proxies in front of the endpoint |
| `401` after a restart | The token was revoked. Pair again |
| Tools return `editor_not_connected` | Keep the app open; it is the tool executor |
| Edits do not appear on canvas | The view follows the target of each relayed command, but check the active clip and layer visibility |
| A claimed task cannot be claimed or finished | The editor is showing another project. Open the task's project |
| The packaged app is not on port 3030 | Another process held the port. Use the endpoint shown in Settings |
| Vision review is impossible | The client has no image support. Report that visual review is pending |

## Live test scripts

These run as real external MCP clients against a running app. Each needs a pairing code.

| Script | What it does |
| --- | --- |
| `mini-services/mcp-server/e2e-client.mjs` | Pairs, then inspect → palette → clip → duplicate frame → paint → verify PNG → undo → structured errors |
| `mini-services/mcp-server/live-client-test.ts` | Pairs and runs the Brain tool sequence |
| `mini-services/mcp-server/zcode-live-verify.mjs` | Pairs as client `ZCode` and runs checks |
| `mini-services/mcp-server/verify-tiers.mjs` | Checks the tier contract of an installed build |
| `mini-services/mcp-server/fire-task.ts` | Builds a four-frame fire clip with `generate_vfx` |
| `mini-services/mcp-server/slime-fire-task.ts`, `repaint.ts`, `repaint-clean.ts` | Draw a slime fire attack with local tools in one batch |

`benchmark/run-benchmark.mjs` is stale: its live mode calls `generate_sprite`, which no longer
exists.
