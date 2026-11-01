import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ShellDefinition } from '../pty/shells';

/**
 * Command boundaries come from the shell itself: its prompt hook reports the command it just ran.
 * Keystrokes are never looked at, so password prompts, `read -s` and full-screen programs cannot end
 * up in the history, and Enter alone means nothing here.
 */
const OSC_PREFIX = '\u001b]7777;';
const MAX_PENDING = 16 * 1024;

export interface ShellCommandEvent {
  command: string;
  exitCode: number | null;
  cwd: string | null;
}

function unescapeField(value: string): string {
  return value.replace(/\\(\\|x[0-9a-fA-F]{2})/g, (_match, code: string) =>
    code === '\\' ? '\\' : String.fromCharCode(Number.parseInt(code.slice(1), 16))
  );
}

/** Removes the private sequences from terminal output, also when one is split across chunks. */
export class ShellIntegrationParser {
  private pending = '';

  constructor(
    private readonly nonce: string,
    private readonly onCommand: (event: ShellCommandEvent) => void
  ) {}

  filter(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = '';
    let output = '';
    for (;;) {
      const start = text.indexOf(OSC_PREFIX);
      if (start < 0) {
        const keep = trailingPrefixLength(text);
        this.pending = text.slice(text.length - keep);
        return output + text.slice(0, text.length - keep);
      }
      output += text.slice(0, start);
      const rest = text.slice(start + OSC_PREFIX.length);
      const bell = rest.indexOf('\u0007');
      const st = rest.indexOf('\u001b\\');
      const end = bell >= 0 && (st < 0 || bell < st) ? bell : st;
      if (end < 0) {
        if (rest.length > MAX_PENDING) {
          // Not ours, or broken. It belongs to the terminal then.
          output += OSC_PREFIX;
          text = rest;
          continue;
        }
        this.pending = text.slice(start);
        return output;
      }
      const body = rest.slice(0, end);
      if (!this.consume(body)) output += text.slice(start, start + OSC_PREFIX.length + end + (end === bell ? 1 : 2));
      text = rest.slice(end + (end === bell ? 1 : 2));
    }
  }

  /** False when the sequence does not carry this session's nonce, so a program printed it. */
  private consume(body: string): boolean {
    const fields = body.split(';');
    if (fields[0] !== this.nonce || fields[1] !== 'cmd' || fields.length !== 5) return false;
    const exit = Number.parseInt(fields[2] as string, 10);
    const cwd = unescapeField(fields[3] as string);
    this.onCommand({
      command: unescapeField(fields[4] as string),
      exitCode: Number.isNaN(exit) ? null : exit,
      cwd: cwd || null
    });
    return true;
  }
}

