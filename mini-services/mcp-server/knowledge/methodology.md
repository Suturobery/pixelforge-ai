# Methodology — the brief → draw → critique → fix loop

You are the pixel artist; the tools are just your hand. Never skip the loop.

## 1. Brief

Before the first pixel, decide and state:

- canvas size (and whether the art is 1x or upscaled Nx)
- palette with a hard color budget (pick or extract one; consult `palettes`)
- style references (check `get_knowledge {topic:"learned"}` for a studied match)
- outline rule (none / selective / full black)
- light direction (one direction, everywhere)

Consult `patterns`, `techniques` and `sharp_edges` as needed.

When the request was vague ("make me a knight"), confirm the brief with the
user in one message before the first pixel — one question beats one wrong
sprite. Specific edit requests skip the gate.

## 2. Draw

Build the sprite through small, undoable steps (`set_pixels`, `fill_rect`, …).
Work silhouette first, then clusters, then detail, then AA/outline cleanup
(`cleanup`). Bigger is not better: the smallest canvas that reads wins.

## 3. Critique — look at your own work

Render a preview (`get_frame_png`), then judge it against `validations`:

- does it read at 1x, as a silhouette, and at target zoom?
- is the light consistent? ramps within the palette budget?
- clusters clean, no lonely pixels, no unintentional jaggies?
- palette count actually enforced?

## 4. Fix

Fix what the critique found — through the bus, so everything stays undoable.
Then loop back to 3 until it passes. Two clean passes > one rushed finish.

## Animation

Apply `animation` curves (idle/walk/run/attack/jump) via the motion presets;
verify with `preview_animation` and the flicker checks. Consistency beats
detail: every frame must belong to the same body.

## Studying new styles

Feed references through `study_reference`; retrieved learned styles are part
of the brief in step 1.

## Fixing existing art

Edits to art that already exists follow the `fix` topic instead of this loop:
never break what is already right.
