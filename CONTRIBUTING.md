# Contributing to PixelForge AI

Thanks for your interest in contributing to **PixelForge AI**! Whether you’re reporting a bug, suggesting a pixel-art workflow improvement, or opening a pull request, your help is welcome.

---

## Development Setup

PixelForge AI has three independent dependency trees (root web studio, local MCP server, and Electron desktop shell):

```bash
# 1. Install dependencies
bun install
cd mini-services/mcp-server && bun install && cd ../..
cd apps/desktop && npm ci && cd ../..

# 2. Generate Prisma client (browser persistence)
bunx prisma generate

# 3. Run the web studio + MCP server in development
bun run dev        # Studio UI on http://localhost:3000
bun run mcp:dev    # Local MCP server on http://127.0.0.1:3030/mcp
```

To run the Electron desktop shell against the dev server:

```bash
bun run desktop:dev
```

---

## Running Checks Before Opening a PR

Please run the relevant checks for the area you modified:

```bash
# Lint the Next.js studio
bun run lint

# Core engine tests & typecheck
bun run core:test
bun run core:typecheck

# MCP server tests & typecheck
bun run mcp:test
bun run mcp:typecheck

# Desktop shell tests & typecheck
bun run desktop:test
bun run desktop:typecheck
```

---

## Architecture Rules to Keep in Mind

1. **Pure `@pixelforge/core`:** Keep `packages/core` free of DOM, React, Electron, and network APIs so it remains deterministic everywhere.
2. **Single `CommandBus`:** All canvas, layer, frame, palette, and MCP edits must go through `CommandBus` so manual and AI edits share one undo history.
3. **100% Local & Deterministic:** Do not add cloud telemetry, paid API-key requirements, or non-deterministic network dependencies to editing tools.
4. **Loopback-Only MCP Security:** Preserve `127.0.0.1` binding, `Host`/`Origin` allowlists, permission tiers (`L0`–`L2`), and rate limits.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/development.md`](docs/development.md) for deeper technical details.

---

## Pull Request Process

1. Fork the repository and create a focused branch (`feat/...` or `fix/...`).
2. Keep PRs scoped to one feature or bug fix.
3. Fill out the PR template clearly — include screenshots or GIFs for UI/canvas changes.
4. By submitting a PR, you agree that your contributions will be licensed under the project’s [MIT License](LICENSE).

Need help getting started? Ask in the [PixelForge AI Discord](https://discord.gg/2f5MvmAqF) or open an issue!
