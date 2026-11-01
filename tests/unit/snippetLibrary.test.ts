import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PRESET_LIBRARY, type Preset } from '../../src/main/snippets/presets';
import { classifyCommand } from '../../src/shared/features/snippetRisk';
import { expandSnippet, placeholdersOf, snippetInputSchema, validateParamValue, type SnippetParam, type SnippetShell } from '../../src/shared/features/snippets';

const presets = PRESET_LIBRARY.presets;
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const scratch = mkdtempSync(join(tmpdir(), 'ryft-presets-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function sampleFor(param: SnippetParam, shell: SnippetShell): string {
  switch (param.type) {
    case 'integer':
      return String(param.min ?? 5);
    case 'port':
      return '2222';
    case 'host':
      return 'example.com';
    case 'user':
      return 'deploy';
    case 'path':
      return shell === 'powershell' ? 'C:\\Temp\\a b.txt' : '/tmp/a b.txt';
    case 'identifier':
      return 'web-1';
    case 'enum':
      return param.options?.[0] ?? '';
    case 'url':
      return 'https://example.com/';
    default:
      return "it's a $(test) value";
  }
}

function expanded(preset: Preset, shell: SnippetShell): string {
  const values = Object.fromEntries(preset.params.map((param) => [param.name, sampleFor(param, shell)]));
  return expandSnippet(preset.command, values, shell, preset.params).command;
}

function shellsOf(preset: Preset): SnippetShell[] {
  return preset.shells.length > 0 ? preset.shells : ['posix', 'powershell', 'cmd'];
}

describe('the built-in library', () => {
  it('has stable, unique ids', () => {
    const ids = presets.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
  });

  it('covers every category of the specification', () => {
    expect(new Set(presets.map((preset) => preset.category))).toEqual(
      new Set(['Linux-System', 'Netzwerk', 'SSH', 'Docker', 'Git', 'Fehlersuche', 'Dateien', 'PowerShell'])
    );
  });

  it.each(presets.map((preset) => [preset.id, preset] as const))('%s is well-formed', (_id, preset) => {
    expect(preset.version).toBeGreaterThanOrEqual(1);
    expect(preset.description.length).toBeGreaterThan(0);
    expect(
      snippetInputSchema.safeParse({
        name: preset.title,
        description: preset.description,
        command: preset.command,
        category: preset.category,
        tags: preset.tags,
        shells: preset.shells,
        params: preset.params,
        favorite: false,
        platforms: preset.platforms,
        requiredTools: preset.requiredTools
      }).success
    ).toBe(true);

    // Each placeholder is declared with a type, and nothing is declared without being used.
    const used = placeholdersOf(preset.command).map((item) => item.name);
    expect(used.slice().sort()).toEqual(preset.params.map((param) => param.name).sort());
    for (const param of preset.params) {
      expect(param.type, param.name).toBeTruthy();
      expect(param.description, param.name).not.toBe('');
      if (param.defaultValue !== null) expect(validateParamValue(param, param.defaultValue), param.name).toBeNull();
    }
  });

  it('never puts a placeholder inside quotes, where a value would be read differently', () => {
    for (const preset of presets) {
      for (const shell of shellsOf(preset)) {
        const marker = expandSnippet(
          preset.command,
          Object.fromEntries(preset.params.map((param) => [param.name, sampleFor(param, shell)])),
          shell,
          preset.params
        );
        expect(marker.warnings, preset.id).toEqual([]);
      }
      for (const name of placeholdersOf(preset.command).map((item) => item.name)) {
        const before = preset.command.slice(0, preset.command.indexOf(`{{${name}`));
        expect((before.match(/"/g) ?? []).length % 2, `${preset.id} ${name}`).toBe(0);
        expect((before.match(/'/g) ?? []).length % 2, `${preset.id} ${name}`).toBe(0);
      }
    }
  });

  it('adapts to PowerShell instead of reusing Linux commands', () => {
    for (const preset of presets.filter((item) => item.shells.length === 1 && item.shells[0] === 'powershell')) {
      expect(preset.command, preset.id).not.toMatch(/(?:^|\|\s*)(?:grep|awk|sed|head|tail|ls|rm|cat|chmod|sudo)\s/);
      expect(preset.command, preset.id).not.toMatch(/\s\/dev\/null|\$\(/);
      // Remove-Item with -Path would read wildcards in a file name as a pattern.
      expect(preset.command, preset.id).not.toMatch(/-(?:Path|Include)\s+\{\{/);
    }
  });

  it('asks for confirmation or an interactive prompt in PowerShell presets that change something', () => {
    for (const preset of presets.filter((item) => item.category === 'PowerShell' && item.risk !== 'safe')) {
      expect(preset.command, preset.id).toMatch(/-Confirm(?:\s|$)/);
    }
  });

  it('contains no force push and no destructive flag that skips a question', () => {
    for (const preset of presets) {
      expect(preset.command, preset.id).not.toMatch(/push\s+(?:.*\s)?(?:-f|--force)/);
      expect(preset.command, preset.id).not.toMatch(/prune\s+(?:.*\s)?(?:-f|--force|-a)\b/);
      expect(preset.command, preset.id).not.toMatch(/\brm\s+-[a-z]*f/);
      expect(preset.command, preset.id).not.toMatch(/-Force\b/);
    }
  });
});

describe('the risk each preset declares', () => {
  it.each(presets.map((preset) => [preset.id, preset] as const))('%s agrees with the classifier', (_id, preset) => {
    for (const shell of shellsOf(preset).filter((item) => item !== 'cmd')) {
      const found = classifyCommand(expanded(preset, shell));
      // Too low would hide a danger, too high would wear out the warning.
      expect(found.level, `${shell}: ${found.reasons.join(', ')}`).toBe(preset.risk);
    }
  });
});

describe('syntax in the real shells', () => {
  const posix = presets.filter((preset) => shellsOf(preset).includes('posix'));

  it.skipIf(!existsSync(GIT_BASH))('parses every POSIX preset with bash -n', () => {
    const failures: string[] = [];
    for (const preset of posix) {
      const file = join(scratch, `${preset.id}.sh`);
      writeFileSync(file, `${expanded(preset, 'posix')}\n`);
      const result = spawnSync(GIT_BASH, ['-n', file], { encoding: 'utf8' });
      if (result.status !== 0) failures.push(`${preset.id}: ${result.stderr}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it.skipIf(process.platform !== 'win32')('parses every PowerShell preset with the PowerShell parser', () => {
    const commands = presets
      .filter((preset) => shellsOf(preset).includes('powershell'))
      .map((preset) => ({ id: preset.id, command: expanded(preset, 'powershell') }));
    const input = join(scratch, 'powershell.json');
    writeFileSync(input, JSON.stringify(commands));
    const script = `
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      Get-Content -LiteralPath '${input}' -Raw -Encoding UTF8 | ConvertFrom-Json | ForEach-Object {
        $errors = $null; $tokens = $null
        [void][System.Management.Automation.Language.Parser]::ParseInput($_.command, [ref]$tokens, [ref]$errors)
        foreach ($problem in $errors) { "$($_.id): $($problem.Message)" }
      }`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    expect(output.trim()).toBe('');
  }, 120_000);
});
