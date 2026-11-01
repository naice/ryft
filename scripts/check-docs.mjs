import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCREENSHOTS = 'docs/screenshots/';
const README = 'README.md';
const NO_COMMIT = /^0+$/;

/** Changes here can alter what users see or can do, so the README and screenshots must follow them. */
export function isUserFacing(file) {
  return file.startsWith('src/') || file.startsWith('resources/') || file === 'package.json';
}

/**
 * `commits` is newest first. Docs only count when committed at or after the newest user-facing change,
 * otherwise they describe an older state of the app.
 */
export function findStaleDocs(commits) {
  const newest = commits.findIndex((commit) => commit.files.some(isUserFacing));
  if (newest === -1) return [];
  const upToDate = commits.slice(0, newest + 1).flatMap((commit) => commit.files);
  const stale = [];
  if (!upToDate.includes(README)) stale.push('readme');
  if (!upToDate.some((file) => file.startsWith(SCREENSHOTS))) stale.push('screenshots');
  return stale;
}

/** Local images only. Links and badges have no file to check. */
export function findReadmeProblems(readme, images) {
  const referenced = [...readme.matchAll(/(?:!\[[^\]]*\]\(|src=")([^)"\s]+)/g)]
    .map((match) => match[1])
    .filter((target) => !/^https?:/.test(target));
  const problems = referenced
    .filter((target) => !images.includes(target) && !existsSync(target))
    .map((target) => `README verweist auf eine fehlende Datei: ${target}`);
  if (!referenced.some((target) => target.startsWith(SCREENSHOTS))) {
    problems.push('README zeigt keinen Screenshot.');
  }
  return problems;
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

function commitsToPush(localSha, remoteSha) {
  const range = NO_COMMIT.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
  const log = git('log', '--format=%x01%H', '--name-only', ...range);
  return log
    .split('\x01')
    .filter(Boolean)
    .map((entry) => ({ files: entry.split('\n').slice(1).filter(Boolean) }));
}

function regenerateScreenshots() {
  console.log('Screenshots werden neu erzeugt ...');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync('npm run screenshots', { stdio: 'inherit', env, shell: true });
  return result.status === 0;
}

function checkReadme() {
  const problems = findReadmeProblems(
    readFileSync(README, 'utf8'),
    readdirSync(SCREENSHOTS).map((file) => SCREENSHOTS + file)
  );
  for (const problem of problems) console.error(problem);
  return problems.length === 0;
}

function prePush() {
  const stale = new Set();
  // Git passes one "<local ref> <local sha> <remote ref> <remote sha>" line per pushed ref.
  for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(' ');
    if (NO_COMMIT.test(localSha)) continue; // Deleting a remote branch pushes nothing.
    for (const item of findStaleDocs(commitsToPush(localSha, remoteSha))) stale.add(item);
  }
  if (!checkReadme()) return 1;
  if (stale.size === 0) return 0;

  const messages = [];
  if (stale.has('screenshots')) {
    // A change that leaves the UI as it was produces identical images, and those cannot be committed.
    if (!regenerateScreenshots()) messages.push('- Screenshots konnten nicht erzeugt werden, die Ausgabe steht oben.');
    else if (git('status', '--porcelain', '--', SCREENSHOTS)) {
      messages.push('- Screenshots wurden neu erzeugt. Bitte prüfen und committen.');
    }
  }
  if (stale.has('readme')) messages.push('- README.md: Funktionen und Screenshots beschreiben und committen.');
  if (messages.length === 0) return 0;

  console.error('\nPush angehalten: Die Dokumentation passt nicht zu den Änderungen an der App.');
  for (const message of messages) console.error(message);
  console.error('Danach erneut pushen.\n');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv.includes('--pre-push') ? prePush() : checkReadme() ? 0 : 1;
}
