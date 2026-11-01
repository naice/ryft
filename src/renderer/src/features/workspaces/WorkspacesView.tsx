import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Copy, Download, FileUp, LayoutPanelTop, Pencil, Plug, Play, Save, Star, Trash2 } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { LayoutNode, WorkspaceDefinition, WorkspaceSummary } from '@shared/contracts';
import { api } from '../../lib/api';
import { collectPanes } from '../../lib/layoutTree';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Modal, TEXTAREA } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';

function mapPanes(node: LayoutNode, edit: (pane: Extract<LayoutNode, { type: 'pane' }>) => LayoutNode): LayoutNode {
  return node.type === 'pane' ? edit(node) : { ...node, first: mapPanes(node.first, edit), second: mapPanes(node.second, edit) };
}

interface PaneDraft {
  cwd: string;
  commands: string;
}

function WorkspaceEditor({
  summary,
  definition,
  onClose,
  onSaved
}: {
  summary: WorkspaceSummary | null;
  definition: WorkspaceDefinition;
  onClose(): void;
  onSaved(): void;
}) {
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const allowed = useApp((state) => state.preferences?.workspaceStartupCommands ?? false);
  const [name, setName] = useState(summary?.name ?? '');
  const [approved, setApproved] = useState(definition.startupApproved);
  const [nameError, setNameError] = useState<string | null>(null);
  const panes = useMemo(() => definition.layout.tabs.flatMap((tab) => collectPanes(tab.root)), [definition]);
  const [drafts, setDrafts] = useState<Record<string, PaneDraft>>(() =>
    Object.fromEntries(panes.map((pane) => [pane.id, { cwd: pane.cwd ?? '', commands: (pane.startupCommands ?? []).join('\n') }]))
  );
  const hasCommands = Object.values(drafts).some((draft) => draft.commands.trim() !== '');

  const paneLabel = (pane: (typeof panes)[number]): string => {
    const { target } = pane;
    if (target.kind === 'ssh') return hosts.find((host) => host.id === target.hostId)?.name ?? 'Nicht verfügbarer Host';
    if (target.kind === 'docker') return `Docker: ${target.containerName}`;
    if (target.kind === 'wsl') return `WSL: ${target.distro ?? 'Standard'}`;
    return shells.find((shell) => shell.id === target.shellId)?.label ?? 'Lokale Shell';
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setNameError('Name erforderlich');
      return;
    }
    const next: WorkspaceDefinition = {
      ...definition,
      startupApproved: approved && hasCommands,
      layout: {
        ...definition.layout,
        tabs: definition.layout.tabs.map((tab) => ({
          ...tab,
          root: mapPanes(tab.root, (pane) => {
            const draft = drafts[pane.id];
            const startupCommands = (draft?.commands ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
            return { ...pane, cwd: draft?.cwd.trim() || null, startupCommands };
          })
        }))
      }
    };
    void attempt(async () => {
      if (summary) await api.invoke(Channels.workspacesUpdate, { id: summary.id, name, definition: next });
      else await api.invoke(Channels.workspacesCreate, { name, definition: next });
      onSaved();
      onClose();
    });
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={summary ? 'Workspace bearbeiten' : 'Workspace speichern'} width={560}>
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <Field label="Name" htmlFor="workspace-name" error={nameError}>
            <Input
              id="workspace-name"
              autoFocus
              maxLength={128}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          </Field>
          {panes.map((pane, index) => (
            <div key={pane.id} data-testid="workspace-pane" className="flex flex-col gap-2 rounded-control border border-border bg-card p-2.5">
              <span className="text-xs font-medium text-text">
                {index + 1}. {paneLabel(pane)}
              </span>
              <Field label="Arbeitsverzeichnis" htmlFor={`workspace-cwd-${pane.id}`}>
                <Input
                  id={`workspace-cwd-${pane.id}`}
                  spellCheck={false}
                  value={drafts[pane.id]?.cwd ?? ''}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [pane.id]: { commands: current[pane.id]?.commands ?? '', cwd: event.target.value } }))
                  }
                />
              </Field>
              <Field label="Startbefehle" htmlFor={`workspace-commands-${pane.id}`} hint="Ein Befehl je Zeile.">
                <textarea
                  id={`workspace-commands-${pane.id}`}
                  rows={2}
                  spellCheck={false}
                  value={drafts[pane.id]?.commands ?? ''}
                  onChange={(event) => {
                    // A release covers the commands that were read, not whatever they turn into.
                    setApproved(false);
                    setDrafts((current) => ({ ...current, [pane.id]: { cwd: current[pane.id]?.cwd ?? '', commands: event.target.value } }));
                  }}
                  className={TEXTAREA}
                />
              </Field>
            </div>
          ))}
          {hasCommands && (
            <div className="flex flex-col gap-2 rounded-control border border-warning p-2.5 text-xs text-text">
              <p className="flex items-start gap-2">
                <AlertTriangle size={15} className="mt-px flex-none text-warning" />
                <span>Startbefehle laufen beim Öffnen dieses Workspaces ohne weitere Nachfrage. Lies sie vor der Freigabe.</span>
              </p>
              <Checkbox label="Ich habe die Startbefehle geprüft und gebe sie frei" checked={approved} onChange={setApproved} />
              {!allowed && (
                <span className="text-[11px] text-subtle">
                  Zusätzlich muss „Startbefehle von Workspaces ausführen“ unter Einstellungen › Verbindungen eingeschaltet sein.
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary">
            Speichern
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const COLUMNS = 'grid-cols-[minmax(160px,2fr)_minmax(90px,0.8fr)_minmax(110px,1fr)_238px]';
const UPDATED = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export function WorkspacesView() {
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const openWorkspace = useWorkspace((state) => state.openWorkspace);
  const currentDefinition = useWorkspace((state) => state.currentDefinition);
  const hasTabs = useWorkspace((state) => state.tabs.length > 0);
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [editing, setEditing] = useState<{ summary: WorkspaceSummary | null; definition: WorkspaceDefinition } | null>(null);

  const load = useCallback(() => attempt(async () => setItems(await api.invoke(Channels.workspacesList))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (item: WorkspaceSummary, connect: boolean) =>
    void attempt(async () => openWorkspace(await api.invoke(Channels.workspacesGet, { id: item.id }), connect));

  const importFile = () =>
    void attempt(async () => {
      const result = await api.invoke(Channels.workspacesImport);
      if (!result) return;
      await load();
      toast(
        result.unresolvedHosts.length > 0 ? 'info' : 'success',
        result.unresolvedHosts.length > 0
          ? `„${result.workspace.name}“ importiert. Nicht gefunden: ${result.unresolvedHosts.join(', ')}. Diese Bereiche melden beim Verbinden einen Fehler.`
          : `„${result.workspace.name}“ importiert. Startbefehle bleiben gesperrt, bis du sie freigibst.`
      );
    });

  return (
    <ToolView
      testId="workspaces-view"
      title="Workspaces"
      description={items.length === 1 ? '1 gespeicherte Arbeitsumgebung' : `${items.length} gespeicherte Arbeitsumgebungen`}
      actions={
        <>
          <Button onClick={importFile}>
            <FileUp size={14} /> Importieren
          </Button>
          <Button variant="primary" disabled={!hasTabs} onClick={() => setEditing({ summary: null, definition: currentDefinition() })}>
            <Save size={14} /> Aktuelles Layout speichern
          </Button>
        </>
      }
    >
      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<LayoutPanelTop size={26} />}
            title="Noch keine Workspaces"
            description={
              hasTabs
                ? 'Speichere deine offenen Tabs und Teilungen, um sie später wieder zu öffnen.'
                : 'Öffne Terminals und teile sie nach Bedarf. Danach lässt sich das Layout hier speichern.'
            }
          />
        </div>
      ) : (
        <div role="table" aria-label="Workspaces" className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div role="row" className={cx('grid h-7 flex-none items-center gap-3 border-b border-border px-4 text-[11px] text-subtle', COLUMNS)}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Umfang</span>
            <span role="columnheader">Geändert</span>
            <span role="columnheader" className="sr-only">
              Aktionen
            </span>
          </div>
          {items.map((item) => (
            <div role="row" key={item.id} data-testid="workspace-row" className={cx('grid min-h-10 flex-none items-center gap-3 border-b border-border px-4 py-1', COLUMNS)}>
              <span role="cell" className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-medium text-text">{item.name}</span>
                {item.isDefault && <span className="flex-none rounded-full bg-selected-strong px-2 text-[11px] leading-[18px] text-cyan">Standard</span>}
              </span>
              <span role="cell" className="truncate text-xs text-secondary">
                {item.tabCount} Tabs, {item.paneCount} Bereiche
              </span>
              <span role="cell" className="truncate text-xs text-secondary">
                {UPDATED.format(new Date(item.updatedAt))}
              </span>
              <span role="cell" className="flex items-center justify-end gap-0.5">
                <IconButton label={`${item.name} öffnen`} onClick={() => open(item, false)}>
                  <Play size={13} className="text-cyan" />
                </IconButton>
                <IconButton label={`${item.name} öffnen und verbinden`} onClick={() => open(item, true)}>
                  <Plug size={13} className="text-cyan" />
                </IconButton>
                <IconButton
                  label={`${item.name} bearbeiten`}
                  onClick={() =>
                    void attempt(async () =>
                      setEditing({ summary: item, definition: await api.invoke(Channels.workspacesGet, { id: item.id }) })
                    )
                  }
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  label={`${item.name} mit aktuellem Layout überschreiben`}
                  disabled={!hasTabs}
                  onClick={() =>
                    askConfirm({
                      title: `„${item.name}“ überschreiben?`,
                      message: 'Das gespeicherte Layout wird durch die offenen Tabs ersetzt. Startbefehle müssen danach neu freigegeben werden.',
                      confirmLabel: 'Überschreiben',
                      danger: true,
                      onConfirm: () =>
                        void attempt(async () => {
                          await api.invoke(Channels.workspacesUpdate, { id: item.id, definition: currentDefinition() });
                          await load();
                        })
                    })
                  }
                >
                  <Save size={13} />
                </IconButton>
                <IconButton
                  label={`${item.name} duplizieren`}
                  onClick={() =>
                    void attempt(async () => {
                      await api.invoke(Channels.workspacesDuplicate, { id: item.id });
                      await load();
                    })
                  }
                >
                  <Copy size={13} />
                </IconButton>
                <IconButton
                  label={item.isDefault ? `${item.name} nicht mehr als Standard öffnen` : `${item.name} beim Start öffnen`}
                  aria-pressed={item.isDefault}
                  onClick={() =>
                    void attempt(async () => {
                      await api.invoke(Channels.workspacesSetDefault, { id: item.isDefault ? null : item.id });
                      await load();
                    })
                  }
                >
                  <Star size={13} className={item.isDefault ? 'fill-current text-cyan' : undefined} />
                </IconButton>
                <IconButton
                  label={`${item.name} exportieren`}
                  onClick={() =>
                    void attempt(async () => {
                      if (await api.invoke(Channels.workspacesExport, { id: item.id })) toast('success', 'Workspace exportiert, ohne Zugangsdaten');
                    })
                  }
                >
                  <Download size={13} />
                </IconButton>
                <IconButton
                  label={`${item.name} löschen`}
                  onClick={() =>
                    askConfirm({
                      title: `„${item.name}“ löschen?`,
                      message: 'Der Workspace wird entfernt. Offene Tabs und laufende Sitzungen bleiben.',
                      confirmLabel: 'Löschen',
                      danger: true,
                      onConfirm: () =>
                        void attempt(async () => {
                          await api.invoke(Channels.workspacesDelete, { id: item.id });
                          await load();
                        })
                    })
                  }
                >
                  <Trash2 size={13} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      )}
      {editing && <WorkspaceEditor summary={editing.summary} definition={editing.definition} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </ToolView>
  );
}
