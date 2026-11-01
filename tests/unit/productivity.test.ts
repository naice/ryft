import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuzzyScore, isCommandRecordable, rankSuggestions } from '../../src/shared/features/commandHistory';
import { buildInstallCommand, isValidPublicKeyLine } from '../../src/shared/features/keys';
import { expandSnippet, placeholdersOf, SnippetExpansionError } from '../../src/shared/features/snippets';
import { matchWorkspaceHost } from '../../src/shared/features/workspaces';
import { workspaceDefinitionSchema, workspaceExportSchema, type WorkspaceLayout } from '../../src/shared/contracts';

describe('snippet substitution', () => {
  const template = 'docker logs --tail {{lines}} {{container}}';

  it('finds parameters, and leaves a Docker format string alone', () => {
    expect(placeholdersOf(`${template} --format '{{.Names}}'`).map((item) => item.name)).toEqual(['lines', 'container']);
    expect(placeholdersOf('echo {{a:1}} {{a}}')).toEqual([{ name: 'a', inlineDefault: '1' }]);
  });

  it('keeps simple values as they are', () => {
    expect(expandSnippet(template, { lines: '100', container: 'web-1' }, 'posix').command).toBe('docker logs --tail 100 web-1');
  });

  it('applies declared defaults before inline ones, and fails on a missing value', () => {
    const params = [{ name: 'lines', defaultValue: '50', description: '' }];
    expect(expandSnippet('tail -n {{lines:10}} f', {}, 'posix', params).command).toBe('tail -n 50 f');
    expect(expandSnippet('tail -n {{lines:10}} f', {}, 'posix').command).toBe('tail -n 10 f');
    expect(() => expandSnippet(template, { lines: '1' }, 'posix')).toThrow(SnippetExpansionError);
  });

  it.each([
    ['; rm -rf /', `echo '; rm -rf /'`],
    ['$(id)', `echo '$(id)'`],
    ['`id`', "echo '`id`'"],
    ['a b', `echo 'a b'`],
    [`it's`, `echo 'it'\\''s'`],
    ['a|b>c', `echo 'a|b>c'`]
  ])('neutralizes %s for POSIX shells', (value, expected) => {
    expect(expandSnippet('echo {{v}}', { v: value }, 'posix').command).toBe(expected);
  });

  it('respects the quotes the template already has', () => {
    expect(expandSnippet('echo "{{v}}"', { v: 'a$(id)"b' }, 'posix').command).toBe('echo "a\\$(id)\\"b"');
    expect(expandSnippet("echo '{{v}}'", { v: "a'b" }, 'posix').command).toBe(`echo 'a'\\''b'`);
    expect(expandSnippet('echo "{{v}}"', { v: 'a$b`c"' }, 'powershell').command).toBe('echo "a`$b``c`""');
    expect(expandSnippet("echo '{{v}}'", { v: "a'b" }, 'powershell').command).toBe("echo 'a''b'");
  });

  it('runs a hostile value through a real POSIX shell as one plain argument', () => {
    const hostile = `a'; touch /tmp/ryft-pwn; echo "$(id)" \`id\` | > *`;
    const { command } = expandSnippet('printf %s {{v}}', { v: hostile }, 'posix');
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
    expect(execFileSync(bash, ['-c', command], { encoding: 'utf8' })).toBe(hostile);
  });

  it('refuses what cmd.exe cannot quote safely', () => {
    expect(expandSnippet('dir {{v}}', { v: 'a b' }, 'cmd').command).toBe('dir "a b"');
    for (const value of ['a&b', 'a"b', '%PATH%', 'a|b']) {
      expect(() => expandSnippet('dir {{v}}', { v: value }, 'cmd')).toThrow(SnippetExpansionError);
    }
  });

  it('refuses line breaks and control characters in values', () => {
    for (const value of ['a\nrm -rf /', 'a\rb', 'a\u001b[0m', 'a\u0003']) {
      expect(() => expandSnippet('echo {{v}}', { v: value }, 'posix')).toThrow(/Steuerzeichen/);
    }
  });

  it('warns about values that can be read as an option', () => {
    expect(expandSnippet('rm {{f}}', { f: '-rf' }, 'posix').warnings).toHaveLength(1);
    expect(expandSnippet('rm {{f}}', { f: 'a' }, 'posix').warnings).toHaveLength(0);
  });
});

describe('history exclusions', () => {
  it.each([
    ' secret-with-leading-space',
    'export API_KEY=abc',
    'PASSWORD=abc ./run',
    'mysql -u root -phunter2',
    'tool --password hunter2',
    'tool --token=abc',
    'curl -H "Authorization: Bearer x" https://example.org',
    'git clone https://me:hunter2@example.org/repo',
    'sshpass -p x ssh host',
    'echo ghp_abcdefghijklmnop1234'
  ])('never records %s', (command) => {
    expect(isCommandRecordable(command, [])).toBe(false);
  });

  it.each(['ls -la', 'git status', 'docker ps', 'cd /tmp/token-free', 'npm run build'])('records %s', (command) => {
    expect(isCommandRecordable(command, [])).toBe(true);
  });

  it('applies user patterns and ignores broken ones', () => {
    expect(isCommandRecordable('kubectl get secrets', ['^kubectl'])).toBe(false);
    expect(isCommandRecordable('ls', ['('])).toBe(true);
    expect(isCommandRecordable('   ', [])).toBe(false);
    expect(isCommandRecordable('x'.repeat(5000), [])).toBe(false);
  });
});

