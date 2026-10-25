# PixelForge AI — Export Metadata Schema (Task 7)

Stable contract for the JSON sidecar emitted with every sprite-sheet export
(`{base}_{clip}.json`). Implemented by `@pixelforge/core`
(`src/export/export.ts`, `EXPORT_METADATA_VERSION = 2`); verified byte-for-byte
by `packages/core/tests/export-golden.test.ts`.

Determinism guarantee: two exports of the same document with the same options
produce **byte-identical** images and metadata (no timestamps, no ambient
state). Exported pixels are composed by one DOM-free straight-alpha
source-over compositor — the same bytes land in browser downloads, Electron
native saves, and the golden tests.

---

## File set

| Artifact | Name | Contents |
|---|---|---|
| Sprite sheet | `{base}_{clip}_sheet.png` | All frames of one clip in a grid or single strip; RGBA8, filter-0 PNG, transparent background |
| Frame PNGs | `{base}_{clip}_frame{NN}.png` | One composite frame per file; native project size (optionally zero-padded index) |
| Metadata | `{base}_{clip}.json` | The schema below — describes exactly one image (`image` field) |

- `{base}` = slugified project name or a custom base; `{clip}` = slugified
  clip name; `{NN}` = zero-padded frame index (default 2 digits).
- One JSON per exported **image** — a multi-clip export emits N sheets + N
  JSONs, each self-describing. There is no manifest file to drift out of sync.
- PNG encoding: 8-bit RGBA (color type 6), filter 0, non-interlaced.
- **No scaling is ever applied** — exported pixels are the project's native
  pixel grid. (Nearest-neighbor scaling is explicitly out of scope.)

---

## Schema

```jsonc
{
  "app": "PixelForge AI",
  "version": 2,                    // metadata contract version
  "project": {
    "name": "Golden Forge",
    "width": 32, "height": 32,     // native frame size in px
    "palette": ["#1428dc", "..."]
  },
  "clip": {
    "id": "clip_idle",
    "name": "idle",
    "fps": 8,                      // clip default (frames without an override)
    "loop": true,                  // false = play once
    "loopMode": "forward",         // "forward" | "reverse" | "pingpong"
    "frameCount": 4,
    "tags": [{ "name": "breathe", "from": 1, "to": 2 }]   // may be []
  },
  "layout": "grid",                // "grid" | "horizontal"
  "frameWidth": 32, "frameHeight": 32,
  "columns": 4,                    // frames per row (horizontal = frameCount)
  "rows": 1,
  "padding": 2,                    // outer margin, px, all four sides
  "spacing": 2,                    // gap between neighbouring frames, px
  "image": "golden-forge_idle_sheet.png",   // the image THIS file describes
  "frames": [
    {
      "index": 0,                  // frame position within the clip (display order)
      "x": 2, "y": 2,              // top-left of this frame INSIDE `image`
      "w": 32, "h": 32,            // frame rect size (= project width/height)
      "durationMs": 125            // EFFECTIVE display duration (see timing)
    }
  ],
  "playback": {
    "mode": "forward",
    "loop": true,
    "fps": 8,
    "sequence": [0, 1, 2, 3],      // ONE full playback cycle, engine-visible order
    "frameDurationsMs": [125, 125, 500, 250],  // parallel to `sequence` (ms per step)
    "cycleMs": 1000,               // sum of frameDurationsMs
    "interpretation": "…human-readable rules (see below)…"
  },
  "godot": {                       // Godot-friendly convenience block
    "animation": "idle",
    "fps": 8,
    "loop": true,
    "frames": [0, 1, 2, 3],
    "sheet": "golden-forge_idle_sheet.png"
  }
}
```

## Geometry rules

```
sheetWidth  = 2·padding + columns·frameWidth  + (columns−1)·spacing
sheetHeight = 2·padding + rows·frameHeight    + (rows−1)·spacing
frame[i].x  = padding + (i % columns) · (frameWidth  + spacing)
frame[i].y  = padding + ⌊i / columns⌋ · (frameHeight + spacing)
```

`layout: "horizontal"` is the degenerate grid (`columns === frameCount`,
`rows === 1`). Sprite-sheet size is guarded (≤ 16384 px per side, ≤ 2²⁴ px
total) — the export fails with a clear error instead of exhausting memory.

## How external engines should interpret playback

The `playback.interpretation` field carries the same rules verbatim:

1. **Frame order**: play `sequence` verbatim — it is ONE full cycle already
   baked for the clip's direction:
   - `forward`: `0,1,…,n-1`
   - `reverse`: `n-1,…,1,0`
   - `pingpong` (looping): `0,1,…,n-1,n-2,…,1` (turn points never duplicated)
   - `pingpong` (play-once): `0,1,…,n-1,…,0` (returns to frame 0)
2. **Timing**: hold step *k* for `playback.frameDurationsMs[k]` milliseconds.
   These are the EFFECTIVE durations: per-frame overrides when set
   (`frames[i].durationMs`), otherwise `1000 / clip.fps`, floored at 1 ms.
   `cycleMs` is their sum — useful for progress bars or scheduling.
3. **Looping**: if `loop` is `true`, restart `sequence` from its beginning
   after the last step; if `false`, play once and **stop on the final entry**
   (which for reverse/ping-pong once is *not* necessarily frame 0/n-1 of the
   sheet).
4. **Engines with forward-only animation** (e.g. Godot's AnimatedSprite2D
   before 4.x ping-pong support, many sprite libraries): play `sequence`
   verbatim as a forward frame list — direction is already encoded in the
   order. For such engines the `frames[]` array order in `godot.frames` is
   the DISPLAY order; use `playback.sequence` when the engine supports
   arbitrary frame sequences.
5. **Per-frame display durations** (`frames[i].durationMs`) are provided for
   engines that step frames rather than steps — index into it with
   `sequence[k]`.

## Compositing rules (what the pixels contain)

- Visible layers of the clip's stack, bottom → top, straight-alpha
  source-over with layer opacity; result is the same math in web and desktop.
- Absent cels are fully transparent (C2). Linked (shared) cels contribute
  their single buffer to every frame that references them.
- Hidden layers and zero-opacity layers contribute nothing.
- Onion skins, selection marching ants, grid lines and every other editor
  overlay are renderer-only concepts and are structurally absent from the
  export path.

## Reliability contract

- The source document is never mutated during export (tested).
- Filenames are deterministic; duplicate clip names are rejected with an
  actionable error instead of silently overwriting.
- Desktop writes go through native dialogs to user-approved locations into
  the session allowlist, path-traversal-proof; each file is written
  atomically (`<name>.tmp` → rename) — a failed write never corrupts an
  existing export; nothing is written when a conflict is detected and
  overwrite is off; partial failures are reported per file.
- Canceled dialogs write nothing.

## Out of scope (later tasks)

GIF export + Godot `.tres` SpriteFrames resources are P1 (plan Task 12).
The MCP server's sheet tool currently operates on the legacy v1 serialized
contract and will be unified onto this service in Task 8.
