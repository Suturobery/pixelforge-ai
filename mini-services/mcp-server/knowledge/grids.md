# Grid drawing — text-grid pixel method for agents

The single most reliable way for a text model to draw pixel art: write the
frame as a TEXT GRID — one character per pixel — then edit characters to
fix it. No shapes, no guessed coordinates.

## The loop

1. **Plan the palette map first.** Assign ONE character per color role and
   write it down, e.g. `# outline · a mid tone · b highlight · c shadow ·
   . transparent`. Keep the set small (6–10 roles).
2. **Write the full frame as a grid** with exactly canvas-width characters
   per row, one row per canvas row. Count characters — a ragged row means a
   wrong pixel somewhere.
3. **Read it back and critique** before painting: silhouette first, then
   paired features (both eyes/arms), then value contrast.
4. **Edit characters, not coordinates.** Fix problems by rewriting the
   grid rows (or substrings) — smaller diffs, fewer mistakes.
5. **Paint in one call.** Convert the final grid to a pixel list and send
   ONE `set_pixels` (up to 2000 px per call). Never paint stroke-by-stroke.
6. **Validate.** `validate_style` on the frame, fix warnings, re-check.

## Fixed letter → palette mapping

Bind each letter to a FIXED palette entry for the whole project session —
never remap letters between frames of one animation, or frames will
flicker. Example for a 6-ramp sprite:

```
. = transparent
# = ramp[0] darkest outline
c = ramp[1] shadow
a = ramp[2] mid
b = ramp[3] highlight
o = ramp[4] accent (eyes, glow)
```

When the project Style Lock enforces a palette, derive the letters from the
project palette (ordered dark→light) and reuse the same mapping for every
frame and every clip you draw in the session.

## Animation

Draw the KEY pose grids first (contact/anticipation), verify each with
validate_style, then write in-between grids by editing the key grids —
never from scratch. Run preview_animation and check invariants before
presenting.

## Why this beats coordinate painting

Text grids make the WHOLE image visible in context, so a model can judge
silhouette and symmetry the way it judges text. Coordinate lists hide the
picture; grids show it.
