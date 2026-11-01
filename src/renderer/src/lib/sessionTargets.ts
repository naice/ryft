import type { Host, LayoutNode, Preferences, SessionTarget, ShellInfo, SnippetShell } from '@shared/contracts';
import { isSessionActive, type SessionState } from '@shared/sessionState';
import { collectPanes } from './layoutTree';

export interface LiveTarget {
  paneId: string;
  label: string;
  shell: SnippetShell;
  hostId: string | null;
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

/** The sessions something can be sent to right now, in tab order. Disconnected panes never count. */
export function liveTargets(
  tabs: readonly { root: LayoutNode }[],
  panes: Readonly<Record<string, { state: SessionState } | undefined>>,
  hosts: readonly Host[],
  shells: readonly ShellInfo[],
  preferences: Preferences | null
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
        hostId: target.kind === 'ssh' ? target.hostId : null
      });
    }
  }
  return result;
}
