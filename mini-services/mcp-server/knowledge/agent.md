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

## Style contract & v0.4.0 AI-Proof Consistency Pack

PixelForge owns the art rules — you plan, it enforces:

1. **Read before drawing.** `get_project_state` includes `styleProfile`
   (art direction, lighting, outline, palette mode, notes, feedback cues)
   AND `styleAnchor` (when the artist pinned a Hero Sprite Style Anchor:
   exact `spriteWidth × spriteHeight`, `bottomMargin` ground line,
   `outlineStyle`, `paletteUsed`, and `craftScore`). Match those exact
   proportions, ground line, and outline style on every new character/prop.
2. **Start from clean proportions with Starter Templates.** Call
   `list_templates` (L0) and `generate_template` (L1) to drop a palette-locked,
   sel-out polished starter base (`chibi-humanoid`, `slime`, `rpg-sword`,
   `potion-flask`, `treasure-chest`, `stone-pedestal`, `topdown-tree`,
   `dungeon-tile`) onto a new layer — character templates auto-tag Motion
   body parts (`head`, `body`, `armL`, `armR`, `legL`, `legR`) immediately.
   Refine details on top instead of guessing anatomy from a blank grid.
3. **Pin your Hero Sprite with `pin_style_anchor` (L1).** Once the first hero
   sprite is approved, call `pin_style_anchor` so every subsequent sprite in
   the project inherits the exact height, ground line, and outline signature.
4. **Act on the automatic `craftGate` after every pixel write.** Every
   pixel-writing tool (`set_pixels`, `fill_rect`, `draw_line`, `draw_ellipse`,
   `draw_polygon`, `flood_fill`, `beautify_layer`, `generate_template`)
   returns a compact `craftGate` (`score`, `grade: "clean"|"polish"|"needs_fix"`,
   `counts`, up to 6 `topDefects` with exact `{kind, x, y}`, and `hint`).
   If `grade !== "clean"`, fix the flagged pixels or run `beautify_layer`
   before presenting the sprite.
5. **It is enforced by the tools you already use.** `get_palette` returns
   the project palette; `set_pixels` and friends validate palette
   membership, and `validate_style` confirms the result obeys the profile
   (size, outline, margins). Check the state's `styleProfile` instead of
   assuming — and never invent colors outside the palette.
6. **Change it with `set_style_profile` (L1)** when the artist asks for a
   style change — not silently. Off-profile edits are still possible with
   pixel tools; keep them inside the palette and outline rules.
7. **Critique is separate from validation.** `validate_style` (free, L0)
   runs the deterministic checks — size, crisp alpha, palette membership,
   transparent background, margins — on any frame. Run it BEFORE presenting
   work; fix warnings first. Subject readability and pose clarity are
   judged by the artist — never claim aesthetic
   certainty.

## Work like a pixel artist the user can watch

The artist sees every call land live (moving AI cursor, pixel-glow trail, status
pill) and can undo each step — so draw in visible stages, not one giant call:

1. Block in the silhouette first (`fill_rect` / `draw_polygon` / `draw_ellipse`).
2. Fill base colors, then add shading and highlights with palette colors.
3. Add the outline / sel-out last, then `beautify_layer` only if `craftGate` asks.
4. **Use Auto-Eyes after EVERY stage:** every pixel-writing tool automatically
   returns a crisp zoomed gridded preview image PLUS `visualCheck` (exact cropped
   `asciiGrid` with `y` row numbers and color legend, `bounds`, `floatingFragments`,
   `symmetryX`, and common-sense `warnings`) alongside `craftGate`. Look at the
   returned image and `asciiGrid` after each pass to catch crooked eyes, detached
   limbs, stray floating dots, flat shading, or bad proportions and fix them
   before moving to the next stage. For extra zoom inspection, call
   `get_frame_png { scale: 8, showGrid: true }`.

Prefer several small, meaningful calls (a body part, a shading pass) over one
huge `set_pixels` or `batch` — it keeps the artist in the loop, makes mistakes
cheap to undo, and keeps the collaboration feeling alive. Say what you are
about to do in your chat reply before each stage.

- Check `artistContext` in `get_project_state` before editing: if the artist drew
  a marquee `selection` (`{x, y, w, h}`) and asks you to edit "this area" or
  "my selection", keep your pixels inside that box. Respect their `primaryColor`,
  `mirrorX`/`mirrorY` symmetry, and `tiledWrap` seamless mode when relevant.
- If a write returns `editor_busy`, the artist is mid-brush-stroke — wait a beat
  and retry rather than spamming calls.
- If a write returns `artist_paused`, the artist toggled **Pause AI** on the live
  HUD to take over the canvas — stop mutating immediately and ask them before
  resuming.

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
