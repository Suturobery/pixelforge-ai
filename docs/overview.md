# PixelForge AI — Overview

## What it is

PixelForge AI is a desktop pixel-art editor with frame-by-frame animation, layers, a
deterministic motion composer, procedural VFX and game-ready export. Alongside the canvas it
runs a local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, so an AI
assistant in your own IDE can read the project, draw, animate and export — as undoable edits on
the same document you are editing.

The original product promise, from the project plan:

> "Generate a character, animate it, correct the pixels, and export game-ready assets — inside
> one desktop workspace."

The product has since changed how the "generate" part works. See [The AI model](#the-ai-model).

## Who it is for

| User | Primary need | Example outcome |
| --- | --- | --- |
| Solo game developer | Produce playable assets quickly | A 32×32 NPC with idle and walk loops |
| Pixel artist | Keep precise control over pixels | Edit generated poses with layers and tools |
| AI-assisted developer | Automate repetitive asset work | Ask an IDE agent to build and export a sprite sheet |

## The AI model

PixelForge has **no in-app image generation and no API-key settings**. The code calls this a
"subscription-only product": reasoning happens in the artist's own IDE (for example Z.AI IDE or
ZCode) and reaches the editor through MCP. Concretely, the "AI" side is three pieces:

1. **External IDE agents over MCP.** The agent reasons; PixelForge executes. Every tool call
   runs on the editor's CommandBus, so agent edits are visible on the canvas and undoable with
   Ctrl+Z. There is no `generate_sprite` tool and none is planned.
2. **Second Brain (deterministic).** A prompt interpreter (typo correction, shorthand
   expansion, intent detection, tool recommendations), a local preference memory, an asset
   brief builder and a task board that hands work to connected agents. No model call is made.
3. **Knowledge base.** Pixel-art craft guidance shipped with the MCP server, which agents read
   with `get_knowledge` before drawing.

Images made elsewhere can still come in: the Reference panel cleans an imported PNG offline
(grid snap, background removal, palette mapping) and adds it as an editable layer.

Details: [AI and agents](ai-agents.md), [Knowledge base](knowledge-base.md).

## Features

### Canvas and drawing

- Canvas from 16×16 up to 256×256 pixels, zoom 25% to 6400%, pixel grid, checkerboard.
- Tools: pencil, eraser, fill (with ordered dither option), line, rectangle, ellipse, marquee,
  eyedropper, move.
- Brush size, square or round brush, and a custom brush saved from a selection.
- Symmetry drawing (mirror X and mirror Y), pixel-perfect strokes.
- Tile snap and tile stamp with an 8, 16 or 32 pixel tile size.
- Marquee selection with copy, cut, paste, delete, nudge, flip, rotate and scaling (free drag
  or to an exact width and height).
- Onion skinning of up to 3 previous and 3 next frames, with tint and opacity.

### Layers

- A layer stack per clip, with per-frame cels.
- Linked layers: share one cel across all frames of a clip (for backgrounds, shadows, or static props).
- Visibility, opacity, paint lock, and blend modes (normal, multiply, screen, overlay, darken,
  lighten).
- Add, duplicate, delete, merge down, reorder. Deletes go to a project trash (20 entries).

### Animation

- Named clips (idle, walk, attack…) with their own layer stack, 1–60 fps, loop on or off, and
  forward, reverse or ping-pong playback.
- Animation tags: label frame ranges (e.g. idle, walk, attack) directly on the timeline.
- Per-frame duration overrides.
- Timeline with drag-and-drop reordering, duplicate, copy, delete, tags popover and scrubber.
- Import a PNG sequence as an animated clip.
- Floating preview that mirrors the shared playback clock.
- Game-ready export: sprite sheet with JSON metadata, animated GIF, and Godot 4 `SpriteFrames` (`.tres`) resources.

### Motion Composer

Tag body parts as regions on a layer, pick a preset — idle, walk, run, attack, jump, spin,
duck, hurt, swim or death — preview the generated frames, then accept them as one undoable
step. Composition is deterministic: same sprite, parts and offsets give identical pixels.

### VFX

