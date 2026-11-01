import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Download, FileJson, ScrollText, Search, Trash2 } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { SessionLogMatch, SessionLogSummary } from '@shared/contracts';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { Button, cx, EmptyState, IconButton, Input } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';
import { useSessionLogs } from './logStore';

const SEARCH_LIMIT = 200;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const formatTime = (value: number) => new Date(value).toLocaleString();

const COLUMNS = 'grid-cols-[minmax(140px,1.4fr)_minmax(140px,1fr)_minmax(140px,1fr)_80px_92px]';

function LogRow({ log }: { log: SessionLogSummary }) {
  const remove = useSessionLogs((state) => state.remove);
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);

  const exportAs = (format: 'text' | 'jsonl') =>
    void attempt(async () => {
      if (await api.invoke(Channels.sessionLogsExport, { id: log.id, format })) toast('success', 'Protokoll exportiert');
    });

  return (
    <div role="row" data-testid="log-row" className={cx('grid min-h-10 flex-none items-center gap-3 border-b border-border px-4 py-1', COLUMNS)}>
      <span role="cell" className="flex min-w-0 items-center gap-2">
        {log.active && <span className="flex-none rounded-[4px] border border-error px-1 text-[10px] font-semibold text-error">REC</span>}
        <span className="truncate text-[13px] font-medium text-text">{log.label}</span>
      </span>
      <span role="cell" className="truncate text-xs text-secondary">
        {formatTime(log.startedAt)}
      </span>
      <span role="cell" className="truncate text-xs text-secondary">
        {log.active ? 'Läuft' : log.endedAt ? formatTime(log.endedAt) : '–'}
      </span>
      <span role="cell" className="truncate text-xs text-secondary" title={log.truncated ? 'Unvollständig: Die Ausgabe kam schneller, als sie geschrieben werden konnte.' : undefined}>
        {formatSize(log.sizeBytes)}
        {log.truncated ? ' *' : ''}
      </span>
      <span role="cell" className="flex items-center justify-end gap-0.5">
        <IconButton label={`${log.label} als Text exportieren`} onClick={() => exportAs('text')}>
          <Download size={13} />
        </IconButton>
        <IconButton label={`${log.label} als JSONL exportieren`} onClick={() => exportAs('jsonl')}>
          <FileJson size={13} />
        </IconButton>
        <IconButton
          label={`${log.label} löschen`}
          disabled={log.active}
          onClick={() =>
            askConfirm({
              title: 'Protokoll löschen?',
              message: `Das Protokoll von „${log.label}“ (${formatTime(log.startedAt)}) wird endgültig gelöscht.`,
              confirmLabel: 'Löschen',
              danger: true,
              onConfirm: () => void attempt(() => remove(log.id))
            })
          }
        >
          <Trash2 size={13} />
        </IconButton>
      </span>
    </div>
  );
}

export function LogsView() {
  const logs = useSessionLogs((state) => state.logs);
  const load = useSessionLogs((state) => state.load);
  const clear = useSessionLogs((state) => state.clear);
  const askConfirm = useApp((state) => state.askConfirm);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SessionLogMatch[] | null>(null);

  useEffect(() => {
    void attempt(load);
  }, [load]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) {
      setMatches(null);
      return;
    }
    void attempt(async () => setMatches(await api.invoke(Channels.sessionLogsSearch, { query: text, limit: SEARCH_LIMIT })));
  };

  const finished = logs.filter((log) => !log.active).length;

  return (
    <ToolView
      testId="logs-view"
      title="Sitzungsprotokolle"
      description={logs.length === 1 ? '1 Protokoll' : `${logs.length} Protokolle`}
      actions={
        <Button
          disabled={finished === 0}
          onClick={() =>
            askConfirm({
              title: finished === 1 ? '1 Protokoll löschen?' : `${finished} Protokolle löschen?`,
              message: 'Alle abgeschlossenen Protokolle werden endgültig gelöscht.',
              confirmLabel: 'Löschen',
              danger: true,
              onConfirm: () => void attempt(clear)
            })
          }
        >
          <Trash2 size={14} /> Alle löschen…
        </Button>
      }
    >
      <p className="flex flex-none items-start gap-2 border-b border-border px-4 py-2 text-xs text-secondary">
        <AlertTriangle size={14} className="mt-px flex-none text-warning" />
        <span>
          Protokolle enthalten, was eine Sitzung anzeigt, und liegen unverschlüsselt in deinem Datenordner. Tastatureingaben zeichnet RYFT nicht auf. Sensible
          Ausgaben landen aber im Protokoll, auch Eingaben, die die Gegenseite als Echo anzeigt. Schalte die Aufzeichnung im Kopf des Terminals aus, bevor du
          an solche Daten gehst.
        </span>
      </p>
      <form onSubmit={search} className="flex flex-none items-center gap-2 border-b border-border px-4 py-2">
        <Input aria-label="Protokolle durchsuchen" placeholder="In Protokollen suchen…" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button type="submit" className="flex-none">
          <Search size={14} /> Suchen
        </Button>
      </form>
      {matches !== null ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="log-matches">
          <div className="flex h-8 flex-none items-center justify-between border-b border-border px-4 text-[11px] text-subtle">
            <span>{matches.length === SEARCH_LIMIT ? `Die ersten ${SEARCH_LIMIT} Treffer` : `${matches.length} Treffer`}</span>
            <Button variant="ghost" className="!h-6 text-[11px]" onClick={() => setMatches(null)}>
              Zurück zur Liste
            </Button>
          </div>
          {matches.map((match, index) => (
            <div key={`${match.logId}-${index}`} data-testid="log-match" className="flex-none border-b border-border px-4 py-1.5">
              <div className="text-[11px] text-subtle">
                {match.label} · {formatTime(match.at)}
              </div>
              <code className="font-terminal text-[11px] break-all text-text select-text">{match.line}</code>
            </div>
          ))}
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<ScrollText size={26} />}
            title="Noch keine Protokolle"
            description="Die Aufzeichnung ist aus, bis du sie im Kopf eines Terminals oder in den Einstellungen einschaltest."
          />
        </div>
      ) : (
        <div role="table" aria-label="Protokolle" className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div role="row" className={cx('grid h-7 flex-none items-center gap-3 border-b border-border px-4 text-[11px] text-subtle', COLUMNS)}>
            <span role="columnheader">Sitzung</span>
            <span role="columnheader">Beginn</span>
            <span role="columnheader">Ende</span>
            <span role="columnheader">Größe</span>
            <span role="columnheader" className="sr-only">
              Aktionen
            </span>
          </div>
          {logs.map((log) => (
            <LogRow key={log.id} log={log} />
          ))}
        </div>
      )}
    </ToolView>
  );
}
