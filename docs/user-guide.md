# PixelForge AI — User Guide

This guide covers the editor as you use it. It applies to the desktop app and to the web
studio in a browser; differences are called out.

## Layout

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Header — logo · project name · New · Open · Save · Resize · Undo/Redo · Settings · Export │
├───┬──────────────────────────────────────────────────┬───────────────┤
│ T │                                                  │ PANELS        │
│ o │              Canvas stage                        │ [Layers|Agent] │
│ o │   tool options · floating palette · view bar     │  [Brain|Motion]│
│ l │   floating preview                               │  [Reference]   │
│ s │                                                  │               │
├───┼──────────────────────────────────────────────────┤               │
│   │ Timeline — clips · transport · scrubber · frames │               │
├───┴──────────────────────────────────────────────────┴───────────────┤
│ Footer — size · zoom · hover · tool · clip/frame · save state        │
└──────────────────────────────────────────────────────────────────────┘
```

| Area | What it holds |
| --- | --- |
| Header | Project name (click to rename), New, Open, Save, Resize canvas, Undo, Redo, Settings, Export |
| Tool rail (left) | The nine tools, brush size and shape, symmetry, dither, tile options, Help and feedback |
| Canvas stage | The drawing surface with the checkerboard, grid, onion skins and selection |
| Timeline (bottom) | Clips, playback controls, the frame strip |
| Panels dock (right) | Layers, Agent, Brain, Motion and Reference. Drag the left edge to resize; the dock expands to a wider layout and hides to a "Panels" tab |
| Floating panels | Palette, animation preview and view toolbar — each draggable, hideable to a labelled pill, with positions remembered |
| Footer | Canvas size, zoom, hovered pixel, active tool, clip and frame, save state |

On a phone the panels dock becomes a slide-over drawer that starts closed.

The first run shows a three-step tour: draw, animate, ship. It does not return unless browser
storage is cleared.

## Projects

**New project** asks for a name, a canvas size preset and a palette. A new project starts with
one clip and one frame at the default frame rate from Settings.

**Open project** lists projects saved by the app. On desktop it also lists recent
`.pixelforgeproj` files and backup snapshots. In a browser it lists the SQLite-stored projects.

**Save** with Ctrl+S.

- Desktop: the first save opens a native Save As dialog. Later saves write to the same file
  atomically — a temporary file is written, then renamed.
- Browser: the project is stored in the local database.

**Autosave** runs in the background after each change once the delay in Settings has passed.
On desktop it waits until the project has a file, so it never opens a dialog.

**Recovery.** If PixelForge finds an autosave newer than your file, or unflushed journal
records, it offers to recover when you open the project.

**Backups.** Each manual save keeps a rolling backup; the Open dialog can restore a snapshot.
Restoring clears the undo history.

**Resize canvas** (header) changes the canvas between 16 and 256 pixels per side. Content is
shifted, not rescaled: choose the top-left or the centre as the anchor. Pixels that fall
outside the new bounds are cropped.

**Recent files** (desktop) remember `.pixelforgeproj` files you opened or saved. You can remove
an entry without touching the file, or move the file to the Recycle Bin after a confirmation.

## Tools

| Key | Tool | Notes |
| --- | --- | --- |
| B | Pencil | Paints the primary colour |
| E | Eraser | Erases |
| F | Fill | Flood fill. With dither on, it fills with a dither of the two colours |
| L | Line | — |
| R | Rectangle | — |
| C | Ellipse | Outline with the primary colour, fill with the secondary when "filled" is on |
| S | Marquee | Selects a rectangle |
| I | Eyedropper | Picks the colour under the cursor |
| M | Move | Moves the selection or the cel |

**Mouse.** Left button paints with the primary colour. Right button paints with the secondary
colour. Middle button pans. The mouse wheel zooms, anchored at the cursor. With tile stamp on,
a click fills the whole tile under the cursor, and the eraser clears that tile.

**Brush.** Size 1–8 with the number keys, or `[` and `]`. Shape is square or circle. A marquee
selection can be saved as a custom brush; the rail then offers a reset to the standard brush.

**Symmetry.** Vertical mirror (Y) and horizontal mirror (Shift+Y) draw the mirrored stroke at
the same time.

**Tilemap options.** Tile snap (K) snaps strokes to the tile grid; tile stamp (Shift+K) stamps
a whole tile; tile size is 8, 16 or 32.

### Selection

With a marquee selection active, the options bar above the canvas offers copy, cut, paste,
delete, deselect, flip and rotate. Drag the eight handles to scale freely, or type an exact
width and height. The same bar has whole-cel transforms.

Arrow keys nudge the selection by 1 pixel, or 4 with Shift.

## Layers

Each clip has its own layer stack, bottom to top. A layer holds a cel on each frame where it
has pixels; a missing cel is fully transparent.

The Layers panel shows the stack of the active clip. Per layer: name, visibility, opacity
slider, blend mode, and paint lock. Actions: add, duplicate, delete, move up, move down, merge
down.

- **Blend modes:** normal, multiply, screen, overlay, darken, lighten.
- **Linked layers** — one cel shared by every frame of the clip — exist in the document model
  and the engine, but no editor control or agent tool creates them yet.
- **Deleting** a layer, frame or clip moves it to the project trash, which holds 20 entries.
  Undo also restores it.

## Animation

### Clips

A project holds any number of named clips. The timeline's clip row lets you add a clip, switch
between clips, and delete one. Double-click a clip tab to rename it. Per clip you can set the
frame rate (1–60 fps), loop on or off, and the playback mode: forward, reverse or ping-pong.

### Frames

The frame strip shows thumbnails in order. Each frame has:

- a duration badge. Zero means "inherit the clip's frame rate". Drag it sideways or click to
  set an exact duration;
- drag-and-drop reordering;
- add empty, copy current, duplicate, delete, and move left or right.

**Import PNG sequence** turns one PNG per file, sorted by filename, into a new animated clip in
a single undo step. Every frame must match the canvas size exactly.

### Playback

| Key | Action |
| --- | --- |
| Space | Play or pause |
| , | Previous frame |
| . | Next frame |
| Alt+N | New empty frame after the current one |

The timeline and the floating preview share one playback clock, so they always agree. While the
editor is paused the floating preview runs its own loop of the active clip. It is resizable and
collapsible.

### Onion skin

Show ghosts of up to three frames before and after the current one. Previous frames are tinted
red and next frames green by default; tint and opacity are in the onion skin popover on the
timeline.

## Palettes

The floating palette shows the document palette. Click a swatch to set the primary colour;
right-click sets the secondary.

| Action | How |
| --- | --- |
| Add a colour | The add button, or add-to-palette from the colour editor |
| Remove the primary colour | The remove button |
| Swap primary and secondary | X |
| Apply a preset | The preset menu: `forge16`, `pico8`, `sweetie16`, `gray8` |
| Browse the library | The library browser (2006 palettes) |
| Build a ramp | Add a four-step light and shade ramp around a colour |
| Take colours from an image | Extract the 16 best colours with median cut |
| Share a palette | Copy or paste a `PF1-…` code |

Palette changes are undoable.

## Style Lock

Style Lock is the project's style contract. It is shared with connected agents and drives the
technical checks. Edit it in the **Reference** panel under **Project style**.

| Field | Values |
| --- | --- |
| Enabled | On or off |
| Name | Up to 48 characters |
| Art direction | Free text, up to 180 characters |
| Camera angle | Side view, front, 3/4 view, top-down, isometric |
| Lighting | Top-left, top, front, flat |
| Outline | Dark 1 px, light 1 px, none |
| Palette policy | Enforce, prefer, none. "Enforce" makes palette membership a validation failure |
| Transparent background | On or off |
| Notes | Up to 480 characters |
| References | Up to 6 frames of this project, each with a label |
| Feedback | Up to 4 "prefer" and 4 "avoid" cues, 72 characters each |

**Approved reference** picks a frame as the reference other assets should match.

## Motion panel

The Motion Composer generates animation from a still sprite by moving tagged body parts.

1. **Source.** Pick the clip and the anchor frame. The canvas shows anchor guides: a ground
  line, the centre axis and the part rectangles.
2. **Body parts.** Tag regions: name, layer, and a rectangle — or the whole layer. Parts are
  regions, never cuts. One button slices the silhouette into head, body, arms and legs
   automatically.
3. **Preset.** Idle, walk, run, attack, jump, spin, duck, hurt, swim or death.
4. **Parameters.** Frame count, amplitude, gap fill (`edge-extend` refills seams, `none`
   leaves honest transparent gaps), and the smear frame for attack.
5. **Preview.** Play it at a chosen speed and read the quality checks: foot lift, foot slide,
   detached parts, loop jump, flicker and others. The preview is never written to the document.
6. **Accept.** Choose a new clip name and whether it loops, then accept. The result is one
   undoable step and is byte-identical to the preview.

You can download the preview frames as a spritesheet strip.

Amplitude is scaled by canvas height, so a 64-pixel sprite moves twice as far as a 32-pixel one.

## VFX

Procedural effects are rendered from the `pixelfx` library into a new clip, deterministically
from a seed. They are also available to agents as `list_vfx` and `generate_vfx`. The same
effect, seed and options always give identical frames; change the seed for a variant.

## Reference panel

### Floating reference image

Open any local image as an overlay beside or over the canvas. Adjust opacity, mirror it, resize
it by the corner handle and drag it by its header. Strokes pass under it. It is session-only:
nothing is saved or uploaded.

### Create from Reference

Clean an image made elsewhere so that it belongs with your approved reference.

1. Set **Project style** and an **Approved reference** (a project frame or an imported PNG).
2. **Import PNG to clean** — fully offline.
3. The candidate pipeline decodes the PNG, trims it, removes the background, detects the real
   pixel grid, snaps to it, scales by whole numbers only, maps colours to the palette and
   cleans the alpha. Targets are 16×16 and 32×32.
4. **Cleaned imports** lists the results. Review the original beside the cleaned image and the
   reference, and read the technical checks.
5. **Add candidate to canvas** puts the cleaned image on a new layer in one undoable step.

### Sketch pack

Draw a rough sketch on a visible layer, then export a sketch pack for an external image model.
The pack is a zip with `sketch.png`, `study.png` (a silhouette view and a three-value view side
by side), `prompt.txt` and, when a reference is set, `style-reference.png`.

## Agent, Brain and Reference panels

The Agent and Brain panels work with AI assistants. See [AI and agents](ai-agents.md).

- **Agent** runs tools inside the app and shows what connected agents did.
- **Brain** interprets prompts, builds asset briefs and manages the task board. Ctrl+Shift+B.
- **Reference** also links to the reference clips used by Style Lock.

## Export

Open with **Export** in the header. The preview is composed by the same code that writes the
files, so what you see is what you get.

| Option | Values |
| --- | --- |
| Scope | Current frame, current clip, or all clips |
| Format | PNG frames · Sprite sheet · GIF (clip) |
| Layout | Grid or horizontal strip (sprite sheet) |
| Columns | Frames per row in grid layout |
| Padding, spacing | Outer margin and gap between frames, in pixels |
| Scale | 1× (native), 2×, 4×, 8×, nearest-neighbour |
| GIF background | Transparent (dithered), dark, black, white |
| File name base | Defaults to a slug of the project name |
| Frame number digits | Zero-padding of frame indices |

**Outputs.** A sprite sheet `{base}_{clip}_sheet.png`, one PNG per frame
`{base}_{clip}_frame{NN}.png`, and one JSON file `{base}_{clip}.json` describing each sheet's
layout and playback. The JSON schema is documented in [Export metadata schema](export-metadata.md).

**Destinations.** In a browser, files download. On desktop, a single file uses a Save dialog
and several files use a folder picker; the dialog warns before overwriting.

GIF has one-bit transparency. Semi-transparent pixels are flattened onto the chosen background,
or dithered when you pick "Trans".

The source project is never modified by an export.

## Settings

| Tab | Contents |
| --- | --- |
| General | Autosave delay, undo history limit, floating button size, UI text scale, software updates (desktop) |
| Canvas | Defaults for new projects: canvas size, frame rate, palette; grid, onion skin, its opacity and tints |
| Agents | Explains that agents use your IDE subscription and that deterministic Brain features stay in-app |
| MCP | Server status and switch, pairing, connected clients, recent operations, troubleshooting |
| Keys | The shortcut reference |

Settings are remembered per browser. On desktop the settings file is the source of truth and
follows your Windows account.

### Settings → MCP

- **Enable MCP server** is the master switch. When off, every tool except pairing returns
  `mcp_disabled`.
- The status line shows the endpoint, whether the editor is attached, and how many clients are
  paired.
- **Connect AI Assistant** generates a pairing code for a tier you choose.
- **Connected clients** lists paired assistants. Revoke one to cut its access immediately.
- **Recent MCP operations** shows the audit trail.
- **Take over the bridge** claims the editor slot from another PixelForge window that holds it.

## Help, feedback and updates

- **Help and feedback** (tool rail) builds a bug report, idea or question, optionally with
  diagnostics and the tail of the app log, then opens your mail client or copies it.
- **Software updates** (Settings → General, desktop) checks for updates. It reports "no feed"
  until an update feed is configured for the build.

## Shortcuts

Canvas shortcuts do not fire while you are typing in a field.

| Keys | Action |
| --- | --- |
| B, E, F, L, R, C, S, I, M | Pencil, eraser, fill, line, rectangle, ellipse, marquee, eyedropper, move |
| 1–8, `[` `]` | Brush size |
| X | Swap primary and secondary colours |
| Y / Shift+Y | Mirror X / mirror Y |
| D | Dither fill |
| K / Shift+K | Tile snap / tile stamp |
| P | Toggle the palette panel |
| G | Toggle the pixel grid |
| O | Toggle onion skin |
| T | Toggle the timeline |
| `+` / `-` | Zoom in / zoom out |
| Ctrl+S | Save |
| Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | Undo / redo |
| Ctrl+C, Ctrl+X, Ctrl+V | Copy, cut, paste the selection |
| Delete, Backspace | Delete the selection contents |
| Arrow keys | Nudge the selection (Shift for 4 px) |
| Esc | Cancel the stroke; deselect |
| Space | Play / pause |
| `,` / `.` | Previous / next frame |
| Alt+N | New empty frame |
| Ctrl+Shift+B | Open the Brain panel |
