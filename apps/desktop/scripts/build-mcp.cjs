// PixelForge AI — compile the MCP mini-service into the bundled sidecar exe.
//
// The installer bundles resources/mcp/mcp-server.exe via extraResources, but
// NOTHING in the old packaging chain rebuilt it — a stale exe from a previous
// session shipped silently (it predates the MCP SDK v2 migration). This step
// compiles the CURRENT source every time so every installer matches the
// source it was built from:
//   bun build --compile --target=bun-windows-x64
//     mini-services/mcp-server/src/index.ts → resources/mcp/mcp-server.exe
//
// Chained into `npm run dist` / `npm run dist:dir` before electron-builder.
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, statSync } = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(desktopDir, '..', '..');
const entry = path.join(repoDir, 'mini-services', 'mcp-server', 'src', 'index.ts');
const isWin = process.platform === 'win32';
const binaryName = isWin ? 'mcp-server.exe' : 'mcp-server';
const outFile = path.join(desktopDir, 'resources', 'mcp', binaryName);
const bunTarget = isWin
  ? 'bun-windows-x64'
  : process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'bun-darwin-arm64'
      : 'bun-darwin-x64'
    : 'bun-linux-x64';

function newestSourceMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of require('node:fs').readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'learned') continue;
        walk(p);
      } else if (/\.(ts|js|json)$/.test(entry.name)) {
        newest = Math.max(newest, statSync(p).mtimeMs);
      }
    }
  };
  walk(dir);
  return newest;
}

if (!existsSync(entry)) {
  console.error(`[build-mcp] MCP entry not found: ${entry}`);
  process.exit(1);
}

// Staleness guard: skip only when the exe is newer than every source file
// (fast repeated dist runs); a missing or stale exe always recompiles.
let stale = true;
if (existsSync(outFile)) {
  const srcNewest = newestSourceMtime(path.join(repoDir, 'mini-services', 'mcp-server', 'src'));
  stale = statSync(outFile).mtimeMs < srcNewest;
  if (!stale) console.log(`[build-mcp] ${binaryName} already up to date — skipping compile`);
}
if (!stale) process.exit(0);

mkdirSync(path.dirname(outFile), { recursive: true });
console.log(`[build-mcp] compiling ${binaryName} (${bunTarget}) from current source...`);
const res = spawnSync('bun', ['build', '--compile', `--target=${bunTarget}`, entry, '--outfile', outFile], {
  cwd: desktopDir,
  stdio: 'inherit',
});
if (res.status !== 0 || !existsSync(outFile)) {
  console.error('[build-mcp] FAILED — refusing to package a stale or missing MCP sidecar');
  process.exit(res.status ?? 1);
}
console.log(`[build-mcp] compiled resources/mcp/${binaryName}`);
