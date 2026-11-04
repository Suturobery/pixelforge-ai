# Fix existing art — without breaking what is already right

<!-- Adapted from with-pebbly/aseprite-ai-artist (MIT) for PixelForge. -->

Editing existing work has a failure mode that drawing from scratch does not:
breaking something that was already correct. The whole procedure is built
around not doing that.

## 1. Understand what is there before changing it

`get_project_state` (canvas, layers, clips, palette) and `get_frame_png`
before anything else. For a targeted edit, look at the exact region — you
cannot edit pixels precisely from a description.

**Never assume layer names, frame counts or the palette.** Drawing into the
wrong layer is the most common way an agent damages someone's file.

## 2. Say what you are about to change

For anything beyond a small touch-up, state the plan in one line and let the
user stop you. Especially before: changing the palette, resizing the canvas,
deleting/merging layers, or editing a layer you did not create.

## 3. Scope the edit as tightly as you can

- A selection limits the edit to one area.
- A layer target keeps you out of everything else.
- A cel target avoids touching other frames.

Scoping is cheaper than repairing.

## 4. Make the change as one undoable step

One grouped edit through the bus = one Ctrl+Z for the user if they dislike
it. Prefer moving/copying cels over redrawing; redraw only where a part
genuinely changes shape, and build the new shape from the previous frame's
pixels so volume does not drift.

## 5. Verify what actually changed

`get_frame_png` again, compare against what you intended — not against what
you hoped. Then run the `validations` checks. If the user said "make it more
X", re-read the request: X must be measurable in the diff you produced.

## Never

- No wholesale redraws to fix a local problem.
- No palette swaps without saying so first.
- No deleting the original when hiding it preserves the escape route.
