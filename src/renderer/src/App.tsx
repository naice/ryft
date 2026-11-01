import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { Channels } from '@shared/channels';
import { api } from './lib/api';
import { attempt, isToolView, useApp } from './state/appStore';
import { useWorkspace } from './state/workspaceStore';
import { ConfirmDialog, ToastStack } from './components/ui/primitives';
import { AiPanel } from './features/ai/AiPanel';
import { useAi } from './features/ai/aiStore';
import { BroadcastBar, BroadcastDialog } from './features/broadcast/BroadcastPanel';
import { useBroadcast } from './features/broadcast/broadcastStore';
import { DockerView } from './features/docker/DockerView';
import { ForwardsView } from './features/forwards/ForwardsView';
import { useForwards } from './features/forwards/forwardStore';
import { HostBrowser } from './features/hosts/HostBrowser';
import { HostEditorDialog } from './features/hosts/HostEditorDialog';
import { KeysView } from './features/keys/KeysView';
import { LogsView } from './features/logs/LogsView';
import { useSessionLogs } from './features/logs/logStore';
import { CommandPalette } from './features/palette/CommandPalette';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { SftpView } from './features/sftp/SftpView';
import { useSftp } from './features/sftp/sftpStore';
import { NavRail } from './features/shell/NavRail';
import { SnippetRunDialog } from './features/snippets/SnippetRunDialog';
import { SnippetsView } from './features/snippets/SnippetsView';
import { useSnippets } from './features/snippets/snippetStore';
import { SuggestionPopup } from './features/snippets/SuggestionPopup';
import { resolveShortcut } from './features/shell/shortcutMap';
import { handleTerminalKey, runShortcut } from './features/shell/shortcuts';
import { TitleBar } from './features/shell/TitleBar';
import { applyTerminalPreferences, configureTerminals, focusTerminal } from './features/terminal/terminalRegistry';
import { SessionPrompts } from './features/workspace/SessionPrompts';
import { Workspace } from './features/workspace/Workspace';
import { WorkspacesView } from './features/workspaces/WorkspacesView';

const MIN_HOST_WIDTH = 220;
const MAX_HOST_WIDTH = 380;

interface Columns {
  nav: number;
  hosts: number;
  compact: boolean;
}

/** Responsive column widths from the UI spec. */
function columnsFor(width: number, hostPanelWidth: number): Columns {
  if (width < 1120) return { nav: 60, hosts: Math.min(hostPanelWidth, 240), compact: true };
  if (width < 1440) return { nav: 176, hosts: Math.min(hostPanelWidth, 240), compact: false };
  return { nav: 196, hosts: hostPanelWidth, compact: false };
}

let started = false;

/** A default workspace replaces the restored layout. Like that one, it starts disconnected. */
async function openDefaultWorkspace(): Promise<boolean> {
  try {
    const summary = (await api.invoke(Channels.workspacesList)).find((item) => item.isDefault);
    if (!summary) return false;
    useWorkspace.getState().openWorkspace(await api.invoke(Channels.workspacesGet, { id: summary.id }), false);
    return true;
  } catch {
    return false;
  }
}

