# PixelForge AI — Development & Testing Guide

> **Status (2026-11-25): partly stale.** The install, run, test and CI commands are current, but
> this guide predates the removal of in-app AI generation. Ignore everything about Task 9 AI
> suites, provider adapters, the AI job manager, candidate tools (`get_candidates`,
> `accept_candidate`, `apply_normalize`), `PF_SMOKE_AI` / `PF_AI_MOCK`, and the "expected
> baseline counts". Current test counts: core 28 files, desktop 37 tests in 3 files, MCP 3 files.
> For the packaging and release pipeline, which this guide does not cover, see
> [Desktop app](desktop-app.md#packaging-and-release). For the product as it is now, start at
> [the documentation index](README.md).

Contributor guide for building, running, and testing PixelForge AI (web + Electron
desktop). All commands are run from the repository root unless noted. CI is defined
in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

---

## 1. Prerequisites

| Tool     | Version   | Used for                                        |
| -------- | --------- | ----------------------------------------------- |
| Bun      | 1.3.x (CI pins 1.3.14) | root + MCP service deps, test runner, scripts |
| Node.js  | 20/22 LTS (CI pins 22) | Electron toolchain (`npm ci` in `apps/desktop`) |
| Xvfb     | any       | headless Electron smoke tests on Linux          |

Dependency installation (three separate trees, each with a frozen lockfile):

```bash
bun install                          # root: renderer, core, scripts  (bun.lock)
cd mini-services/mcp-server && bun install --frozen-lockfile   # (bun.lock)
cd apps/desktop && npm ci                                      # (package-lock.json)
```

`prisma generate` runs automatically as needed; if the Prisma client is missing:
`bunx prisma generate`.

## 2. Running the application

**Web studio** (Next.js dev server, port 3000):

```bash
bun run dev          # http://localhost:3000
```

**Desktop app** (Electron shell loading the dev server):

```bash
bun run dev          # terminal 1 — renderer on :3000
bun run desktop:dev  # terminal 2 — compiles main+preload, launches Electron
```

**MCP server** (loopback :3030, used by both web and desktop):

```bash
bun run mcp:dev      # mini-services/mcp-server, 127.0.0.1:3030
```

Pair an MCP client in the app: **Settings → MCP → Connect AI Assistant**.

## 3. Test suites

| Suite | Command | What it covers |
| ----- | ------- | -------------- |
| Core unit + golden | `bun run core:test` | project/clip models, CommandBus, undo/redo, tile-diff history, pixel tools, linked cels, playback clock, serialization, save/recovery, v1 import migration, export accuracy — **incl. 25 export golden-image tests**; plus the Task 9 AI suites: **23 normalize-v2 golden tests** (per-stage + full pipeline + A/B vs NN) and **20 generation-contract tests** (provider capabilities, prompt engineering, request planning/parsing, ESTIMATE pricing, cache keys) |
| Core typecheck | `bun run core:typecheck` + `bun run core:test:typecheck` | strict TS for `packages/core/src` and tests |
| Desktop security/settings | `cd apps/desktop && bun test tests/` | settings schema validation/migration (incl. the Task 9 `ai` spend-control section), atomic writes, corrupt-file recovery, credential encrypt/decrypt round-trip (test-double SecretBox), no-plaintext-on-disk grep gate, IPC secret-scan, session-only fallback — plus the Task 9 suites: **AI job manager** (queue, 1-per-provider concurrency, cancel queued/running, 120 s deadline, transient retry, result cache incl. `$0` hits inside spend caps, monthly hard stop + warning, usage records) and **provider adapters** (OpenAI-compatible b64/url parsing, https-only downloads, capability refusals, Z.AI SDK-absence degradation, deterministic offline mock) |
| Desktop typecheck/build | `bun run desktop:typecheck` / `bun run desktop:build` | Electron main + preload compile |
| MCP contract | `bun run mcp:test` | real SDK client ⇄ in-process server over the wire: transport security (401/403/413, loopback bind), pairing lifecycle, single-use codes, L0/L1 tiers, revocation, rate limits, brute-force throttle, audit log, session hygiene, restart persistence, pairing-token entropy — plus the Task 9 candidate tools (`get_candidates` L0; `accept_candidate` / `reject_candidate` / `apply_normalize` L1) and the proof that `generate_sprite` stays UNREGISTERED until the Task 11 approval center |
| MCP typecheck | `bun run mcp:typecheck` | strict TS for the MCP service |
| Renderer build | `bun run build` | `next build` production compile + standalone output |
| Lint | `bun run lint` | ESLint (flat config) over the whole repo |
| Electron smokes | see §5 | startup, preload bridge, canvas, file round-trip, export round-trip, MCP bridge + live E2E, credential vault, **AI pipeline (PF_SMOKE_AI+PF_AI_MOCK): renderer → bridge v5 → main job manager → deterministic mock adapter → candidate store → normalize v2 → CommandBus import → undo, with a no-key-material view check** |

Expected baseline counts: **core 265 · desktop 46 · MCP contract 24 · MCP live E2E 19**.

## 4. Running the complete CI pipeline locally

```bash
bun run ci:local          # lint + typechecks + all three unit/contract suites
bun run ci:local --smoke  # additionally: full-stack Electron smokes + live MCP E2E (needs Xvfb)
bun run ci:local --fast   # stop at the first failing check
```

`ci:local.sh` mirrors the CI jobs' checks (it does not run `next build`; that step
is verified in CI's `renderer-build` job, or locally via `bun run build` when no
dev server is using `.next`).

## 5. Electron smoke tests (full stack)

