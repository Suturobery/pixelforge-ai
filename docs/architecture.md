# PixelForge AI — Architecture

## The short version

PixelForge is one editor with several ways in. The document, its validation and its undo
history live in a single **CommandBus** inside the editor page. The UI, the in-app Agent
Console and external IDE agents all go through that bus. Nothing edits pixels around it.

```text
        manual editing (UI)  ──────┐
        Agent Console (in-app) ────┤
                                  ▼
   renderer page  ──►  CommandBus  ──►  Project (v2 document)  ──►  files / exports
        ▲                     ▲
        │ tool-request        │ same commands, same validation, same history
        │ over WebSocket      │
   MCP server  ◄──────────────┘
        ▲
        │ Streamable HTTP + Bearer token
   IDE agent (ZCode, Z.AI IDE, any MCP client)
```

## Processes and ports

### Packaged desktop app

```text
┌──────────────────── Electron main process (apps/desktop/src/main) ────────────────────┐
│ SettingsStore · UpdateService · IPC handlers · window and session hardening           │
│ McpSupervisor ──spawn──► mcp-server.exe     RenderServer ──spawn──▶ Next standalone    │
└───────────┬──────────────────────────────────────────────────────┬───────────────────┘
            │ preload: window.pixelforge (bridge v5)                │ http://127.0.0.1:3131
┌───────────▼──────────────────────────────────────────────────────▼───────────────────┐
│ BrowserWindow — sandboxed renderer running the editor page (src/)                     │
│ Zustand store · CommandBus (@pixelforge/core) · MCP tool executor · editor bridge     │
└───────────┬───────────────────────────────────────────────────────────────────────────┘
            │ WebSocket ws://127.0.0.1:<port>/  (hello + editor key)
┌───────────▼──────────────── MCP server (mini-services/mcp-server) ────────────────────┐
│ Bun.serve on 127.0.0.1:  /mcp  ·  / (editor WebSocket)  ·  /health                    │
│ auth → tier → rate → relay · client allowlist · audit log · task board · knowledge    │
└───────────▲───────────────────────────────────────────────────────────────────────────┘
            │ POST/GET/DELETE http://127.0.0.1:<port>/mcp  (Bearer pfm_… token)
     IDE agent / MCP client
```

| Process | Packaged | Development |
| --- | --- | --- |
| Electron main | `apps/desktop/dist/main/index.js` | Same, compiled by `npm run build` |
| Renderer server | Electron binary in Node mode running `resources/renderer/server.js` | `next dev -p 3000` |
| Renderer page | `http://127.0.0.1:3131` (`PF_RENDERER_PORT`) | `http://localhost:3000` (`PF_DEV_URL`) |
| MCP server | `resources/mcp/mcp-server.exe` | `bun src/index.ts` in `mini-services/mcp-server` |

**Ports**

| Port | Used by | Notes |
| --- | --- | --- |
| 3000 | Next.js dev server | Development only |
| 3131 | Embedded renderer server | Packaged only; configurable with `PF_RENDERER_PORT` |
| 3030 | MCP server | `PF_MCP_PORT`. A packaged app uses 3030 when free, otherwise picks a free loopback port and tells the renderer through the bridge |
| 81 | Caddy gateway | Hosted-preview deploys only (`.zscripts`, `Caddyfile`) |

All app services bind to loopback only.

## Responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| `packages/core` (`@pixelforge/core`) | Document model, CommandBus and commands, pixel operations, tile-diff history, playback clock, export compositor, motion composer, PNG/ZIP codecs, `.pixelforgeproj` persistence, v1 importer, AI helper math | Anything that needs a DOM, React, Electron or the network |
| `src/lib/pixelforge` (`store.ts`) | One `CommandBus` instance, view state (zoom, tool, selection, playhead), strokes, pointer selection | File system access |
| `src/lib/pixelforge/mcp-tools.ts` | The executor for every relayed MCP tool | Authentication, tiers, rate limits |
| `src/lib/pixelforge/mcp-bridge.ts` | The editor's WebSocket to the MCP server, control plane for Settings | Document rules |
| `mini-services/mcp-server` | Pairing, tokens, tiers, rate limits, audit log, task board, knowledge, relay to the editor | The document — it holds no editor state |
| `apps/desktop` | Windows, IPC, native dialogs, the fs allowlist, settings file, key vault, MCP supervision, updates | Editor logic |
| Next.js API routes (`src/app/api`) | Project rows in SQLite, the editor-key hand-off, an MCP reachability probe | MCP tools (the old REST runner is retired with 410) |

## The single mutation path

