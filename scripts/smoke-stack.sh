#!/usr/bin/env bash
# =============================================================================
# PixelForge AI — full-stack desktop smoke + MCP E2E orchestrator (Task 15a)
#
# Boots the complete product stack in an ISOLATED environment and drives the
# real Electron smoke harness against it:
#
#   dev server (temp SQLite DB) → seed "Sample: Farmer"
#     → MCP server (temp data dir, loopback :3030)
#       → xvfb Electron smokes: shell · dev canvas · file round-trip ·
#         export round-trip · MCP bridge + full MCP E2E · settings file
#
# Isolation rules (v3.1 Task 15a §8):
#   • CI mode (default) uses a throwaway SQLite DB + throwaway MCP data dir;
#     developer project files (db/custom.db, db/mcp-clients.json, …) are never
#     touched. Everything is cleaned up on exit.
#   • PF_REUSE_DEV_SERVER=1 (sandbox convenience) reuses an already-running
#     dev server on :3000 — in that mode the REAL developer DB is in play, so
#     the script first verifies that "Sample: Farmer" is the newest project
#     (the editor resumes the newest row; the MCP E2E expects exactly that).
#
# Requirements: bun, node, Xvfb (Linux), apps/desktop npm install done.
# Usage:  bash scripts/smoke-stack.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REUSE_DEV_SERVER="${PF_REUSE_DEV_SERVER:-0}"
SMOKE_TMP=""
DEV_PID=""
MCP_PID=""
XVFB_PID=""
XVFB_DISPLAY=""

cleanup() {
  if [ -n "$MCP_PID" ]; then kill "$MCP_PID" 2>/dev/null || true; fi
  if [ -n "$DEV_PID" ]; then kill "$DEV_PID" 2>/dev/null || true; fi
  if [ -n "$XVFB_PID" ]; then kill "$XVFB_PID" 2>/dev/null || true; fi
  if [ -n "$SMOKE_TMP" ] && [ -d "$SMOKE_TMP" ]; then rm -rf "$SMOKE_TMP"; fi
}
trap cleanup EXIT

fail() { echo "SMOKE-STACK-FAIL: $1" >&2; exit 1; }

# -------------------------------------------------------------- [1] preflight
echo "== [1/6] preflight =="
command -v bun >/dev/null || fail "bun not found on PATH"
command -v rg >/dev/null || fail "ripgrep (rg) not found on PATH"
command -v Xvfb >/dev/null || fail "Xvfb not found (Linux: sudo apt-get install -y xvfb)"
[ -x apps/desktop/node_modules/.bin/electron ] || fail "apps/desktop not installed (run: cd apps/desktop && npm ci)"
[ -f apps/desktop/dist/main/index.js ] || { echo "desktop dist missing — building…"; (cd apps/desktop && npm run build); }

if curl -sf -o /dev/null "http://127.0.0.1:3030/health"; then
  fail "port 3030 already has a /health responder — stop the existing MCP server (bun run mcp:dev) first"
fi

# Xvfb without xvfb-run (xvfb-run hard-depends on xauth, absent on minimal
# images). One shared display serves every smoke launch.
acquire_display() {
  local d
  for d in 99 98 97 96 95 94 93 92 91 90; do
    if [ ! -e "/tmp/.X11-unix/X$d" ]; then
      XVFB_DISPLAY=":$d"
      Xvfb "$XVFB_DISPLAY" -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
      XVFB_PID=$!
      sleep 1.5
      kill -0 "$XVFB_PID" 2>/dev/null && return 0
    fi
  done
  return 1
}
acquire_display || fail "no free X display (tried :90–:99)"
echo "   Xvfb on display $XVFB_DISPLAY (pid $XVFB_PID)"

SMOKE_TMP="$(mktemp -d /tmp/pf-smoke-stack-XXXXXX)"
mkdir -p "$SMOKE_TMP/mcp"
echo "   temp workspace: $SMOKE_TMP"

# ------------------------------------------------------- [2] dev server + seed
echo "== [2/6] renderer dev server =="
if [ "$REUSE_DEV_SERVER" = "1" ]; then
  curl -sf -o /dev/null "http://localhost:3000/api" || fail "reuse mode: no dev server answering on :3000"
  newest="$(bun -e 'const r = await fetch("http://localhost:3000/api/projects", { headers: { "X-PixelForge-Agent": "1", Origin: "http://localhost:3000" } }); const j = await r.json(); console.log(j.projects?.[0]?.name ?? "")')"
  if [ "$newest" != "Sample: Farmer" ]; then
    fail "reuse mode: newest project is \"$newest\", expected \"Sample: Farmer\" (the editor resumes the newest row; the MCP E2E depends on it)"
  fi
  echo "   reusing running dev server on :3000 (developer DB active)"
