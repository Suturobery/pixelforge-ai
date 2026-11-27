# Security Policy

PixelForge AI runs locally on your computer and includes a loopback-only **Model Context Protocol (MCP)** server (`127.0.0.1`) plus an Electron desktop shell. We take local security and privacy seriously.

## Security Boundaries Built Into PixelForge AI

- **Loopback-Only MCP Server:** Binds strictly to `127.0.0.1` with `Host` and `Origin` allowlists to prevent DNS rebinding and cross-origin browser access.
- **Per-Client Tokens & Permission Tiers:** Clients authenticate with revocable SHA-256 hashed bearer tokens scoped to `L0` (read-only), `L1` (undoable edits), or `L2` (destructive & disk operations), with per-tier rate limits and an append-only audit log.
- **Sandboxed Electron Renderer:** Uses `contextIsolation`, `sandbox: true`, no Node integration in the renderer, and session-scoped native file pickers for filesystem access.
- **Zero Cloud Telemetry:** PixelForge AI makes no paid AI API calls and never uploads your sprites or projects to external servers.

## Supported Versions

Security fixes are applied to the latest `0.x` release line:

| Version | Supported |
| --- | --- |
| `0.7.x` (latest) | Yes |
| `< 0.7.0` | No — please update to the latest release |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, please report it privately using **GitHub Security Advisories**:
1. Go to the **Security** tab of `Suturobery/pixelforge-ai`.
2. Click **Report a vulnerability** and include:
   - Affected component (`apps/desktop`, `mini-services/mcp-server`, `src/`, or `packages/core`)
   - Steps to reproduce or proof of concept
   - Potential impact

We will acknowledge reports as quickly as possible and coordinate a fix before public disclosure.
