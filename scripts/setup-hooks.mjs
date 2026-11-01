import { spawnSync } from 'node:child_process';

// Runs from "npm install". Outside a git checkout there is nothing to configure.
const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
if (result.status !== 0) console.log('Git-Hooks nicht eingerichtet: kein Git-Repository gefunden.');
