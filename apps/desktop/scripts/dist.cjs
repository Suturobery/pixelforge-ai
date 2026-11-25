// PixelForge AI — dist wrapper: injects the update feed (when configured)
// into electron-builder, so a plain `npm run dist` stays feed-less and a
// release build is one env var away:
//   PF_UPDATE_URL=https://your-host/updates npm run dist
// (or set GH_REPO=owner/name for a GitHub Releases feed)
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const generic = process.env.PF_UPDATE_URL;
const ghRepo = process.env.GH_REPO;

const platformFlag =
  process.env.PF_DIST_TARGET ||
  (process.platform === 'darwin' ? '--mac' : process.platform === 'linux' ? '--linux' : '--win');

const args = [platformFlag, '--config', 'electron-builder.yml', '--publish', 'never'];
if (generic) {
  args.push('-c.publish.provider=generic', `-c.publish.url=${generic}`);
  console.log(`[dist] update feed (generic): ${generic}`);
} else if (ghRepo) {
  args.push('-c.publish.provider=github', `-c.publish.repo=${ghRepo.split('/')[1]}`, `-c.publish.owner=${ghRepo.split('/')[0]}`);
  console.log(`[dist] update feed (github): ${ghRepo}`);
} else {
  console.log('[dist] no PF_UPDATE_URL/GH_REPO — installer built without update feed');
}

// Resolve the declared local dependency. Never use npx here: a release build
// must not silently download a different builder version, and shell mode
// turns environment-supplied publish URLs into command-line injection.
const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const res = spawnSync(process.execPath, [builderCli, ...args], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