Every document change is a command on the bus:

```ts
bus.execute(type, payload, origin)        // validate, apply, record history
bus.transaction(label, origin, fn)        // group commands; any throw rolls everything back
```

- `origin` is `'ui'`, `'mcp'` or `'ai'` and is stored on every history entry.
- A command's `apply` is pure: document in, new document out. A failed command cannot leave
  the document half-changed.
- Pixel edits carry 16×16 tile diffs; structural edits carry snapshots. Both are budgeted
  against the history memory limit.
- Pointer strokes use `beginStroke` / `endStroke` and commit as one `pixels.applyOp` command.
- The only whole-document replacement paths are the store's load functions (open, create,
  import), which reset history by design.

## How a tool call travels

1. The MCP client sends JSON-RPC to `POST /mcp` with `Authorization: Bearer <token>`.
2. The HTTP layer in `mini-services/mcp-server/src/index.ts` checks, in order: a
   `Content-Length` header, a body of at most 2 MB, the `Host` allowlist, the `Origin`, then
   resolves the bearer to an identity. Failed authentications are throttled.
3. `McpHost.handleHttp` binds the request to an MCP session (`mcp-session-id`). A session is
   locked to the identity that created it.
4. The SDK dispatches to the registered tool. `McpHost.runTool` checks the master switch, the
   permission tier, and the rate budget for the tool's tier.
5. If the caller holds a claimed task, the edit is restricted to that task's project.
6. **Server tools** are answered here. **Relayed tools** are sent to the editor over the editor
   WebSocket with a 30 second timeout.
7. The editor page (`mcp-bridge.ts`) calls `executeMcpTool`, which checks for a stroke in
   progress, an optional `expectedStateHash`, and the task project, then runs the handler on
   the bus. Pixel tools also capture a before/after review snapshot.
8. The result envelope travels back. The server audits the call and returns JSON text, the
   same object as `structuredContent`, and — for `get_frame_png` and `preview_animation` —
   native PNG image content.
9. If the document changed, the editor pushes a `projectChanged` event, which the server
   forwards as an MCP notification to every live session.

## Editor bridge protocol

One WebSocket per MCP server. The server keeps a single editor slot.

| Direction | Message | Purpose |
| --- | --- | --- |
| Editor → server | `hello` | Claim the slot. Carries `editorKey`, `bridgeVersion`, `appVersion`, `origin`, `mcpEnabled`, optional `takeover` |
| Server → editor | `hello-ok` | Attached. Returns server status |
| Editor → server | `ping` | Keepalive, every 15 s |
| Server → editor | `pong` | Reply |
| Server → editor | `tool-request` | A relayed tool call: `id`, `tool`, `args`, `clientId`, `clientName`, `tier`, optional `expectedProjectKey` |
| Editor → server | `tool-result` | The result envelope for that `id` |
| Editor → server | `event` | `projectChanged` with `stateHash`, `name`, `dirty`, `projectKey`, `projectName` |
| Editor → server | `status-update` | Mirror of the MCP master switch |
| Server → editor | `status` | Current server status |
| Editor → server | `ctrl-request` | Settings control plane (only the slot owner) |
| Server → editor | `ctrl-result` | Reply to a control request |

Control requests: `status`, `pair-generate`, `pair-cancel`, `clients-list`, `client-revoke`,
`client-remove`, `ops-recent`, `brain-push`, `brain-tasks`, `brain-clear`, `brain-retry`,
`brain-cancel`, `tools-changed`.

**Slot arbitration**

- A hello must arrive within 5 s of the socket opening, or the socket is closed.
- The hello must present the editor key — a 32-byte secret the server stores in
  `editor-auth.json`. The page fetches it from `GET /api/mcp/editor-key` and compares in
  constant time on the server.
- A healthy holder keeps the slot. A newcomer is rejected unless the holder has been silent
  for more than 25 s, or the newcomer sends `takeover: true` — which only happens when the
  user presses **Take over the bridge** in Settings.
- On the page side, the Web Locks API (`pixelforge-mcp-editor`) ensures one tab per browser
  holds the bridge.

**Close codes**

| Code | Meaning |
| --- | --- |
| 4000 | Another editor is connected |
| 4001 | Hello timeout |
| 4002 | Malformed JSON |
| 4003 | Hello required, or unauthorized editor (bad or missing key) |
| 4005 | Replaced by a newer editor |

**Transport candidates** — the page tries, in order: the endpoint reported by the Electron
bridge (packaged); `ws://127.0.0.1:<mcpPort>/`; then a gateway-relative
`ws(s)://<host>/?XTransformPort=3030` when the page is not served from localhost. Reconnect is
3 s, or 15 s after a 4000.

