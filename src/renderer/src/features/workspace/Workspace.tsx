import { useEffect, useState, type KeyboardEvent } from 'react';
import { Container, Plus, Server, SquareTerminal, X } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { SessionTarget, WslDistro } from '@shared/contracts';
import { api } from '../../lib/api';
import { collectPanes } from '../../lib/layoutTree';
import { useApp } from '../../state/appStore';
import { useWorkspace, type WorkspaceTab } from '../../state/workspaceStore';
import { Button, cx, EmptyState, IconButton, Modal } from '../../components/ui/primitives';
import { ServerStackIcon } from '../../components/ui/icons';
import { BroadcastToggle } from '../broadcast/BroadcastPanel';
import { SplitView } from './SplitView';
import { usePaneLabel } from './TerminalPane';

function SessionTabView({ tab }: { tab: WorkspaceTab }) {
  const active = useWorkspace((state) => state.activeTabId === tab.id);
  const activateTab = useWorkspace((state) => state.activateTab);
  const requestCloseTab = useWorkspace((state) => state.requestCloseTab);
  const panes = collectPanes(tab.root);
  // Named after the first pane rather than the focused one, so that moving focus does not relabel the tab.
  const first = panes[0]!;
  const { title } = usePaneLabel(first.target);
  const failed = useWorkspace((state) => panes.some((item) => state.panes[item.id]?.state === 'failed'));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Delete') {
      event.preventDefault();
      requestCloseTab(tab.id);
    }
  };

  return (
    <div
      data-testid="session-tab"
      data-active={active}
      onAuxClick={(event) => {
        if (event.button === 1) requestCloseTab(tab.id);
      }}
      className={cx(
        'group ryft-no-drag relative flex h-[38px] max-w-[220px] min-w-[124px] flex-[0_1_180px] items-center rounded-card border transition-colors duration-120',
        active ? 'border-border-active bg-tab-active shadow-glow' : 'border-border bg-tab-idle hover:border-border-hover'
      )}
    >
      {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-cyan" />}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => activateTab(tab.id)}
        onKeyDown={onKeyDown}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-card pl-2.5 text-left"
      >
        <span className={cx('flex-none', failed && 'text-error')}>
          {first.target.kind === 'ssh' ? (
            <ServerStackIcon size={15} muted={failed} />
          ) : first.target.kind === 'docker' ? (
            <Container size={15} className={failed ? 'text-error' : 'text-cyan'} />
          ) : (
            <SquareTerminal size={15} className={failed ? 'text-error' : 'text-cyan'} />
          )}
        </span>
        <span className={cx('min-w-0 flex-1 truncate text-xs', active ? 'font-medium text-text' : 'text-secondary')}>
          {title}
          {panes.length > 1 && <span className="text-subtle"> · {panes.length}</span>}
        </span>
      </button>
      <IconButton label="Tab schließen" shortcut="Ctrl+W" size={22} className="mr-1" onClick={() => requestCloseTab(tab.id)}>
        <X size={13} />
      </IconButton>
    </div>
  );
}

/** What the `+` opens: a real choice between local shells and saved hosts. */
function SessionChooser() {
  const chooser = useWorkspace((state) => state.chooser);
  const setChooser = useWorkspace((state) => state.setChooser);
  const openTab = useWorkspace((state) => state.openTab);
  const splitActive = useWorkspace((state) => state.splitActive);
  const focusPane = useWorkspace((state) => state.focusPane);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const openEditor = useApp((state) => state.openEditor);
  const open = chooser !== null;
  const [distros, setDistros] = useState<WslDistro[]>([]);

  useEffect(() => {
    if (!open) return;
    // Only reads what WSL knows. A distribution that is not running stays that way until someone picks it.
    void api.invoke(Channels.wslStatus).then((status) => setDistros(status.distros)).catch(() => setDistros([]));
  }, [open]);

  const choose = (target: SessionTarget) => {
    if (chooser?.split) {
      focusPane(chooser.split.paneId);
      splitActive(chooser.split.direction, target);
    } else {
      openTab(target);
    }
  };

  const row = 'flex h-9 flex-none items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] text-text hover:bg-hover';
  return (
    <Modal
      open={chooser !== null}
      onOpenChange={(open) => !open && setChooser(null)}
      title={chooser?.split ? 'Was soll im neuen Bereich laufen?' : 'Neue Sitzung'}
      width={420}
    >
      <div className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto px-3 pb-3">
        <div className="px-2.5 py-1 text-[11px] font-medium text-subtle">Lokal</div>
        {/* wsl.exe exists on Windows even without WSL, and every real distribution has its own row below. */}
        {shells.filter((shell) => shell.id !== 'wsl').map((shell) => (
          <button key={shell.id} type="button" className={row} onClick={() => choose({ kind: 'local', shellId: shell.id })}>
            <SquareTerminal size={16} className="text-cyan" />
            {shell.label}
          </button>
        ))}
        {distros.length > 0 && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle">WSL</div>}
        {distros.map((distro) => (
          <button key={distro.name} type="button" className={row} onClick={() => choose({ kind: 'wsl', distro: distro.name })}>
            <SquareTerminal size={16} className="text-cyan" />
            <span className="min-w-0 flex-1 truncate">{distro.name}</span>
            <span className="flex-none text-[11px] text-secondary">{distro.running ? 'Läuft' : 'Startet beim Öffnen'}</span>
          </button>
        ))}
        <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle">SSH</div>
        {hosts.map((host) => (
          <button key={host.id} type="button" className={row} onClick={() => choose({ kind: 'ssh', hostId: host.id })}>
            <ServerStackIcon size={16} />
            <span className="min-w-0 flex-1 truncate">{host.name}</span>
            <span className="truncate text-[11px] text-secondary">{host.hostname}</span>
          </button>
        ))}
        {hosts.length === 0 && (
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setChooser(null);
              openEditor(null);
            }}
          >
            <Plus size={14} /> Host hinzufügen
          </Button>
        )}
      </div>
    </Modal>
  );
}

function WorkspaceEmpty() {
  const setChooser = useWorkspace((state) => state.setChooser);
  const openTab = useWorkspace((state) => state.openTab);
  const defaultShellId = useApp((state) => state.preferences?.defaultShellId ?? null);
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<Server size={28} />}
        title="Keine offene Sitzung"
        description="Doppelklicke einen Host, um dich zu verbinden, oder starte eine lokale Shell."
        action={
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => openTab({ kind: 'local', shellId: defaultShellId })}>
              <SquareTerminal size={14} /> Lokales Terminal
            </Button>
            <Button onClick={() => setChooser({ split: null })}>Sitzung wählen</Button>
          </div>
        }
      />
    </div>
  );
}

export function Workspace() {
  const tabs = useWorkspace((state) => state.tabs);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const setChooser = useWorkspace((state) => state.setChooser);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col">
      <div role="tablist" aria-label="Sitzungen" className="flex h-[42px] flex-none items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <SessionTabView key={tab.id} tab={tab} />
        ))}
        <IconButton label="Neue Sitzung" size={26} onClick={() => setChooser({ split: null })}>
          <Plus size={15} />
        </IconButton>
        <BroadcastToggle />
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 && <WorkspaceEmpty />}
        {/* Inactive tabs stay mounted but hidden, so their sessions and scrollback keep running. */}
        {tabs.map((tab) => (
          <div key={tab.id} className={cx('h-full min-h-0', tab.id !== activeTabId && 'hidden')}>
            <SplitView root={tab.root} tabId={tab.id} />
          </div>
        ))}
      </div>
      <SessionChooser />
    </main>
  );
}
