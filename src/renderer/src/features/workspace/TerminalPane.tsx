import { useEffect, useRef } from 'react';
import {
  AlertCircle,
  CircleDashed,
  Columns2,
  Loader2,
  Maximize2,
  Minimize2,
  Circle,
  Plug,
  RadioTower,
  RefreshCw,
  Rows2,
  ShieldAlert,
  X
} from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import { Channels } from '@shared/channels';
import type { Host, SessionTarget } from '@shared/contracts';
import { flattenJumpChain } from '@shared/features/jumpChain';
import { isSessionActive, type SessionState } from '@shared/sessionState';
import { api } from '../../lib/api';
import { attempt as guarded, useApp } from '../../state/appStore';
import { IDLE_PANE, useWorkspace } from '../../state/workspaceStore';
import { Button, cx, IconButton } from '../../components/ui/primitives';
import { useBroadcast } from '../broadcast/broadcastStore';
import { useSessionLogs } from '../logs/logStore';
import { attachTerminal, copyFrom, fitTerminal, hasSelection, pasteInto } from '../terminal/terminalRegistry';

const STATE_LABEL: Record<SessionState, string> = {
  disconnected: 'Getrennt',
  connecting: 'Verbinde…',
  authenticating: 'Anmeldung…',
  connected: 'Verbunden',
  reconnecting: 'Verbinde erneut…',
  failed: 'Fehlgeschlagen',
  closed: 'Beendet'
};

const MENU_ITEM =
  'flex h-[30px] cursor-default items-center rounded-[4px] px-2.5 text-[13px] text-text outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40';

function StatusIcon({ state }: { state: SessionState }) {
  switch (state) {
    case 'connected':
      return <span className="m-[2.5px] block size-2 rounded-full bg-success" />;
    case 'connecting':
    case 'authenticating':
    case 'reconnecting':
      return <Loader2 size={13} className="ryft-spin text-warning" />;
    case 'failed':
      return <AlertCircle size={13} className="text-error" />;
    default:
      return <CircleDashed size={13} className="text-subtle" />;
  }
}

/** The hops in connection order, for showing which way a session takes. */
function jumpRouteOf(hostId: string, hosts: Host[]): string {
  const chain = flattenJumpChain(hostId, (id) => hosts.find((item) => item.id === id)?.options.jumpHostIds ?? null);
  if (!chain.ok) return '';
  return chain.hops.slice(0, -1).map((id) => hosts.find((item) => item.id === id)?.name ?? 'Gelöschter Host').join(' → ');
}

export function usePaneLabel(target: SessionTarget): { title: string; kindLabel: string; detail: string; route?: string } {
  const host = useApp((state) =>
    target.kind === 'ssh' ? state.hosts.find((item) => item.id === target.hostId) : undefined
  );
  const shell = useApp((state) => {
    if (target.kind !== 'local') return undefined;
    const id = target.shellId ?? state.preferences?.defaultShellId;
    return state.shells.find((item) => item.id === id) ?? state.shells[0];
  });
  const route = useApp((state) => (target.kind === 'ssh' ? jumpRouteOf(target.hostId, state.hosts) : ''));
  const defaultDistro = useApp((state) => state.preferences?.wslDefaultDistro ?? null);
  if (target.kind === 'local') return { title: shell?.label ?? 'Lokal', kindLabel: 'Lokal', detail: 'Lokale Shell' };
  if (target.kind === 'wsl') {
    const distro = target.distro ?? defaultDistro ?? 'Standard';
    return { title: distro, kindLabel: 'WSL', detail: `WSL-Distribution ${distro}` };
  }
  if (target.kind === 'docker') {
    return { title: target.containerName, kindLabel: 'Docker', detail: `Container ${target.containerId.slice(0, 12)} im Kontext ${target.endpoint.context}` };
  }
  if (!host) return { title: 'Gelöschter Host', kindLabel: 'SSH', detail: 'Dieser Host existiert nicht mehr' };
  return {
    title: host.name,
    kindLabel: 'SSH',
    detail: `${host.username}@${host.hostname}${host.port === 22 ? '' : `:${host.port}`}`,
    route
  };
}