## Trust boundaries

| Boundary | Mechanisms |
| --- | --- |
| MCP client → MCP server | Loopback bind; `Host` allowlist (`127.0.0.1:<port>` or `localhost:<port>`) against DNS rebinding; loopback-only `Origin`; bearer tokens stored as SHA-256 hashes; one-time 6-word pairing codes (15 min, about 49.85 bits); 30 failed auths in 60 s → 429 for the rest of the window; 2 MB body cap; session bound to identity; tier grants; per-tier rate limits; append-only audit log |
| Editor page → MCP server | Shared editor key required in `hello`; origin check (loopback or same-host) |
| Renderer → operating system | `contextIsolation`, `sandbox: true`, no Node integration, `webSecurity`, all permission requests denied, CSP (enforced when packaged, report-only on the dev server), popups denied, `<webview>` blocked, navigation limited to the renderer origin |
| Renderer → files | Every file operation goes through IPC to main and must resolve inside a directory the user picked this session; symlinks are resolved before the check; recent projects are capabilities granted only by a native picker; deletion goes to the Recycle Bin after a main-process confirmation |
| HTTP API (Next.js) | Localhost only unless `PF_ALLOW_LAN=1`; `X-PixelForge-Agent: 1` header tripwire on every guarded route; optional bearer token when `PF_WEB_TOKEN` is set |

The API header is a tripwire, not authentication: a cross-origin page cannot set a custom
header without a CORS preflight, and these routes never answer one. Real authentication is the
MCP server's job.

## HTTP API surface

| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| GET | `/api` | none | Placeholder "Hello, world!" |
| GET | `/api/mcp/editor-key` | read guard | Returns the editor-link token |
| GET | `/api/mcp/status` | read guard | Probes the MCP endpoint with an `initialize` request (1.5 s timeout); reports reachable and whether auth is required |
| GET | `/api/projects` | read guard | Lists saved projects (id, name, size, `updatedAt`) |
| POST | `/api/projects` | state-change guard | Validates and upserts a v1 project payload |
| GET | `/api/projects/[id]` | read guard | Loads one project |
| DELETE | `/api/projects/[id]` | state-change guard | Deletes one project row |
| any | `/api/mcp/run`, `/api/mcp/tools`, `/api/mcp/ops` | none | **410 Gone.** Retired REST tool runner; use MCP |

Guard failures return 403 with a code: `LOCAL_ONLY`, `WEB_TOKEN_REQUIRED`,
`UNTRUSTED_ORIGIN` or `MISSING_AGENT_HEADER`.

## Data flow and storage

| Data | Browser | Desktop development | Packaged desktop |
| --- | --- | --- | --- |
| Projects | SQLite rows (v1 JSON) | SQLite rows, or `.pixelforgeproj` files | `.pixelforgeproj` files the user picks |
| App preferences | `localStorage` | `localStorage`, mirrored to the settings file | Settings file is the source of truth |
| Panel layouts | `localStorage` | `localStorage`, mirrored to settings | Same |
| MCP clients, audit log, editor key, task board | `<repo>/db` | `<repo>/db` | `%APPDATA%/PixelForge AI/mcp-data` |
| Logs | — | `userData/logs` | `%APPDATA%/PixelForge AI/logs` |

Full detail: [Project and file formats](project-format.md).

## Hosted-preview topology

`.zscripts/` (build, start, dev) deploys the studio to a sandbox behind a Caddy gateway.
`Caddyfile` listens on `:81`, forwards requests carrying `?XTransformPort=<n>` to
`localhost:<n>` and everything else to `localhost:3000`. The editor page reaches the MCP
server through that transform, and the MCP server accepts an editor `Origin` whose host equals
the request `Host` for this reason. The build script self-heals a missing
`output: "standalone"` in `next.config.ts`, because the packaged server needs it.

## Design rules enforced in code

- `@pixelforge/core` stays free of DOM, React and Electron so it runs identically in the
  renderer, in main, in workers and in tests.
- The renderer never mutates canvas state directly; it dispatches commands.
- Exports are composed from document buffers by core, never from the screen renderer, so
  onion skins, selection outlines and guides cannot leak into output.
- Motion rules R1–R10 (`src/lib/pixelforge/types.ts`): translation-only part transforms, fixed
  z-order, deterministic composition, static pixels preserved, per-frame durations as data,
  QA that reports and never mutates.
- MCP tool arguments are bounded data, not a free-form instruction channel.
- There are no paid tools and no network calls behind any tool.
