import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Container, FileText, Info, Loader2, Play, Power, RefreshCw, RotateCw, Search, SquareTerminal, X } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { DockerAction, DockerContainer, DockerContainerDetails, DockerEndpoint, DockerStatus } from '@shared/contracts';
import { api, errorMessage } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, cx, EmptyState, IconButton, Modal, Select } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';

const REFRESH_MS = 10_000;
const LOG_TAIL_LINES = 500;
/** The window keeps the end of a log. Everything older is still in Docker. */
const MAX_LOG_CHARS = 512 * 1024;

type StateFilter = 'all' | 'running' | 'stopped';

function endpointValue(endpoint: DockerEndpoint): string {
  return JSON.stringify(endpoint);
}

function LogPanel({ endpoint, container, onClose }: { endpoint: DockerEndpoint; container: DockerContainer; onClose(): void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'running' | 'ended'>('running');
  const [error, setError] = useState<string | null>(null);
  const output = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const streamId = crypto.randomUUID();
    const unsubscribers = [
      api.onDockerLog((event) => {
        if (event.streamId === streamId) setText((current) => (current + event.data).slice(-MAX_LOG_CHARS));
      }),
      api.onDockerLogEnd((event) => {
        if (event.streamId !== streamId) return;
        setStatus('ended');
        setError(event.error);
      })
    ];
    setText('');
    setStatus('running');
    setError(null);
    api.invoke(Channels.dockerLogsStart, { streamId, endpoint, containerId: container.id, tail: LOG_TAIL_LINES }).catch((failure: unknown) => {
      setStatus('ended');
      setError(errorMessage(failure));
    });
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void api.invoke(Channels.dockerLogsStop, { streamId }).catch(() => undefined);
    };
  }, [endpoint, container.id]);

  useEffect(() => {
    const element = output.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 80) element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <section aria-label={`Logs von ${container.name}`} data-testid="docker-logs" className="flex h-[38%] min-h-[140px] flex-none flex-col border-t border-border">
      <header className="flex h-8 flex-none items-center gap-2 border-b border-border bg-pane-header px-3">
        <FileText size={13} className="flex-none text-cyan" />
        <span className="min-w-0 truncate text-xs font-medium text-text">Logs: {container.name}</span>
        <span className="flex-none text-[11px] text-secondary">{status === 'running' ? 'Live' : 'Beendet'}</span>
        <div className="flex-1" />
        <IconButton label="Logs schließen" size={22} onClick={onClose}>
          <X size={13} />
        </IconButton>
      </header>
      {error && (
        <p role="alert" className="flex-none border-b border-border px-3 py-1 text-xs text-error">
          {error}
        </p>
      )}
      <pre ref={output} data-testid="docker-log-text" className="min-h-0 flex-1 overflow-auto bg-terminal p-2 font-terminal text-[11px] leading-[1.45] text-text select-text">
        {text}
      </pre>
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-0.5 text-xs">
      <span className="text-subtle">{label}</span>
      <span className="min-w-0 break-words text-text select-text">{children}</span>
    </div>
  );
}