function PaneOverlay({ id, target, title }: { id: string; target: SessionTarget; title: string }) {
  const runtime = useWorkspace((state) => state.panes[id] ?? IDLE_PANE);
  const connectPane = useWorkspace((state) => state.connectPane);
  const requestClosePane = useWorkspace((state) => state.requestClosePane);
  const askConfirm = useApp((store) => store.askConfirm);
  const { state, error, exitCode, attempt } = runtime;
  if (state === 'connected') return null;

  const blocked = error?.code === 'HOST_KEY_MISMATCH' || error?.code === 'HOST_KEY_REVOKED';
  let headline: string;
  let body: string | null = null;
  switch (state) {
    case 'disconnected':
      headline = target.kind === 'ssh' ? `Nicht mit ${title} verbunden` : target.kind === 'local' ? 'Lokale Shell nicht gestartet' : `${title} nicht gestartet`;
      break;
    case 'connecting':
    case 'authenticating':
      headline = STATE_LABEL[state];
      body = runtime.detail ?? null;
      break;
    case 'reconnecting':
      headline = `Verbindung verloren, Versuch ${attempt ?? 1}…`;
      body = error?.message ?? null;
      break;
    case 'failed':
      headline = blocked ? 'Verbindung blockiert' : 'Verbindung fehlgeschlagen';
      body = error?.message ?? null;
      break;
    case 'closed':
      headline = target.kind === 'ssh' ? 'Sitzung beendet' : 'Shell beendet';
      body = exitCode !== null ? `Exit-Code ${exitCode}` : null;
      break;
  }
  const busy = state === 'connecting' || state === 'authenticating' || state === 'reconnecting';
  // A key from ~/.ssh/known_hosts is never changed by RYFT, so only its own decisions can be replaced here.
  const change = blocked && error?.hostKeyChange?.source === 'ryft' ? error.hostKeyChange : null;

  const replaceKey = () => {
    if (!change?.changeId) return;
    const { changeId } = change;
    askConfirm({
      title: `Host-Schlüssel von ${change.host}:${change.port} ersetzen?`,
      message: `Bisher: ${change.expectedFingerprint}\nNeu: ${change.presentedFingerprint}\n\nEin geänderter Schlüssel kann bedeuten, dass jemand die Verbindung abfängt. Ersetze ihn nur, wenn du den neuen Fingerprint auf einem anderen Weg geprüft hast.`,
      confirmLabel: 'Schlüssel ersetzen',
      danger: true,
      onConfirm: () =>
        void guarded(async () => {
          await api.invoke(Channels.knownHostsAcceptChange, { changeId });
          connectPane(id);
        })
    });
  };

  // Output of the ended session stays readable behind the banner, so it sits at the bottom.
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center p-3">
      <div
        role={state === 'failed' ? 'alert' : 'status'}
        data-testid="pane-status"
        data-state={state}
        className={cx(
          'flex max-w-[560px] min-w-0 items-start gap-2.5 rounded-card border bg-raised p-3 shadow-float',
          state === 'failed' ? 'border-error' : 'border-border'
        )}
      >
        <span className="mt-0.5 flex-none">
          {blocked ? <ShieldAlert size={16} className="text-error" /> : <StatusIcon state={state} />}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] font-semibold text-text">{headline}</span>
          {body && <span className="text-xs break-words text-secondary select-text">{body}</span>}
          {!busy && (
            <div className="mt-1.5 flex gap-2">
              {!blocked && (
                <Button variant="primary" className="!h-7 text-xs" onClick={() => connectPane(id)}>
                  {state === 'disconnected' ? <Plug size={13} /> : <RefreshCw size={13} />}
                  {state === 'disconnected' ? 'Verbinden' : 'Erneut verbinden'}
                </Button>
              )}
              {change?.changeId && (
                <Button variant="danger" className="!h-7 text-xs" onClick={replaceKey}>
                  Schlüssel ersetzen
                </Button>
              )}
              <Button className="!h-7 text-xs" onClick={() => requestClosePane(id)}>
                Schließen
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TerminalPane({ id, target, tabId }: { id: string; target: SessionTarget; tabId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const active = useWorkspace((state) => state.tabs.find((tab) => tab.id === tabId)?.activePaneId === id);
  const state = useWorkspace((store) => store.panes[id]?.state ?? 'disconnected');
  const maximized = useWorkspace((store) => store.maximizedPaneId === id);
  const focusPane = useWorkspace((store) => store.focusPane);
  const toggleMaximize = useWorkspace((store) => store.toggleMaximize);
  const requestClosePane = useWorkspace((store) => store.requestClosePane);
  const splitActive = useWorkspace((store) => store.splitActive);
  const disconnectPane = useWorkspace((store) => store.disconnectPane);
  const { title, kindLabel, detail, route } = usePaneLabel(target);
  const remote = target.kind === 'ssh';
  const broadcasting = useBroadcast((store) => store.targets.includes(id));
  const recording = useSessionLogs((store) => store.recording[id] ?? false);
  const setRecording = useSessionLogs((store) => store.setRecording);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    attachTerminal(id, container);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitTerminal(id));
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [id]);

  const split = (direction: 'row' | 'column') => {
    focusPane(id);
    splitActive(direction);
  };

  return (
    <section
      aria-label={`Terminal ${title}`}
      data-testid="terminal-pane"
      data-pane-id={id}
      data-active={active}
      data-broadcast={broadcasting}
      onMouseDownCapture={() => focusPane(id)}
      className={cx(
        'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-card border bg-terminal transition-colors duration-120',
        broadcasting ? 'border-warning' : active ? 'border-border-active' : remote ? 'border-pane-border-remote' : 'border-pane-border-local'
      )}
    >
      <header className="flex h-[30px] flex-none items-center gap-2 border-b border-border bg-pane-header pr-1 pl-2.5">
        <StatusIcon state={state} />
        <span className="min-w-0 truncate text-xs font-medium text-text" title={detail}>
          {title}
        </span>
        <span className={cx('flex-none text-[11px]', remote ? 'text-[var(--ryft-purple)]' : 'text-cyan')}>{kindLabel}</span>
        <span className="min-w-0 truncate text-[11px] text-secondary" data-testid="pane-route" title={route ? `Über ${route}` : undefined}>
          — {STATE_LABEL[state]}
          {route ? ` · über ${route}` : ''}
        </span>
        <div className="flex-1" />
        {broadcasting && (
          <span data-testid="pane-broadcast" className="flex flex-none items-center gap-1 text-[11px] font-medium text-warning">
            <RadioTower size={12} /> Broadcast
          </span>
        )}
        <IconButton
          label={recording ? 'Aufzeichnung beenden' : 'Sitzung aufzeichnen'}
          size={22}
          disabled={!isSessionActive(state)}
          onClick={() => void guarded(() => setRecording(id, !recording))}
        >
          <Circle size={12} data-testid="pane-rec" data-recording={recording} className={recording ? 'fill-error text-error' : undefined} />
        </IconButton>
        <IconButton label="Rechts teilen" shortcut="Ctrl+Shift+D" size={22} onClick={() => split('row')}>
          <Columns2 size={13} />
        </IconButton>
        <IconButton label="Unten teilen" shortcut="Ctrl+Shift+E" size={22} onClick={() => split('column')}>
          <Rows2 size={13} />
        </IconButton>
        <IconButton label={maximized ? 'Verkleinern' : 'Maximieren'} size={22} onClick={() => toggleMaximize(id)}>
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconButton>
        <IconButton label="Bereich schließen" size={22} onClick={() => requestClosePane(id)}>
          <X size={14} />
        </IconButton>
      </header>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="relative min-h-0 flex-1">
            <div ref={containerRef} className="ryft-terminal-host" />
            {/* Above the terminal, because xterm paints an opaque background of its own. */}
            {remote && !active && <div className="pointer-events-none absolute inset-0 bg-pane-remote-tint" />}
            <PaneOverlay id={id} target={target} title={title} />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-[55] min-w-44 rounded-card border border-border bg-raised p-1 shadow-float">
            <ContextMenu.Item className={MENU_ITEM} disabled={!hasSelection(id)} onSelect={() => void copyFrom(id)}>
              Kopieren
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} disabled={!isSessionActive(state)} onSelect={() => void pasteInto(id)}>
              Einfügen
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => split('row')}>Rechts teilen</ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => split('column')}>Unten teilen</ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item className={MENU_ITEM} disabled={!isSessionActive(state)} onSelect={() => disconnectPane(id)}>
              Trennen
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </section>
  );
}
