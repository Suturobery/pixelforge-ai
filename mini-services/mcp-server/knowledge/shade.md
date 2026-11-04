# Shade a sprite

<!-- Adapted from with-pebbly/aseprite-ai-artist (MIT) for PixelForge. -->

Flat shading — the same hue, darker — is the clearest signal that a sprite was
made by moving a brightness slider. Real shading shifts hue.

## The rule

- **Shadows** rotate toward blue/purple and desaturate slightly.
- **Highlights** rotate toward yellow/orange and saturate slightly.

## Procedure

1. **Fix the light direction and state it.** Upper-left is the safe default.
   It does not move again — not across the sprite, not across frames.
2. **Confirm the flat art is right first** (`get_frame_png`). Shading a bad
   silhouette wastes the effort.
3. **One shadow step.** `set_pixels` the region away from the light. Draw the
   shadow shape so it follows the form's cross-section, not the outline —
   a shadow that follows the outline reads as a stain, not volume.
4. **Look again** (`get_frame_png`). Does it read as volume?
5. **One light step** on the side facing the light.
6. Most sprites are finished here.
7. **Only if it needs it:** a deep shadow in occluded crevices, a specular
   highlight of one or two pixels on the hardest material, or reflected
   light — a faint cool step on the shadow side's outer edge (makes metal
   read as metal).

## Ramps

If a material gets shaded more than once, put its ramp in the palette
(`add_palette_color` / `set_palette`). Reuse the darkest step across
materials — it ties a sprite together and costs no palette slots.

## Dithering

Only on 32px+ sprites and only in large flat areas. Keep the two colours
adjacent in a ramp, and stop if it reads as noise.

## Checks

- Is the light in exactly one place?
- Do the shadows hue-shift, or are they the same hue darker?
- Any banding — long parallel stripes of adjacent steps?
- Any semi-transparent pixels? (`validations` topic.)
