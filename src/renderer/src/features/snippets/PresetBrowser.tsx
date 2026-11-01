import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, CircleSlash, Copy, CornerDownLeft, LoaderCircle, RefreshCw, Search, Star } from 'lucide-react';
import type { Snippet, SnippetParamType, SnippetShell, TerminalContext } from '@shared/contracts';
import { fuzzyScore } from '@shared/features/commandHistory';
import { evaluateCompatibility, mergeContext, platformLabel, UNKNOWN_CONTEXT } from '@shared/features/snippetCompat';
import { classifyCommand } from '@shared/features/snippetRisk';
import { detectsOnItsOwn, liveTargets } from '../../lib/sessionTargets';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, Checkbox, cx, IconButton, Select } from '../../components/ui/primitives';
import { CompatBadge, RiskBadge } from './snippetBadges';
import { useSnippets } from './snippetStore';

export const SHELL_NAME: Record<SnippetShell, string> = { posix: 'POSIX', powershell: 'PowerShell', cmd: 'cmd' };

export const PARAM_TYPE_LABEL: Record<SnippetParamType, string> = {
  text: 'Text',
  integer: 'Zahl',
  port: 'Port',
  host: 'Hostname',
  user: 'Benutzer',
  path: 'Pfad',
  identifier: 'Bezeichner',
  enum: 'Auswahl',
  url: 'Adresse'
};

const ALL = '';
const FAVORITES = 'favorites';
const SPLIT_PLACEHOLDERS = /(\{\{\s*[A-Za-z_][A-Za-z0-9_-]{0,63}\s*(?::[^{}\r\n]*)?\}\})/;