else
  # plain mode owns :3000 — a busy port would make `next dev` silently pick
  # another one while the readiness poll below answers via the EXISTING
  # server, silently running the whole smoke against the developer DB
  if curl -sf -o /dev/null --max-time 2 "http://localhost:3000/api"; then
    fail "port 3000 already serves the editor — stop the dev server, or run with REUSE_DEV_SERVER=1 (developer DB active)"
  fi
  export DATABASE_URL="file:$SMOKE_TMP/ci.db"
  bunx prisma db push --accept-data-loss --skip-generate >/dev/null 2>&1 || fail "prisma db push failed"
  bunx next dev -p 3000 >"$SMOKE_TMP/dev-server.log" 2>&1 &
  DEV_PID=$!
  ready=0
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "http://localhost:3000/api"; then ready=1; break; fi
    kill -0 "$DEV_PID" 2>/dev/null || { tail -40 "$SMOKE_TMP/dev-server.log" >&2; fail "dev server exited early"; }
    sleep 1
  done
  [ "$ready" = "1" ] || { tail -40 "$SMOKE_TMP/dev-server.log" >&2; fail "dev server not ready after 120 s"; }
  echo "   dev server ready (pid $DEV_PID, temp DB: $SMOKE_TMP/ci.db)"
  echo "== [3/6] seed sample project =="
  bun scripts/seed-sample.ts || fail "seed-sample failed"
fi

# ----------------------------------------------------------- [4] MCP server
echo "== [4/6] MCP server (loopback :3030, isolated data dir) =="
pushd mini-services/mcp-server >/dev/null
PF_MCP_PORT=3030 PF_MCP_DATA_DIR="$SMOKE_TMP/mcp" bun src/index.ts >"$SMOKE_TMP/mcp-server.log" 2>&1 &
MCP_PID=$!
popd >/dev/null
ready=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:3030/health"; then ready=1; break; fi
  kill -0 "$MCP_PID" 2>/dev/null || { tail -40 "$SMOKE_TMP/mcp-server.log" >&2; fail "MCP server exited early"; }
  sleep 1
done
[ "$ready" = "1" ] || { tail -40 "$SMOKE_TMP/mcp-server.log" >&2; fail "MCP server not ready after 30 s"; }
echo "   MCP server ready (pid $MCP_PID, data dir: $SMOKE_TMP/mcp)"

# --------------------------------------------------------- [5] Electron smokes
# Each launch is a fresh Electron process under its own Xvfb display; the
# harness exits 0/1 and prints [SMOKE:OK]/[SMOKE:FAIL]. --no-sandbox is
# required in CI containers; harmless locally.
electron_smoke() {
  local label="$1"; shift
  echo "--- smoke: $label ---"
  local log="$SMOKE_TMP/smoke-$label.log"
  # authoritative result = electron's exit code (harness app.exit(0|1)); the
  # [SMOKE:OK] line is evidence, not the verdict
  if (cd apps/desktop && timeout 300 env "$@" PF_SMOKE=1 DISPLAY="$XVFB_DISPLAY" ./node_modules/.bin/electron --no-sandbox .) >"$log" 2>&1; then
    rg -o '\[SMOKE:OK\].*' "$log" | tail -1 || echo "   $label: exit 0"
  else
    echo "[SMOKE:FAIL] $label — last 40 log lines:" >&2
    tail -40 "$log" >&2
    return 1
  fi
}

echo "== [5/6] Electron smokes (xvfb) =="
electron_smoke shell   PF_RENDERER=shell
electron_smoke dev
electron_smoke file    PF_SMOKE_FILE=1
electron_smoke export  PF_SMOKE_EXPORT=1
electron_smoke mcp     PF_SMOKE_MCP=1 PF_SMOKE_MCP_E2E=1
electron_smoke settings PF_SMOKE_SETTINGS=1

# --------------------------------------------------------------- [6] summary
echo "== [6/6] smoke stack summary =="
echo "SMOKE-STACK-OK: shell · dev · file · export · mcp(+E2E) · settings all passed"
