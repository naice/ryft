import { Command } from 'cmdk';
import { Dialog as RadixDialog } from 'radix-ui';
import {
  ArrowLeftRight,
  Braces,
  Columns2,
  FolderOpen,
  KeyRound,
  LayoutPanelTop,
  Plus,
  Rows2,
  Search,
  Settings,
  SquareTerminal,
  X, Bot, Container, RadioTower, ScrollText } from 'lucide-react';
import { useAi } from '../ai/aiStore';
import { useBroadcast } from '../broadcast/broadcastStore';
import { useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { ServerStackIcon } from '../../components/ui/icons';

const ITEM =
  'flex h-9 cursor-default items-center gap-2.5 rounded-control px-2.5 text-[13px] text-text data-[selected=true]:bg-selected-strong';
const HEADING =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle';

function Shortcut({ keys }: { keys: string }) {
  return <span className="ml-auto flex-none text-[11px] text-subtle">{keys}</span>;
}

export function CommandPalette() {
  const open = useApp((state) => state.paletteOpen);
  const setOpen = useApp((state) => state.setPaletteOpen);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const openEditor = useApp((state) => state.openEditor);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const setNav = useApp((state) => state.setNav);
  const isMac = useApp((state) => state.info?.platform === 'darwin');
  const connectHost = useWorkspace((state) => state.connectHost);
  const openTab = useWorkspace((state) => state.openTab);
  const splitActive = useWorkspace((state) => state.splitActive);
  const requestCloseTab = useWorkspace((state) => state.requestCloseTab);
  const activeTabId = useWorkspace((state) => state.activeTabId);

  const mod = isMac ? '⌘' : 'Ctrl+';
  const shift = isMac ? '⇧' : 'Shift+';
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ryft-anim-overlay fixed inset-0 z-40 bg-overlay" />
        <RadixDialog.Content
          aria-describedby={undefined}
          data-testid="command-palette"
          className="ryft-anim-pop fixed top-[14%] left-1/2 z-50 flex max-h-[60vh] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 flex-col overflow-hidden rounded-panel border border-border bg-host-panel shadow-float"
        >
          <RadixDialog.Title className="sr-only">Befehlspalette</RadixDialog.Title>
          <Command label="Befehlspalette" className="flex min-h-0 flex-col" loop>
            <div className="flex h-11 flex-none items-center gap-2 border-b border-border px-3">
              <Search size={16} className="flex-none text-subtle" />
              <Command.Input
                autoFocus
                placeholder="Host oder Befehl suchen…"
                className="ryft-bare-input min-w-0 flex-1 bg-transparent text-[13px] text-text select-text placeholder:text-subtle"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
              <Command.Empty className="px-2.5 py-6 text-center text-[13px] text-secondary">Keine Treffer</Command.Empty>
              {hosts.length > 0 && (
                <Command.Group heading="Hosts" className={HEADING}>
                  {hosts.map((host) => (
                    <Command.Item
                      key={host.id}
                      value={`verbinden ${host.name} ${host.hostname} ${host.username} ${host.tags.join(' ')} ${host.id}`}
                      className={ITEM}
                      onSelect={() => run(() => connectHost(host.id))}
                    >
                      <ServerStackIcon size={16} />
                      <span className="min-w-0 truncate">{host.name}</span>
                      <span className="ml-auto min-w-0 truncate text-[11px] text-secondary">
                        {host.username}@{host.hostname}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Aktionen" className={HEADING}>
                <Command.Item value="host hinzufügen neu" className={ITEM} onSelect={() => run(() => openEditor(null))}>
                  <Plus size={16} className="text-secondary" /> Host hinzufügen
                </Command.Item>
                {shells.map((shell, index) => (
                  <Command.Item
                    key={shell.id}
                    value={`lokales terminal shell ${shell.label}`}
                    className={ITEM}
                    onSelect={() => run(() => openTab({ kind: 'local', shellId: shell.id }))}
                  >
                    <SquareTerminal size={16} className="text-secondary" /> Lokales Terminal: {shell.label}
                    {index === 0 && <Shortcut keys={`${mod}T`} />}
                  </Command.Item>
                ))}
                {activeTabId && (
                  <>
                    <Command.Item value="rechts teilen split" className={ITEM} onSelect={() => run(() => splitActive('row'))}>
                      <Columns2 size={16} className="text-secondary" /> Rechts teilen
                      <Shortcut keys={`${mod}${shift}D`} />
                    </Command.Item>
                    <Command.Item value="unten teilen split" className={ITEM} onSelect={() => run(() => splitActive('column'))}>
                      <Rows2 size={16} className="text-secondary" /> Unten teilen
                      <Shortcut keys={`${mod}${shift}E`} />
                    </Command.Item>
                    <Command.Item value="tab schließen" className={ITEM} onSelect={() => run(() => requestCloseTab(activeTabId))}>
                      <X size={16} className="text-secondary" /> Tab schließen
                      <Shortcut keys={`${mod}W`} />
                    </Command.Item>
                  </>
                )}
                <Command.Item value="workspaces arbeitsbereiche layout" className={ITEM} onSelect={() => run(() => setNav('workspaces'))}>
                  <LayoutPanelTop size={16} className="text-secondary" /> Workspaces
                </Command.Item>
                <Command.Item value="snippets befehle verlauf" className={ITEM} onSelect={() => run(() => setNav('snippets'))}>
                  <Braces size={16} className="text-secondary" /> Snippets und Verlauf
                </Command.Item>
                <Command.Item value="ssh keys schlüssel erzeugen importieren" className={ITEM} onSelect={() => run(() => setNav('keys'))}>
                  <KeyRound size={16} className="text-secondary" /> SSH Keys
                </Command.Item>
                <Command.Item value="docker container logs shell" className={ITEM} onSelect={() => run(() => setNav('docker'))}>
                  <Container size={16} className="text-secondary" /> Docker
                </Command.Item>
                <Command.Item value="sitzungsprotokolle logging aufzeichnung logs" className={ITEM} onSelect={() => run(() => setNav('logs'))}>
                  <ScrollText size={16} className="text-secondary" /> Sitzungsprotokolle
                </Command.Item>
                <Command.Item value="ai assistant ki ollama modell" className={ITEM} onSelect={() => run(() => useAi.getState().setOpen(true))}>
                  <Bot size={16} className="text-secondary" /> AI Assistant
                </Command.Item>
                <Command.Item value="broadcast mehrere sitzungen senden" className={ITEM} onSelect={() => run(() => useBroadcast.getState().setDialogOpen(true))}>
                  <RadioTower size={16} className="text-secondary" /> Broadcast starten
                </Command.Item>
                <Command.Item value="sftp dateien übertragen" className={ITEM} onSelect={() => run(() => setNav('sftp'))}>
                  <FolderOpen size={16} className="text-secondary" /> SFTP
                </Command.Item>
                <Command.Item
                  value="port forwarding weiterleitung tunnel socks"
                  className={ITEM}
                  onSelect={() => run(() => setNav('forwards'))}
                >
                  <ArrowLeftRight size={16} className="text-secondary" /> Port Forwarding
                </Command.Item>
                <Command.Item value="einstellungen settings" className={ITEM} onSelect={() => run(() => setSettingsOpen(true))}>
                  <Settings size={16} className="text-secondary" /> Einstellungen
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
