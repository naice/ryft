import type { Host, LayoutNode, Preferences, SessionTarget, ShellInfo, SnippetPlatform, SnippetShell, TerminalContext } from '@shared/contracts';
import { isSessionActive, type SessionState } from '@shared/sessionState';
import { collectPanes } from './layoutTree';

export interface LiveTarget {
  paneId: string;
  label: string;
  /** The quoting rules to assume as long as nothing better is known. */
  shell: SnippetShell;
  hostId: string | null;
  /** What follows from how the session was opened, before anything has been asked of it. */
  context: TerminalContext;
}

function localShellOf(target: Extract<SessionTarget, { kind: 'local' }>, shells: readonly ShellInfo[], defaultShellId: string | null): string {
  return target.shellId ?? defaultShellId ?? shells[0]?.id ?? '';
}

/** Which quoting rules apply to what is typed into a pane. A remote login shell is assumed to be POSIX. */
export function snippetShellOf(target: SessionTarget, shells: readonly ShellInfo[], defaultShellId: string | null): SnippetShell {
  if (target.kind !== 'local') return 'posix';
  const id = localShellOf(target, shells, defaultShellId);
  if (id === 'pwsh' || id === 'powershell') return 'powershell';
  return id === 'cmd' ? 'cmd' : 'posix';
}

function platformOf(nodePlatform: string | undefined): SnippetPlatform | null {
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'darwin') return 'macos';
  return nodePlatform === 'linux' ? 'linux' : null;
}

/** Only what is certain: an SSH host or the login shell of a WSL distribution can be anything. */
function initialContext(
  target: SessionTarget,
  shells: readonly ShellInfo[],
  defaultShellId: string | null,
  nodePlatform: string | undefined
): TerminalContext {
  if (target.kind === 'ssh') return { platform: null, shell: null, tools: null };
  if (target.kind === 'wsl') return { platform: 'linux', shell: null, tools: null };
  if (target.kind === 'docker') return { platform: null, shell: 'posix', tools: null };
  if (localShellOf(target, shells, defaultShellId) === 'wsl') return { platform: 'linux', shell: null, tools: null };
  return { platform: platformOf(nodePlatform), shell: snippetShellOf(target, shells, defaultShellId), tools: null };
}

/** The sessions something can be sent to right now, in tab order. Disconnected panes never count. */
export function liveTargets(
  tabs: readonly { root: LayoutNode }[],
  panes: Readonly<Record<string, { state: SessionState } | undefined>>,
  hosts: readonly Host[],
  shells: readonly ShellInfo[],
  preferences: Preferences | null,
  nodePlatform?: string
): LiveTarget[] {
  const defaultShellId = preferences?.defaultShellId ?? null;
  const result: LiveTarget[] = [];
  for (const tab of tabs) {
    for (const item of collectPanes(tab.root)) {
      const state = panes[item.id]?.state;
      if (state !== 'connected' || !isSessionActive(state)) continue;
      const { target } = item;
      const label =
        target.kind === 'ssh'
          ? (hosts.find((host) => host.id === target.hostId)?.name ?? 'Gelöschter Host')
          : target.kind === 'docker'
            ? `Docker: ${target.containerName}`
            : target.kind === 'wsl'
              ? `WSL: ${target.distro ?? preferences?.wslDefaultDistro ?? 'Standard'}`
              : (shells.find((shell) => shell.id === localShellOf(target, shells, defaultShellId))?.label ?? 'Lokal');
      result.push({
        paneId: item.id,
        label,
        shell: snippetShellOf(target, shells, defaultShellId),
        hostId: target.kind === 'ssh' ? target.hostId : null,
        context: initialContext(target, shells, defaultShellId, nodePlatform)
      });
    }
  }
  return result;
}

/** A local shell can be asked without any side effect. Everything else opens a connection, so it waits for a click. */
export function detectsOnItsOwn(target: LiveTarget, tabs: readonly { root: LayoutNode }[]): boolean {
  for (const tab of tabs) {
    const pane = collectPanes(tab.root).find((item) => item.id === target.paneId);
    if (pane) return pane.target.kind === 'local';
  }
  return false;
}
