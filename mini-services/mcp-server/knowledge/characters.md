# Characters — craft recipes for agent-drawn sprites

Characters are the hardest subject: the eye forgives a soft flame, never a
broken face. Follow these recipes with the TEXT GRID method
(`get_knowledge {topic:"grids"}`) — grids first, then paint in one call.

## Proportion recipes (read before drawing)

**Humanoid 32×32** (front view):
- head 8–10 px tall, body 10–12, legs 10–14 — head ≈ 1/3 of total height
- shoulders 10–12 px wide; arms 3–4 px thick; feet 4–5 px wide
- eyes at head-vertical center, 2 px apart minimum

**Humanoid 64×64**:
- head 14–16 px, body 20–24, legs 22–28
- eyes 3×3 px with 1 px highlight; hands 4×4

**Creature (mimic/slime)**: asymmetric beats symmetrical — one eye bigger,
one log kicked out, treasure overflowing to one side. Symmetry reads as
"generated"; controlled asymmetry reads as "authored".

## The 7-step character loop

1. **Silhouette grid first** — single character (`#`) only, NO details.
   Squint test: is the species readable from the silhouette alone?
2. **Anchor features** — eyes, mouth, hands: the 3 things the viewer finds.
   Place them on the grid before shading.
3. **Fill ramps** — one dark→mid→light ramp per material (skin, cloth,
   metal, wood). Never more than 4 ramps on a 32×32.
4. **Cluster shading** — shade in 2–3 px clusters, never 1 px noise.
   Light comes from the Style Lock direction (or top-left).
5. **Outline discipline** — 1 px dark outline (Style Lock default); inner
   outlines only where two same-value areas meet.
6. **Paired-part check** — both eyes/arms/legs drawn OR deliberately
   occluded by the pose. A missing far arm reads as a bug, not a pose.
7. **Paint ONE set_pixels, then validate_style** — fix warnings, then (for
   characters) run the parts tagging (`set_parts`) so motion presets work.

## Quality bar (what validate_style cannot see — self-check honestly)

- Does the face read at 1× zoom? (the viewer's first 3 seconds)
- Is the value contrast strong enough that the character separates from a
  dark background AND a light one?
- 3+ px clusters everywhere — single stray pixels only as intentional
  sparkle/damage
- Every color earns its slot (≤ 12 on 32×32, ≤ 20 on 64×64)

## Using motion with characters

After accept: `set_parts` (head/body/armL/armR/legL/legR) then
`apply_motion_preset` for idle/hurt/attack. Characters with parts animate
free — characters without parts are statues.
