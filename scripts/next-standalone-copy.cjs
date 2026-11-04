// PixelForge AI — post-`next build` standalone assembly (cross-platform).
// Copies the client assets + public files into .next/standalone so the
// standalone server.js can serve the full app. Replaces the unix-only
// `cp -r` pipeline that broke on Windows.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATIC_FROM = path.join(ROOT, '.next', 'static');
const STATIC_TO = path.join(ROOT, '.next', 'standalone', '.next', 'static');
const PUBLIC_FROM = path.join(ROOT, 'public');
const PUBLIC_TO = path.join(ROOT, '.next', 'standalone', 'public');

function main() {
  // Prisma leaves *.tmpNNNN copies of its query engine DLL in the traced
  // output on Windows — 21 MB EACH. Remove them or the installer bloats 80+.
  const pdir = path.join(ROOT, '.next', 'standalone', 'node_modules', '.prisma', 'client');
  if (fs.existsSync(pdir)) {
    for (const f of fs.readdirSync(pdir)) {
      if (/\.tmp\d+$/.test(f)) fs.rmSync(path.join(pdir, f), { force: true });
    }
  }

  if (!fs.existsSync(path.join(ROOT, '.next', 'standalone'))) {
    throw new Error('missing .next/standalone — run `next build` first');
  }
  fs.cpSync(STATIC_FROM, STATIC_TO, { recursive: true });
  fs.cpSync(PUBLIC_FROM, PUBLIC_TO, { recursive: true });
  const serverJs = fs.existsSync(path.join(ROOT, '.next', 'standalone', 'server.js'));
  const serverDir = fs.existsSync(path.join(ROOT, '.next', 'standalone', '.next', 'server'));
  console.log(
    `standalone copy OK — server.js: ${serverJs}, .next/server: ${serverDir}, static+public copied`,
  );
  if (!serverJs || !serverDir) process.exit(1);
}

main();
