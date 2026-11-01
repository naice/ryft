import type { Snippet, SnippetPlatform, SnippetShell } from './snippets';

/** What is known about a terminal. Null means not known, which is not the same as not there. */
export interface TerminalContext {
  platform: SnippetPlatform | null;
  shell: SnippetShell | null;
  tools: Record<string, boolean> | null;
}

export const UNKNOWN_CONTEXT: TerminalContext = { platform: null, shell: null, tools: null };

export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';

export interface Compatibility {
  status: CompatibilityStatus;
  reasons: string[];
}

const PLATFORM_LABEL: Record<SnippetPlatform, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
const SHELL_LABEL: Record<SnippetShell, string> = { posix: 'POSIX-Shells', powershell: 'PowerShell', cmd: 'die Eingabeaufforderung' };

export const platformLabel = (platform: SnippetPlatform): string => PLATFORM_LABEL[platform];

/** What detection found, on top of what was already known. A detection which found nothing takes nothing away. */
export function mergeContext(known: TerminalContext, detected: TerminalContext | undefined): TerminalContext {
  if (!detected) return known;
  return {
    platform: detected.platform ?? known.platform,
    shell: detected.shell ?? known.shell,
    tools: detected.tools ?? known.tools
  };
}

/** A definite mismatch wins over anything unknown, and support is only ever claimed when all of it is known. */
export function evaluateCompatibility(
  snippet: Pick<Snippet, 'shells' | 'platforms' | 'requiredTools'>,
  context: TerminalContext
): Compatibility {
  const missing: string[] = [];
  const unknown: string[] = [];

  if (snippet.shells.length > 0) {
    if (context.shell === null) unknown.push('Shell nicht erkannt');
    else if (!snippet.shells.includes(context.shell)) {
      missing.push(`Nur für ${snippet.shells.map((shell) => SHELL_LABEL[shell]).join(', ')}`);
    }
  }
  if (snippet.platforms.length > 0) {
    if (context.platform === null) unknown.push('Betriebssystem nicht erkannt');
    else if (!snippet.platforms.includes(context.platform)) {
      missing.push(`Nur für ${snippet.platforms.map(platformLabel).join(', ')}`);
    }
  }
  for (const tool of snippet.requiredTools) {
    const available = context.tools?.[tool];
    if (available === false) missing.push(`„${tool}“ fehlt`);
    else if (available === undefined) unknown.push(`„${tool}“ nicht geprüft`);
  }

  if (missing.length > 0) return { status: 'incompatible', reasons: missing };
  if (unknown.length > 0) return { status: 'unknown', reasons: unknown };
  if (snippet.shells.length === 0 && snippet.platforms.length === 0 && snippet.requiredTools.length === 0) {
    return { status: 'unknown', reasons: ['Das Snippet macht keine Angaben'] };
  }
  return { status: 'compatible', reasons: [] };
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/** Reads what the probe script printed. A remote machine wrote it, so only what was asked for counts. */
export function parseProbeOutput(output: string, tools: readonly string[]): TerminalContext | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes('ryft-end')) return null;
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  const os = value('ryft-os');
  const platform: SnippetPlatform | null = /^linux$/i.test(os)
    ? 'linux'
    : /^darwin$/i.test(os)
      ? 'macos'
      : /^(?:mingw|msys|cygwin)/i.test(os)
        ? 'windows'
        : null;
  const shellName = value('ryft-shell').split('/').pop() ?? '';
  const found = new Set(lines.filter((line) => line.startsWith('ryft-tool=')).map((line) => line.slice('ryft-tool='.length)));
  return {
    platform,
    shell: POSIX_SHELLS.has(shellName) ? 'posix' : null,
    tools: Object.fromEntries(tools.map((tool) => [tool, found.has(tool)]))
  };
}
