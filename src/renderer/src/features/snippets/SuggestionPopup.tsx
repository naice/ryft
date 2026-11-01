import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { Dialog as RadixDialog } from 'radix-ui';
import { Braces, History, Search } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { CommandHistoryEntry, Snippet } from '@shared/contracts';
import { rankSuggestions } from '@shared/features/commandHistory';
import { evaluateCompatibility, mergeContext, UNKNOWN_CONTEXT } from '@shared/features/snippetCompat';
import { placeholdersOf } from '@shared/features/snippets';
import { api } from '../../lib/api';
import { liveTargets } from '../../lib/sessionTargets';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { insertIntoPane, useSnippets } from './snippetStore';

const ITEM =
  'flex h-9 cursor-default items-center gap-2.5 rounded-control px-2.5 text-[13px] text-text data-[selected=true]:bg-selected-strong';

export function SuggestionPopup() {
  const paneId = useSnippets((state) => state.suggestionsFor);
  const close = useSnippets((state) => state.closeSuggestions);
  const snippets = useSnippets((state) => state.snippets);
  const load = useSnippets((state) => state.load);
  const openRun = useSnippets((state) => state.openRun);
  const contexts = useSnippets((state) => state.contexts);
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const preferences = useApp((state) => state.preferences);
  const nodePlatform = useApp((state) => state.info?.platform);
  const historyEnabled = useApp((state) => state.preferences?.commandHistoryEnabled ?? false);
  const [history, setHistory] = useState<CommandHistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const open = paneId !== null;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    void attempt(async () => {
      await load();
      setHistory(historyEnabled ? await api.invoke(Channels.commandHistoryList, { query: '', hostId: null, limit: 500 }) : []);
    });
  }, [open, load, historyEnabled]);

  const suggestions = useMemo(() => {
    const target = liveTargets(tabs, panes, hosts, shells, preferences, nodePlatform).find((item) => item.paneId === paneId);
    const context = target && paneId ? mergeContext(target.context, contexts[paneId]) : UNKNOWN_CONTEXT;
    // A personal command comes first. The library only fills up what is left, and never offers what cannot run here.
    const fits = (item: Snippet) => evaluateCompatibility(item, context).status !== 'incompatible';
    const own = snippets.filter((item) => item.source === 'user' || (item.favorite && fits(item)));
    const library = query.trim() ? snippets.filter((item) => item.source === 'builtin' && !item.favorite && fits(item)) : [];
    const first = rankSuggestions(query, history, own, 30);
    return [...first, ...rankSuggestions(query, [], library, 30 - first.length)];
  }, [query, history, snippets, contexts, paneId, tabs, panes, hosts, shells, preferences, nodePlatform]);

  const choose = (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion || !paneId) return;
    close();
    const snippet = suggestion.kind === 'snippet' ? snippets.find((item) => item.id === suggestion.id) : undefined;
    if (snippet && placeholdersOf(snippet.command).length > 0) openRun(snippet);
    else insertIntoPane(paneId, suggestion.text);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ryft-anim-overlay fixed inset-0 z-40 bg-overlay" />
        <RadixDialog.Content
          aria-describedby={undefined}
          data-testid="suggestion-popup"
          className="ryft-anim-pop fixed top-[14%] left-1/2 z-50 flex max-h-[60vh] w-[620px] max-w-[calc(100vw-48px)] -translate-x-1/2 flex-col overflow-hidden rounded-panel border border-border bg-host-panel shadow-float"
        >
          <RadixDialog.Title className="sr-only">Befehl vorschlagen</RadixDialog.Title>
          <Command label="Befehl vorschlagen" shouldFilter={false} loop className="flex min-h-0 flex-col">
            <div className="flex h-11 flex-none items-center gap-2 border-b border-border px-3">
              <Search size={16} className="flex-none text-subtle" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Verlauf und Snippets durchsuchen…"
                className="ryft-bare-input min-w-0 flex-1 bg-transparent text-[13px] text-text select-text placeholder:text-subtle"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
              <Command.Empty className="px-2.5 py-6 text-center text-[13px] text-secondary">Keine Treffer</Command.Empty>
              {suggestions.map((suggestion, index) => (
                <Command.Item
                  key={`${suggestion.kind}-${suggestion.id}`}
                  value={`${suggestion.kind}-${suggestion.id}`}
                  className={ITEM}
                  onSelect={() => choose(index)}
                >
                  {suggestion.kind === 'snippet' ? (
                    <Braces size={15} className="flex-none text-cyan" aria-label="Snippet" />
                  ) : (
                    <History size={15} className="flex-none text-secondary" aria-label="Verlauf" />
                  )}
                  <span className="min-w-0 truncate font-terminal text-xs">{suggestion.label}</span>
                  <span className="ml-auto max-w-[40%] flex-none truncate text-[11px] text-subtle">{suggestion.detail}</span>
                </Command.Item>
              ))}
            </Command.List>
            <p className="flex-none border-t border-border px-3 py-1.5 text-[11px] text-subtle">
              Enter fügt ein, ohne auszuführen. Esc schließt.
            </p>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