function CommandTemplate({ command }: { command: string }) {
  return (
    <code
      data-testid="preset-command"
      className="block rounded-control border border-border bg-canvas px-2.5 py-1.5 font-terminal text-xs break-all whitespace-pre-wrap text-text select-text"
    >
      {command.split(SPLIT_PLACEHOLDERS).map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="text-cyan">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </code>
  );
}

function ToolStatus({ tool, context }: { tool: string; context: TerminalContext }) {
  const available = context.tools?.[tool];
  const Icon = available === true ? CircleCheck : available === false ? CircleSlash : CircleHelp;
  const color = available === true ? 'text-success' : available === false ? 'text-error' : 'text-subtle';
  const state = available === true ? 'vorhanden' : available === false ? 'fehlt' : 'nicht geprüft';
  return (
    <span className="flex items-center gap-1 text-[11px] text-secondary" title={`${tool}: ${state}`}>
      <Icon size={12} className={color} aria-label={state} />
      <span className="font-terminal">{tool}</span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-secondary">{title}</span>
      {children}
    </div>
  );
}

function PresetDetail({
  snippet,
  context,
  paneId,
  onCopied
}: {
  snippet: Snippet;
  context: TerminalContext;
  paneId: string | null;
  onCopied(copy: Snippet): void;
}) {
  const openRun = useSnippets((state) => state.openRun);
  const duplicate = useSnippets((state) => state.duplicate);
  const setFavorite = useSnippets((state) => state.setFavorite);
  const compatibility = evaluateCompatibility(snippet, context);
  const reasons = classifyCommand(snippet.command).reasons;

  return (
    <div data-testid="preset-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-text">{snippet.name}</h3>
            <IconButton
              label={snippet.favorite ? `${snippet.name} aus Favoriten entfernen` : `${snippet.name} als Favorit markieren`}
              aria-pressed={snippet.favorite}
              onClick={() => void attempt(() => setFavorite(snippet))}
            >
              <Star size={14} className={snippet.favorite ? 'fill-current text-cyan' : undefined} />
            </IconButton>
          </div>
          <p className="text-xs text-secondary">{snippet.description}</p>
          <div className="flex flex-wrap items-center gap-3">
            <RiskBadge risk={snippet.risk} />
            <CompatBadge compatibility={compatibility} />
          </div>
        </div>

        <Section title="Befehl">
          <CommandTemplate command={snippet.command} />
        </Section>

        {compatibility.reasons.length > 0 && (
          <Section title={compatibility.status === 'incompatible' ? 'Warum es nicht passt' : 'Noch nicht bekannt'}>
            <ul className="flex flex-col gap-0.5 text-[11px] text-secondary">
              {compatibility.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Section>
        )}

        {snippet.risk !== 'safe' && reasons.length > 0 && (
          <Section title="Was der Befehl tut">
            <ul className="flex flex-col gap-0.5 text-[11px] text-secondary">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Section>
        )}

        {snippet.params.length > 0 && (
          <Section title="Parameter">
            <dl className="flex flex-col gap-1.5">
              {snippet.params.map((param) => (
                <div key={param.name} className="flex flex-col">
                  <dt className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-text">
                    <span className="font-terminal">{param.name}</span>
                    <span className="text-subtle">
                      {PARAM_TYPE_LABEL[param.type ?? 'text']}
                      {param.required === false ? ', optional' : ''}
                      {param.defaultValue ? `, Standard: ${param.defaultValue}` : ''}
                    </span>
                  </dt>
                  {param.description && <dd className="text-[11px] text-secondary">{param.description}</dd>}
                </div>
              ))}
            </dl>
          </Section>
        )}

        {snippet.requiredTools.length > 0 && (
          <Section title="Benötigt">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {snippet.requiredTools.map((tool) => (
                <ToolStatus key={tool} tool={tool} context={context} />
              ))}
            </div>
          </Section>
        )}

        <Section title="Läuft auf">
          <p className="text-[11px] text-secondary">
            {[
              snippet.platforms.length > 0 ? snippet.platforms.map(platformLabel).join(', ') : 'Alle Systeme',
              snippet.shells.length > 0 ? snippet.shells.map((shell) => SHELL_NAME[shell]).join(', ') : 'alle Shells'
            ].join(' · ')}
          </p>
        </Section>
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
        <Button onClick={() => void attempt(async () => onCopied(await duplicate(snippet.id)))}>
          <Copy size={13} /> Kopie bearbeiten
        </Button>
        <Button variant="primary" onClick={() => openRun(snippet, paneId ?? undefined)}>
          <CornerDownLeft size={13} /> Einfügen…
        </Button>
      </div>
    </div>
  );
}

function contextSummary(context: TerminalContext, tools: readonly string[]): string {
  const platform = context.platform ? platformLabel(context.platform) : 'System unbekannt';
  const shell = context.shell ? SHELL_NAME[context.shell] : 'Shell unbekannt';
  const known = context.tools;
  const checked = known ? `${tools.filter((tool) => known[tool]).length} von ${tools.length} Werkzeugen gefunden` : 'Werkzeuge nicht geprüft';
  return `${platform} · ${shell} · ${checked}`;
}

/** The read-only library: what fits the chosen terminal, what each entry does, and a way to make it one's own. */
export function PresetBrowser({ onCopied }: { onCopied(copy: Snippet): void }) {
  const snippets = useSnippets((state) => state.snippets);
  const contexts = useSnippets((state) => state.contexts);
  const detecting = useSnippets((state) => state.detecting);
  const detect = useSnippets((state) => state.detect);
  const setFavorite = useSnippets((state) => state.setFavorite);
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const preferences = useApp((state) => state.preferences);
  const nodePlatform = useApp((state) => state.info?.platform);
  const toast = useApp((state) => state.toast);

  const targets = useMemo(
    () => liveTargets(tabs, panes, hosts, shells, preferences, nodePlatform),
    [tabs, panes, hosts, shells, preferences, nodePlatform]
  );
  const [chosenPane, setChosenPane] = useState<string | null>(() => tabs.find((tab) => tab.id === activeTabId)?.activePaneId ?? null);
  const target = targets.find((item) => item.paneId === chosenPane) ?? targets[0] ?? null;
  const paneId = target?.paneId ?? null;
  const context = target ? mergeContext(target.context, contexts[target.paneId]) : UNKNOWN_CONTEXT;
  const isDetecting = paneId !== null && detecting.includes(paneId);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);
  const [onlyFitting, setOnlyFitting] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const library = useMemo(() => snippets.filter((item) => item.source === 'builtin'), [snippets]);
  const toolNames = useMemo(() => [...new Set(library.flatMap((item) => item.requiredTools))], [library]);

  const localPaneToDetect = target && !contexts[target.paneId] && detectsOnItsOwn(target, tabs) ? target.paneId : null;
  useEffect(() => {
    if (localPaneToDetect) void attempt(() => detect(localPaneToDetect).then(() => undefined));
  }, [localPaneToDetect, detect]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of library) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    return [...counts.entries()];
  }, [library]);

  const entries = useMemo(
    () =>
      library
        .filter((item) => category === ALL || (category === FAVORITES ? item.favorite : item.category === category))
        .map((item) => {
          const haystacks = [item.name, item.command, item.description, item.category, item.tags.join(' ')];
          const scores = haystacks.map((text) => fuzzyScore(query, text)).filter((score): score is number => score !== null);
          return { item, score: scores.length > 0 ? Math.max(...scores) : null, compatibility: evaluateCompatibility(item, context) };
        })
        .filter((entry) => entry.score !== null),
    [library, category, query, context]
  );
  const hidden = onlyFitting ? entries.filter((entry) => entry.compatibility.status === 'incompatible').length : 0;
  const visible = useMemo(() => {
    const shown = onlyFitting ? entries.filter((entry) => entry.compatibility.status !== 'incompatible') : entries;
    return query.trim() ? [...shown].sort((a, b) => (b.score as number) - (a.score as number)) : shown;
  }, [entries, onlyFitting, query]);

  const selected = visible.find((entry) => entry.item.id === selectedId)?.item ?? visible[0]?.item ?? null;

  const runDetection = () => {
    if (!paneId) return;
    void attempt(async () => {
      const found = await detect(paneId);
      if (found.platform === null && found.shell === null && found.tools === null) {
        toast('info', 'Diese Sitzung ließ sich nicht prüfen. Die Eignung bleibt unbekannt.');
      }
    });
  };

  const moveSelection = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = visible.findIndex((entry) => entry.item.id === selected?.id);
    const next = visible[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    setSelectedId(next.item.id);
    document.getElementById(`preset-${next.item.id}`)?.focus();
  };

  const favorites = library.filter((item) => item.favorite).length;
  const categoryButtons = [
    { value: ALL, label: 'Alle', count: library.length },
    { value: FAVORITES, label: 'Favoriten', count: favorites },
    ...categories.map(([value, count]) => ({ value, label: value, count }))
  ];

  return (
    <div data-testid="preset-browser" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="w-52 flex-none">
          <Select
            ariaLabel="Terminal"
            value={paneId ?? ''}
            onChange={setChosenPane}
            options={targets.length > 0 ? targets.map((item) => ({ value: item.paneId, label: item.label })) : [{ value: '', label: 'Kein Terminal offen' }]}
          />
        </div>
        <span data-testid="preset-context" className="min-w-0 flex-1 truncate text-[11px] text-secondary" title="Erkannt wird, wie die Sitzung gestartet wurde, nicht eine darin gestartete Shell.">
          {target ? contextSummary(context, toolNames) : 'Ohne Terminal bleibt die Eignung unbekannt.'}
        </span>
        <Button disabled={!target || isDetecting} onClick={runDetection}>
          {isDetecting ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />} Erkennen
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div role="group" aria-label="Kategorien" className="flex w-40 flex-none flex-col gap-0.5 overflow-y-auto border-r border-border p-2">
          {categoryButtons.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={category === item.value}
              onClick={() => setCategory(item.value)}
              className={cx(
                'flex h-7 flex-none items-center justify-between gap-2 rounded-control px-2 text-xs transition-colors duration-120',
                category === item.value ? 'bg-selected-strong text-text' : 'text-secondary hover:bg-hover hover:text-text'
              )}
            >
              <span className="truncate">{item.label}</span>
              <span className="flex-none text-[11px] text-subtle">{item.count}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-3 border-b border-border px-3 py-2">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border border-border bg-canvas px-2 focus-within:border-border-active">
              <Search size={14} className="flex-none text-subtle" />
              <input
                aria-label="Bibliothek durchsuchen"
                placeholder="Bibliothek durchsuchen…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="ryft-bare-input min-w-0 flex-1 bg-transparent text-xs text-text select-text placeholder:text-subtle"
              />
            </div>
            <Checkbox label="Nur passende" checked={onlyFitting} onChange={setOnlyFitting} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" onKeyDown={moveSelection}>
            {visible.map(({ item, compatibility }) => (
              <div
                key={item.id}
                data-testid="preset-row"
                data-preset={item.presetId ?? undefined}
                className={cx(
                  'flex flex-none items-center gap-1 border-b border-border pl-1.5 pr-3 transition-colors duration-120',
                  item.id === selected?.id ? 'bg-selected-strong' : 'hover:bg-hover'
                )}
              >
                <IconButton
                  label={item.favorite ? `${item.name} aus Favoriten entfernen` : `${item.name} als Favorit markieren`}
                  aria-pressed={item.favorite}
                  onClick={() => void attempt(() => setFavorite(item))}
                >
                  <Star size={13} className={item.favorite ? 'fill-current text-cyan' : undefined} />
                </IconButton>
                <button
                  id={`preset-${item.id}`}
                  type="button"
                  aria-current={item.id === selected?.id}
                  onClick={() => setSelectedId(item.id)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 text-left"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs font-medium text-text">{item.name}</span>
                    {category === ALL && <span className="flex-none text-[11px] text-subtle">{item.category}</span>}
                  </span>
                  <code className="truncate font-terminal text-[11px] text-secondary">{item.command}</code>
                </button>
                <RiskBadge risk={item.risk} compact />
                <CompatBadge compatibility={compatibility} compact />
              </div>
            ))}
            {visible.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-secondary">Keine Treffer</p>}
            {hidden > 0 && (
              <p data-testid="preset-hidden" className="flex-none px-4 py-2 text-center text-[11px] text-subtle">
                {hidden === 1 ? '1 Eintrag passt nicht zu diesem Terminal und ist ausgeblendet.' : `${hidden} Einträge passen nicht zu diesem Terminal und sind ausgeblendet.`}
              </p>
            )}
          </div>
        </div>
        <div className="flex w-[360px] flex-none flex-col border-l border-border">
          {selected ? (
            <PresetDetail key={selected.id} snippet={selected} context={context} paneId={paneId} onCopied={onCopied} />
          ) : (
            <p className="px-4 py-6 text-center text-[13px] text-secondary">Nichts ausgewählt</p>
          )}
        </div>
      </div>
    </div>
  );
}
