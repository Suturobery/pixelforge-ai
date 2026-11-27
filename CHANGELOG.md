# Changelog

All notable changes to **PixelForge AI** are documented here.

---

## [0.7.2] — 2026-11-27
- **8–64px Tile Sizes:** Full tileset support for `8`, `16`, `24`, `32`, `48`, and `64` px grids.
- **2-Layer Level Mockup Theater:** Paint on separate **Ground** and alpha-composited **Overlay/Props** layers with expandable theater view, room presets (`6×4` to `12×8`), and `Alt+click` tile eyedropper.
- **Room Undo/Redo & Hover Ghost Preview:** 40-step room undo/redo stack plus live hover ghost stamping.
- **Live Brush Sync:** Active tile brush refreshes automatically as you edit pixels in the source tileset.

## [0.7.1] — 2026-11-27
- **Spacious Clips Contact Sheet Theater:** Expanded modal layout for inspecting every clip at once.
- **Zero-Jitter Animation Playback:** Tightened frame timing and playback clock synchronization.
- **Core Typecheck Fix:** Explicit `Uint8ClampedArray` typing for TypeScript 5.9 compatibility.

## [0.7.0] — 2026-11-27
- **Tileset Stamp Picker:** Slice tiles from the canvas with Rotate (`Q`), Flip H/V, and canvas stamp painting.
- **Animated Level Mockup:** Build multi-frame animated rooms, bake to clips, or export as PNG.
- **Clips Contact Sheet:** Side-by-side clip preview modal.

## [0.6.1] — 2026-11-27
- **Integrated Dark Titlebar:** Seamless dark desktop window chrome.
- **In-Window Startup Splash:** Smooth loading screen during studio & MCP sidecar initialization.

## [0.6.0] — 2026-11-27
- **Pixel-Perfect Editable Vectors (`N` Tool):** Crisp lines, quadratic/cubic Bézier curves, rects, ellipses, and polygons with live draggable handles, MCP support (`set_vectors` / `bake_vectors`), and 1-click Bake.
- **Non-Destructive Live FX Modifiers:** Live 1px Solid / Sel-Out outlines, drop shadows, and OKLab skin/color remaps across every frame.
- **Automatic Hue Shifter:** Build cool-shadow / warm-highlight shading ramps from a single color (UI + `generate_hue_ramp`).
- **Auto-Eyes Upgrades:** Enhanced zoomed visual preview and spatial checks for paired MCP agents.

## [0.5.5] — 2026-11-26
- **Auto-Eyes Visual Preview & Spatial Self-Critique:** Pixel-writing MCP tools automatically return zoomed gridded PNGs and `visualCheck` (ASCII pixel map, bounds, floating fragments, symmetry %, warnings).

## [0.5.4] — 2026-11-26
- **Actionable Second Brain & Agent Panels:** 1-click local actions (**Drop Starter Base**, **Open Motion**, **Run VFX**, **Copy for IDE AI**) and task-board wake triggers.
- **UI Polish:** Fixed palette overflow, tightened dock tab spacing, and updated docs.

## [0.5.3] — 2026-11-26
- **Live AI Artist Co-Pilot Overlay:** 60fps moving AI brush cursor, corner focus brackets, progressive pixel reveal, `+N px` pill, **Hold `Before`** compare, 1-click Undo, and **Pause AI** lock.
- **Sprite Skins Fix:** Resolved edge cases when cloning palette-variant clips.

## [0.5.2] — 2026-11-26
- **Codex TOML Fix:** Cleanly replaces Codex TOML sub-tables during 1-Click MCP Auto-Setup to prevent duplicate key errors.

## [0.5.1] — 2026-11-26
- **16-Bit Starter Templates:** Upgraded all 8 Starter Templates to hand-crafted 16-bit pixel-art masters.
- **Live Sprite Thumbnails:** Real pixel previews in Skins & Starter Templates pickers.

## [0.5.0] — 2026-11-26
- **1-Click IDE MCP Auto-Setup:** Auto-detects and configures Cursor, Claude Code, Codex, Windsurf, and Antigravity with `.pixelforge.bak` backups.
- **Aseprite Importer:** Open or drag-and-drop `.ase` / `.aseprite` files with layers, frames, timings, tags, and palettes preserved.
- **1-Click Sprite Skins:** Clone clips into `Fire`, `Ice`, `Poison`, `Shadow`, `Royal Gold`, `Cyber`, `Retro GB`, and `Stone` variants.
- **Artwork Review, Asset Set Check & Multi-OS Releases:** Added Windows, macOS (`arm64`), and Linux (`AppImage`) release automation.

## [0.4.1] — 2026-11-26
- **Discord Community Feedback:** Replaced email reporting with one-click Discord report templates.
- **Automatic In-App Update Notifications:** Toast notifications and restart pill for new desktop releases.

## [0.4.0] — 2026-11-25
- **AI-Proof Consistency Pack:** Starter Sprite Templates, Hero Style Anchor, Style Lock, and Auto Craft Gate.

## [0.3.0] — Earlier
- **Studio Pack & VFX Studio:** 244 built-in deterministic `pixelfx` procedural VFX, Motion Composer, and game-ready exports.
