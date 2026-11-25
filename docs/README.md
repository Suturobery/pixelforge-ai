# PixelForge AI — Documentation

PixelForge AI is a Windows-first pixel-art and frame-by-frame animation studio with a
local MCP server, so AI assistants running in your own IDE can inspect and edit the same
document you edit by hand — through the same command bus, with the same undo history.

This folder describes the current source and historical project decisions. Check the package
manifests and tool catalog for the exact version and MCP count in your checkout.

## The docs

| Document | What it covers | Status |
| --- | --- | --- |
| [Overview](overview.md) | What the product is, who it is for, the full feature list, what is deliberately absent, component versions, quick start, repository map | Current |
| [User guide](user-guide.md) | The editor: layout, tools, shortcuts, layers, timeline, palettes, Style Lock, Motion, VFX, Reference, export, files, settings | Current |
| [Architecture](architecture.md) | Processes and ports, the single mutation path, how a tool call travels, editor bridge protocol, trust boundaries, HTTP API surface | Current |
| [AI and agents](ai-agents.md) | Pairing, permission tiers, rate limits, MCP tools, result envelope, error codes, notifications and resources, task board, Second Brain, Agent Console | Current |
| [Knowledge base](knowledge-base.md) | The 21 knowledge topics agents can read, learned styles, the 2006-palette library | Current |
| [Project and file formats](project-format.md) | Document model v2, `.pixelforgeproj` container, the v1 web/SQLite format, autosave and journal files, where every file lives | Current |
| [Core engine](core-engine.md) | `@pixelforge/core`: module map, public API, CommandBus, pixel ops, history, playback, export service, motion presets, AI helpers, persistence | Current |
| [Desktop app](desktop-app.md) | Electron shell: startup, security posture, preload bridge contract, MCP supervisor, embedded renderer server, settings vault, updates, packaging and release | Current |
| [Connecting AI agents](connect-agents.md) | Short agent-facing guide: pair, then the workflow agents are asked to follow | Current |
| [Development and testing](development.md) | Install, run, test suites, CI, smoke tests, golden images | Partly stale — see its status note |
| [Export metadata schema](export-metadata.md) | The JSON sidecar written with every sprite-sheet export (version 2) | Current, one stale note |
| [MCP packaging readiness](desktop-mcp-packaging-readiness.md) | The original assessment of how the desktop app should host the MCP service | Superseded — kept for history |
| [Project plan (extracted)](PixelForge_AI_Project_Plan_extracted.md) | The original product plan, v1.0, 24 October 2026 | Historical — the vision, not the current state |

## Where to start

- **I want to use the app** → [User guide](user-guide.md)
- **I want to connect my IDE assistant** → [Connecting AI agents](connect-agents.md), then [AI and agents](ai-agents.md) for every tool
- **I want to understand how it works** → [Architecture](architecture.md), then [Core engine](core-engine.md) and [Desktop app](desktop-app.md)
- **I want to build an installer** → [Desktop app](desktop-app.md#packaging-and-release)
- **I want to set up a dev environment and run tests** → [Development and testing](development.md)
- **I am writing code that reads or writes project files** → [Project and file formats](project-format.md)

## Conventions used in these docs

- Source paths are relative to the repository root and shown in `backticks`.
- "Relayed" tools run inside the editor page. "Server" tools run inside the MCP server and need no editor.
- Tier names (`L0`, `L1`, `L2`, `L3`) are the MCP permission tiers defined in [AI and agents](ai-agents.md#permission-tiers).
- "Style Lock" is the product name for the project's style profile.
