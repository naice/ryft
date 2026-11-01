import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { LayoutNode, SessionError, SessionPrompt, SessionTarget, WorkspaceDefinition, WorkspaceLayout } from '@shared/contracts';
import { WORKSPACE_VERSION } from '@shared/features/workspaces';
import { isSessionActive, type SessionState } from '@shared/sessionState';
import { api, errorMessage } from '../lib/api';
import {
  collectPanes,
  findPane,
  neighborPane,
  pane,
  removePane,
  setRatioAt,
  splitPane,
  withFreshIds,
  type SplitDirection
} from '../lib/layoutTree';
import {
  clearTerminal,
  disposeTerminal,
  ensureTerminal,
  fitTerminal,
  focusTerminal,
  setTerminalLive,
  terminalSize,
  writeToTerminal
} from '../features/terminal/terminalRegistry';
import { useApp } from './appStore';

export interface WorkspaceTab {
  id: string;
  root: LayoutNode;
  activePaneId: string;
}

export interface PaneRuntime {
  state: SessionState;
  error: SessionError | null;
  exitCode: number | null;
  attempt: number | null;
  /** The hop of a jump chain being connected. */
  detail?: string | null;
}

const IDLE: PaneRuntime = { state: 'disconnected', error: null, exitCode: null, attempt: null };

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  panes: Record<string, PaneRuntime>;
  maximizedPaneId: string | null;
  prompts: SessionPrompt[];
  /** Shows the "what to open" chooser, optionally to fill a split of an existing pane. */
  chooser: { split: { paneId: string; direction: SplitDirection } | null } | null;

  restore(layout: WorkspaceLayout | null): void;
  /** Adds the tabs of a saved workspace behind the open ones; running sessions are not touched. */
  openWorkspace(definition: WorkspaceDefinition, connect: boolean): void;
  /** The open tabs in the form a workspace stores them. Startup commands need a fresh approval. */
  currentDefinition(): WorkspaceDefinition;
  openTab(target: SessionTarget): void;
  /** Focuses a pane already showing the host, or opens a new tab for it. */
  connectHost(hostId: string): void;
  setChooser(chooser: WorkspaceState['chooser']): void;
  splitActive(direction: SplitDirection, target?: SessionTarget): void;
  activateTab(id: string): void;
  moveTab(offset: 1 | -1): void;
  requestCloseTab(id: string): void;
  requestClosePane(id: string): void;
  focusPane(id: string): void;
  cycleFocus(offset: 1 | -1): void;
  toggleMaximize(id: string): void;
  setRatio(tabId: string, path: readonly ('first' | 'second')[], ratio: number): void;
  commitLayout(): void;
  connectPane(id: string): void;
  disconnectPane(id: string): void;
  onState(event: { sessionId: string } & PaneRuntime): void;
  onData(sessionId: string, data: string): void;
  onPrompt(prompt: SessionPrompt): void;
  resolvePrompt(promptId: string): void;
}