function DetailsDialog({ endpoint, container, onClose }: { endpoint: DockerEndpoint; container: DockerContainer; onClose(): void }) {
  const [details, setDetails] = useState<DockerContainerDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .invoke(Channels.dockerInspect, { endpoint, containerId: container.id })
      .then(setDetails)
      .catch((failure: unknown) => setError(errorMessage(failure)));
  }, [endpoint, container.id]);

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={container.name} description={container.image} width={620}>
      <div className="flex max-h-[440px] min-h-0 flex-col overflow-y-auto px-5 pb-4">
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
        {!details && !error && <Loader2 size={16} className="ryft-spin text-secondary" />}
        {details && (
          <>
            <DetailRow label="ID">
              <code className="font-terminal text-[11px]">{details.id}</code>
            </DetailRow>
            <DetailRow label="Status">{details.state}</DetailRow>
            <DetailRow label="Erstellt">{details.created}</DetailRow>
            <DetailRow label="Gestartet">{details.startedAt ?? '–'}</DetailRow>
            <DetailRow label="Neustarts">{details.restartCount}</DetailRow>
            <DetailRow label="Befehl">
              <code className="font-terminal text-[11px]">{details.command || '–'}</code>
            </DetailRow>
            <DetailRow label="Arbeitsordner">{details.workingDir || '–'}</DetailRow>
            <DetailRow label="Umgebung">{details.environmentCount} Variablen. Die Werte zeigt RYFT nicht, weil dort oft Geheimnisse stehen.</DetailRow>
            <DetailRow label="Ports">{details.ports.join(', ') || '–'}</DetailRow>
            <DetailRow label="Netzwerke">
              {details.networks.map((network) => `${network.name} ${network.ipAddress}`.trim()).join(', ') || '–'}
            </DetailRow>
            <DetailRow label="Mounts">
              {details.mounts.length === 0
                ? '–'
                : details.mounts.map((mount) => (
                    <div key={mount.destination}>
                      {mount.source} → {mount.destination}
                      {mount.readOnly ? ' (nur lesen)' : ''}
                    </div>
                  ))}
            </DetailRow>
            <DetailRow label="Labels">
              {details.labels.length === 0
                ? '–'
                : details.labels.map((label) => (
                    <div key={label.key}>
                      {label.key}={label.value}
                    </div>
                  ))}
            </DetailRow>
          </>
        )}
      </div>
      <div className="flex justify-end border-t border-border px-5 py-3">
        <Button onClick={onClose}>Schließen</Button>
      </div>
    </Modal>
  );
}

const COLUMNS = 'grid-cols-[minmax(120px,1.2fr)_minmax(120px,1.2fr)_minmax(110px,1fr)_minmax(90px,1fr)_minmax(80px,0.7fr)_142px]';

