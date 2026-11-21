# Driving PixelForge as an agent

How to work fast and never damage the user's work.

## Session flow

1. Call `get_project_state` FIRST. Its ids (clipId, layerId, frameId) and
   `stateHash` feed every other tool.
2. Target clips/layers/frames by explicit `clipName` / `layerName` /
   `frameIndex` — never guess ids from a previous read if `subscribe_events`
   reported a change (the `stateHash` moved).
3. Pass `expectedStateHash` (from any read) on writes when you want the
   optimistic-concurrency guard: the write fails with `stale_document`
   instead of landing on a document you did not expect.

## Speed rules

- **Batch everything multi-step.** `batch` (or a saved `macro_run`) runs up
  to 50 tool calls in ONE round-trip and ONE undoable transaction. This is
  the single biggest speedup — each relayed call costs you rate budget.
- **One `set_pixels` can paint 2000 pixels.** Compose the whole sprite as a
  pixel list instead of painting stroke by stroke.
- **Check `get_quota` before long jobs.** Budgets are per tool tier per
  minute (L0 60, L1 120, L2 60, L3 20). Failed calls still consume budget —
  back off on `rate_limited`, do not hammer.
- **Palettes: 2000+ library presets are one call away** — browse with
  `get_knowledge {topic:"palette_library", style:"gameboy"}`, apply with
  `apply_library_palette {id}` (L2, undoable).

## Safety rules

- Writes are undoable and share ONE history with the human editor. The user
  can undo your work; never assume your edits are invisible.
- `create_project` and `open_project` replace the ACTIVE document. They are
  rejected while the document is dirty (`dirty_project`); `create_project`
  additionally requires `confirm: true`. The user saves manually (Ctrl+S).
- Deletes are trash-backed: `delete_frame` / `delete_layer` / `delete_clip`
  land in the project trash — restorable with `restore_from_trash` using the
  entry id from `get_project_state`.
- A clip always keeps at least one frame, a project at least one clip.
- Do not run `undo` / `redo` / `batch` as steps inside `batch` or macros —
  they are rejected inside a transaction.

## Naming conventions

- `duplicate_layer` names the copy `"<source name> copy"`, inserted directly
  above the source.
- `add_layer` without a name creates `"layer N"`; new clips start with one
  layer named `"Layer 1"`.
- Prefer explicit names you pass yourself — agents that address layers by
  name should avoid ambiguous defaults.

## Animation workflow

1. `get_knowledge {topic:"animation"}` for curves, then
   `suggest_motion_preset` (free, deterministic) for parameters.
2. Tag body regions with `set_parts` (head/body/armL/armR/legL/legR).
3. Drawing pixel art? Read `get_knowledge {topic:"grids"}` (method) and `get_knowledge {topic:"characters"}` (proportion recipes + quality bar) first.
4. `apply_motion_preset` commits atomically to a NEW clip by default — pass
   `overwrite:true` + `targetClipId` only when replacing frames on purpose.
4. `preview_animation` returns `invariants` — `emptyFrames` (pose never
   drawn) and `uniformTiming`. An empty in-between is a bug, not a style:
   draw it before showing the clip.

## Style contract

PixelForge owns the art rules — you plan, it enforces:

1. **Read before drawing.** `get_project_state` includes `styleProfile`
   (art direction, lighting, outline, palette mode, notes, feedback cues).
   Treat it as binding: wrong-style sprites fail `validate_style`.
2. **It is enforced by the tools you already use.** `get_palette` returns
   the project palette; `set_pixels` and friends validate palette
   membership, and `validate_style` confirms the result obeys the profile
   (size, outline, margins). Check the state's `styleProfile` instead of
   assuming — and never invent colors outside the palette.
3. **Change it with `set_style_profile` (L1)** when the artist asks for a
   style change — not silently. Off-profile edits are still possible with
   pixel tools; keep them inside the palette and outline rules.
4. **Critique is separate from validation.** `validate_style` (free, L0)
   runs the deterministic checks — size, crisp alpha, palette membership,
   transparent background, margins — on any frame. Run it BEFORE presenting
   work; fix warnings first. Subject readability and pose clarity are
   judged by the artist — never claim aesthetic
   certainty.

## No paid tools, no image generation

There are NO paid tools and NO provider-backed image generation. Every
tool here runs locally and deterministically: drawing, animation, motion
presets, procedural VFX (`list_vfx` + `generate_vfx`, seeded), palettes,
macros, knowledge. If a task looks like it needs an AI image model, it
does not — build it with the pixel and VFX tools instead.

## Task board (second-brain orchestration)

The artist composes work briefs in the Brain Panel (Asset Brief) and they
land here as tasks (`brain_get_tasks`, free, L0). When you are asked to
"work the task board":

1. `brain_get_tasks` → read `pending` items. `brain_get_status` and
   `brain_get_capabilities` (both L0) give service state and your tier's
   tool catalog; `brain_interpret_prompt` (L0) normalizes rough prompts
   against the project before you plan.
2. `brain_claim_task {id}` — exclusive claim.
3. Execute with the normal workflow (grids → paint → validate_style). For
   long jobs emit `brain_update_task_progress {id, progress}` — it also
   refreshes your claim lease.
4. `brain_complete_task {id, result}` on success (include the validation
   summary) or `brain_fail_task {id, reason}` when blocked. You may cancel
   your own claim with `brain_cancel_task {id}`.

Deterministic steps (VFX, palettes) can also be executed by the app
itself — the board only carries work delegated to agents.
