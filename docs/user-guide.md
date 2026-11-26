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
| N | Pixel-Perfect Vector | Non-destructive editable **Curves** (3-pt Quadratic / 4-pt Cubic Bézier), **Lines**, **Rects**, **Ellipses**, and **Polygons** with live draggable handles, zero anti-aliasing, Live FX support, and 1-click **Bake** |
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
- **Linked layers:** share one cel across every frame of the clip, or unlink into independent per-frame cels.
- **Non-Destructive Live FX Modifiers:** open the wand (**Live FX**) button in the active layer bar to toggle **Live 1px Outline** (Solid or automatic hue-shifted **Sel-Out**, 4-way or 8-way), **Live Drop Shadow** (offset X/Y, color, opacity), and **Live Color / Skin Remap** (OKLab ramp or nearest preset). Modifiers render live across every frame and export cleanly without altering raw pixels; layers with active modifiers show an `FX` badge, and you can **Bake to pixels** or **Clear** anytime (fully undoable).
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
| Add a colour | The `+` button, or add-to-palette from the colour editor |
| Remove the primary colour | The `-` button |
| Sort palette (OKLab) | The sort button (by lightness or hue wheel) |
| Replace Primary → Secondary | The replace button (scope: layer, frame, or clip) |
| Copy active hex | Click the `#rrggbb` hex readout on the right of the tool row |
| Generate Sprite Skins | Click **Skins** to preview and clone the active clip into elemental/RPG palette-swapped clips |
| Share a palette | Click **Code** to copy or paste a `PF1-…` share code |
| Swap primary and secondary | X |
| Apply a preset / browse 2,000+ palettes | Click the palette selector bar at the bottom (with optional **Swap sprite skin on pick**) |
| Automatic Hue Shifter | Click `+`, pick any base colour, tune steps (3 / 5 / 7), cool-shadow / warm-highlight hue shift, and contrast, preview live swatches, and add the whole ramp in one undoable step |
| Take colours from an image | Extract the 16 best colours with median cut |

Palette changes are undoable.

**Aseprite Import:** Open or drag-and-drop `.ase` / `.aseprite` files directly into the studio to import layers, frames, frame durations, tags (as clips), and palettes.

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

## Live AI Artist Co-Pilot, Agent, Brain and Reference panels

When an IDE AI assistant (Claude Code, Codex, Cursor, Windsurf, or Antigravity) connects via MCP, a floating **Live AI Co-Pilot HUD** appears at the top-center of the canvas stage:

- **Watch edits land live:** Pixels appear progressively along the AI brush cursor with corner focus brackets and a `+N px` status pill.
- **Hold `Before` to compare:** Hold the **Before** button on the pill or feed row to peek at the pre-edit frame.
- **1-Click Undo & Activity Feed:** Undo the latest AI step directly on the pill, or expand the feed to jump to edited frames, flash regions, toggle **Follow**, or undo to an earlier step.
- **Pause AI (Artist Priority):** Pause mutating AI writes while you paint manually; read-only inspection continues until you click **Resume**.
- **Two-way selection awareness:** Draw a marquee selection before messaging your IDE AI — `get_project_state` shares your selection box, active colors, symmetry, and tile-wrap state.

The right-dock panels (grouped under **Artwork**, **Animate**, and **Assist**):

- **Agent (MCP Tools):** Runs PixelForge tools locally, shows 1×/3× Before/After style checks, and displays live relayed MCP edits.
- **Brain (Ctrl+Shift+B):** Interprets rough prompts with 1-click local actions (**Run VFX**, **Drop Starter Base**, **Open Motion**), copies ready-to-paste IDE handoff prompts (**Copy for IDE AI**), builds Pixel Art Recipes, and manages the Agent Task Board (with 1-click wake triggers since MCP cannot auto-wake an idle IDE chat).
- On a completed task, choose **Review** to inspect the live clip at true 1× size or enlarged,
  play its animation, see technical craft warnings, and approve the frame or request an IDE revision.
- **Reference** links to the reference clips used by Style Lock and offline PNG-to-pixel cleaning.

## Export

Open with **Export** in the header. The preview is composed by the same code that writes the
files, so what you see is what you get.

| Option | Values |
| --- | --- |
| Scope | Current frame, current clip, or all clips |
| Format | PNG frames · Sprite sheet · Master Atlas (all clips) · GIF (clip) |
| Layout | Grid or horizontal strip (sprite sheet) |
| Columns | Frames per row in grid layout |
| Padding, spacing | Outer margin and gap between frames, in pixels |
| Scale | 1× (native), 2×, 4×, 8×, 16×, nearest-neighbour |
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

For an all-clips sheet or Master Atlas, open **Asset set check** before export. It checks a
representative frame of each clip for project-palette colors. Mark character or enemy clips as
**Actor** to compare height, ground line and outline with your pinned Hero Style Anchor. Props,
tiles and effects are not forced to match the hero's proportions. Warnings are advisory.

## Settings

| Tab | Contents |
| --- | --- |
| General | Autosave delay, undo history limit, floating button size, UI text scale, software updates (desktop) |
| Canvas | Defaults for new projects: canvas size, frame rate, palette; grid, onion skin, its opacity and tints |
| AI connection | Explains IDE subscriptions and local Brain features; MCP server status, pairing, connection check, connected clients and troubleshooting |
| Keys | The shortcut reference |

Settings are remembered per browser. On desktop the settings file is the source of truth and
follows your Windows account.

### Settings → AI connection

- **Enable MCP server** is the master switch. When off, every tool except pairing returns
  `mcp_disabled`.
- The status line shows the endpoint, whether the editor is attached, and how many clients are
  paired.
- **Connect AI Assistant** generates a pairing code for a tier you choose.
- Choose the IDE name for the copied pairing guide. After the IDE calls `get_project_state`,
  **Check connection** reports the service, editor, pairing and recent project read separately.
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