describe('suggestions', () => {
  it('matches fuzzily and prefers direct hits', () => {
    expect(fuzzyScore('dkps', 'docker ps')).not.toBeNull();
    expect(fuzzyScore('zzz', 'docker ps')).toBeNull();
    expect(fuzzyScore('docker', 'docker ps')!).toBeGreaterThan(fuzzyScore('dkr', 'docker ps')!);
  });

  it('merges history and snippets, each command once', () => {
    const entry = (id: string, command: string) => ({
      id,
      command,
      sessionLabel: 's',
      hostId: null,
      cwd: null,
      exitCode: 0,
      createdAt: ''
    });
    const results = rankSuggestions(
      'dock',
      [entry('1', 'docker ps'), entry('2', 'docker ps'), entry('3', 'ls')],
      [{ id: 's', name: 'Docker Logs', command: 'docker logs', description: '', favorite: false }]
    );
    expect(results.map((item) => item.kind).sort()).toEqual(['history', 'snippet']);
  });
});

describe('workspace serialization', () => {
  const pane = '00000000-0000-4000-8000-000000000001';
  const tab = '00000000-0000-4000-8000-000000000002';
  const hostId = '00000000-0000-4000-8000-000000000003';
  const layout: WorkspaceLayout = {
    tabs: [
      {
        id: tab,
        activePaneId: pane,
        root: { type: 'pane', id: pane, target: { kind: 'ssh', hostId }, cwd: '/srv', startupCommands: ['ls'] }
      }
    ],
    activeTabId: tab
  };
  const definition = { version: 1, layout, hostPanelWidth: 260, startupApproved: false };

  it('survives a round trip through JSON', () => {
    expect(workspaceDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)))).toEqual(definition);
  });

  it('reads a layout saved before panes had a folder', () => {
    const old = { tabs: [{ id: tab, activePaneId: pane, root: { type: 'pane', id: pane, target: { kind: 'ssh', hostId } } }], activeTabId: tab };
    expect(workspaceDefinitionSchema.safeParse({ ...definition, layout: old }).success).toBe(true);
  });

  it('refuses another format version and unknown fields, such as a password', () => {
    expect(workspaceDefinitionSchema.safeParse({ ...definition, version: 2 }).success).toBe(false);
    expect(workspaceDefinitionSchema.safeParse({ ...definition, password: 'x' }).success).toBe(false);
    const file = { format: 'ryft-workspace', version: 1, name: 'n', definition, hosts: [] };
    expect(workspaceExportSchema.safeParse(file).success).toBe(true);
    expect(workspaceExportSchema.safeParse({ ...file, hosts: [{ id: hostId, name: 'a', hostname: 'h', port: 22, username: 'u', password: 'x' }] }).success).toBe(false);
  });

  it('matches hosts of an imported file by id and address, never by name alone', () => {
    const ref = { id: hostId, name: 'prod', hostname: 'h', port: 22, username: 'u' };
    expect(matchWorkspaceHost(ref, [ref])).toBe(hostId);
    const other = { ...ref, id: 'other' };
    expect(matchWorkspaceHost(ref, [other])).toBe('other');
    expect(matchWorkspaceHost(ref, [{ ...other, hostname: 'x' }])).toBeNull();
    expect(matchWorkspaceHost(ref, [other, { ...other, id: 'third' }])).toBeNull();
    expect(matchWorkspaceHost(ref, [{ ...ref, hostname: 'elsewhere' }])).toBeNull();
  });
});

describe('public key installation', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc+/= me@laptop';

  it('accepts only plain key lines', () => {
    expect(isValidPublicKeyLine(key)).toBe(true);
    for (const bad of [`${key}\nssh-rsa AAAA`, `command="x" ${key}`, "ssh-ed25519 AAAA'; rm -rf /", 'ssh-dss AAAA', 'ssh-ed25519 AAAA $(id)']) {
      expect(isValidPublicKeyLine(bad)).toBe(false);
      expect(() => buildInstallCommand(bad)).toThrow();
    }
  });

  it('adds a key once in a disposable home and keeps existing lines', () => {
    const home = mkdtempSync(join(tmpdir(), 'ryft-install-'));
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
    const run = () =>
      execFileSync(bash, ['-c', buildInstallCommand(key)], { encoding: 'utf8', env: { ...process.env, HOME: home } }).trim();
    try {
      expect(run()).toBe('RYFT_KEY_ADDED');
      expect(run()).toBe('RYFT_KEY_PRESENT');
      const lines = readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8').trim().split('\n');
      expect(lines).toEqual([key]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
