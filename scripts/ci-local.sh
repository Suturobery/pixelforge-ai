#!/usr/bin/env bash
# =============================================================================
# PixelForge AI — run the complete CI pipeline locally (Task 15a)
#
# Mirrors .github/workflows/ci.yml minus the (slow) production builds:
#   1. ESLint
#   2. TypeScript gates: core · core-tests · desktop · mcp
#   3. Core unit + golden-image suite      (packages/core)
#   4. Desktop settings/security + AI job/adapter suites (apps/desktop/tests)
#   5. MCP protocol contract suite         (mini-services/mcp-server)
#
# Flags:
#   --smoke     additionally run scripts/smoke-stack.sh (xvfb full-stack
#               Electron smokes + live MCP E2E) after the pure checks
#   --fast      stop on first failure even in summary mode (default: run
#               everything, then report — matches CI's parallel jobs)
#
# Usage:  bash scripts/ci-local.sh [--smoke] [--fast]
#         bun run ci:local
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WITH_SMOKE=0
FAST=0
for arg in "$@"; do
  case "$arg" in
    --smoke) WITH_SMOKE=1 ;;
    --fast) FAST=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

results=()
failed=0

run_check() {
  local name="$1"; shift
  echo ""
  echo "════════ $name ════════"
  if "$@"; then
    results+=("PASS  $name")
  else
    rc=$?
    results+=("FAIL  $name  (exit $rc)")
    failed=$((failed + 1))
    [ "$FAST" = "1" ] && { echo "stopping (--fast)"; return 1; }
  fi
  return 0
}

echo "PixelForge AI — local CI ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
echo "repo: $REPO_ROOT"

# 1 ── lint + type gates -----------------------------------------------------
run_check "eslint"                    bun run lint
run_check "typecheck: core"           bun run core:typecheck
run_check "typecheck: core-tests"     bun run core:test:typecheck
run_check "typecheck: desktop"        bun run desktop:typecheck
run_check "typecheck: mcp-server"     bun run mcp:typecheck

# 2 ── unit / contract suites ------------------------------------------------
run_check "tests: core (incl. export goldens)"  bash -c 'cd packages/core && bun test'
run_check "tests: desktop settings+AI suites"     bash -c 'cd apps/desktop && bun test tests/'
run_check "tests: mcp contract"                 bash -c 'cd mini-services/mcp-server && bun test'

# 3 ── optional full-stack smokes --------------------------------------------
if [ "$WITH_SMOKE" = "1" ]; then
  if bash scripts/smoke-stack.sh; then
    results+=("PASS  smokes: full stack + MCP E2E")
  else
    results+=("FAIL  smokes: full stack + MCP E2E")
    failed=$((failed + 1))
  fi
fi

# 4 ── summary ----------------------------------------------------------------
echo ""
echo "════════ summary ════════"
for line in "${results[@]}"; do echo "$line"; done
echo ""
if [ "$failed" -gt 0 ]; then
  echo "LOCAL-CI-FAIL: $failed check(s) failed"
  exit 1
fi
echo "LOCAL-CI-OK: all checks passed"
