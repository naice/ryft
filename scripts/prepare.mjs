import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

// Runs from "npm install". Outside a git checkout there is nothing to configure.
const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
if (result.status !== 0) console.log('Git-Hooks nicht eingerichtet: kein Git-Repository gefunden.');

// node-pty 1.1.0 ships this helper without the execute bit, so every shell fails with "posix_spawnp failed".
if (process.platform === 'darwin') {
  chmodSync(`node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`, 0o755);
}
