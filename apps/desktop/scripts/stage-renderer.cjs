// Stage the freshly built Next standalone output into electron-builder's
// extraResources directory. Packaging must never reuse an older editor bundle.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const source = path.join(root, '.next', 'standalone');
const destination = path.join(root, 'apps', 'desktop', 'resources', 'renderer');
const staging = path.join(root, 'apps', 'desktop', 'resources', `.renderer-staging-${process.pid}`);

if (!fs.existsSync(path.join(source, 'server.js'))) {
  throw new Error('Missing .next/standalone/server.js. Build the web renderer before staging it.');
}

// Copy first; replace only after a complete standalone bundle exists.
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(source, staging, { recursive: true, force: true });
if (!fs.existsSync(path.join(staging, 'server.js'))) {
  throw new Error('Renderer staging is incomplete (server.js missing).');
}
fs.rmSync(destination, { recursive: true, force: true });
fs.renameSync(staging, destination);
console.log(`[stage-renderer] staged ${source} -> ${destination}`);
