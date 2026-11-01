import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowLeftRight, Copy, Loader2, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import type { ForwardInput, ForwardProfile, ForwardRuntime, ForwardStatus, Host } from '@shared/contracts';
import { forwardInputSchema, isLoopbackAddress } from '@shared/features/forwards';
import { attempt, useApp } from '../../state/appStore';
import { Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Modal, Select } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';
import { useForwards } from './forwardStore';

const TYPE_LABEL: Record<ForwardInput['type'], string> = {
  local: 'Lokal (-L)',
  remote: 'Remote (-R)',
  dynamic: 'SOCKS (-D)'
};

const STATUS_LABEL: Record<ForwardStatus, string> = {
  stopped: 'Gestoppt',
  starting: 'Startet…',
  running: 'Aktiv',
  reconnecting: 'Verbindet erneut…',
  failed: 'Fehlgeschlagen'
};

interface FormState {
  name: string;
  hostId: string;
  type: ForwardInput['type'];
  bindAddress: string;
  bindPort: string;
  destHost: string;
  destPort: string;
  restoreOnStart: boolean;
  autoReconnect: boolean;
  allowNonLoopback: boolean;
}

function toForm(profile: ForwardProfile | null, hostId: string): FormState {
  return {
    name: profile?.name ?? '',
    hostId: profile?.hostId ?? hostId,
    type: profile?.type ?? 'local',
    bindAddress: profile?.bindAddress ?? '127.0.0.1',
    bindPort: profile ? String(profile.bindPort) : '',
    destHost: profile?.destHost ?? 'localhost',
    destPort: profile?.destPort ? String(profile.destPort) : '',
    restoreOnStart: profile?.restoreOnStart ?? false,
    autoReconnect: profile?.autoReconnect ?? false,
    allowNonLoopback: profile?.allowNonLoopback ?? false
  };
}