function trailingPrefixLength(text: string): number {
  const max = Math.min(OSC_PREFIX.length - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    if (OSC_PREFIX.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

export type IntegrationKind = 'powershell' | 'bash' | 'zsh';

/** Everything else gets a working terminal without a recorded history instead of a guess. */
export function integrationKindOf(shell: Pick<ShellDefinition, 'id' | 'file'>): IntegrationKind | null {
  if (shell.id === 'pwsh' || shell.id === 'powershell') return 'powershell';
  const name = basename(shell.file).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'bash') return 'bash';
  if (name === 'zsh') return 'zsh';
  return null;
}

function powershellScript(nonce: string): string {
  return [
    `$global:__ryftNonce = '${nonce}'`,
    // This setup script is itself the first history entry, so the first prompt only takes note of it.
    '$global:__ryftStarted = $false',
    '$global:__ryftLastId = $null',
    '$global:__ryftPrompt = $function:prompt',
    'function global:__ryftEscape([string]$value) {',
    "  $value = $value -replace '\\\\', '\\\\'",
    "  foreach ($code in 7, 10, 13, 27, 59) { $value = $value.Replace([string][char]$code, ('\\x{0:x2}' -f $code)) }",
    '  $value',
    '}',
    'function global:prompt {',
    '  $ok = $?',
    '  $native = $global:LASTEXITCODE',
    '  $last = Get-History -Count 1',
    '  if (-not $global:__ryftStarted) {',
    '    $global:__ryftStarted = $true',
    '    if ($last) { $global:__ryftLastId = $last.Id }',
    '  } elseif ($last -and $last.Id -ne $global:__ryftLastId) {',
    '    $global:__ryftLastId = $last.Id',
    '    $code = if ($ok) { 0 } elseif ($native) { $native } else { 1 }',
    '    $cwd = if ($PWD.Provider.Name -eq "FileSystem") { $PWD.ProviderPath } else { "" }',
    '    [Console]::Write(([char]27 + "]7777;" + $global:__ryftNonce + ";cmd;" + $code + ";" + (__ryftEscape $cwd) + ";" + (__ryftEscape $last.CommandLine) + [char]7))',
    '  }',
    '  $global:LASTEXITCODE = $native',
    '  & $global:__ryftPrompt',
    '}'
  ].join('\n');
}

const ESCAPE_HELPER =
  `__ryft_escape() { local v="$1"; v="\${v//\\\\/\\\\\\\\}"; v="\${v//;/\\\\x3b}"; v="\${v//$'\\n'/\\\\x0a}"; v="\${v//$'\\r'/\\\\x0d}"; v="\${v//$'\\a'/\\\\x07}"; v="\${v//$'\\e'/\\\\x1b}"; printf '%s' "$v"; }`;

/** One line of bash. `history 1` is empty for commands the user's HISTCONTROL keeps out of the history. */
function bashHook(nonceExpression: string): string {
  return [
    `__ryft_nonce=${nonceExpression}`,
    ESCAPE_HELPER,
    `__ryft_precmd() { local code=$? entry num cmd; entry="$(HISTTIMEFORMAT= builtin history 1)"; entry="\${entry#"\${entry%%[![:space:]]*}"}"; num="\${entry%%[[:space:]]*}"; if [ -z "\${__ryft_seen+x}" ]; then __ryft_seen="$num"; return $code; fi; if [ "$num" != "$__ryft_seen" ]; then __ryft_seen="$num"; cmd="\${entry#"$num"}"; cmd="\${cmd:2}"; printf '\\033]7777;%s;cmd;%s;%s;%s\\007' "$__ryft_nonce" "$code" "$(__ryft_escape "$PWD")" "$(__ryft_escape "$cmd")"; fi; return $code; }`,
    `PROMPT_COMMAND="__ryft_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`
  ].join('; ');
}

function zshHook(nonceExpression: string): string {
  return [
    `__ryft_nonce=${nonceExpression}`,
    ESCAPE_HELPER,
    `__ryft_cmd=''`,
    `__ryft_preexec() { __ryft_cmd="$1"; }`,
    `__ryft_precmd() { local code=$?; if [ -n "$__ryft_cmd" ]; then printf '\\033]7777;%s;cmd;%s;%s;%s\\007' "$__ryft_nonce" "$code" "$(__ryft_escape "$PWD")" "$(__ryft_escape "$__ryft_cmd")"; __ryft_cmd=''; fi; return $code; }`,
    `autoload -Uz add-zsh-hook`,
    `add-zsh-hook preexec __ryft_preexec`,
    `add-zsh-hook precmd __ryft_precmd`
  ].join('; ');
}

/**
 * The opt-in setup line for an SSH shell, which has nothing but its input to be configured through.
 * The leading space keeps it out of the remote history where the shell honours that convention.
 */
export function remoteSetupLine(nonce: string): string {
  return ` if [ -n "$BASH_VERSION" ]; then ${bashHook(`'${nonce}'`)}; elif [ -n "$ZSH_VERSION" ]; then ${zshHook(`'${nonce}'`)}; fi\r`;
}

const BASH_RC = `# Written by RYFT. Behaves like a login shell, then reports finished commands to the terminal.
if [ -f /etc/profile ]; then . /etc/profile; fi
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"
fi
${bashHook('"$RYFT_SHELL_NONCE"')}
unset RYFT_SHELL_NONCE
`;

const zshForward = (file: string): string =>
  `ZDOTDIR="\${RYFT_USER_ZDOTDIR:-$HOME}"; if [ -f "$ZDOTDIR/${file}" ]; then . "$ZDOTDIR/${file}"; fi; ZDOTDIR="$RYFT_ZDOTDIR"\n`;

function writeIntegrationFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

export interface LocalIntegration {
  shell: ShellDefinition;
  env: Record<string, string>;
  parser: ShellIntegrationParser;
}

/** Starts a local shell with the reporting hook, on top of the user's own profile. */
export function prepareLocalIntegration(
  shell: ShellDefinition,
  directory: string,
  nonce: string,
  onCommand: (event: ShellCommandEvent) => void
): LocalIntegration | null {
  const kind = integrationKindOf(shell);
  if (!kind) return null;
  const parser = new ShellIntegrationParser(nonce, onCommand);
  if (kind === 'powershell') {
    const encoded = Buffer.from(powershellScript(nonce), 'utf16le').toString('base64');
    // An encoded command also works under the Restricted execution policy, unlike a script file.
    return { shell: { ...shell, args: [...shell.args, '-NoExit', '-EncodedCommand', encoded] }, env: {}, parser };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (kind === 'bash') {
    const rcfile = join(directory, 'bashrc');
    writeIntegrationFile(rcfile, BASH_RC);
    return {
      shell: { ...shell, args: ['--rcfile', rcfile.replace(/\\/g, '/'), '-i'] },
      env: { RYFT_SHELL_NONCE: nonce },
      parser
    };
  }
  const zdotdir = join(directory, 'zsh');
  mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
  writeIntegrationFile(join(zdotdir, '.zshenv'), `RYFT_ZDOTDIR="$ZDOTDIR"\n${zshForward('.zshenv')}`);
  writeIntegrationFile(join(zdotdir, '.zprofile'), zshForward('.zprofile'));
  writeIntegrationFile(
    join(zdotdir, '.zshrc'),
    `${zshForward('.zshrc')}${zshHook('"$RYFT_SHELL_NONCE"')}\nunset RYFT_SHELL_NONCE\nZDOTDIR="\${RYFT_USER_ZDOTDIR:-$HOME}"\nunset RYFT_USER_ZDOTDIR RYFT_ZDOTDIR\n`
  );
  return {
    shell,
    env: {
      RYFT_SHELL_NONCE: nonce,
      ZDOTDIR: zdotdir,
      ...(process.env.ZDOTDIR ? { RYFT_USER_ZDOTDIR: process.env.ZDOTDIR } : {})
    },
    parser
  };
}
