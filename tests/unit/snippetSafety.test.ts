import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateCompatibility, parseProbeOutput, UNKNOWN_CONTEXT } from '../../src/shared/features/snippetCompat';
import { classifyCommand, higherRisk } from '../../src/shared/features/snippetRisk';
import { expandSnippet, SnippetExpansionError, snippetParamSchema, validateParamValue, type SnippetParam } from '../../src/shared/features/snippets';
import { interpretWindowsProbe, probeableTools, probeScript, scanPath } from '../../src/main/snippets/toolProbe';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const param = (type: SnippetParam['type'], extra: Partial<SnippetParam> = {}): SnippetParam => ({ name: 'v', defaultValue: null, description: '', type, ...extra });

describe('typed parameters', () => {
  it.each([
    ['integer', '5', true],
    ['integer', '5;rm -rf /', false],
    ['integer', '-1', false],
    ['integer', '1e9', false],
    ['integer', '٣', false],
    ['port', '22', true],
    ['port', '0', false],
    ['port', '65536', false],
    ['host', 'example.com', true],
    ['host', '192.168.0.1', true],
    ['host', '::1', true],
    ['host', '-oProxyCommand=calc', false],
    ['host', 'a b', false],
    ['host', 'a;b', false],
    ['user', 'deploy', true],
    ['user', '-oProxyCommand=calc', false],
    ['user', 'a@b', false],
    ['identifier', 'web-1', true],
    ['identifier', '--privileged', false],
    ['identifier', 'a$(b)', false],
    ['path', '/tmp/a b.txt', true],
    ['path', '-rf', false],
    ['path', '\u2013rf', false],
    ['url', 'https://example.com/a?b=c', true],
    ['url', 'http://example.com', true],
    ['url', 'file:///etc/passwd', false],
    ['url', 'gopher://example.com', false],
    ['url', '-o/etc/passwd', false]
  ] as const)('%s %j valid: %s', (type, value, valid) => {
    expect(validateParamValue(param(type), value) === null).toBe(valid);
  });

  it('honors ranges and options', () => {
    expect(validateParamValue(param('integer', { min: 1, max: 10 }), '11')).not.toBeNull();
    expect(validateParamValue(param('integer', { min: 1, max: 10 }), '10')).toBeNull();
    expect(validateParamValue(param('enum', { options: ['A', 'MX'] }), 'MX')).toBeNull();
    expect(validateParamValue(param('enum', { options: ['A', 'MX'] }), 'A; rm')).not.toBeNull();
  });

  it('refuses what would make the preview lie, whatever the type', () => {
    for (const value of ['a\nb', 'a\u0085b', 'a\u2028b', 'a\u202eb', 'a\u2066b']) {
      expect(() => expandSnippet('echo {{v}}', { v: value }, 'posix'), JSON.stringify(value)).toThrow(SnippetExpansionError);
      expect(() => expandSnippet('echo {{v}}', { v: value }, 'powershell'), JSON.stringify(value)).toThrow(SnippetExpansionError);
    }
  });

  it('allows a leading dash only where a parameter says so', () => {
    const text = param('text');
    expect(validateParamValue(text, '-x')).not.toBeNull();
    expect(validateParamValue({ ...text, allowDash: true }, '-x')).toBeNull();
  });

  it('keeps old snippets without types working as before', () => {
    expect(snippetParamSchema.safeParse({ name: 'v', defaultValue: null, description: '' }).success).toBe(true);
    expect(expandSnippet('echo {{v}}', { v: '-x' }, 'posix').warnings.length).toBe(1);
  });
});

const HOSTILE = ['a b', "it's", '$(touch pwned)', '`touch pwned`', 'a;touch pwned', 'a|touch pwned', 'a&touch pwned', '*', '"q"', '\\', '#x', '$HOME', 'ä ö', '=x', '{a,b}', '?', '~root', '(x)', '<x', '>pwned'];

