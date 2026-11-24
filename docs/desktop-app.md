# PixelForge AI — Desktop App

`apps/desktop` is the Electron shell. It owns the window, native file dialogs, the settings
file and key vault, the MCP sidecar, the embedded renderer server and the installer. It contains
no editor logic: the editor is the Next.js page in `src/`, served to the window.

| Fact | Value |
| --- | --- |
| Package | `@pixelforge/desktop`, version `0.2.9`, product name `PixelForge AI` |
| App id | `ai.pixelforge.desktop` |
| Entry | `dist/main/index.js`, compiled from `src/main/index.ts` |
| Stack | Electron 45, electron-builder 25.1.8, electron-updater 6.8.11, TypeScript 5 |
| Install | `npm ci` in `apps/desktop` (separate from the bun trees) |

## Source layout

| Path | Contents |
| --- | --- |
| `src/main/index.ts` | Entry point and startup sequence |
| `src/main/menu.ts` | Minimal application menu |
| `src/window.ts` | Main window creation, security posture, layout persistence, renderer loading |
| `src/config.ts` | Dev/packaged detection, renderer target and port |
| `src/security.ts` | Permission handlers, CSP, download logging |
| `src/render-server.ts` | The embedded Next.js server for packaged builds |
| `src/mcp/launcher.ts` | Spawns the MCP sidecar |
| `src/mcp/supervisor-core.ts` | The MCP supervision state machine (pure, tested) |
| `src/bridge/handlers.ts` | IPC handlers for dialogs, recents and the file allowlist |
| `src/bridge/settings-handlers.ts` | IPC handlers for settings and credentials |
| `src/settings/schema.ts`, `store.ts` | Versioned settings file: validation, migration, atomic writes |
| `src/settings/secret-box.ts` | `safeStorage` adapter for the credential vault |
| `src/update/service.ts` | Software updates |
| `src/startup-splash.ts` | Native splash shown while the renderer boots |
| `src/smoke.ts` | Full-stack smoke probes, enabled with `PF_SMOKE=1` |
| `src/preload/index.ts` | The bridge exposed to the page as `window.pixelforge` |
| `src/shared/bridge-types.ts` | The canonical bridge contract |
| `static/` | Diagnostic shell page and splash assets |
| `scripts/` | `build-mcp.cjs`, `stage-renderer.cjs`, `dist.cjs` |
| `electron-builder.yml` | Packaging configuration |
| `resources/` | Build inputs: `mcp/`, `renderer/`, `prisma/` |

## Startup sequence

1. `app.setName('PixelForge AI')`, then `app.enableSandbox()` — the Chromium sandbox is forced
   for every renderer.
2. The logger and the settings store are created. `userData` is `%APPDATA%/PixelForge AI`.
3. A single-instance lock is taken. A second launch quits and focuses the running window.
4. On ready: process error handlers, bridge handlers, settings handlers, the update service and
   the application menu are registered.
5. A native splash window appears (except in smoke mode).
6. The MCP port is chosen and the supervisor starts the sidecar.
7. `PF_MCP_DATA_DIR` is set for the renderer server so it reads the same editor key as the MCP
   server.
8. The main window is created and its session hardened.
9. In a packaged build the renderer server starts. If it fails, the window falls back to the
   diagnostic shell instead of a blank page.
10. The renderer loads. The splash closes when the window is ready to show.

On quit the window layout is saved and the MCP child the app started is stopped. An adopted
server is left to its owner.

## Window and security posture

