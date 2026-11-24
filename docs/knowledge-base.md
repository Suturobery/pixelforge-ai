# PixelForge AI — Knowledge Base

The MCP server ships a set of pixel-art craft guides. An agent reads them with `get_knowledge`
before drawing. The guides are plain Markdown files, need no editor connection, and are free.

## How it is served

| Fact | Detail |
| --- | --- |
| Tool | `get_knowledge { topic, style? }` — tier L0, answered by the server |
| Source folder | `mini-services/mcp-server/knowledge/` |
| Packaged location | `resources/mcp/knowledge/` next to `mcp-server.exe`; override with `PF_KNOWLEDGE_DIR` |
| Topics | 19 Markdown guides, plus `palette_library` (JSON) and `learned` (an index) |
| Result | `{ topic, markdown }` as a tool envelope; `summary` is `knowledge: <topic>` |
| Unknown topic | `bad_request` with the list of valid topics |

The server's `instructions` tell agents to read `methodology` and `grids` before drawing and
`characters` for character sprites.

## Topics

| Topic | Title in the guide | Sections |
| --- | --- | --- |
| `agent` | Driving PixelForge as an agent | Session flow · Speed rules · Safety rules · Naming conventions · Animation workflow · Style contract · No paid tools, no image generation · Task board |
| `methodology` | The brief → draw → critique → fix loop | Brief · Draw · Critique — look at your own work · Fix · Animation · Studying new styles · Fixing existing art |
| `grids` | Grid drawing — text-grid pixel method for agents | The loop · Fixed letter → palette mapping · Animation · Why this beats coordinate painting |
| `characters` | Craft recipes for agent-drawn sprites | Proportion recipes · The 7-step character loop · Quality bar · Using motion with characters |
| `patterns` | How to build things | Canvas sizes · Character proportions · Build order (silhouette-first) · Readability rules · Symmetry · Items and icons · Tiles and tilesets · Scenes |
| `techniques` | Colour, shading, dithering, anti-aliasing, outlines, texture | Colour ramps · Shading · Dithering · Anti-aliasing (manual only) · Outlines · Texture recipes · Sub-pixel detail |
| `palettes` | Choice, budgets, presets | Philosophy · Budgets · Presets · Building custom ramps · Retro conversion · Palette swaps · Palette library and learned palettes |
| `shade` | Shade a sprite | The rule · Procedure · Ramps · Dithering · Checks |
| `animation` | Frame counts, timing, cycles, puppeting | Frame counts and timing · 4-frame walk construction · Idle (breathing) · Part-per-layer puppeting · Squash and stretch · Oversized attack frames · Loop hygiene · Preview and judge · Key-pose planning |
| `rig` | Rig a character for animation | The standard rig · Building it fresh · Splitting an existing sprite |
| `lpc` | LPC universal sheet — humanoid movement contract | The grid · Humanoid proportions inside the cell · Key-pose rules per action · Weapon clipping · Workflow |
| `vfx` | Procedural effects (pixelfx) | Workflow · Notes |
| `tileset` | Build a tileset | Decide the grid first · Seamless tiles · Autotiling · From a painted mockup · Export |
| `concept` | Design it first — concept before pixels | Two modes · The art spec · Reference mode |
| `cleanup` | Hybrid pipeline — from generated art to clean, editable pixels | The pipeline · What each cleanup step does · Tuning by source type · After cleaning · Honest limits |
| `fix` | Fix existing art — without breaking what is already right | Understand · Say what you will change · Scope the edit · One undoable step · Verify · "Never" list |
| `validations` | The per-iteration critique checklist | Silhouette and readability · Light and colour · Craft · Animation · Export · Report with evidence |
| `sharp_edges` | Known failure modes (check before finalizing) | Twelve numbered failure modes · "Library-specific gotchas" |
| `export` | Formats, scaling, engines | Golden rules · What to export per use case · GIF caveats · Spritesheet + JSON · File size sanity |
| `palette_library` | — | JSON data, not a guide. See below |
| `learned` | Learned Styles — Index | An index of study cards. See below |

## What the key guides say

### `agent`

- **Session flow.** Call `get_project_state` first. Target things by `clipName`, `layerName`
  and `frameIndex`. Pass `expectedStateHash` on writes for a staleness guard.
- **Speed rules.** Batch multi-step work (`batch` or a macro) — up to 50 calls in one
  round-trip and one undo step. One `set_pixels` paints 2000 pixels. Check `get_quota` before
  long jobs. Library palettes are one `apply_library_palette` call away.
