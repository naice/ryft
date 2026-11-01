import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import type { ShellInfo } from '@shared/contracts';

export interface ShellDefinition extends ShellInfo {
  file: string;
  args: string[];
}

export function findOnPath(executable: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function detectWindowsShells(): ShellDefinition[] {
  const shells: ShellDefinition[] = [];
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const pwsh = findOnPath('pwsh.exe');
  if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(powershell)) {
    shells.push({ id: 'powershell', label: 'Windows PowerShell', file: powershell, args: ['-NoLogo'] });
  }
  const cmd = process.env.ComSpec ?? join(systemRoot, 'System32', 'cmd.exe');
  if (existsSync(cmd)) shells.push({ id: 'cmd', label: 'Eingabeaufforderung', file: cmd, args: [] });
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (existsSync(gitBash)) shells.push({ id: 'git-bash', label: 'Git Bash', file: gitBash, args: ['--login', '-i'] });
  const wsl = join(systemRoot, 'System32', 'wsl.exe');
  if (existsSync(wsl)) shells.push({ id: 'wsl', label: 'WSL', file: wsl, args: [] });
  return shells;
}

function detectUnixShells(): ShellDefinition[] {
  const paths = new Set<string>();
  if (process.env.SHELL) paths.add(process.env.SHELL);
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const path = line.trim();
      if (path.startsWith('/')) paths.add(path);
    }
  } catch {
    // Some systems have no /etc/shells.
  }
  paths.add('/bin/bash');
  paths.add('/bin/sh');
  const unique = new Map<string, ShellDefinition>();
  for (const file of paths) {
    const name = basename(file);
    if (!unique.has(name) && existsSync(file) && name !== 'false' && name !== 'nologin') {
      unique.set(name, { id: name.slice(0, 64), label: name, file, args: ['-l'] });
    }
  }
  return [...unique.values()];
}

export function detectShells(): ShellDefinition[] {
  return process.platform === 'win32' ? detectWindowsShells() : detectUnixShells();
}

/** Shells are addressed by id only: the renderer can never make main execute an arbitrary path. */
export function resolveShell(shells: ShellDefinition[], shellId: string | null): ShellDefinition | null {
  return shells.find((shell) => shell.id === shellId) ?? shells[0] ?? null;
}