/** Effects run twice under StrictMode, and a second restore would duplicate every tab. */
async function startOnce(): Promise<void> {
  if (started) return;
  started = true;
  // xterm measures its cell size once, so the terminal font has to be there before the first terminal opens.
  await Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('bold 13px "JetBrains Mono"')]).catch(
    () => undefined
  );
  await useApp.getState().load();
  const prefs = useApp.getState().preferences;
  if (!prefs) return;
  applyTerminalPreferences(prefs);
  if (!(await openDefaultWorkspace()) && prefs.restoreLayout) useWorkspace.getState().restore(prefs.workspaceLayout);
  await attempt(async () => {
    await Promise.all([useForwards.getState().load(), useSftp.getState().loadJobs()]);
    // Main only starts the profiles that have restoring explicitly switched on.
    await api.invoke(Channels.forwardsRestore);
  });
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // xterm reports its own keys through its custom handler.
      if ((event.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const { info } = useApp.getState();
      const action = resolveShortcut(event, info?.platform === 'darwin', true);
      if (action) {
        event.preventDefault();
        runShortcut(action);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function useSessionEvents() {
  useEffect(() => {
    const unsubscribers = [
      api.onSessionData(({ sessionId, data }) => useWorkspace.getState().onData(sessionId, data)),
      api.onSessionState((event) => useWorkspace.getState().onState(event)),
      api.onSessionPrompt((prompt) => useWorkspace.getState().onPrompt(prompt)),
      api.onSftpClosed((event) => useSftp.getState().onSftpClosed(event)),
      api.onTransferUpdate((jobs) => useSftp.getState().onJobs(jobs)),
      api.onTransferRemoved((ids) => useSftp.getState().onJobsRemoved(ids)),
      api.onForwardState((runtime) => useForwards.getState().onState(runtime)),
      api.onAiChunk(({ requestId, text }) => useAi.getState().onChunk(requestId, text)),
      api.onSessionLogState((event) => useSessionLogs.getState().onState(event))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);
}

function HostColumnGutter({ width }: { width: number }) {
  const setPreferences = useApp((state) => state.setPreferences);
  const preview = useRef<number | null>(null);
  const start = useRef<{ x: number; width: number } | null>(null);

  const commit = (next: number) => {
    const clamped = Math.round(Math.min(MAX_HOST_WIDTH, Math.max(MIN_HOST_WIDTH, next)));
    useApp.setState((state) => ({
      preferences: state.preferences && { ...state.preferences, hostPanelWidth: clamped }
    }));
    return clamped;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) preview.current = commit(start.current.width + event.clientX - start.current.x);
  };
  const onPointerUp = () => {
    start.current = null;
    if (preview.current !== null) void setPreferences({ hostPanelWidth: preview.current });
    preview.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    void setPreferences({ hostPanelWidth: commit(width + (event.key === 'ArrowRight' ? 12 : -12)) });
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Breite der Hostliste ändern"
      aria-valuenow={width}
      aria-valuemin={MIN_HOST_WIDTH}
      aria-valuemax={MAX_HOST_WIDTH}
      className="ryft-gutter ryft-gutter-row !w-2"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

export function App() {
  const ready = useApp((state) => state.ready);
  const loadError = useApp((state) => state.loadError);
  const preferences = useApp((state) => state.preferences);
  const width = useWindowWidth();

  useSessionEvents();
  useGlobalShortcuts();

  useEffect(() => {
    configureTerminals({
      handleKey: handleTerminalKey,
      onFocus: (id) => useWorkspace.getState().focusPane(id),
      platform: () => useApp.getState().info?.platform ?? ''
    });
    void startOnce();
  }, []);

  const theme = preferences?.theme;
  const highContrast = preferences?.highContrast;
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    if (highContrast) document.documentElement.dataset.contrast = 'high';
    else delete document.documentElement.dataset.contrast;
  }, [theme, highContrast]);

  useEffect(() => {
    if (preferences) applyTerminalPreferences(preferences);
    // Only terminal-relevant fields matter, and layout writes must not re-theme every terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    preferences?.theme,
    preferences?.terminalFontFamily,
    preferences?.terminalFontSize,
    preferences?.terminalLineHeight,
    preferences?.terminalCursorStyle,
    preferences?.terminalCursorBlink,
    preferences?.terminalScrollback,
    preferences?.terminalRenderer,
    preferences?.ansiOverrides
  ]);

  const anyDialogOpen = useApp(
    (state) => state.paletteOpen || state.settingsOpen || state.editor !== null || state.confirm !== null
  );
  const snippetDialogOpen = useSnippets((state) => state.running !== null || state.suggestionsFor !== null);
  const broadcastDialogOpen = useBroadcast((state) => state.dialogOpen);
  const aiOpen = useAi((state) => state.open);
  const promptOpen = useWorkspace((state) => state.prompts.length > 0);
  const nav = useApp((state) => state.nav);
  const toolView = isToolView(nav);
  const wasDialogOpen = useRef(false);
  useEffect(() => {
    const open = anyDialogOpen || promptOpen || snippetDialogOpen || broadcastDialogOpen;
    if (wasDialogOpen.current && !open) {
      // Keyboard users continue typing where they were.
      const { tabs, activeTabId } = useWorkspace.getState();
      const tab = tabs.find((item) => item.id === activeTabId);
      if (tab && !isToolView(useApp.getState().nav)) requestAnimationFrame(() => focusTerminal(tab.activePaneId));
    }
    wasDialogOpen.current = open;
  }, [anyDialogOpen, promptOpen, snippetDialogOpen, broadcastDialogOpen]);

  const wasToolView = useRef(false);
  useEffect(() => {
    if (wasToolView.current && !toolView) {
      const { tabs, activeTabId } = useWorkspace.getState();
      const tab = tabs.find((item) => item.id === activeTabId);
      if (tab) requestAnimationFrame(() => focusTerminal(tab.activePaneId));
    }
    wasToolView.current = toolView;
  }, [toolView]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div role="alert" className="flex max-w-md items-start gap-3 rounded-panel border border-error bg-host-panel p-4">
          <AlertTriangle size={18} className="flex-none text-error" />
          <div>
            <h1 className="text-base font-semibold text-text">RYFT konnte nicht laden</h1>
            <p className="mt-1 text-[13px] text-secondary">{loadError}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!ready || !preferences) return <div className="h-full bg-canvas" />;

  const columns = columnsFor(width, preferences.hostPanelWidth);

  return (
    <Tooltip.Provider delayDuration={400}>
      <div
        data-testid="app-shell"
        className="flex h-full flex-col border border-[color-mix(in_srgb,var(--ryft-cyan)_16%,transparent)] bg-canvas"
      >
        <TitleBar />
        <BroadcastBar />
        <div className="flex min-h-0 flex-1 px-3 pb-3">
          <div className="flex-none" style={{ width: columns.nav }}>
            <NavRail compact={columns.compact} />
          </div>
          <div className="w-2 flex-none" />
          {/* Hidden, not unmounted: sessions keep running and their scrollback stays. */}
          <div className={toolView ? 'hidden' : 'flex min-w-0 flex-1'}>
            <div className="flex-none" style={{ width: columns.hosts }}>
              <HostBrowser />
            </div>
            <HostColumnGutter width={columns.hosts} />
            <div className="min-w-[460px] flex-1">
              <Workspace />
            </div>
          </div>
          {nav === 'workspaces' && (
            <div className="min-w-0 flex-1">
              <WorkspacesView />
            </div>
          )}
          {nav === 'snippets' && (
            <div className="min-w-0 flex-1">
              <SnippetsView />
            </div>
          )}
          {nav === 'keys' && (
            <div className="min-w-0 flex-1">
              <KeysView />
            </div>
          )}
          {nav === 'sftp' && (
            <div className="min-w-0 flex-1">
              <SftpView />
            </div>
          )}
          {nav === 'forwards' && (
            <div className="min-w-0 flex-1">
              <ForwardsView />
            </div>
          )}
          {nav === 'docker' && (
            <div className="min-w-0 flex-1">
              <DockerView />
            </div>
          )}
          {nav === 'logs' && (
            <div className="min-w-0 flex-1">
              <LogsView />
            </div>
          )}
          {aiOpen && (
            <div className="ml-2 w-[340px] flex-none">
              <AiPanel />
            </div>
          )}
        </div>
      </div>
      <HostEditorDialog />
      <CommandPalette />
      <SettingsPanel />
      <SnippetRunDialog />
      <SuggestionPopup />
      <BroadcastDialog />
      <SessionPrompts />
      <ConfirmDialog />
      <ToastStack />
    </Tooltip.Provider>
  );
}
