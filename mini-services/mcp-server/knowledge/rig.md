# Rig a character for animation

<!-- Adapted from with-pebbly/aseprite-ai-artist (MIT) for PixelForge. -->

Pixels baked into a single layer cannot be animated without redrawing them.
Rig first: split the character onto named layers (cels), so animation moves
cels instead of re-drawing pixels — then the motion presets can drive it.

## The standard rig

Bottom to top, so nearer parts draw over farther ones:

```
arm-near     ← camera-side arm
leg-near
head
torso
arm-far      ← partly hidden by the torso; this is what sells depth
leg-far
shadow       ← ground contact, if the style has one
```

Add `weapon`, `cape`, `hair-front`, `hair-back` as the design needs. Keep the
layer names stable — every later tool call and preset refers to them by name.

## Building it fresh

Create the layers first (`add`/layer ops via the bus), then draw each part on
its own layer from the start. One structural edit, one undo step.

## Splitting an existing sprite

When the art is already baked into one layer:

1. Inspect the exact part boundaries before touching anything
   (`get_frame_png`, zoomed). Guessing coordinates is how limbs get clipped.
2. Create the rig layers.
3. Copy each part to its layer (`set_pixels` with selection-clip /
   transform ops). **Copy generously** — a limb needs a pixel or two of
   overlap with the torso, or a gap appears the moment it moves; the stacking
   order hides the excess.
4. Hide the original layer — do not delete it. If a boundary was wrong, you
   want the original still there.
5. Preview with the original hidden. The sprite should look unchanged; a limb
   that lost pixels means the boundary was wrong.

## Then

Tag the parts (`set_parts`) and apply a motion preset (`apply_motion_preset`,
see the `animation` topic). Idle/walk/run move the named cels — no redraws.
