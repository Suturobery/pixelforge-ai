// PixelForge AI — auto-resolve the prisma CLI dependency closure for the
// staged resources/prisma bundle: run `db push` against a throwaway db,
// read the missing-module error, copy that module from the workspace
// node_modules, repeat until it runs clean (or a non-module failure).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const UNPACKED = path.join(ROOT, 'apps', 'desktop', 'out3', 'win-unpacked');
const NM = path.join(UNPACKED, 'resources', 'prisma', 'vendor', 'prisma', 'node_modules');
const EXE = path.join(UNPACKED, 'PixelForge AI.exe');

function stage() {
  // refresh everything EXCEPT vendor/prisma/node_modules — that dir holds
  // the accumulated dependency closure from earlier rounds
  const nmBackup = path.join(UNPACKED, 'resources', 'prisma', 'vendor', 'prisma', 'node_modules');
  let saved = null;
  if (fs.existsSync(nmBackup)) {
    saved = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pf-nm-'));
    fs.cpSync(nmBackup, saved, { recursive: true });
  }
  fs.rmSync(path.join(UNPACKED, 'resources', 'prisma'), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'apps', 'desktop', 'resources', 'prisma'), path.join(UNPACKED, 'resources', 'prisma'), { recursive: true });
  if (saved) {
    fs.cpSync(saved, nmBackup, { recursive: true });
    fs.rmSync(saved, { recursive: true, force: true });
  }
}

function tryRun() {
  const dbUrl = 'file:' + path.resolve(UNPACKED, 'test.db').split(path.sep).join('/');
  try {
    execFileSync(EXE, ['resources/prisma/prisma-cli.cjs', 'db', 'push', '--skip-generate', '--schema', 'resources/prisma/schema.prisma'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DATABASE_URL: dbUrl },
      cwd: UNPACKED,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 'ok';
  } catch (e) {
    const out = String(e.stderr ?? '') + String(e.stdout ?? '');
    const m = out.match(/Cannot find module '([^']+)'/);
    if (!m) return 'other: ' + out.slice(0, 250);
    // 'pkg/subpath' errors mean the package itself is missing — keep only
    // the package specifier (1 or 2 leading path segments)
    const parts = m[1].split('/');
    const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    return { missing: pkg };
  }
}

function main() {
  for (let round = 1; round <= 60; round++) {
    stage();
    const r = tryRun();
    if (r === 'ok') {
      console.log(`SUCCESS after ${round} round(s) — prisma CLI closure complete`);
      return;
    }
    if (typeof r === 'string') {
      console.log('NON-MODULE FAILURE:', r);
      process.exit(1);
    }
    const src = path.join(ROOT, 'node_modules', ...r.missing.split('/'));
    if (!fs.existsSync(src)) {
      console.log(`module not present in workspace node_modules: ${r.missing}`);
      process.exit(1);
    }
    const dest = path.join(NM, r.missing);
    if (fs.existsSync(dest)) {
      console.log(`already staged but still failing: ${r.missing}`);
      process.exit(1);
    }
    fs.cpSync(src, dest, { recursive: true });
    console.log(`round ${round} → +${r.missing}`);
  }
  console.log('round cap reached');
  process.exit(1);
}

main();
