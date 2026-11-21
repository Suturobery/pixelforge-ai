# VFX — procedural effects (pixelfx)

PixelForge embeds the pixelfx library (MIT, github:patch-gg/pixelfx): 244
deterministic, seeded, code-generated pixel-art effects — fire, explosions,
water, ice, lightning, arcane, projectiles, impacts, status, nature, ui,
pickups, transitions and more.

## Workflow

1. `list_vfx { category: "fire" }` — free (L0). Returns ids like
   `fire/campfire` with name, tags, native size, duration.
2. `generate_vfx` — free (L1). **The app owns accuracy — you may be vague:**
   - `effect: "campfire"` (no path needed) is fuzzy-matched to the catalog;
     the response's `resolvedEffect` tells you what was chosen.
   - `palette: "project"` applies the project palette ramp (dark→bright).
     When a Style Lock profile is ENABLED, the project palette is applied
     AUTOMATICALLY even if you pass nothing — on-style by default. Pass an
     explicit hex ramp to override; check `paletteApplied` in the response.
   - `light` 0..1 (default 1): lower = subtler additive glow. For small
     canvases or subtle assets use 0.4–0.7.
   - `frames` default covers the effect duration at the chosen fps.
3. **Verify like everything else**: `preview_animation` (invariants) and
   `validate_style`. VFX routinely touches canvas edges and carries
   semi-transparent pixels by design — pass `allowEdgeTouch: true` and
   treat the alpha warning as an artist decision, not a bug.
4. Deterministic: same effect + same seed + same options = identical
   frames. Need a variant? Change the seed, not the prompt.

## Notes

- Effects render at the PROJECT canvas size; an effect whose native size
  exceeds the canvas is cropped (place with x/y).
- The generated clip lands with the `vfx` layer — inspect with get_clip,
  paint over it, or delete frames like any clip (trash-backed).
- Image generation (paid) is unrelated: VFX is pure code, no provider, no
  approval gate.