| Setting | Value |
| --- | --- |
| Size | 1280×800 default, minimum 960×600, launched maximized |
| Restored layout | Applied only if the saved bounds are visible on a currently attached display |
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` |
| `webSecurity`, `allowRunningInsecureContent` | `true`, `false` |
| Permissions | Every request denied |
| Popups | Denied; `http(s)` and `mailto` links go to the operating system |
| Navigation | Limited to the renderer's own origin |
| `<webview>` | Blocked |
| CSP | Enforced in packaged builds; report-only against the dev server, which needs inline scripts for hot reload |

## The preload bridge

The page receives exactly one object, `window.pixelforge` (`bridgeVersion: 5`). It never gets
`ipcRenderer`, Node primitives, a path it did not pick, or key material.

| Namespace | Method | IPC channel |
| --- | --- | --- |
| root | `ping()` | `pf:ping` |
| `app` | `getInfo()` | `pf:app-info` |
| `app` | `notify(title, body)` | `pf:notify` |
| `app` | `logsTail()` | `pf:logs-tail` |
| `clipboard` | `writeText(text)` | `pf:clipboard-write` |
| `mcp` | `status()` | `pf:mcp-status` |
| `dialog` | `openFile(options)`, `saveFile(options)` | `pf:dialog-open`, `pf:dialog-save` |
| `project` | `pickOpen(options)`, `pickSave(options)` | `pf:project-pick-open`, `pf:project-pick-save` |
| `project` | `openRecent(path)` | `pf:project-open-recent` |
| `project` | `forgetRecent(path)` | `pf:project-forget-recent` |
| `project` | `trashRecent(path)` | `pf:project-trash-recent` |
| `project` | `rememberCurrentPath(path)` | `pf:project-remember-current` |
| `project` | `confirm(message, detail)` | `pf:confirm` |
| `project.fs` | `readFile`, `writeFile`, `rename`, `unlink`, `exists`, `mkdir`, `listDir`, `stat` | `pf:fs-read`, `pf:fs-write`, `pf:fs-rename`, `pf:fs-unlink`, `pf:fs-exists`, `pf:fs-mkdir`, `pf:fs-listdir`, `pf:fs-stat` |
| `exports` | `pickDir()` | `pf:export-pick-dir` |
| `settings` | `getAll()`, `update(patch)` | `pf:settings-get`, `pf:settings-update` |
| `settings` | `setApiKey(providerId, plaintext)` | `pf:settings-set-api-key` |
| `settings` | `hasKey(providerId)`, `removeKey(providerId)` | `pf:settings-has-key`, `pf:settings-remove-key` |
| `settings` | `credentialStatus()` | `pf:settings-credential-status` |
| `updates` | `status()`, `check()`, `install()`, `onStatus(listener)` | `pf:app-update-status`, `pf:app-update-check`, `pf:app-update-install` |

`src/types/pixelforge-bridge.d.ts` is an ambient copy of the contract for the web code.

The renderer adapts `project.fs` onto core's `FileFs` interface, so atomic writes, backups,
journals and recovery stay in `@pixelforge/core`. Main only performs raw I/O.

## File access model

The page cannot name a directory. Access is granted only by the user, through a native picker.

| Rule | Detail |
| --- | --- |
| Roots | A directory becomes accessible when a picker returns a file or folder inside it |
| Re-check on every call | Each operation resolves the path and requires it to sit inside an allowed root |
| Symlinks | Resolved before the check, so a planted link cannot escape an allowed root |
| Recent projects | Capabilities. Only paths previously chosen in a picker are accepted after a restart; at most 32 are remembered |
| Renames | A renamed project is remembered only if it stays inside an approved root |
| Deletion | Only a trusted recent project, only to the Recycle Bin, only after a confirmation shown by main |
| Limits | Paths up to 1024 characters; writes up to 256 MB |

## MCP supervision

`McpSupervisor` is a pure state machine; the platform launcher is injected.

| State | Meaning |
| --- | --- |
| `stopped` | Not running |
| `adopted` | A healthy server was already on the port; the supervisor uses it but does not own it (development only) |
| `running` | The supervisor started the child and `/health` answers |
| `failed` | Could not start, health timed out, the restart budget ran out, or an unverified process holds the port |

| Timing | Value |
| --- | --- |
| Health request timeout | 1.5 s |
| Start-up health timeout | 15 s, polled every 400 ms |
| Restart budget | 3 attempts |
| Restart backoff | 1 s, 2 s, 4 s |

- **Port.** `PF_MCP_PORT` forces it. Otherwise development uses 3030 and a packaged build uses
  3030 when free, or asks the operating system for a free loopback port.
- **Development** adopts a server already running on the port, so `bun run mcp:dev` and the
  shell can coexist.
- **Packaged** never adopts: it must own its server. It runs `resources/mcp/mcp-server.exe`
  with `PF_MCP_PORT`, `PF_MCP_DATA_DIR` (`userData/mcp-data`) and `PF_KNOWLEDGE_DIR`.
- The renderer learns the real endpoint from `window.pixelforge.mcp.status()` and refuses to
  connect otherwise, so a stray process on 3030 cannot become the control plane.

## Embedded renderer server

In a packaged build the Electron binary is restarted in Node mode (`ELECTRON_RUN_AS_NODE=1`) to
run `resources/renderer/server.js`, the Next.js standalone server. No system Node is needed.

| Setting | Value |
| --- | --- |
| Port | 3131 (`PF_RENDERER_PORT`) |
| Bind | `127.0.0.1` |
| Health check | Any 2xx from `/`, within 20 s |
| Environment | `NODE_ENV=production`, `PORT`, `HOSTNAME`, `DATABASE_URL`, `PF_MCP_PORT` |
| Database | `userData/mcp-data/webapp.db`, copied from `resources/prisma/template.db` on first run |
| Port already answering | The server is **not** started — Electron must never navigate to an unknown loopback service with the privileged preload attached |

## Settings and credentials

`userData/settings.json`, schema version 1. Loaded before the window exists; validated and
migrated field by field; written atomically (temporary file, then rename). A corrupt file is
backed up and replaced by defaults rather than failing the start.

| Section | Fields |
| --- | --- |
| `app` | Autosave delay, history limit, default clip fps and canvas size, default palette, grid and onion-skin defaults, onion opacity and tints, floating button size, UI text scale |
| `window` | Bounds and maximized state |
| `panels` | Layout of the floating panels |
| `mcp` | `agentApiEnabled`, `bridgeAutoConnect` |
| `ai`, `aiProviders`, `activeProviderId`, `brainProviderId` | Legacy. Left on disk untouched, no longer read by the editor |

**Credential vault.** API keys are encrypted with Electron `safeStorage` (DPAPI on Windows). The
ciphertext lives in the settings file. A plaintext key crosses the bridge exactly once, through
`settings.setApiKey`, and is never returned — the page only sees `hasKey` booleans and metadata.
A key that cannot be decrypted is treated as missing and scrubbed from the file. When
encryption is unavailable keys are kept in memory for the session only.

The editor no longer has provider settings, so the vault has no producer today. The bridge
methods remain.

## Software updates

`electron-updater`, inert by default.

- It activates only in a packaged build with a feed: the runtime `PF_UPDATE_PUBLISH`, or the
  `app-update.yml` written at build time.
- Without a feed, a check reports `no-feed`.
- With a feed: `checking` → `available` → `downloading` → `downloaded`. Updates download
  automatically. Installation never happens on its own: the user presses restart to install.
- A start-up check runs 10 s after launch so update traffic does not slow first paint.

States: `no-feed`, `idle`, `checking`, `available`, `not-available`, `downloading`,
`downloaded`, `error`.

## Packaging and release

### Configuration

`electron-builder.yml`:

| Setting | Value |
| --- | --- |
| Target | Windows, NSIS installer |
| Artifact | `PixelForge AI-Setup-<version>.exe` |
| Installer | Assisted (not one-click), per-user, install directory selectable |
| Output | `apps/desktop/release/` |
| Asar | `dist/`, `static/`, `package.json` |
| Code signing | Not configured |
| Update feed | `publish: null` |

### What ships

```text
resources/
├─ app.asar            the Electron main and preload code and the static shell
├─ mcp/
│   ├─ mcp-server.exe  the MCP server, compiled from current source with `bun build --compile`
│   └─ knowledge/      the knowledge guides and the palette library (no learned/ cards)
├─ renderer/           Next.js standalone build: server.js, .next, node_modules, public
└─ prisma/             schema.prisma, blank template.db, staged Prisma CLI
```

### Build pipeline

`npm run dist` in `apps/desktop` runs four steps in order:

| Step | Script | What it does |
| --- | --- | --- |
| 1 | `npm run build` | `tsc`: compiles main and preload to `dist/` |
| 2 | `npm run stage:renderer` | `next build` from the repository root, then `scripts/stage-renderer.cjs` copies the standalone output into `resources/renderer/`, excluding the development `db/` data |
| 3 | `npm run build:mcp` | `scripts/build-mcp.cjs` compiles `mini-services/mcp-server/src/index.ts` into `resources/mcp/mcp-server.exe`. Skipped only when the executable is newer than every source file |
| 4 | `node scripts/dist.cjs` | Runs electron-builder. With `PF_UPDATE_URL` or `GH_REPO` set, it also writes an update feed configuration |

Prerequisites: bun for the root and MCP dependencies, `npm ci` in `apps/desktop`, and a
`bunx prisma generate` if the Prisma client is missing.

`npm run dist:dir` produces an unpacked `win-unpacked/` directory instead of an installer, which
is faster for testing.

### Known gaps

- Builds are unsigned, so SmartScreen warns on first run.
- No update feed is configured.
- Only a Windows target exists.
- `resources/renderer/.env` (untracked, holding a local `DATABASE_URL`) is not excluded by the
  packaging configuration.

## Development versus packaged

| Behaviour | Development | Packaged |
| --- | --- | --- |
| Renderer | `http://localhost:3000` (`PF_DEV_URL`) | Embedded server on `127.0.0.1:3131` |
| MCP port | 3030 | 3030, else a free port |
| Existing MCP server on the port | Adopted | Refused; a free port is chosen instead |
| MCP data dir | `<repo>/db` | `userData/mcp-data` |
| CSP | Report-only | Enforced |
| Updates | Inert | Active with a feed |
| Splash | Shown | Shown |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Compile, then launch Electron against the dev server |
| `npm start` | Launch Electron from the existing `dist/` |
| `npm run build` / `npm run typecheck` | Compile / type-check main and preload |
| `npm test` | `bun test tests/` |
| `npm run build:mcp` | Recompile the MCP sidecar |
| `npm run stage:renderer` | Build and stage the renderer |
| `npm run dist` / `npm run dist:dir` | Installer / unpacked directory |
| `npm run smoke:dev` | Launch in smoke mode against the dev server |
| `npm run smoke:shell` | Launch in smoke mode with the diagnostic shell |

