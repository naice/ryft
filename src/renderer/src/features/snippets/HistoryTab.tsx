import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardPaste, Copy, History, Search, Settings, Trash2 } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { CommandHistoryEntry } from '@shared/contracts';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, EmptyState, IconButton, Select } from '../../components/ui/primitives';
import { insertIntoPane } from './snippetStore';

const TIME = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

function HistoryRow({ entry, paneId, onChanged }: { entry: CommandHistoryEntry; paneId: string | null; onChanged(): void }) {
  const toast = useApp((state) => state.toast);
  const showTerminals = useApp((state) => state.showTerminals);
  return (
    <div data-testid="history-row" className="flex flex-none items-center gap-3 border-b border-border px-4 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <code className="truncate font-terminal text-xs text-text select-text" title={entry.command}>
          {entry.command}
        </code>
        <span className="truncate text-[11px] text-subtle">
          {entry.sessionLabel}
          {entry.cwd ? ` · ${entry.cwd}` : ''}
          {entry.exitCode !== null ? ` · Exit ${entry.exitCode}` : ''} · {TIME.format(new Date(entry.createdAt))}
        </span>
      </div>
      <div className="flex flex-none items-center gap-0.5">
        <IconButton
          label="In aktives Terminal einfügen"
          disabled={!paneId}
          onClick={() => {
            if (!paneId) return;
            showTerminals();
            insertIntoPane(paneId, entry.command);
          }}
        >
          <ClipboardPaste size={13} />
        </IconButton>
        <IconButton
          label="Befehl kopieren"
          onClick={() =>
            void attempt(async () => {
              await api.invoke(Channels.clipboardWrite, { text: entry.command });
              toast('success', 'Befehl kopiert');
            })
          }
        >
          <Copy size={13} />
        </IconButton>
        <IconButton
          label="Aus dem Verlauf löschen"
          onClick={() =>
            void attempt(async () => {
              await api.invoke(Channels.commandHistoryDelete, { id: entry.id });
              onChanged();
            })
          }
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
    </div>
  );
}

export function HistoryTab() {
  const enabled = useApp((state) => state.preferences?.commandHistoryEnabled ?? false);
  const hosts = useApp((state) => state.hosts);
  const askConfirm = useApp((state) => state.askConfirm);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const paneId = useWorkspace((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId)?.activePaneId;
    return active && state.panes[active]?.state === 'connected' ? active : null;
  });
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [hostId, setHostId] = useState('');

  const load = useCallback(
    () => attempt(async () => setEntries(await api.invoke(Channels.commandHistoryList, { query, hostId: hostId || null, limit: 500 }))),
    [query, hostId]
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 120);
    return () => clearTimeout(timer);
  }, [load]);

  const hostOptions = useMemo(
    () => [{ value: '', label: 'Alle Sitzungen' }, ...hosts.map((host) => ({ value: host.id, label: host.name }))],
    [hosts]
  );

  return (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border border-border bg-canvas px-2 focus-within:border-border-active">
          <Search size={14} className="flex-none text-subtle" />
          <input
            aria-label="Verlauf durchsuchen"
            placeholder="Verlauf durchsuchen…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ryft-bare-input min-w-0 flex-1 bg-transparent text-xs text-text select-text placeholder:text-subtle"
          />
        </div>
        <div className="w-44 flex-none">
          <Select ariaLabel="Sitzung" value={hostId} onChange={setHostId} options={hostOptions} />
        </div>
        <IconButton label="Verlauf einstellen" size={32} onClick={() => setSettingsOpen(true)}>
          <Settings size={15} />
        </IconButton>
        <Button
          disabled={entries.length === 0}
          onClick={() =>
            askConfirm({
              title: 'Verlauf löschen?',
              message: 'Alle aufgezeichneten Befehle werden endgültig entfernt.',
              confirmLabel: 'Alles löschen',
              danger: true,
              onConfirm: () =>
                void attempt(async () => {
                  await api.invoke(Channels.commandHistoryClear);
                  setEntries([]);
                })
            })
          }
        >
          Alles löschen
        </Button>
      </div>
      {!enabled && (
        <p role="status" className="flex-none border-b border-border px-4 py-2 text-xs text-warning">
          Die Aufzeichnung ist ausgeschaltet. Vorhandene Einträge bleiben, bis du sie löschst.
        </p>
      )}
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<History size={26} />}
            title={query || hostId ? 'Keine Treffer' : 'Noch kein Verlauf'}
            description="Aufgezeichnet wird in PowerShell, sowie in bash und zsh auf Hosts mit eingeschalteter Shell-Integration. Andere Shells zeichnen nichts auf, statt zu raten."
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} paneId={paneId} onChanged={() => void load()} />
          ))}
        </div>
      )}
    </>
  );
}
