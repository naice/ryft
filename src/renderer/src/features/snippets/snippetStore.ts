import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { Snippet, SnippetInput, TerminalContext } from '@shared/contracts';
import { api } from '../../lib/api';
import { isToolView, useApp } from '../../state/appStore';
import { registerPromptContext, unregisterPromptContext, useWorkspace } from '../../state/workspaceStore';
import { insertCommand, isAlternateScreen, type InsertResult } from '../terminal/terminalRegistry';

export function insertProblemText(result: InsertResult): string {
  switch (result) {
    case 'not-live':
      return 'Diese Sitzung ist nicht verbunden.';
    case 'alternate-screen':
      return 'In dieser Sitzung läuft ein Vollbildprogramm, das den Text als Tastendruck lesen würde.';
    case 'multiline-unsafe':
      return 'Diese Shell kennt kein geschütztes Einfügen, mehrzeilige Befehle würden sofort ausgeführt.';
    case 'ok':
      return '';
  }
}

interface SnippetState {
  snippets: Snippet[];
  /** The snippet whose parameters and targets are being chosen. */
  running: Snippet | null;
  /** The session the run form starts with, when it was opened for a particular one. */
  runningPane: string | null;
  /** The pane the suggestion popup inserts into. */
  suggestionsFor: string | null;
  /** What detection found out, per pane. */
  contexts: Record<string, TerminalContext>;
  detecting: string[];
  load(): Promise<void>;
  save(id: string | null, input: SnippetInput): Promise<Snippet>;
  remove(id: string): Promise<void>;
  setFavorite(snippet: Snippet): Promise<void>;
  /** A personal copy of a snippet, which is how a built-in one gets edited. */
  duplicate(id: string): Promise<Snippet>;
  detect(paneId: string): Promise<TerminalContext>;
  openRun(snippet: Snippet, paneId?: string): void;
  closeRun(): void;
  openSuggestions(): void;
  closeSuggestions(): void;
}

const byName = (a: Snippet, b: Snippet) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export const useSnippets = create<SnippetState>((set, get) => ({
  snippets: [],
  running: null,
  runningPane: null,
  suggestionsFor: null,
  contexts: {},
  detecting: [],

  async load() {
    set({ snippets: await api.invoke(Channels.snippetsList) });
  },

  async save(id, input) {
    const saved = id ? await api.invoke(Channels.snippetsUpdate, { id, input }) : await api.invoke(Channels.snippetsCreate, input);
    set({ snippets: [...get().snippets.filter((item) => item.id !== saved.id), saved].sort(byName) });
    return saved;
  },

  async remove(id) {
    await api.invoke(Channels.snippetsDelete, { id });
    set({ snippets: get().snippets.filter((item) => item.id !== id) });
  },

  async setFavorite(snippet) {
    const updated = await api.invoke(Channels.snippetsSetFavorite, { id: snippet.id, favorite: !snippet.favorite });
    set({ snippets: get().snippets.map((item) => (item.id === updated.id ? updated : item)) });
  },

  async duplicate(id) {
    const copy = await api.invoke(Channels.snippetsDuplicate, { id });
    set({ snippets: [...get().snippets, copy].sort(byName) });
    return copy;
  },

  async detect(paneId) {
    const contextId = crypto.randomUUID();
    registerPromptContext(contextId);
    set({ detecting: [...get().detecting, paneId] });
    try {
      const context = await api.invoke(Channels.snippetsDetect, { sessionId: paneId, contextId });
      set({ contexts: { ...get().contexts, [paneId]: context } });
      return context;
    } finally {
      unregisterPromptContext(contextId);
      set({ detecting: get().detecting.filter((id) => id !== paneId) });
    }
  },

  openRun: (running, paneId) => set({ running, runningPane: paneId ?? null }),
  closeRun: () => set({ running: null, runningPane: null }),

  /** On demand only: nothing is shown or read while the user simply types, and Tab stays the shell's. */
  openSuggestions() {
    const { tabs, activeTabId, panes } = useWorkspace.getState();
    const paneId = tabs.find((tab) => tab.id === activeTabId)?.activePaneId;
    const { toast, nav } = useApp.getState();
    if (isToolView(nav)) return;
    if (!paneId || panes[paneId]?.state !== 'connected') {
      toast('info', 'Vorschläge brauchen eine verbundene Sitzung.');
      return;
    }
    if (isAlternateScreen(paneId)) {
      toast('info', 'In einem Vollbildprogramm gibt es keine Vorschläge.');
      return;
    }
    set({ suggestionsFor: paneId });
  },
  closeSuggestions: () => set({ suggestionsFor: null })
}));

/** Puts text on the prompt of a pane, without running it. */
export function insertIntoPane(paneId: string, text: string): void {
  const result = insertCommand(paneId, text, false);
  if (result !== 'ok') useApp.getState().toast('error', insertProblemText(result));
}
