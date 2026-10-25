# PixelForge AI — MCP Service in a Packaged Windows Desktop Build

**Task 13a deliverable (v3.1 §12 row 13a, §6 of the task brief).**
Assessment of how the Bun-hosted MCP service (Task 8, `mini-services/mcp-server`)
will be launched, supervised, and stopped by the packaged Electron application.
No architecture rewrite was performed — this is a readiness assessment with a
recommendation.

---

## 1. Current architecture (what exists today)

- The MCP server is a **standalone Bun process** (`mini-services/mcp-server`)
  listening on **127.0.0.1:3030** — one port serving:
  - `/mcp` — Streamable-HTTP MCP (official TS SDK, session-per-client),
  - `/` — WebSocket upgrade = the editor bridge (renderer ⇄ CommandBus),
  - `/health` — liveness only.
- `createPixelForgeServer(deps)` was written **embed-first**: the same modules
  can be imported and hosted in-process (the sandbox runs them standalone only
  because the preview panel needs the port).
- Data dir: `PF_MCP_DATA_DIR` (defaults to `<repo>/db`) holding
  `mcp-clients.json` (SHA-256 token hashes) and `mcp-ops.jsonl` (audit log).
  Task 13a added best-effort `0600` restriction on both (POSIX).

## 2. Launch / supervision / shutdown (recommended lifecycle)

| Phase | Behavior |
|---|---|
| **Startup** | Electron main starts the MCP host **after** `app.whenReady()` and **before** the renderer loads, so the bridge can connect on first paint. Chosen port is probed (`3030`→`3039`, first free) and published to the renderer via the settings bridge (new read-only field when implemented). |
| **Supervision** | Main polls `GET /health` every 5 s. On 2 consecutive failures: restart with backoff (1 s / 5 s / 15 s); after 3 failed restarts, surface a Settings → MCP status error and keep the editor fully usable (MCP is an add-on, not a dependency of the canvas). |
| **Shutdown** | `before-quit` → stop accepting, `server.stop(true)`, then kill the child (below). Windows note: a Bun child must be killed via its PID **with the process group** (`taskkill /PID <pid> /T /F`) because Bun on Windows does not propagate SIGTERM to children. In-process hosting (option B) removes this entire class of problem. |
| **Crash isolation** | The MCP host already swallows `unhandledRejection`/`uncaughtException` (Task 8). A hard crash of the MCP process must never take the editor down — the renderer bridge reconnects with backoff (Task 8 behavior). |

## 3. Hosting options (assessment)

### Option A — sidecar: bundle the MCP server as a compiled Bun executable

`bun build --compile --target=bun-windows-x64 ./src/index.ts → pixelforge-mcp.exe`
spawned by Electron main as the sidecar described above.

- ✅ Zero Node/Electron runtime coupling; the official SDK + `Bun.serve` run
  unmodified; smallest code delta (spawn + supervise ≈ 80 LOC in main).
- ✅ `bun-types`-free compiled binary — no runtime install for users.
- ⚠️ Adds ~90–110 MB to the installer (Bun runtime embedded in the exe).
- ⚠️ Two runtimes ship in one app; version drift between Electron and sidecar
  must be pinned in CI.

### Option B — in-process: host the MCP server inside the Electron main process

The embed-first API already compiles for Node (no Bun-specific APIs in
`auth/store/server/editor-link/tools-catalog`; only `index.ts`'s `Bun.serve`
and the WS-upgrade glue are Bun-flavored). Port `Bun.serve` to
`node:http` + a small WS upgrade handler, or `@fastify/websocket`.

- ✅ One process, one runtime; supervision/kill complexity disappears; app is
  ~100 MB lighter; health checks become direct function calls.
- ⚠️ Moderate port work (the HTTP server + WS upgrade ≈ 150–250 LOC), plus
  golden tests re-run against the Node path.
- ✅ Recommended **target state** (P1 follow-up), consistent with the plan's
  "mcp pkg, main-hosted" architecture note (§8.1/§8.2).

**Recommendation:** ship P0 packaging with **Option A** (smallest delta, fully
tested today), and land **Option B** as a P1 follow-up before the updater
task (13b). No rewrite was started in 13a, per scope rules.

## 4. Windows runtime dependencies

- **Bun sidecar (A):** no user-facing prerequisites — the compiled exe embeds
  the runtime. AV/SmartScreen may flag an unsigned exe (same as the Electron
  shell; signing lands with 13b).
- **In-process (B):** none beyond Electron itself.
- **safeStorage (credentials):** DPAPI is always present on Windows; no
  keyring service dependency (unlike Linux). Encryption availability should
  still be probed at runtime (`safeStorage.isEncryptionAvailable()`), which
  the Task 13a vault already does.

## 5. Credential ownership & storage locations (packaged layout)

| Data | Location (packaged) | Owner | Notes |
|---|---|---|---|
| App settings + `apiKeyEnc` ciphertext | `%APPDATA%/PixelForge AI/settings.json` (Electron `userData`) | Electron main | 0600-equivalent via user-profile ACLs; ciphertext bound to the Windows user by DPAPI. |
| Session-only keys | Memory only | Electron main | Never persisted (C13; when `isEncryptionAvailable()` is false). |
| MCP client allowlist (token hashes) | `<userData>/mcp/mcp-clients.json` | MCP host | Set `PF_MCP_DATA_DIR` to `<userData>/mcp` at spawn (option A) or pass `dataDir` (option B). Currently repo-relative — **must move for packaging**. |
| MCP audit log | `<userData>/mcp/mcp-ops.jsonl` | MCP host | Same relocation. |
| Editor projects | User-chosen paths + `<file>.autosave.pixelforgeproj` | Renderer ⇄ core persistence | Unchanged by 13a. |

## 6. Port conflicts & failure recovery

- Bind is loopback-only (`127.0.0.1`), so a conflict can only come from another
  local process occupying 3030. Startup probes 3030→3039 and records the
  working port; the editor bridge receives it via the settings bridge.
- If all ports are taken: MCP is reported unavailable in Settings → MCP; the
  editor continues (drawing/animation/persistence are not MCP-dependent).
- Two app instances: Electron holds a single-instance lock (`requestSingleInstanceLock`), so the second launch never spawns a second MCP host.

## 7. Offline behavior

- **Canvas/editing/persistence/exports:** fully offline (no network calls).
- **MCP:** fully offline — loopback protocol between local assistant clients
  and the editor; pairing works offline.
- **AI generation:** requires network (built-in Z.AI or user providers).
  Provider failures fall back to the built-in engine's error path (existing
  behavior, unchanged).

## 8. Manual packaging QA checklist (NOT executed — no Windows packaging in 13a)

1. `bun build --compile` the sidecar; verify `pixelforge-mcp.exe --health` on a clean Windows VM.
2. Launch the packaged Electron app; confirm the bridge connects (dev-server renderer is replaced by the packaged renderer before this step — Task 4+ renderer port).
3. Pair a client, revoke after restart, confirm `mcp-clients.json` relocated to `%APPDATA%`.
4. Store an API key; verify `settings.json` contains only `apiKeyEnc`; copy `settings.json` to another user profile → decrypt must fail → key treated as missing (Task 13a recovery behavior).
5. Kill the sidecar mid-session → supervisor restarts it → bridge reconnects.
6. Block port 3030 with a dummy listener → app falls back to 3031.
7. Quit the app → `tasklist` shows no orphan `pixelforge-mcp.exe`.

> **Status: none of the above has been executed.** Task 13a covers the
> settings/credential infrastructure only; packaging verification remains
> open until the Windows packaging task runs.
