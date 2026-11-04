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
3. `apply_motion_preset` commits atomically to a NEW clip by default — pass
   `overwrite:true` + `targetClipId` only when replacing frames on purpose.

## Where the money is

`generate_sprite` is the only PAID tool (L3 + provider quota). Everything
else — drawing, animation, palettes, macros, knowledge — is deterministic
and free. Do not wait on provider quota to do canvas work.