function ForwardEditor({
  editing,
  hosts,
  onClose
}: {
  editing: { profile: ForwardProfile | null };
  hosts: Host[];
  onClose(): void;
}) {
  const save = useForwards((state) => state.save);
  const running = useForwards((state) => (editing.profile ? state.runtime[editing.profile.id]?.status : undefined));
  const selectedHostId = useApp((state) => state.selectedHostId);
  const [form, setForm] = useState(() => toForm(editing.profile, selectedHostId ?? hosts[0]?.id ?? ''));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors({});
  };

  const publicBind = form.bindAddress.trim() !== '' && !isLoopbackAddress(form.bindAddress.trim());
  const needsDestination = form.type !== 'dynamic';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = forwardInputSchema.safeParse({
      name: form.name,
      hostId: form.hostId,
      type: form.type,
      bindAddress: form.bindAddress,
      bindPort: form.bindPort.trim() === '' ? Number.NaN : Number(form.bindPort),
      destHost: needsDestination ? form.destHost : null,
      destPort: needsDestination && form.destPort.trim() !== '' ? Number(form.destPort) : null,
      restoreOnStart: form.restoreOnStart,
      autoReconnect: form.autoReconnect,
      allowNonLoopback: publicBind && form.allowNonLoopback
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] =
          field === 'name'
            ? 'Name erforderlich'
            : field === 'hostId'
              ? 'Host erforderlich'
              : field === 'bindPort'
                ? 'Port zwischen 0 und 65535'
                : field === 'destHost' || field === 'destPort'
                  ? 'Zielhost und Zielport erforderlich'
                  : issue.message;
      }
      setErrors(next);
      return;
    }
    void attempt(async () => {
      await save(editing.profile?.id ?? null, parsed.data);
      onClose();
    });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={editing.profile ? 'Weiterleitung bearbeiten' : 'Weiterleitung hinzufügen'}
      width={520}
    >
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" htmlFor="forward-name" error={errors.name}>
              <Input id="forward-name" autoFocus maxLength={128} value={form.name} onChange={(event) => update('name', event.target.value)} />
            </Field>
            <Field label="Host" htmlFor="forward-host" error={errors.hostId}>
              <Select
                id="forward-host"
                value={form.hostId}
                onChange={(value) => update('hostId', value)}
                options={[{ value: '', label: 'Host wählen…' }, ...hosts.map((host) => ({ value: host.id, label: host.name }))]}
              />
            </Field>
          </div>
          <Field
            label="Art"
            htmlFor="forward-type"
            hint={
              form.type === 'local'
                ? 'Ein Port auf diesem Rechner führt über den Server zum Ziel.'
                : form.type === 'remote'
                  ? 'Ein Port auf dem Server führt zurück zu einem Ziel, das dieser Rechner erreicht.'
                  : 'Ein SOCKS5-Proxy auf diesem Rechner, alle Verbindungen laufen über den Server.'
            }
          >
            <Select
              id="forward-type"
              value={form.type}
              onChange={(value) => update('type', value as ForwardInput['type'])}
              options={(Object.keys(TYPE_LABEL) as ForwardInput['type'][]).map((value) => ({ value, label: TYPE_LABEL[value] }))}
            />
          </Field>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label={form.type === 'remote' ? 'Bind-Adresse auf dem Server' : 'Bind-Adresse'} htmlFor="forward-bind" error={errors.bindAddress}>
              <Input id="forward-bind" spellCheck={false} value={form.bindAddress} onChange={(event) => update('bindAddress', event.target.value)} />
            </Field>
            <Field label="Quellport" htmlFor="forward-port" error={errors.bindPort} hint="0 = frei wählen">
              <Input id="forward-port" inputMode="numeric" value={form.bindPort} onChange={(event) => update('bindPort', event.target.value)} />
            </Field>
          </div>
          {publicBind && (
            <div role="alert" className="flex flex-col gap-2 rounded-control border border-warning p-2.5 text-xs text-text">
              <p className="flex items-start gap-2">
                <AlertTriangle size={15} className="mt-px flex-none text-warning" />
                <span>
                  „{form.bindAddress.trim()}“ ist nicht Loopback. Der Port ist damit von anderen Rechnern erreichbar, und jeder, der ihn
                  erreicht, kann den Tunnel benutzen. RYFT prüft dabei keine Anmeldung.
                </span>
              </p>
              <Checkbox
                label="Ich möchte diesen Port bewusst im Netz öffnen"
                checked={form.allowNonLoopback}
                onChange={(value) => update('allowNonLoopback', value)}
              />
              {errors.allowNonLoopback && <span className="text-[11px] text-error">{errors.allowNonLoopback}</span>}
            </div>
          )}
          {needsDestination && (
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field label="Zielhost" htmlFor="forward-dest" error={errors.destHost}>
                <Input id="forward-dest" spellCheck={false} value={form.destHost} onChange={(event) => update('destHost', event.target.value)} />
              </Field>
              <Field label="Zielport" htmlFor="forward-dest-port" error={errors.destPort}>
                <Input id="forward-dest-port" inputMode="numeric" value={form.destPort} onChange={(event) => update('destPort', event.target.value)} />
              </Field>
            </div>
          )}
          <Checkbox
            label="Bei Verbindungsverlust automatisch neu aufbauen"
            hint="Mit wachsendem Abstand zwischen den Versuchen, bis du stoppst."
            checked={form.autoReconnect}
            onChange={(value) => update('autoReconnect', value)}
          />
          <Checkbox
            label="Beim Start von RYFT wiederherstellen"
            hint="Baut die Verbindung beim Programmstart ohne weitere Nachfrage auf."
            checked={form.restoreOnStart}
            onChange={(value) => update('restoreOnStart', value)}
          />
          {running && running !== 'stopped' && (
            <p className="text-xs text-secondary">Änderungen gelten erst nach einem Neustart der Weiterleitung.</p>
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

function StatusBadge({ runtime }: { runtime: ForwardRuntime | undefined }) {
  const status = runtime?.status ?? 'stopped';
  const busy = status === 'starting' || status === 'reconnecting';
  return (
    <span className="flex items-center gap-1.5 text-xs text-text" data-testid="forward-status" data-status={status}>
      {busy ? (
        <Loader2 size={12} className="ryft-spin flex-none text-warning" />
      ) : (
        <span
          className={cx(
            'size-2 flex-none rounded-full',
            status === 'running' ? 'bg-success' : status === 'failed' ? 'bg-error' : 'bg-subtle'
          )}
        />
      )}
      <span className="truncate">
        {STATUS_LABEL[status]}
        {status === 'reconnecting' && runtime?.attempt ? ` (${runtime.attempt})` : ''}
        {status === 'running' && runtime && runtime.connections > 0 ? ` · ${runtime.connections} Verb.` : ''}
      </span>
    </span>
  );
}

const COLUMNS = 'grid-cols-[minmax(120px,1.4fr)_minmax(90px,1fr)_88px_minmax(130px,1.2fr)_minmax(130px,1.2fr)_minmax(110px,1fr)_112px]';

function ForwardRow({ profile, host, onEdit }: { profile: ForwardProfile; host: Host | undefined; onEdit(): void }) {
  const runtime = useForwards((state) => state.runtime[profile.id]);
  const start = useForwards((state) => state.start);
  const stop = useForwards((state) => state.stop);
  const remove = useForwards((state) => state.remove);
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const status = runtime?.status ?? 'stopped';
  const active = status === 'running' || status === 'starting' || status === 'reconnecting';
  const publicListener = !isLoopbackAddress(profile.bindAddress);
  const shownPort = runtime?.boundPort ?? profile.bindPort;

  return (
    <div role="row" data-testid="forward-row" className="flex flex-none flex-col border-b border-border px-4 py-1.5">
      <div className={cx('grid min-h-8 items-center gap-3', COLUMNS)}>
        <span role="cell" className="truncate text-[13px] font-medium text-text" title={profile.name}>
          {profile.name}
        </span>
        <span role="cell" className="truncate text-xs text-secondary">
          {host?.name ?? '–'}
        </span>
        <span role="cell" className="truncate text-xs text-secondary">
          {TYPE_LABEL[profile.type]}
        </span>
        <span role="cell" className="flex min-w-0 items-center gap-1.5 font-terminal text-[11px] text-text">
          {publicListener && (
            <span title="Von anderen Rechnern erreichbar">
              <AlertTriangle size={13} className="flex-none text-warning" aria-label="Von anderen Rechnern erreichbar" />
            </span>
          )}
          <span className="truncate">
            {profile.bindAddress}:{shownPort}
          </span>
        </span>
        <span role="cell" className="truncate font-terminal text-[11px] text-secondary">
          {profile.type === 'dynamic' ? 'SOCKS5' : `${profile.destHost}:${profile.destPort}`}
        </span>
        <span role="cell" className="min-w-0">
          <StatusBadge runtime={runtime} />
        </span>
        <span role="cell" className="flex items-center justify-end gap-0.5">
          {active ? (
            <IconButton label={`${profile.name} stoppen`} onClick={() => void attempt(() => stop(profile.id))}>
              <Square size={13} />
            </IconButton>
          ) : (
            <IconButton label={`${profile.name} starten`} onClick={() => void attempt(() => start(profile.id))}>
              <Play size={13} className="text-cyan" />
            </IconButton>
          )}
          <IconButton
            label={`Adresse von ${profile.name} kopieren`}
            disabled={status !== 'running'}
            onClick={() =>
              void attempt(async () => {
                await navigator.clipboard.writeText(`${profile.bindAddress}:${shownPort}`);
                toast('success', 'Adresse kopiert');
              })
            }
          >
            <Copy size={13} />
          </IconButton>
          <IconButton label={`${profile.name} bearbeiten`} onClick={onEdit}>
            <Pencil size={13} />
          </IconButton>
          <IconButton
            label={`${profile.name} löschen`}
            onClick={() =>
              askConfirm({
                title: `„${profile.name}“ löschen?`,
                message: active ? 'Die laufende Weiterleitung wird gestoppt.' : 'Das Profil wird entfernt.',
                confirmLabel: 'Löschen',
                danger: true,
                onConfirm: () => void attempt(() => remove(profile.id))
              })
            }
          >
            <Trash2 size={13} />
          </IconButton>
        </span>
      </div>
      {runtime?.error && (status === 'failed' || status === 'reconnecting') && (
        <p role="alert" className="mt-0.5 flex items-start gap-1.5 text-[11px] break-words text-error select-text">
          <AlertTriangle size={12} className="mt-px flex-none" />
          {runtime.error}
        </p>
      )}
    </div>
  );
}

export function ForwardsView() {
  const profiles = useForwards((state) => state.profiles);
  const load = useForwards((state) => state.load);
  const activeCount = useForwards((state) => Object.values(state.runtime).filter((item) => item.status === 'running').length);
  const hosts = useApp((state) => state.hosts);
  const [editing, setEditing] = useState<{ profile: ForwardProfile | null } | null>(null);

  useEffect(() => {
    void attempt(load);
    // Deleting a host removes its profiles in main, so the list has to follow the hosts.
  }, [load, hosts.length]);

  return (
    <ToolView
      testId="forwards-view"
      title="Port Forwarding"
      description={`${profiles.length} Profile, ${activeCount} aktiv`}
      actions={
        <Button variant="primary" disabled={hosts.length === 0} onClick={() => setEditing({ profile: null })}>
          <Plus size={14} /> Weiterleitung
        </Button>
      }
    >
      {profiles.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<ArrowLeftRight size={26} />}
            title="Noch keine Weiterleitungen"
            description={
              hosts.length === 0
                ? 'Lege zuerst einen Host an. Eine Weiterleitung läuft immer über einen gespeicherten Host.'
                : 'Mach einen entfernten Dienst lokal erreichbar, einen lokalen auf dem Server, oder starte einen SOCKS-Proxy.'
            }
          />
        </div>
      ) : (
        <div role="table" aria-label="Port-Weiterleitungen" className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div role="row" className={cx('grid h-7 flex-none items-center gap-3 border-b border-border px-4 text-[11px] text-subtle', COLUMNS)}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Host</span>
            <span role="columnheader">Art</span>
            <span role="columnheader">Bind / Quellport</span>
            <span role="columnheader">Ziel</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className="sr-only">Aktionen</span>
          </div>
          {profiles.map((profile) => (
            <ForwardRow
              key={profile.id}
              profile={profile}
              host={hosts.find((host) => host.id === profile.hostId)}
              onEdit={() => setEditing({ profile })}
            />
          ))}
        </div>
      )}
      {editing && <ForwardEditor editing={editing} hosts={hosts} onClose={() => setEditing(null)} />}
    </ToolView>
  );
}