## Environment variables

| Variable | Effect |
| --- | --- |
| `PF_MCP_PORT` | Force the MCP port |
| `PF_MCP_DATA_DIR` | MCP data directory; also used by the renderer for the editor key |
| `PF_RENDERER` | `shell` loads `static/shell.html` instead of the editor |
| `PF_RENDERER_PORT` | Embedded renderer port (default 3131) |
| `PF_DEV_URL` | Dev server URL (default `http://localhost:3000`) |
| `PF_DEVTOOLS` | `1` opens DevTools in development |
| `PF_DISABLE_GPU` | `1` disables GPU acceleration (headless runs) |
| `PF_USER_DATA_OVERRIDE` | Replaces `userData` for the renderer database path |
| `PF_SMOKE` | `1` runs the smoke probes after load |
| `PF_UPDATE_PUBLISH` | Runtime update feed URL |
| `PF_UPDATE_URL`, `GH_REPO` | Build-time feed configuration for `scripts/dist.cjs` |
| `PF_VERBOSE` | `1` also mirrors log lines to the console |

## Logs

`userData/logs/main-<date>.log`, one file per day. The Help and feedback dialog can attach the
last 200 lines (up to 48 KB) of today's file to a report.

## Tests

`bun test tests/` in `apps/desktop` — three files, 37 tests.

| File | Tests | Covers |
| --- | --- | --- |
| `settings.test.ts` | 27 | Schema validation and recovery; store persistence; the credential vault with encryption available and unavailable (session-only keys); vault interactions with other settings; the legacy AI spend-control section |
| `mcp-supervisor.test.ts` | 5 | The supervision state machine: adopt, start, health timeout, restart budget |
| `palette-share.test.ts` | 5 | `PF1-…` palette share codes |
