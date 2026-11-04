# Design it first — concept before pixels

<!-- Adapted from with-pebbly/aseprite-ai-artist (MIT) for PixelForge. -->

Drawing from nothing asks one model to invent a character, a pose, a camera,
a palette and the placement of every pixel, all at once. That is the step
where generated pixel art falls apart. Split the job:

- **The design** (look, key poses, storyboard) is decided BEFORE pixels — by
  the user, a concept image, or the app's AI generation (candidates → review).
- **You own the pixel interpretation** — reading that design into a canvas,
  a palette and a set of shapes, drawn through the bus.

The reference is a guide for proportion, pose and colour masses. It is never
the pixels: a concept downscaled onto the canvas is anti-aliased mush, and no
amount of cleanup turns it into pixel art.

## Two modes

| What you have | Mode |
|---|---|
| Only words ("a fire mage with a walk cycle") | **Creative** — write the art spec, offer AI generation, or draw from the spec |
| An image — concept art, sketch, screenshot, sheet | **Reference** — study it, then draw to reproduce the design |

## The art spec (write it in the brief, keep it short)

- **Subject & scenario** — who/what, one line of personality; for animation,
  what happens first frame → last frame.
- **Target** — canvas W×H, how many px tall the subject stands, view, facing,
  light direction, outline style.
- **Silhouette** — heads tall; the 2–3 shapes that must read at 1×
  (a pointed hat, a long coat, an oversized sword).
- **Palette** — exact hex list with roles (outline, skin ramp, cloth ramp,
  metal ramp, accent). Its size is the ceiling.
- **Animation** — cycle, frame count, one line per key pose, loop/one-shot
  (plan with the `animation` topic; key poses are the storyboard).
- **Must not** — text, background scenery, props not in the brief.

## Reference mode

1. `study_reference` the image — palette, symmetry and measurements land in
   the learned knowledge base.
2. `get_knowledge {topic:"learned", style:"…"}` — read the study back.
3. Draw to the design: silhouette → clusters → detail (see `methodology`),
   palette enforced from the study.