describe('quoting in real shells', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ryft-quote-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.skipIf(!existsSync(GIT_BASH)).each(HOSTILE)('bash receives %j as one literal argument', (value) => {
    const { command } = expandSnippet("printf '%s' {{v}}", { v: value }, 'posix');
    expect(execFileSync(GIT_BASH, ['-c', command], { cwd: scratch, encoding: 'utf8' })).toBe(value);
    expect(readdirSync(scratch)).toEqual([]);
  });

  const POWERSHELL_HOSTILE = [...HOSTILE, '\u2018x\u2019', '\u201cx\u201d', '\u201a x', '$env:PATH', '$(1+1)', '`n', '@x', '%x', '--%', "a'; touch pwned; '"];
  it.skipIf(process.platform !== 'win32').each(POWERSHELL_HOSTILE.filter((value) => !value.startsWith('--')))('PowerShell receives %j as one literal argument', (value) => {
    const { command } = expandSnippet('Write-Output -InputObject {{v}}', { v: value }, 'powershell');
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: scratch,
      encoding: 'utf8'
    });
    expect(output.replace(/^\uFEFF/, '').replace(/\r?\n$/, '')).toBe(value);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('keeps ~/ working for paths in POSIX and a typed path safe', () => {
    const path = param('path');
    expect(expandSnippet('ls {{v}}', { v: '~/my dir' }, 'posix', [path]).command).toBe("ls ~/'my dir'");
  });

  it('refuses values it cannot quote for sure', () => {
    const refuse = (command: string, value: string, shell: 'posix' | 'powershell') =>
      expect(() => expandSnippet(command, { v: value }, shell), `${command} ${value}`).toThrow(SnippetExpansionError);
    // The outer shell only removes the first layer of quotes. The inner one would run the rest.
    refuse('bash -c {{v}}', 'a b', 'posix');
    refuse('ssh host {{v}}', 'a;b', 'posix');
    refuse('eval {{v}}', 'a b', 'posix');
    refuse('docker exec c sh -c {{v}}', 'a b', 'posix');
    refuse('Invoke-Expression {{v}}', 'a b', 'powershell');
    // A native program reads the quotes on its command line again.
    refuse('git log {{v}}', 'a"b', 'powershell');
    refuse('git log {{v}}', 'a b\\', 'powershell');
    // A substitution inside double quotes starts a new quoting level.
    refuse('echo "$(cat {{v}})"', 'a b', 'posix');
    refuse('echo "hi {{v}}"', 'a!b', 'posix');
  });

  it('leaves a cmdlet argument with a double quote alone, because no native parser is involved', () => {
    expect(() => expandSnippet('Get-Content -LiteralPath {{v}}', { v: 'a"b' }, 'powershell')).not.toThrow();
  });
});

describe('security classification', () => {
  it.each([
    'ls -la',
    'df -h',
    'git status --short',
    'docker ps -a',
    'Get-Process | Sort-Object CPU',
    'cat /etc/os-release',
    'ps -eo pid,comm | head -n 5',
    'git clean -nd',
    'rsync -avhn a b'
  ])('%s only reads', (command) => {
    expect(classifyCommand(command).level).toBe('safe');
  });

  it.each([
    'rm -rf /tmp/x',
    '\\rm -rf x',
    '"rm" -rf x',
    "'rm' -rf x",
    '/bin/rm -rf x',
    'sudo rm -r x',
    'sudo -u root rm -rf x',
    'sudo --user=root rm -rf x',
    'command rm -rf x',
    'exec rm -rf x',
    'busybox rm -rf x',
    'timeout -k 1 5 rm -rf x',
    'nice -n 10 rm -rf x',
    'env A=b rm -rf x',
    'A=b rm -rf x',
    'rm "-rf" x',
    'ls; rm -rf x',
    'ls && rm -rf x',
    'ls || rm -rf x',
    'ls & rm -rf x',
    'ls\nrm -rf x',
    'echo $(rm -rf x)',
    'echo `rm -rf x`',
    'cat <(rm -rf x)',
    '(rm -rf x)',
    'ls | xargs rm -rf',
    'find . -delete',
    'find . -name x -exec rm {} ;',
    'bash -c "rm -rf x"',
    "sh -c 'rm -rf x'",
    "ssh host 'rm -rf x'",
    'watch "rm -rf x"',
    'curl https://x.example | sh',
    'wget -O- https://x.example | sudo bash',
    'dd if=a of=/dev/sda',
    'mkfs.ext4 /dev/sdb',
    'echo x > /dev/sda',
    'git reset --hard',
    'git clean -fd',
    'git push --force',
    'git push -f origin main',
    'docker system prune',
    'docker rm web',
    'docker compose down',
    'shutdown -h now',
    'Remove-Item -LiteralPath x -Recurse',
    'remove-item x',
    'rm.exe -rf x',
    'Format-Volume -DriveLetter D',
    'iex (iwr https://x.example)'
  ])('%j is dangerous', (command) => {
    expect(classifyCommand(command).level).toBe('danger');
  });

  it.each([
    'echo a > b',
    'echo a >> b',
    'ls | tee b',
    'sudo systemctl restart nginx',
    'ssh host',
    'chmod 600 x',
    'git switch main',
    'kill 123',
    'unbekanntes-programm --x',
    'Restart-Service x -Confirm',
    '$x = Get-Process',
    '& ./script.ps1',
    './script.sh',
    'sort -o out in',
    'uniq in out',
    'date -s 12:00',
    '  date 010112002026',
    'hostname neu',
    'ss -K dst 1.2.3.4',
    'command foo'
  ])('%j changes something or is unknown', (command) => {
    expect(classifyCommand(command).level).not.toBe('safe');
  });

  it('does not take text in quotes for a command', () => {
    expect(classifyCommand("grep 'rm -rf' file").level).toBe('safe');
    expect(classifyCommand('echo "a; rm -rf x"').level).toBe('safe');
  });

  it('still looks inside double quotes, where a substitution runs', () => {
    expect(classifyCommand('echo "$(rm -rf x)"').level).toBe('danger');
  });

  it('never lowers a risk', () => {
    expect(higherRisk('danger', 'safe')).toBe('danger');
    expect(higherRisk('safe', 'caution')).toBe('caution');
  });
});