`scripts/smoke-stack.sh` boots the entire product stack in isolation and drives the
real desktop harness through it:

```bash
bun run ci:smoke                    # CI mode: own temp SQLite DB + temp MCP data dir
PF_REUSE_DEV_SERVER=1 bun run ci:smoke   # reuse an already-running dev server on :3000
```

It verifies: Electron startup + preload bridge (`shell`), editor canvas mount
(`dev`), native save/reopen + corrupt-file rejection + autosave recovery (`file`),
export byte round-trip + conflict preflight (`export`), MCP editor bridge + **the
full live MCP E2E** (`mcp`, 19 checks), the credential vault end-to-end
(`settings`, including the plaintext-on-disk grep gate), and the **AI generation
pipeline** (`ai`, run with `PF_AI_MOCK=1` — a deterministic offline adapter, so
CI never spends money or touches a real provider). Every smoke's exit code
is authoritative; `[SMOKE:OK]` lines are evidence.

Isolation rules: CI mode writes only to a `mktemp -d` workspace (throwaway SQLite
DB via `DATABASE_URL`, throwaway MCP data dir via `PF_MCP_DATA_DIR`); developer
files (`db/custom.db`, `db/mcp-clients.json`) are never touched. Everything is
stopped and removed on exit.

**Credential restart-persistence** (`PF_SMOKE_KEY_SEED`/`PF_SMOKE_KEY_VERIFY`) is
deliberately not part of CI: headless Linux has no OS keyring, so `safeStorage`
takes the session-only path. Real DPAPI (Windows) / Keychain (macOS) persistence
is verified by the mechanism tests plus manual desktop QA — never claimed from CI.

## 6. Golden-image fixtures (export + normalize regression)

The export goldens live in `packages/core/tests/export-golden.test.ts`; the
normalize-v2 goldens (Task 9) in `packages/core/tests/ai-normalize-golden.test.ts`.
The fixtures
are **deterministic in-code literals** (tiny 8×8 canvases, explicit ids, no clock,
no `uid()`) — the "golden files" are the reviewed expected pixel/metadata values
committed in the test source itself. Tests compare **decoded PNG pixels** (via the
core `decodePng`), never raw PNG bytes, so zlib output differences across runtimes
cannot cause false failures.

Update policy:

- **Never regenerate goldens automatically after a failure.** A failing golden
  test means output changed — investigate first.
- Intentional format/engine changes require editing the literal expectations in a
  dedicated commit, with the reason recorded in the worklog and the task report.
- Determinism guard: an identical request must produce byte-identical artifacts
  (covered by the "determinism" test in the same file).

## 7. MCP E2E (live)

`mini-services/mcp-server/e2e-client.mjs` drives the real editor over real MCP:

```bash
bun mini-services/mcp-server/e2e-client.mjs "<6-word pairing code>"
# or: PF_E2E_PAIRING_CODE="<code>" bun mini-services/mcp-server/e2e-client.mjs
```

Requires: dev server on :3000, MCP server on :3030, the editor page open with
**Sample: Farmer** as the active document (the page auto-resumes the newest
project). It pairs (single-use code), executes the §9 workflow — inspect →
palette → clip → duplicate frame → paint → pixel-verify composited PNG → undo →
restore-verify → structured errors → notifications → fake-token rejection — and
exits 0 only when every check passes. In the automated smoke this is driven
programmatically through the bridge ctrl plane (`PF_SMOKE_MCP_E2E=1`).

## 8. Diagnosing common failures

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| `bun test` reports `Cannot find module 'bun:test'` | wrong cwd — run inside `packages/core`, `apps/desktop`, or `mini-services/mcp-server` |
| Desktop typecheck fails on `electron` types | `apps/desktop` not installed — `cd apps/desktop && npm ci` |
| MCP tests fail to bind | test port collision is prevented by a pid-hashed port; if you spawned a server with `PF_MCP_PORT` pinned to 3030, stop it — the contract tests pick their own port |
| Smoke: `port 3030 already has a /health responder` | your dev MCP service (`bun run mcp:dev`) is running — stop it before `ci:smoke` |
| Smoke: `xvfb-run: xauth command not found` | the stack script no longer uses xvfb-run; ensure the `xvfb` package (Xvfb binary) is installed |
| Smoke: dev canvas never appears | dev server on :3000 is down or still compiling — check `dev.log`; the smoke polls for 20 s |
| E2E check 3 fails (`get_project_state` name mismatch) | the active document is not `Sample: Farmer` — seed it (`bun scripts/seed-sample.ts`) or make it the newest project |
| `403 MISSING_AGENT_HEADER` on project APIs | expected — state-changing (and read) project routes require `X-PixelForge-Agent: 1`; use the app UI or add the header |
| Tests fail with `SQLITE_CANTOPEN` | `DATABASE_URL` points somewhere unwritable; tests that need a DB create their own temp file |

## 9. CI workflow layout

Five parallel jobs (`.github/workflows/ci.yml`), all gated on non-zero exits:

1. **static** — ESLint + the four TypeScript gates
2. **core-tests** — core suite (includes goldens)
3. **mcp-tests** — MCP contract suite (self-isolating port + data dir)
4. **renderer-build** — `prisma generate` + `next build` (standalone)
5. **desktop-smoke** — desktop unit suite + Electron compile + Xvfb full-stack
   smokes + live MCP E2E; uploads smoke evidence as artifacts

Toolchain: Bun 1.3.14 (pinned), Node 22, frozen lockfiles everywhere, dependency
caches keyed on lockfile hashes. No paid AI calls, no secrets required.
