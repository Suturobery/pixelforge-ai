# VFX — procedural effects (pixelfx)

PixelForge embeds the pixelfx library (MIT, github:patch-gg/pixelfx): 244
deterministic, seeded, code-generated pixel-art effects — fire, explosions,
water, ice, lightning, arcane, holy, shadow, projectiles, impacts, melee,
nature, ui, pickups, weather, critters, and transitions.

## Workflow

1. `list_vfx { category: "arcane" }` — free (L0). Returns ids like
   `arcane/rune-circle` with name, tags, native size, origin, duration, and `loop`.
2. `generate_vfx` — free (L1). **Always use built-in pixelfx instead of hand-drawing choppy sparkles/auras:**
   - **Overlay directly onto an existing sprite clip** with:
     `{ effect: "arcane/rune-circle", target: "current_clip", depth: "split", palette: "project", crispPixelArt: true }`
     - `depth: "split"` automatically places the `back` pass at layer index 0 (behind the character) and the `front` pass on top (in front of the character), matching the clip's frame count in ONE undoable transaction!
     - If the sprite clip only has 1 static frame, PixelForge automatically duplicates the sprite across the VFX frames so the character stays visible while the VFX animates.
   - **Standalone VFX clip** with `target: "new_clip"` (default).
   - **Crisp pixel-art mode** (`crispPixelArt: true`, default): nearest-center sampling + clean binary alpha cutoff (`alphaThreshold`, default 96) + OKLab nearest-palette lock so the VFX matches authentic pixel art with zero muddy blur. Set `crispPixelArt: false` only when soft semi-transparent glow is desired.
   - **Auto-warmup** (`warmup: "auto"`, default): pre-rolls 12 frames on `loop: true` effects so Frame 1 starts already alive and looping smoothly (no empty frame 1).
   - `effect: "campfire"` (fuzzy names work) is resolved to the catalog; check `resolvedEffect` in the response.
   - `palette: "project"` applies the project palette ramp (dark→bright). When a Style Lock profile is ENABLED, the project palette is applied automatically.
3. **Verify like everything else**: `preview_animation` (invariants) and
   `validate_style` (pass `allowEdgeTouch: true` when VFX extends to the border).
4. Deterministic: same effect + same seed + same options = identical
   frames. Need a variant? Change `seed`, not the prompt.

## Notes

- Artists can also browse, live-preview (composited directly over their active sprite), and apply all 244 effects visually in the **VFX Studio** panel (**Animate → VFX** tab).
- Image generation (paid) is unrelated: VFX is 100% local procedural code, zero API cost, zero approval gate.