Procedural pixel-art effects from the `pixelfx` library (fire, explosions, ice, lightning,
arcane, nature, UI, pickups…), rendered deterministically from a seed into a new clip.

### Palettes and Style Lock

- A project palette, four built-in presets (`forge16`, `pico8`, `sweetie16`, `gray8`), palette
  harvesting from any image, and clipboard share codes (`PF1-…`).
- A library of 2006 named palettes that agents can search and apply.
- **Style Lock**: a per-project style contract (art direction, camera angle, lighting, outline,
  palette policy, transparent background, notes, up to 6 reference frames, prefer/avoid cues)
  shared with connected agents and used by technical validation.

### Reference

- A floating reference image you can draw under, with opacity, mirror and resize.
- Offline PNG cleaning for 16×16 and 32×32 targets: grid snap, background removal, palette
  mapping, with an original-versus-cleaned review and technical checks.
- A sketch pack export (`sketch.png`, `study.png`, `prompt.txt`, optional
  `style-reference.png`) for finishing a rough sketch with an external model.

### Export

- PNG frames, sprite sheet (strip or grid layout) and animated GIF.
- Nearest-neighbour scale 1×, 2×, 4× or 8×; the source is never rescaled.
- A JSON metadata sidecar per sheet (version 2) with frame rectangles, playback order and a
  Godot-friendly block. See [Export metadata schema](export-metadata.md).
- Deterministic: the same document and options produce byte-identical output.

### Files

- Native `.pixelforgeproj` files on desktop: atomic saves, embedded history journal,
  autosave, rolling backups and crash recovery prompts.
- In a plain browser the studio saves to a local SQLite database instead.
- Recent files, backup snapshots, last-session restore.

### Agents

- A loopback-only MCP server with pairing codes, four permission tiers, rate limits and an
  audit log.
- 90 tools: reading, painting, animation, motion, VFX, palettes, imports, export, macros and
  batch transactions.
- An Agent Console to run the same tools by hand in the app.
- A task board for handing work to IDE agents, gated to the project it was queued for.
- Human artwork review in the Brain panel: native-size and animated proof, craft checks,
  approval, and project-bound revision requests.
- Asset set consistency checks before batch export and via `validate_asset_set` for IDE agents.

### Desktop shell

- Electron app with a sandboxed renderer, a bundled renderer server and a supervised MCP
  sidecar — no terminal needed.
- Versioned settings file, native file dialogs, optional in-app updates.

## What is not included

These are absent from the code today, not merely turned off:

- Image generation from a prompt, paid tools, API-key settings, spend limits.
- Accounts, cloud sync, marketplace or collaboration (the rail has an "Accounts — coming soon"
  placeholder).
- Skeleton rigging, interpolation or 3D-to-pixel workflows.
- Code signing and a configured update feed for the installer.

## Components and versions

| Component | Path | Stack | Version |
| --- | --- | --- | --- |
| Desktop shell | `apps/desktop` | Electron 45, electron-builder 25.1.8, electron-updater 6.8.11 | `0.4.1` |
| Editor UI (renderer) | `src/` | Next.js 16.4.6, React 19, Tailwind CSS 4, Zustand 5, Radix UI | `0.4.1` (root `package.json`) |
| Editor core | `packages/core` | Pure TypeScript, zero dependencies | `@pixelforge/core` `0.4.1` |
| MCP server | `mini-services/mcp-server` | Bun, `@modelcontextprotocol/server` 2.4.0, zod 4 | `@pixelforge/mcp-server` `1.0.0` |
| Database | `prisma/schema.prisma` | SQLite through Prisma 6.11 | — |

The desktop, renderer, and core package manifests currently say `0.4.1`. The core's
`CORE_VERSION` constant still says `0.3.0`; the MCP server has its own `1.0.0` package version.

## Quick start

### Use the web studio in a browser

```bash
bun install
bun run dev          # studio on http://localhost:3000
bun run mcp:dev      # MCP server on http://127.0.0.1:3030
```

On Windows, `start-pixelforge.cmd` starts both in minimized windows. In a browser the studio
saves to SQLite and has no native file dialogs.