- **Safety rules.** Writes share one history with the human, who can undo them.
  `create_project` and `open_project` replace the active document and are refused while it is
  dirty. Deletes are trash-backed. A clip always keeps one frame and one layer. `undo`, `redo`
  and `batch` are rejected as steps inside a batch or macro.
- **Naming.** `duplicate_layer` names the copy "<source> copy". An unnamed `add_layer` becomes
  "layer N". Pass explicit names.
- **Style contract.** Treat `styleProfile` from `get_project_state` as binding. Do not invent
  colours outside the palette. `validate_style` checks technical constraints only — readability
  and pose clarity are the artist's judgement.
- **Task board.** Read `brain_get_tasks`, claim, work with progress updates, then complete or
  fail the task.

### `methodology`

1. **Brief.** Decide canvas size, a palette with a hard colour budget, style references, the
   outline rule and one light direction. Confirm a vague request with the user before the first
   pixel.
2. **Draw.** Small undoable steps: silhouette first, then clusters, then detail, then outline
   and anti-aliasing cleanup.
3. **Critique.** Render with `get_frame_png` and judge it against `validations`.
4. **Fix.** Fix through the bus so everything stays undoable, then loop.

### `grids`

Write the frame as a text grid — one character per pixel, exactly canvas-width characters per
row — with a fixed letter-to-colour-role mapping. Critique the grid, edit characters rather than
coordinates, then convert it to one `set_pixels` call. Keep the same letter mapping across every
frame of an animation to avoid flicker. Draw key poses first and derive in-betweens by editing
them.

### `vfx`

The guide describes the embedded `pixelfx` library as 244 seeded effects. Workflow: `list_vfx`
by category, then `generate_vfx`. A vague `effect` name is fuzzy-matched and the response reports
`resolvedEffect`. With Style Lock enabled the project palette is applied automatically. Verify
with `preview_animation` and `validate_style` using `allowEdgeTouch: true`, because effects often
touch the canvas edge and carry semi-transparent pixels by design.

## Learned styles

`study_reference` grows the knowledge base from reference sprites. It decodes a PNG up to
512×512, extracts up to 16 colours by median cut, measures size, opaque ratio and horizontal
mirror symmetry, and writes a study card.

| Location | Contents |
| --- | --- |
| `knowledge/learned/` | Five shipped cards (chibi JRPG cast, dynamic attack canvas, dramatic chibi swordsman, tactical chibi layered cloth, tall tactical job sprites) and `INDEX.md` |
| `<MCP data dir>/knowledge-learned/` | Cards you create: `u<yyyymmdd>-<xxxx>-<slug>.md` plus `INDEX.md` |

`get_knowledge { topic: "learned" }` returns both indexes. With `style` set to a card's file stem
it returns that card; user-grown cards override shipped ones with the same name. Shipped
`learned/` cards are not copied into the installer.

## Palette library

`knowledge/palette-library.json` (the same file is `src/lib/pixelforge/palette-library.json`)
holds 2006 named palettes: classic consoles and Lospec favourites. Each has a name, optional
author, a size and a colour list.

| Call | Behaviour |
| --- | --- |
| `get_knowledge { topic: "palette_library" }` | Lists the first 30 presets |
| `get_knowledge { topic: "palette_library", style: "<keyword>" }` | Searches id, name and notes; returns up to 20 matches |
| `get_knowledge { topic: "palette_library", style: "<exact id>" }` | The full preset with its colours |
| `apply_library_palette { id }` | Applies it as the project palette (tier L2, undoable) |

## Read with care: references to tools PixelForge does not have

The guides were adapted from a pixel-art skill written for a different, Python-based toolchain.
Some passages still describe that toolchain. They are guidance text, so nothing breaks, but an
agent that follows them literally will look for things that do not exist here:

Five guides contain such passages: `sharp_edges.md`, `palettes.md`, `cleanup.md`, `animation.md`
and `export.md`. What they mention:

- `sharp_edges.md` — `stats()`, `px()`, `line()`, `build.py`, `save_png`, `save_gif`,
  `save_spritesheet`, and a "Library-specific gotchas" section about `ellipse()`,
  `polygon()`, `quantize()`, `to_palette()` and `copy_cel(link=True)`.
- `palettes.md` — `PALETTES[name]` and `Sprite(palette="name")`.
- `cleanup.md` — pipeline step names and tuning parameters of its own.

What exists in PixelForge is the tool catalog in [AI and agents](ai-agents.md#tool-catalog).
Validation is `validate_style`; saving and exporting are `save_project`, `export_sheet` and
`export_gif`.