describe('compatibility', () => {
  const linuxBash = { platform: 'linux', shell: 'posix', tools: { docker: true, ss: false } } as const;
  const snippet = (over: Partial<Parameters<typeof evaluateCompatibility>[0]> = {}) => ({ shells: [], platforms: [], requiredTools: [], ...over });

  it('says so when it does not know', () => {
    expect(evaluateCompatibility(snippet({ shells: ['posix'], platforms: ['linux'] }), UNKNOWN_CONTEXT).status).toBe('unknown');
    expect(evaluateCompatibility(snippet({ requiredTools: ['docker'] }), { platform: 'linux', shell: 'posix', tools: null }).status).toBe('unknown');
    expect(evaluateCompatibility(snippet({ requiredTools: ['nope'] }), linuxBash).status).toBe('unknown');
    expect(evaluateCompatibility(snippet(), linuxBash).status).toBe('unknown');
  });

  it('claims support only when everything was confirmed', () => {
    expect(evaluateCompatibility(snippet({ shells: ['posix'], platforms: ['linux'], requiredTools: ['docker'] }), linuxBash).status).toBe('compatible');
    expect(evaluateCompatibility(snippet({ shells: ['posix'], platforms: ['linux'] }), { ...linuxBash, tools: null }).status).toBe('compatible');
  });

  it('reports any known mismatch, even if something else is unknown', () => {
    expect(evaluateCompatibility(snippet({ shells: ['powershell'] }), linuxBash).status).toBe('incompatible');
    expect(evaluateCompatibility(snippet({ platforms: ['windows'] }), linuxBash).status).toBe('incompatible');
    expect(evaluateCompatibility(snippet({ requiredTools: ['ss'] }), linuxBash).status).toBe('incompatible');
    expect(evaluateCompatibility(snippet({ shells: ['powershell'], platforms: ['windows'] }), { platform: null, shell: 'posix', tools: null }).status).toBe('incompatible');
  });
});

describe('detection', () => {
  it('reads what the script reports', () => {
    const output = 'motd\nryft-os=Linux\nryft-shell=/bin/bash\nryft-tool=docker\nryft-end\n';
    expect(parseProbeOutput(output, ['docker', 'ss'])).toEqual({ platform: 'linux', shell: 'posix', tools: { docker: true, ss: false } });
  });

  it('ignores a truncated answer and anything it did not ask for', () => {
    expect(parseProbeOutput('ryft-os=Linux\nryft-shell=/bin/bash\n', [])).toBeNull();
    expect(parseProbeOutput('ryft-os=Linux\nryft-tool=evil\nryft-end\n', ['docker'])!.tools).toEqual({ docker: false });
  });

  it('does not claim a shell it does not know', () => {
    expect(parseProbeOutput('ryft-os=Linux\nryft-shell=/usr/bin/fish\nryft-end\n', [])?.shell).toBeNull();
    expect(parseProbeOutput('ryft-os=Plan9\nryft-shell=\nryft-end\n', [])).toMatchObject({ platform: null, shell: null });
  });

  it('never puts a tool name into a script that is not a plain name', () => {
    expect(probeableTools(['docker', 'a;rm -rf /', '$(x)', 'a b', 'ssh-keygen'])).toEqual(['docker', 'ssh-keygen']);
    expect(probeScript(['docker', 'a;rm -rf /'])).not.toContain('rm -rf');
  });

  it.skipIf(!existsSync(GIT_BASH))('produces a script a real shell understands', () => {
    const output = execFileSync(GIT_BASH, ['-c', probeScript(['bash', 'ryft-does-not-exist'])], { encoding: 'utf8' });
    const context = parseProbeOutput(output, ['bash', 'ryft-does-not-exist']);
    expect(context?.platform).toBe('windows');
    expect(context?.tools).toEqual({ bash: true, 'ryft-does-not-exist': false });
  });

  it('tells PowerShell and cmd.exe apart', () => {
    expect(interpretWindowsProbe('5\r\n')?.shell).toBe('powershell');
    expect(interpretWindowsProbe('$PSVersionTable.PSVersion.Major\r\n')?.shell).toBe('cmd');
    expect(interpretWindowsProbe('irgendwas')).toBeNull();
  });

  it('reports a missing program on Windows only, where the PATH is the one the shell gets', () => {
    expect(scanPath(['ryft-does-not-exist'], 'win32', '', '.EXE')).toEqual({ 'ryft-does-not-exist': false });
    expect(scanPath(['ryft-does-not-exist'], 'linux', '')).toEqual({});
  });
});