export function DockerView() {
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const showTerminals = useApp((state) => state.showTerminals);
  const openTab = useWorkspace((state) => state.openTab);
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [endpointKey, setEndpointKey] = useState('');
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [logsOf, setLogsOf] = useState<string | null>(null);
  const [detailsOf, setDetailsOf] = useState<DockerContainer | null>(null);

  const usable = useMemo(() => (status?.endpoints ?? []).filter((item) => !item.insecure), [status]);
  const refused = useMemo(() => (status?.endpoints ?? []).filter((item) => item.insecure), [status]);
  const endpoint = useMemo(() => usable.find((item) => endpointValue(item.endpoint) === endpointKey)?.endpoint ?? null, [usable, endpointKey]);

  const loadStatus = useCallback(async () => {
    const next = await api.invoke(Channels.dockerStatus);
    setStatus(next);
    setEndpointKey((current) => {
      const choices = next.endpoints.filter((item) => !item.insecure);
      if (choices.some((item) => endpointValue(item.endpoint) === current)) return current;
      const preferred = choices.find((item) => item.isCurrent) ?? choices[0];
      return preferred ? endpointValue(preferred.endpoint) : '';
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    try {
      setContainers(await api.invoke(Channels.dockerList, { endpoint }));
      setListError(null);
    } catch (failure) {
      setContainers([]);
      setListError(errorMessage(failure));
    }
  }, [endpoint]);

  useEffect(() => {
    void attempt(loadStatus);
  }, [loadStatus]);

  useEffect(() => {
    setLogsOf(null);
    void refresh();
    // Runs only while this view is open, which is the only time anyone looks at it.
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return containers.filter((item) => {
      if (filter === 'running' && item.state !== 'running') return false;
      if (filter === 'stopped' && item.state === 'running') return false;
      return !needle || `${item.name} ${item.image} ${item.ports} ${item.status}`.toLocaleLowerCase().includes(needle);
    });
  }, [containers, query, filter]);

  const run = (container: DockerContainer, action: DockerAction) => {
    if (!endpoint) return;
    setBusyId(container.id);
    void attempt(async () => {
      await api.invoke(Channels.dockerAction, { endpoint, containerId: container.id, action });
      await refresh();
    }).finally(() => setBusyId(null));
  };

  const confirmed = (container: DockerContainer, action: 'stop' | 'restart') =>
    askConfirm({
      title: `„${container.name}“ ${action === 'stop' ? 'stoppen' : 'neu starten'}?`,
      message: 'Laufende Prozesse im Container werden beendet, und was von ihm abhängt, verliert die Verbindung.',
      confirmLabel: action === 'stop' ? 'Stoppen' : 'Neu starten',
      danger: true,
      onConfirm: () => run(container, action)
    });

  const probe = (distro: string) =>
    askConfirm({
      title: `WSL-Distribution „${distro}“ starten?`,
      message: 'Um Docker dort zu finden, muss RYFT die Distribution starten. Dabei starten auch Dienste und Container, die dort automatisch hochfahren.',
      confirmLabel: 'Starten und prüfen',
      onConfirm: () => {
        setProbing(distro);
        void attempt(async () => {
          const found = await api.invoke(Channels.dockerProbeDistro, { distro });
          if (found.length === 0) toast('info', `In „${distro}“ gibt es keinen Docker-Kontext.`);
          await loadStatus();
        }).finally(() => setProbing(null));
      }
    });

  const openShell = (container: DockerContainer) => {
    if (!endpoint) return;
    openTab({ kind: 'docker', endpoint, containerId: container.id, containerName: container.name });
    showTerminals();
  };

  const logContainer = containers.find((item) => item.id === logsOf);

  return (
    <ToolView
      testId="docker-view"
      title="Docker"
      description={endpoint ? `${containers.length} Container · ${usable.find((item) => item.endpoint === endpoint)?.url ?? ''}` : 'Container über die Docker-CLI dieses Systems'}
      actions={
        <Button onClick={() => void attempt(async () => { await loadStatus(); await refresh(); })}>
          <RefreshCw size={14} /> Aktualisieren
        </Button>
      }
    >
      {status === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={18} className="ryft-spin text-secondary" />
        </div>
      ) : (
        <>
          {(status.stoppedDistros.length > 0 || refused.length > 0) && (
            <div className="flex flex-none flex-col gap-1.5 border-b border-border px-4 py-2 text-xs text-secondary">
              {status.stoppedDistros.map((distro) => (
                <div key={distro} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">WSL-Distribution „{distro}“ läuft nicht und wird deshalb nicht abgefragt.</span>
                  <Button className="!h-7 text-xs" disabled={probing !== null} onClick={() => probe(distro)}>
                    {probing === distro && <Loader2 size={13} className="ryft-spin" />} Starten und prüfen…
                  </Button>
                </div>
              ))}
              {refused.map((item) => (
                <p key={item.label} role="alert" className="text-warning">
                  Kontext „{item.label}“ ({item.url}) ist unverschlüsseltes TCP zu einem anderen Rechner. RYFT nutzt ihn nicht.
                </p>
              ))}
            </div>
          )}
          {usable.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={<Container size={26} />}
                title="Docker nicht gefunden"
                description={status.error ?? 'RYFT findet hier keine Docker-CLI. Installiere Docker oder starte oben eine WSL-Distribution, in der Docker liegt.'}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                <div className="w-[240px] flex-none">
                  <Select
                    ariaLabel="Docker-Kontext"
                    value={endpointKey}
                    onChange={setEndpointKey}
                    options={usable.map((item) => ({ value: endpointValue(item.endpoint), label: item.label }))}
                  />
                </div>
                <div className="flex h-8 min-w-[160px] flex-1 items-center gap-2 rounded-control border border-border bg-canvas px-2 focus-within:border-border-active">
                  <Search size={14} className="flex-none text-subtle" />
                  <input
                    aria-label="Container suchen"
                    placeholder="Name, Image, Port…"
                    spellCheck={false}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="ryft-bare-input min-w-0 flex-1 bg-transparent text-xs text-text select-text placeholder:text-subtle"
                  />
                </div>
                <div className="w-[130px] flex-none">
                  <Select
                    ariaLabel="Nach Status filtern"
                    value={filter}
                    onChange={(value) => setFilter(value as StateFilter)}
                    options={[
                      { value: 'all', label: 'Alle' },
                      { value: 'running', label: 'Laufend' },
                      { value: 'stopped', label: 'Gestoppt' }
                    ]}
                  />
                </div>
              </div>
              {listError ? (
                <p role="alert" className="m-4 rounded-control border border-error p-3 text-xs text-text">
                  {listError}
                </p>
              ) : visible.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon={<Container size={26} />}
                    title={containers.length === 0 ? 'Keine Container' : 'Keine Treffer'}
                    description={containers.length === 0 ? 'In diesem Kontext gibt es noch keine Container.' : 'Ändere die Suche oder den Statusfilter.'}
                  />
                </div>
              ) : (
                <div role="table" aria-label="Container" className="flex min-h-0 flex-1 flex-col overflow-auto">
                  <div role="row" className={cx('grid h-7 flex-none items-center gap-3 border-b border-border px-4 text-[11px] text-subtle', COLUMNS)}>
                    <span role="columnheader">Name</span>
                    <span role="columnheader">Image</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Ports</span>
                    <span role="columnheader">Laufzeit</span>
                    <span role="columnheader" className="sr-only">
                      Aktionen
                    </span>
                  </div>
                  {visible.map((container) => {
                    const running = container.state === 'running';
                    const busy = busyId === container.id;
                    return (
                      <div
                        key={container.id}
                        role="row"
                        data-testid="docker-row"
                        className={cx('grid min-h-10 flex-none items-center gap-3 border-b border-border px-4 py-1', COLUMNS)}
                      >
                        <span role="cell" className="flex min-w-0 items-center gap-2">
                          <span className={cx('size-2 flex-none rounded-full', running ? 'bg-success' : 'bg-subtle')} />
                          <span className="truncate text-[13px] font-medium text-text" title={container.name}>
                            {container.name}
                          </span>
                        </span>
                        <span role="cell" className="truncate text-xs text-secondary" title={container.image}>
                          {container.image}
                        </span>
                        <span role="cell" className="truncate text-xs text-secondary" title={container.status}>
                          {container.status}
                        </span>
                        <span role="cell" className="truncate font-terminal text-[11px] text-secondary" title={container.ports}>
                          {container.ports || '–'}
                        </span>
                        <span role="cell" className="truncate text-xs text-secondary">
                          {container.runningFor}
                        </span>
                        <span role="cell" className="flex items-center justify-end gap-0.5">
                          {busy && <Loader2 size={13} className="ryft-spin mr-1 text-secondary" />}
                          {running ? (
                            <>
                              <IconButton label={`${container.name} stoppen`} disabled={busy} onClick={() => confirmed(container, 'stop')}>
                                <Power size={13} />
                              </IconButton>
                              <IconButton label={`${container.name} neu starten`} disabled={busy} onClick={() => confirmed(container, 'restart')}>
                                <RotateCw size={13} />
                              </IconButton>
                              <IconButton label={`Shell in ${container.name} öffnen`} onClick={() => openShell(container)}>
                                <SquareTerminal size={13} />
                              </IconButton>
                            </>
                          ) : (
                            <IconButton label={`${container.name} starten`} disabled={busy} onClick={() => run(container, 'start')}>
                              <Play size={13} />
                            </IconButton>
                          )}
                          <IconButton label={`Logs von ${container.name}`} onClick={() => setLogsOf(logsOf === container.id ? null : container.id)}>
                            <FileText size={13} />
                          </IconButton>
                          <IconButton label={`Details von ${container.name}`} onClick={() => setDetailsOf(container)}>
                            <Info size={13} />
                          </IconButton>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {endpoint && logContainer && <LogPanel endpoint={endpoint} container={logContainer} onClose={() => setLogsOf(null)} />}
            </>
          )}
        </>
      )}
      {endpoint && detailsOf && <DetailsDialog endpoint={endpoint} container={detailsOf} onClose={() => setDetailsOf(null)} />}
    </ToolView>
  );
}
