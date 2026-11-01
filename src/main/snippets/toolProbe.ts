import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Client } from 'ssh2';
import { parseProbeOutput, UNKNOWN_CONTEXT, type TerminalContext } from '@shared/features/snippetCompat';
import { SNIPPET_TOOL_NAME, type SnippetPlatform } from '@shared/features/snippets';

const PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_TOOLS = 128;

/** Tool names come from stored snippets, so they are checked again before they become part of a script. */
export function probeableTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => SNIPPET_TOOL_NAME.test(tool)).slice(0, MAX_TOOLS);
}

/**
 * Only reads: the system name, $SHELL, and which programs exist. The sbin directories count because a
 * non-interactive login often leaves them out of PATH although the terminal has them.
 */
export function probeScript(tools: readonly string[]): string {
  const names = probeableTools(tools).join(' ');
  return [
    `printf 'ryft-os=%s\\n' "$(uname -s 2>/dev/null)"`,
    `printf 'ryft-shell=%s\\n' "\${SHELL:-}"`,
    `PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"`,
    `for ryft_tool in ${names}; do command -v "$ryft_tool" >/dev/null 2>&1 && printf 'ryft-tool=%s\\n' "$ryft_tool"; done`,
    `printf 'ryft-end\\n'`
  ].join('; ');
}

/** A shell that fails the POSIX script gets this one: PowerShell prints a number, cmd.exe echoes the text. */
export const WINDOWS_SHELL_PROBE = '$PSVersionTable.PSVersion.Major';

export function interpretWindowsProbe(output: string): TerminalContext | null {
  const text = output.trim();
  if (/^\d+$/.test(text)) return { platform: null, shell: 'powershell', tools: null };
  if (text === WINDOWS_SHELL_PROBE) return { platform: 'windows', shell: 'cmd', tools: null };
  return null;
}

export function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT_BYTES, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });
}

function execOverSsh(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) return reject(error);
      let stdout = '';
      const timer = setTimeout(() => {
        channel.close();
        reject(new Error('timeout'));
      }, PROBE_TIMEOUT_MS);
      channel.on('data', (chunk: Buffer) => {
        if (stdout.length < OUTPUT_LIMIT_BYTES) stdout += chunk.toString('utf8');
      });
      channel.stderr.resume();
      channel.on('close', () => {
        clearTimeout(timer);
        resolve(stdout);
      });
    });
  });
}

/** What a login over this connection runs on. It cannot see a shell the terminal switched to later on. */
export async function probeOverSsh(client: Client, tools: readonly string[]): Promise<TerminalContext> {
  const posix = parseProbeOutput(await execOverSsh(client, probeScript(tools)), probeableTools(tools));
  if (posix) return posix;
  return interpretWindowsProbe(await execOverSsh(client, WINDOWS_SHELL_PROBE)) ?? UNKNOWN_CONTEXT;
}

/** A script that fails or times out says nothing about the terminal, so that is what it reports. */
export async function probeWith(run: (script: string) => Promise<string>, tools: readonly string[]): Promise<TerminalContext> {
  try {
    return parseProbeOutput(await run(probeScript(tools)), probeableTools(tools)) ?? UNKNOWN_CONTEXT;
  } catch {
    return UNKNOWN_CONTEXT;
  }
}

/** What is certain about the local machine, no matter how the probe goes. */
export function localPlatform(platform: NodeJS.Platform): SnippetPlatform | null {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform === 'linux' ? 'linux' : null;
}

/**
 * For PowerShell and cmd.exe on this machine, which inherit RYFT's own PATH. Cmdlets are never on it, so
 * snippets list programs only. Elsewhere a desktop app sees a shorter PATH than a shell does, which makes a
 * miss meaningless, and that is why a tool is only reported missing on Windows.
 */
export function scanPath(tools: readonly string[], platform: NodeJS.Platform, path = process.env.PATH ?? '', pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'): Record<string, boolean> {
  const directories = path.split(delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? ['', ...pathExt.split(';')] : [''];
  const result: Record<string, boolean> = {};
  for (const tool of probeableTools(tools)) {
    const found = directories.some((directory) => extensions.some((extension) => existsSync(join(directory, tool + extension))));
    if (found || platform === 'win32') result[tool] = found;
  }
  return result;
}
