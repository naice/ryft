import { create } from 'zustand';
import { mirrorTargets, remainingBroadcastTargets, validateBroadcastActivation } from '@shared/features/broadcast';
import { api } from '../../lib/api';
import { liveTargets } from '../../lib/sessionTargets';
import { useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { insertProblemText } from '../snippets/snippetStore';
import { insertCommand, setKeyMirror } from '../terminal/terminalRegistry';

export type BroadcastMode = 'command' | 'keys';

interface BroadcastState {
  active: boolean;
  mode: BroadcastMode;
  /** Pane ids. Only ever chosen by hand: a session opened later is not part of this. */
  targets: string[];
  dialogOpen: boolean;
  setDialogOpen(open: boolean): void;
  activate(selected: string[], mode: BroadcastMode): string | null;
  deactivate(): void;
  /** Runs a command everywhere. The caller has shown the targets and the command and asked first. */
  send(command: string): void;
}

function connectedPanes(): string[] {
  const { tabs, panes } = useWorkspace.getState();
  const { hosts, shells, preferences } = useApp.getState();
  return liveTargets(tabs, panes, hosts, shells, preferences).map((target) => target.paneId);
}

export function labelsOf(ids: readonly string[]): string[] {
  const { tabs, panes } = useWorkspace.getState();
  const { hosts, shells, preferences } = useApp.getState();
  const live = liveTargets(tabs, panes, hosts, shells, preferences);
  return ids.map((id) => live.find((target) => target.paneId === id)?.label ?? 'Getrennte Sitzung');
}

export const useBroadcast = create<BroadcastState>((set, get) => ({
  active: false,
  mode: 'command',
  targets: [],
  dialogOpen: false,

  setDialogOpen: (dialogOpen) => set({ dialogOpen }),

  activate(selected, mode) {
    const result = validateBroadcastActivation(selected, connectedPanes());
    if (!result.ok) return result.reason;
    set({ active: true, mode, targets: result.targets, dialogOpen: false });
    setKeyMirror(
      mode === 'keys'
        ? (source, data) => {
            for (const id of mirrorTargets(source, get().targets)) api.writeSession(id, data);
          }
        : null
    );
    return null;
  },

  deactivate() {
    setKeyMirror(null);
    set({ active: false, targets: [] });
  },

  send(command) {
    const { toast } = useApp.getState();
    const { targets } = get();
    const failures: string[] = [];
    const labels = labelsOf(targets);
    targets.forEach((id, index) => {
      const result = insertCommand(id, command, true);
      if (result !== 'ok') failures.push(`${labels[index]}: ${insertProblemText(result)}`);
    });
    if (failures.length === 0) toast('success', `An ${targets.length} Sitzungen gesendet`);
    else toast('error', `An ${targets.length - failures.length} von ${targets.length} gesendet. ${failures.join(' ')}`);
  }
}));

// A session which drops out stays out, even if it reconnects: it may be somewhere else by then.
useWorkspace.subscribe(() => {
  const { active, targets, deactivate } = useBroadcast.getState();
  if (!active) return;
  const remaining = remainingBroadcastTargets(targets, connectedPanes());
  if (remaining.length === targets.length) return;
  if (remaining.length < 2) {
    deactivate();
    useApp.getState().toast('info', 'Broadcast beendet: Es sind weniger als zwei verbundene Sitzungen übrig.');
    return;
  }
  useBroadcast.setState({ targets: remaining });
  useApp.getState().toast('info', `Eine Sitzung ist nicht mehr verbunden. Broadcast läuft mit ${remaining.length} Sitzungen weiter.`);
});