function paneRunning(runtime: PaneRuntime | undefined): boolean {
  return runtime ? isSessionActive(runtime.state) : false;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Panes whose startup commands the user released by opening an approved workspace. It lives only in
 * memory, so that a layout restored after a restart can never run anything by itself.
 */
const startupPending = new Set<string>();

/** SFTP panes and tunnels ask for credentials too, without being a pane. */
const promptContexts = new Set<string>();

export function registerPromptContext(id: string): void {
  promptContexts.add(id);
}

export function unregisterPromptContext(id: string): void {
  promptContexts.delete(id);
  const { prompts } = useWorkspace.getState();
  if (prompts.some((prompt) => prompt.sessionId === id)) {
    useWorkspace.setState({ prompts: prompts.filter((prompt) => prompt.sessionId !== id) });
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const closePanes = (ids: string[]): void => {
    const panes = { ...get().panes };
    for (const id of ids) {
      if (paneRunning(panes[id])) {
        void api.invoke(Channels.sessionsClose, { sessionId: id }).catch(() => undefined);
      }
      setTerminalLive(id, false);
      disposeTerminal(id);
      startupPending.delete(id);
      delete panes[id];
    }
    set({
      panes,
      prompts: get().prompts.filter((prompt) => !ids.includes(prompt.sessionId)),
      maximizedPaneId: ids.includes(get().maximizedPaneId ?? '') ? null : get().maximizedPaneId
    });
  };

  const closeTabNow = (id: string): void => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((tab) => tab.id === id);
    const tab = tabs[index];
    if (!tab) return;
    closePanes(collectPanes(tab.root).map((item) => item.id));
    const remaining = tabs.filter((item) => item.id !== id);
    set({
      tabs: remaining,
      activeTabId: activeTabId === id ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null) : activeTabId
    });
    get().commitLayout();
    focusActivePane();
  };

  const closePaneNow = (id: string): void => {
    const tab = get().tabs.find((item) => findPane(item.root, id));
    if (!tab) return;
    const nextRoot = removePane(tab.root, id);
    if (!nextRoot) {
      closeTabNow(tab.id);
      return;
    }
    const nextActive = tab.activePaneId === id ? neighborPane(tab.root, id, 1)?.id ?? collectPanes(nextRoot)[0]!.id : tab.activePaneId;
    closePanes([id]);
    set({
      tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, root: nextRoot, activePaneId: nextActive } : item))
    });
    get().commitLayout();
    focusActivePane();
  };

  const focusActivePane = (): void => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((item) => item.id === activeTabId);
    if (tab) requestAnimationFrame(() => focusTerminal(tab.activePaneId));
  };

  const addPaneRuntime = (id: string): void => {
    set({ panes: { ...get().panes, [id]: IDLE } });
    ensureTerminal(id);
  };

  /** Asks before ending live sessions, when the user has that preference on. */
  const confirmClose = (ids: string[], title: string, proceed: () => void): void => {
    const running = ids.filter((id) => paneRunning(get().panes[id])).length;
    if (running === 0 || useApp.getState().preferences?.confirmCloseRunning === false) {
      proceed();
      return;
    }
    useApp.getState().askConfirm({
      title,
      message:
        running === 1
          ? 'Eine Sitzung läuft noch und wird beendet.'
          : `${running} Sitzungen laufen noch und werden beendet.`,
      confirmLabel: 'Beenden',
      danger: true,
      onConfirm: proceed
    });
  };

  return {
    tabs: [],
    activeTabId: null,
    panes: {},
    maximizedPaneId: null,
    prompts: [],
    chooser: null,

    /** Restored panes stay disconnected. Connecting is always an explicit user action. */
    restore(layout) {
      if (!layout) return;
      const panes: Record<string, PaneRuntime> = {};
      for (const tab of layout.tabs) {
        for (const item of collectPanes(tab.root)) {
          panes[item.id] = IDLE;
          ensureTerminal(item.id);
        }
      }
      set({
        tabs: layout.tabs,
        activeTabId: layout.activeTabId ?? layout.tabs[0]?.id ?? null,
        panes
      });
    },

    openWorkspace(definition, connect) {
      useApp.getState().showTerminals();
      const added: WorkspaceTab[] = [];
      const panes = { ...get().panes };
      let activeTabId: string | null = null;
      for (const saved of definition.layout.tabs) {
        const ids = new Map<string, string>();
        const root = withFreshIds(saved.root, ids);
        const created = collectPanes(root);
        const tab: WorkspaceTab = {
          id: crypto.randomUUID(),
          root,
          activePaneId: ids.get(saved.activePaneId) ?? (created[0] as { id: string }).id
        };
        for (const item of created) {
          panes[item.id] = IDLE;
          ensureTerminal(item.id);
          if (definition.startupApproved && item.startupCommands?.length) startupPending.add(item.id);
        }
        added.push(tab);
        if (saved.id === definition.layout.activeTabId) activeTabId = tab.id;
      }
      if (added.length === 0) return;
      set({
        tabs: [...get().tabs, ...added],
        panes,
        activeTabId: activeTabId ?? (added[0] as WorkspaceTab).id,
        chooser: null,
        maximizedPaneId: null
      });
      get().commitLayout();
      const app = useApp.getState();
      if (definition.hostPanelWidth !== null && definition.hostPanelWidth !== app.preferences?.hostPanelWidth) {
        void app.setPreferences({ hostPanelWidth: definition.hostPanelWidth }).catch(() => undefined);
      }
      requestAnimationFrame(() => {
        for (const tab of added) {
          for (const item of collectPanes(tab.root)) {
            fitTerminal(item.id);
            if (connect) get().connectPane(item.id);
          }
        }
        focusActivePane();
      });
    },

    currentDefinition() {
      const { tabs, activeTabId } = get();
      return {
        version: WORKSPACE_VERSION,
        layout: { tabs: tabs.slice(0, 64), activeTabId },
        hostPanelWidth: useApp.getState().preferences?.hostPanelWidth ?? null,
        startupApproved: false
      };
    },

    openTab(target) {
      useApp.getState().showTerminals();
      const id = crypto.randomUUID();
      addPaneRuntime(id);
      const tab: WorkspaceTab = { id: crypto.randomUUID(), root: pane(id, target), activePaneId: id };
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id, chooser: null, maximizedPaneId: null });
      get().commitLayout();
      // The terminal needs a first layout pass to know its real size before the PTY starts.
      requestAnimationFrame(() => {
        fitTerminal(id);
        get().connectPane(id);
        focusTerminal(id);
      });
    },

    connectHost(hostId) {
      for (const tab of get().tabs) {
        const existing = collectPanes(tab.root).find(
          (item) => item.target.kind === 'ssh' && item.target.hostId === hostId && get().panes[item.id]?.state !== 'failed'
        );
        if (existing) {
          get().activateTab(tab.id);
          get().focusPane(existing.id);
          if (!paneRunning(get().panes[existing.id])) get().connectPane(existing.id);
          return;
        }
      }
      get().openTab({ kind: 'ssh', hostId });
    },

    setChooser: (chooser) => set({ chooser }),

    splitActive(direction, target) {
      const { tabs, activeTabId } = get();
      const tab = tabs.find((item) => item.id === activeTabId);
      if (!tab) {
        set({ chooser: { split: null } });
        return;
      }
      if (!target) {
        set({ chooser: { split: { paneId: tab.activePaneId, direction } } });
        return;
      }
      useApp.getState().showTerminals();
      const id = crypto.randomUUID();
      addPaneRuntime(id);
      set({
        tabs: tabs.map((item) =>
          item.id === tab.id
            ? { ...item, root: splitPane(item.root, tab.activePaneId, direction, pane(id, target)), activePaneId: id }
            : item
        ),
        chooser: null,
        maximizedPaneId: null
      });
      get().commitLayout();
      requestAnimationFrame(() => {
        fitTerminal(id);
        get().connectPane(id);
        focusTerminal(id);
      });
    },

    activateTab(id) {
      useApp.getState().showTerminals();
      set({ activeTabId: id, maximizedPaneId: null });
      get().commitLayout();
      const tab = get().tabs.find((item) => item.id === id);
      if (tab) {
        requestAnimationFrame(() => {
          for (const item of collectPanes(tab.root)) fitTerminal(item.id);
          focusTerminal(tab.activePaneId);
        });
      }
    },

    moveTab(offset) {
      const { tabs, activeTabId } = get();
      if (tabs.length < 2) return;
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const next = tabs[(index + offset + tabs.length) % tabs.length];
      if (next) get().activateTab(next.id);
    },

    requestCloseTab(id) {
      const tab = get().tabs.find((item) => item.id === id);
      if (!tab) return;
      confirmClose(
        collectPanes(tab.root).map((item) => item.id),
        'Tab schließen?',
        () => closeTabNow(id)
      );
    },

    requestClosePane(id) {
      confirmClose([id], 'Bereich schließen?', () => closePaneNow(id));
    },

    focusPane(id) {
      const tab = get().tabs.find((item) => findPane(item.root, id));
      if (!tab || tab.activePaneId === id) return;
      set({ tabs: get().tabs.map((item) => (item.id === tab.id ? { ...item, activePaneId: id } : item)) });
      get().commitLayout();
    },

    cycleFocus(offset) {
      const { tabs, activeTabId } = get();
      const tab = tabs.find((item) => item.id === activeTabId);
      const next = tab && neighborPane(tab.root, tab.activePaneId, offset);
      if (next) {
        get().focusPane(next.id);
        focusTerminal(next.id);
      }
    },

    toggleMaximize(id) {
      set({ maximizedPaneId: get().maximizedPaneId === id ? null : id });
      requestAnimationFrame(() => {
        const tab = get().tabs.find((item) => findPane(item.root, id));
        if (tab) {
          for (const item of collectPanes(tab.root)) fitTerminal(item.id);
        }
        focusTerminal(id);
      });
    },

    setRatio(tabId, path, ratio) {
      set({
        tabs: get().tabs.map((item) => (item.id === tabId ? { ...item, root: setRatioAt(item.root, path, ratio) } : item))
      });
    },

    commitLayout() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        const { tabs, activeTabId } = get();
        const app = useApp.getState();
        if (app.preferences?.restoreLayout === false) return;
        void app.setPreferences({ workspaceLayout: { tabs: tabs.slice(0, 64), activeTabId } });
      }, 300);
    },

    connectPane(id) {
      const tab = get().tabs.find((item) => findPane(item.root, id));
      const node = tab && findPane(tab.root, id);
      if (!node) return;
      clearTerminal(id);
      setTerminalLive(id, true);
      const { cols, rows } = terminalSize(id);
      const startup = startupPending.has(id) ? (node.startupCommands ?? []) : [];
      const launch = node.cwd || startup.length > 0 ? { launch: { cwd: node.cwd ?? null, startupCommands: startup } } : {};
      api.invoke(Channels.sessionsOpen, { sessionId: id, target: node.target, cols, rows, ...launch }).catch((error: unknown) => {
        setTerminalLive(id, false);
        const message = errorMessage(error);
        set({ panes: { ...get().panes, [id]: { ...IDLE, state: 'failed', error: { code: 'UNKNOWN', message } } } });
      });
    },

    disconnectPane(id) {
      void api.invoke(Channels.sessionsClose, { sessionId: id }).catch(() => undefined);
    },

    onState({ sessionId, ...runtime }) {
      if (!get().panes[sessionId]) return;
      setTerminalLive(sessionId, isSessionActive(runtime.state));
      set({ panes: { ...get().panes, [sessionId]: runtime } });
      if (runtime.state === 'connected') {
        startupPending.delete(sessionId);
        fitTerminal(sessionId);
      }
      if (runtime.state === 'connected' || runtime.state === 'failed' || runtime.state === 'closed') {
        const app = useApp.getState();
        void app.refreshHistory().catch(() => undefined);
        const node = get().tabs.map((tab) => findPane(tab.root, sessionId)).find(Boolean);
        if (node?.target.kind === 'ssh') void app.refreshHost(node.target.hostId).catch(() => undefined);
      }
    },

    onData(sessionId, data) {
      writeToTerminal(sessionId, data);
    },

    onPrompt(prompt) {
      if (get().panes[prompt.sessionId] || promptContexts.has(prompt.sessionId)) set({ prompts: [...get().prompts, prompt] });
    },

    resolvePrompt(promptId) {
      set({ prompts: get().prompts.filter((prompt) => prompt.promptId !== promptId) });
    }
  };
});

export { IDLE as IDLE_PANE };