### Use the desktop app in development

```bash
bun install
cd mini-services/mcp-server && bun install --frozen-lockfile && cd ../..
cd apps/desktop && npm ci && cd ../..
bun run dev          # terminal 1: renderer on :3000
bun run desktop:dev  # terminal 2: compiles main and preload, launches Electron
```

In development the shell loads the dev server and adopts an MCP server already running on
port 3030, or starts one itself.

### Build an installer

```bash
cd apps/desktop
npm run dist
```

This compiles the shell, builds and stages the renderer, compiles the MCP sidecar from current
source and runs electron-builder. The NSIS installer lands in `apps/desktop/release/` as
`PixelForge AI-Setup-<version>.exe`. See [Desktop app](desktop-app.md#packaging-and-release).

## Repository map

| Path | Contents |
| --- | --- |
| `apps/desktop` | Electron main, preload, shared bridge types, settings store, MCP supervisor, embedded renderer server, packaging config |
| `src` | The Next.js editor: `app` (page and API routes), `components/pixelforge`, `lib/pixelforge` |
| `packages/core` | `@pixelforge/core`: document model, CommandBus, pixel ops, history, persistence, export, motion, AI helpers, tests |
| `mini-services/mcp-server` | MCP server source, its tests, the knowledge base, live client test scripts |
| `prisma`, `src/lib/db.ts` | SQLite schema and Prisma client |
| `scripts` | Seed, audit and benchmark scripts, CI and smoke orchestrators, packaging helpers |
| `tests` | Root-level tests (web persistence, hardening, Brain, IDE guide, MCP review) and deploy-script tests |
| `.github/workflows` | CI (`ci.yml`) and multi-OS release automation (`release.yml`) |
| `db` | Local runtime data in development: SQLite database, MCP data, task board |
| `sprite-review` | Sample projects and review images (straw hat, watering farmer) |
| `artifacts` | Test and verification output; most files are deleted in the working tree |

Three dependency trees are installed separately: root (bun), `mini-services/mcp-server` (bun)
and `apps/desktop` (npm). They are not a workspace.

## History

| Version | What landed |
| --- | --- |
| `0.1.10` | Embedded knowledge skill system (`get_knowledge`, `study_reference`), palette library UI, packaged build |
| `0.1.11` | `save_project` (L2), contract tests, renderer bundle |
| `0.2.1` | Web and desktop version unified, MCP TypeScript SDK v1 to v2 migration, Brain tools docs |
| `0.2.3` | Character kit, Create from Reference, removal of the legacy AI panel |
| `0.2.4` | Installer rebuilds `mcp-server.exe` from current source; tier-accurate IDE guide |
| `0.2.5` | Task-board project gating, ZCode pairing verification, Brain/Agent workflow routing, live Review Result capture |

## Status and known gaps

- The working tree has uncommitted changes, including new core modules (`grid-detect`,
  `reference-candidate`, `reference-mock`) and the `sketch-pack` module.
- Installers are unsigned, so Windows SmartScreen will warn. `publish` is `null` in
  `electron-builder.yml`, so in-app updates report "no feed" until one is configured.
- Only a Windows target is configured.
- Several helper scripts still name removed tools. `benchmark/run-benchmark.mjs` describes a
  paid `generate_sprite` mode, and the `brain_get_status` result carries a note about
  `brain_ask` / `brain_plan_goal`, none of which exist in the tool catalog.
- Some scripts under `mini-services/mcp-server/` hard-code a machine-specific token path
  (`C:/Users/Client/AppData/Local/Temp/pf-mcp-token.txt`).
- `apps/desktop/resources/renderer/.env` is untracked and holds a local `DATABASE_URL`. It is
  not filtered out by `electron-builder.yml`, so it is likely copied into the installer. The
  renderer server sets `DATABASE_URL` explicitly at launch, so the file is inert at runtime.
- Layer paint lock and blend mode are not written to `.pixelforgeproj` files, so they reset when
  a desktop project file is reopened. See
  [Project and file formats](project-format.md#known-gaps).
- [Development and testing](development.md) still describes removed AI-generation test suites.
