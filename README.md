<div align="center">

# PixelForge AI

### Local-first pixel art, animation, tileset & VFX studio with a live AI Co-Pilot

Use the AI IDE subscriptions you already pay for (**Cursor, Claude Code, Codex, Windsurf, Antigravity**) to paint, animate, and review directly on your live pixel canvas — **100% local, deterministic, and open source.**

<p>
  <a href="./LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-14b8a6.svg?style=flat-square"></a>
  <a href="https://github.com/Suturobery/pixelforge-ai/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/Suturobery/pixelforge-ai?style=flat-square&color=14b8a6&label=download"></a>
  <a href="https://github.com/Suturobery/pixelforge-ai/releases"><img alt="Total Downloads" src="https://img.shields.io/github/downloads/Suturobery/pixelforge-ai/total?style=flat-square&color=0ea5e9&label=downloads"></a>
  <a href="https://github.com/Suturobery/pixelforge-ai/actions/workflows/ci.yml"><img alt="CI Build Status" src="https://img.shields.io/github/actions/workflow/status/Suturobery/pixelforge-ai/ci.yml?style=flat-square&label=build"></a>
  <img alt="Platform: Windows | macOS | Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-334155.svg?style=flat-square">
  <a href="./CONTRIBUTING.md"><img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-10b981.svg?style=flat-square"></a>
  <a href="https://discord.gg/2f5MvmAqF"><img alt="Discord Community" src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

![PixelForge AI — Starter Templates & 1-Click Sprite Skins](docs/images/pixelforge-showcase.png)

</div>

---

## Download

Get the latest desktop installer for **Windows** (`.exe`), **macOS** (`arm64.dmg` / `.zip`), or **Linux** (`.AppImage`) from **[GitHub Releases](https://github.com/Suturobery/pixelforge-ai/releases/latest)**.

Desktop builds bundle the studio and local MCP sidecar automatically (no terminal needed) and include background update notifications.

> **Unsigned indie builds:** Releases are built transparently via GitHub Actions and are currently unsigned, so Windows SmartScreen or macOS Gatekeeper may show a first-run prompt. See **[CODE_SIGNING.md](CODE_SIGNING.md)** for quick instructions (or build from source below).

---

## Built for Both Beginners & Pixel Artists

### Live AI Artist Co-Pilot & Local MCP (No Cloud API Keys)
- **Watch AI Paint Live:** Connected IDE agents paint onto the exact same canvas, layers, palette, and `Ctrl+Z` undo history you use by hand — with a 60fps moving AI brush cursor, progressive pixel reveal, corner focus brackets, and a live `+N px` pill.
- **Stay in Control:** **Hold `Before`** to compare edits, undo in 1 click, toggle **Pause AI** while you paint manually, and draw a marquee selection so agents know *exactly* where to work (`artistContext`).
- **Auto-Eyes Self-Critique:** Every pixel-writing MCP tool automatically returns a zoomed gridded PNG plus a structured `visualCheck` (ASCII pixel map, bounds, floating fragments, symmetry %, and warnings) so agents actually *see* and fix crooked pixels.
- **1-Click IDE Setup (96 MCP Tools):** Auto-detects **Cursor, Claude Code, Codex, Windsurf, and Antigravity** (with safe `.pixelforge.bak` backups, loopback `127.0.0.1` binding, revocable tokens, and `L0`/`L1`/`L2` permission tiers).

### Pixel Art, Animation, Tilesets & VFX Studio
- **Pixel-Perfect Editable Vectors (`N`) & Live FX:** Draw crisp, zero-anti-aliasing lines, quadratic/cubic Bézier curves, rects, ellipses, and polygons with live draggable handles + 1-click Bake. Stack **Non-Destructive Live FX** (1px Solid or hue-shifted **Sel-Out** outlines, drop shadows, and OKLab skin/color remaps) across every frame.
- **Tileset Stamp Picker & 2-Layer Level Mockup Theater:** `8`–`64` px tiles, live brush sync, Rotate/Flip, 2-layer rooms (**Ground** + **Overlay/Props**), 40-step room undo, hover ghost preview, animated multi-frame tiles, Bake to Clip, and PNG export.
- **Motion Composer & 244 Procedural VFX:** 10 deterministic body-part presets (`idle`, `walk`, `run`, `attack`, `jump`, `spin`, `duck`, `hurt`, `swim`, `death`) and seeded `pixelfx` VFX (`fire`, `lightning`, `explosion`, `portal`, `smoke`, and more).
- **Beginner-Friendly Head Starts:** 8 hand-crafted 16-bit **Starter Sprite Templates**, **1-Click Sprite Skins** (`Fire`, `Ice`, `Poison`, `Shadow`, `Royal Gold`, `Cyber`, `Retro GB`, `Stone`), **Automatic Hue Shifter**, 2,000+ curated palettes, **Second Brain** prompt interpreter & instant actions, **Hero Style Anchor**, and **Clips Contact Sheet** theater.
- **Aseprite Import & Game Engine Export:** Drag-and-drop `.ase` / `.aseprite` files with layers, timings, tags, and palettes preserved. Export PNG frames, Sprite Sheets, **Master Atlas**, lossless **GIF**, **Aseprite JSON** (Unity / Phaser / PixiJS), and **Godot 4 `SpriteFrames` (`.tres`)**.

---

## Quick Start (Development)

```bash
# Install dependencies (3 independent trees)
bun install
cd mini-services/mcp-server && bun install && cd ../..
cd apps/desktop && npm ci && cd ../..

# Generate Prisma client & run web studio + MCP server
bunx prisma generate
bun run dev        # Studio on http://localhost:3000
bun run mcp:dev    # MCP server on http://127.0.0.1:3030/mcp
```

For the Electron desktop shell:

```bash
bun run desktop:dev
```

---

## Documentation

Full guides live in [`docs/`](docs/README.md):

- [User Guide](docs/user-guide.md) — Tools, vectors, Live FX, timeline, Motion, VFX, export, and settings
- [Connecting AI Agents (MCP)](docs/connect-agents.md) — 1-click pairing for Cursor, Claude Code, Codex, Windsurf, and Antigravity
- [AI & MCP Reference](docs/ai-agents.md) — Permission tiers, tool catalog, task board, and Second Brain
- [Architecture](docs/architecture.md) — Desktop shell, `CommandBus`, editor bridge, and security boundaries
- [Development Guide](docs/development.md) — Running locally, testing, and building installers

---

## Community, Contributing & License

- **Community & Support:** Join the **[PixelForge AI Discord](https://discord.gg/2f5MvmAqF)** or use **Help & feedback (?)** inside the app.
- **Contributing:** PRs and bug reports are welcome! Read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and [`SECURITY.md`](SECURITY.md).
- **Changelog:** See [`CHANGELOG.md`](CHANGELOG.md) or [GitHub Releases](https://github.com/Suturobery/pixelforge-ai/releases).
- **License:** Source code is licensed under the **[GNU AGPL-3.0 License](LICENSE)**. Brand marks and promotional assets are covered by [`LICENSE-ASSETS`](LICENSE-ASSETS); artwork you create in PixelForge AI belongs **100% to you**.
