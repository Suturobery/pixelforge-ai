// Stage the freshly built Next standalone output into electron-builder's
// extraResources directory. Packaging must never reuse an older editor bundle.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const source = path.join(root, '.next', 'standalone');
const staticSource = path.join(root, '.next', 'static');
const publicSource = path.join(root, 'public');
const destination = path.join(root, 'apps', 'desktop', 'resources', 'renderer');
const staging = path.join(root, 'apps', 'desktop', 'resources', `.renderer-staging-${process.pid}`);

if (!fs.existsSync(path.join(source, 'server.js'))) {
  throw new Error('Missing .next/standalone/server.js. Build the web renderer before staging it.');
}
if (!fs.existsSync(staticSource)) {
  throw new Error('Missing .next/static. Build the web renderer before staging it.');
}

// Never copy nested apps/ release artifacts if Next file tracing touched them.
fs.rmSync(path.join(source, 'apps'), { recursive: true, force: true });

// Sweep any stale .renderer-staging-* directories left by interrupted runs.
const resourcesDir = path.join(root, 'apps', 'desktop', 'resources');
for (const entry of fs.readdirSync(resourcesDir)) {
  if (entry.startsWith('.renderer-staging-')) {
    fs.rmSync(path.join(resourcesDir, entry), { recursive: true, force: true });
  }
}

// Copy first; replace only after a complete standalone bundle exists.
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(source, staging, { recursive: true, force: true });
// The traced standalone bundle carries the DEV machine's runtime data (db/ —
// editor-auth token, custom.db, MCP client registrations). The packaged
// server points DATABASE_URL at userData, so none of it is used at runtime;
// shipping it would leak developer data into every installer.
fs.rmSync(path.join(staging, 'db'), { recursive: true, force: true });
// Next's standalone output deliberately excludes public/ and .next/static.
// They contain the client chunks that hydrate the server-rendered editor.
fs.cpSync(staticSource, path.join(staging, '.next', 'static'), { recursive: true, force: true });
if (fs.existsSync(publicSource)) {
  fs.cpSync(publicSource, path.join(staging, 'public'), { recursive: true, force: true });
}
if (!fs.existsSync(path.join(staging, 'server.js'))) {
  throw new Error('Renderer staging is incomplete (server.js missing).');
}
if (!fs.existsSync(path.join(staging, '.next', 'static'))) {
  throw new Error('Renderer staging is incomplete (.next/static missing).');
}
fs.rmSync(destination, { recursive: true, force: true });
try {
  fs.renameSync(staging, destination);
} catch {
  // Windows file-indexer / AV locks can block directory rename with EPERM;
  // copy into destination and clean up the staging folder.
  fs.cpSync(staging, destination, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
}
console.log(`[stage-renderer] staged ${source} -> ${destination}`);
