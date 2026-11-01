import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, FolderOpen, KeyRound, ShieldCheck, X } from 'lucide-react';
import { Channels } from '@shared/channels';
import { DEFAULT_HOST_OPTIONS, hostInputSchema, type AuthMethod, type Host, type HostOptions } from '@shared/contracts';
import { flattenJumpChain } from '@shared/features/jumpChain';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { Button, Checkbox, cx, Field, IconButton, Input, Modal, Select, TEXTAREA } from '../../components/ui/primitives';
import { useKeys } from '../keys/keyStore';

interface FormState {
  name: string;
  hostname: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  keyReference: string;
  groupId: string;
  tags: string;
  favorite: boolean;
  authProfileId: string;
  options: OptionsForm;
}

/** The advanced options as typed; they only become numbers and lists when saving. */
interface OptionsForm {
  connectTimeoutSec: string;
  keepaliveIntervalSec: string;
  reconnectPolicy: HostOptions['reconnectPolicy'];
  defaultRemoteDir: string;
  terminalType: string;
  encoding: HostOptions['encoding'];
  env: string;
  startupCommands: string;
  runStartupCommands: boolean;
  proxyType: HostOptions['proxy']['type'];
  proxyHost: string;
  proxyPort: string;
  jumpHostIds: string[];
  shellIntegration: boolean;
}

function optionsToForm(options: HostOptions): OptionsForm {
  return {
    connectTimeoutSec: String(options.connectTimeoutSec),
    keepaliveIntervalSec: String(options.keepaliveIntervalSec),
    reconnectPolicy: options.reconnectPolicy,
    defaultRemoteDir: options.defaultRemoteDir,
    terminalType: options.terminalType,
    encoding: options.encoding,
    env: options.env.map(({ name, value }) => `${name}=${value}`).join('\n'),
    startupCommands: options.startupCommands.join('\n'),
    runStartupCommands: options.runStartupCommands,
    proxyType: options.proxy.type,
    proxyHost: options.proxy.type === 'none' ? '' : options.proxy.host,
    proxyPort: options.proxy.type === 'none' ? '' : String(options.proxy.port),
    jumpHostIds: options.jumpHostIds,
    shellIntegration: options.shellIntegration
  };
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formToOptions(form: OptionsForm): unknown {
  return {
    connectTimeoutSec: Number(form.connectTimeoutSec),
    keepaliveIntervalSec: Number(form.keepaliveIntervalSec),
    reconnectPolicy: form.reconnectPolicy,
    defaultRemoteDir: form.defaultRemoteDir,
    terminalType: form.terminalType,
    encoding: form.encoding,
    env: nonEmptyLines(form.env).map((line) => {
      const index = line.indexOf('=');
      return index < 0 ? { name: line, value: '' } : { name: line.slice(0, index), value: line.slice(index + 1) };
    }),
    startupCommands: nonEmptyLines(form.startupCommands),
    runStartupCommands: form.runStartupCommands,
    proxy:
      form.proxyType === 'none' ? { type: 'none' } : { type: form.proxyType, host: form.proxyHost, port: Number(form.proxyPort) },
    jumpHostIds: form.jumpHostIds,
    shellIntegration: form.shellIntegration
  };
}

const EMPTY: FormState = {
  name: '',
  hostname: '',
  port: '22',
  username: '',
  authMethod: 'agent',
  keyReference: '',
  groupId: '',
  tags: '',
  favorite: false,
  authProfileId: '',
  options: optionsToForm(DEFAULT_HOST_OPTIONS)
};

function fromHost(host: Host | null, groupId: string | null): FormState {
  if (!host) return { ...EMPTY, groupId: groupId ?? '' };
  return {
    name: host.name,
    hostname: host.hostname,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    keyReference: host.keyReference ?? '',
    groupId: host.groupId ?? '',
    tags: host.tags.join(', '),
    favorite: host.favorite,
    authProfileId: host.authProfileId ?? '',
    options: optionsToForm(host.options)
  };
}

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: 'agent', label: 'SSH-Agent' },
  { value: 'key', label: 'Schlüsseldatei' },
  { value: 'password', label: 'Passwort' }
];

const FIELD_ERRORS: Record<string, string> = {
  name: 'Name erforderlich',
  hostname: 'Gültiger Hostname oder IP erforderlich',
  port: 'Port zwischen 1 und 65535',
  username: 'Benutzername erforderlich, ohne Leerzeichen',
  keyReference: 'Schlüsseldatei erforderlich',
  tags: 'Maximal 16 Tags mit je bis zu 32 Zeichen',
  'options.connectTimeoutSec': '1 bis 600 Sekunden',
  'options.keepaliveIntervalSec': '0 bis 3600 Sekunden',
  'options.defaultRemoteDir': 'Keine Steuerzeichen, maximal 4096 Zeichen',
  'options.terminalType': 'Nur Buchstaben, Ziffern und . _ + -',
  'options.env': 'Eine Variable je Zeile als NAME=Wert, maximal 32',
  'options.startupCommands': 'Maximal 32 Befehle mit je bis zu 4096 Zeichen',
  'options.proxy': 'Proxy-Host und Port zwischen 1 und 65535 erforderlich'
};

function fieldOf(path: readonly PropertyKey[]): string {
  // Nested paths such as options.env.3.name report on the field the user actually edits.
  return path[0] === 'options' ? `options.${String(path[1])}` : String(path[0]);
}

const CHAIN_PROBLEM: Record<'cycle' | 'missing' | 'tooLong', string> = {
  cycle: 'Diese Sprung-Hosts bilden einen Kreis.',
  missing: 'Ein Sprung-Host existiert nicht mehr.',
  tooLong: 'Die Kette hat zu viele Sprünge (maximal 8).'
};

function AdvancedOptions({
  value,
  errors,
  hostId,
  open,
  onToggle,
  onChange
}: {
  value: OptionsForm;
  errors: Record<string, string>;
  hostId: string | null;
  open: boolean;
  onToggle(open: boolean): void;
  onChange(patch: Partial<OptionsForm>): void;
}) {
  const hosts = useApp((state) => state.hosts);
  const candidates = hosts.filter((item) => item.id !== hostId && !value.jumpHostIds.includes(item.id));
  return (
    <div className="flex-none rounded-control border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="flex h-8 w-full items-center gap-1.5 px-2.5 text-xs font-medium text-secondary hover:text-text"
      >
        <ChevronRight size={14} className={cx('transition-transform duration-120', open && 'rotate-90')} />
        Erweitert
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Verbindungs-Timeout (s)" htmlFor="host-timeout" error={errors['options.connectTimeoutSec']}>
              <Input
                id="host-timeout"
                inputMode="numeric"
                value={value.connectTimeoutSec}
                onChange={(event) => onChange({ connectTimeoutSec: event.target.value })}
              />
            </Field>
            <Field label="Keepalive (s, 0 = aus)" htmlFor="host-keepalive" error={errors['options.keepaliveIntervalSec']}>
              <Input
                id="host-keepalive"
                inputMode="numeric"
                value={value.keepaliveIntervalSec}
                onChange={(event) => onChange({ keepaliveIntervalSec: event.target.value })}
              />
            </Field>
            <Field label="Neu verbinden" htmlFor="host-reconnect">
              <Select
                id="host-reconnect"
                value={value.reconnectPolicy}
                options={[
                  { value: 'inherit', label: 'Wie Einstellung' },
                  { value: 'auto', label: 'Automatisch' },
                  { value: 'never', label: 'Nie' }
                ]}
                onChange={(next) => onChange({ reconnectPolicy: next as OptionsForm['reconnectPolicy'] })}
              />
            </Field>
          </div>
          <Field
            label="SFTP-Startordner"
            htmlFor="host-remote-dir"
            error={errors['options.defaultRemoteDir']}
            hint="Leer: Home-Ordner des Benutzers"
          >
            <Input
              id="host-remote-dir"
              spellCheck={false}
              placeholder="/var/www"
              value={value.defaultRemoteDir}
              onChange={(event) => onChange({ defaultRemoteDir: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Terminal-Typ" htmlFor="host-term" error={errors['options.terminalType']}>
              <Input
                id="host-term"
                spellCheck={false}
                value={value.terminalType}
                onChange={(event) => onChange({ terminalType: event.target.value })}
              />
            </Field>
            <Field label="Zeichenkodierung" htmlFor="host-encoding">
              <Select
                id="host-encoding"
                value={value.encoding}
                options={[
                  { value: 'utf8', label: 'UTF-8' },
                  { value: 'latin1', label: 'Latin-1' }
                ]}
                onChange={(next) => onChange({ encoding: next as OptionsForm['encoding'] })}
              />
            </Field>
          </div>
          <Field
            label="Umgebungsvariablen"
            htmlFor="host-env"
            error={errors['options.env']}
            hint="NAME=Wert je Zeile. Der Server übernimmt nur, was er per AcceptEnv erlaubt. Keine Secrets eintragen: diese Werte liegen unverschlüsselt in der Datenbank."
          >
            <textarea
              id="host-env"
              rows={2}
              spellCheck={false}
              value={value.env}
              onChange={(event) => onChange({ env: event.target.value })}
              className={TEXTAREA}
            />
          </Field>
          <Field
            label="Startbefehle"
            htmlFor="host-startup"
            error={errors['options.startupCommands']}
            hint="Ein Befehl je Zeile. Ohne das Häkchen darunter werden sie nicht ausgeführt."
          >
            <textarea
              id="host-startup"
              rows={2}
              spellCheck={false}
              value={value.startupCommands}
              onChange={(event) => onChange({ startupCommands: event.target.value })}
              className={TEXTAREA}
            />
          </Field>
          <Checkbox
            label="Startbefehle bei jeder Verbindung automatisch ausführen"
            checked={value.runStartupCommands}
            onChange={(runStartupCommands) => onChange({ runStartupCommands })}
          />
          <Checkbox
            label="Shell-Integration für den Befehlsverlauf"
            hint="Schickt beim Verbinden eine sichtbare Einrichtungszeile an bash oder zsh. In fish und anderen Shells bleibt der Verlauf leer."
            checked={value.shellIntegration}
            onChange={(shellIntegration) => onChange({ shellIntegration })}
          />
          <div className="grid grid-cols-[132px_1fr_88px] gap-3">
            <Field label="Proxy" htmlFor="host-proxy">
              <Select
                id="host-proxy"
                value={value.proxyType}
                options={[
                  { value: 'none', label: 'Keiner' },
                  { value: 'socks5', label: 'SOCKS5' },
                  { value: 'http', label: 'HTTP CONNECT' }
                ]}
                onChange={(next) => onChange({ proxyType: next as OptionsForm['proxyType'] })}
              />
            </Field>
            <Field label="Proxy-Host" htmlFor="host-proxy-host" error={errors['options.proxy']}>
              <Input
                id="host-proxy-host"
                spellCheck={false}
                disabled={value.proxyType === 'none'}
                value={value.proxyHost}
                onChange={(event) => onChange({ proxyHost: event.target.value })}
              />
            </Field>
            <Field label="Proxy-Port" htmlFor="host-proxy-port">
              <Input
                id="host-proxy-port"
                inputMode="numeric"
                disabled={value.proxyType === 'none'}
                value={value.proxyPort}
                onChange={(event) => onChange({ proxyPort: event.target.value })}
              />
            </Field>
          </div>
          <Field
            label="Sprung-Hosts"
            htmlFor="host-jump"
            error={errors['options.jumpHostIds']}
            hint="In Verbindungsreihenfolge. Jeder Host-Schlüssel wird einzeln geprüft."
          >
            <div className="flex flex-col gap-1.5">
              {value.jumpHostIds.map((jumpId, index) => (
                <div key={jumpId} className="flex h-7 items-center gap-2 rounded-control border border-border bg-card px-2 text-xs text-text">
                  <span className="text-subtle">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{hosts.find((item) => item.id === jumpId)?.name ?? 'Gelöschter Host'}</span>
                  <IconButton
                    label="Sprung-Host entfernen"
                    size={20}
                    onClick={() => onChange({ jumpHostIds: value.jumpHostIds.filter((item) => item !== jumpId) })}
                  >
                    <X size={12} />
                  </IconButton>
                </div>
              ))}
              <Select
                id="host-jump"
                value=""
                options={[
                  { value: '', label: candidates.length ? 'Sprung-Host hinzufügen…' : 'Keine weiteren Hosts' },
                  ...candidates.map((item) => ({ value: item.id, label: item.name }))
                ]}
                onChange={(next) => {
                  if (next) onChange({ jumpHostIds: [...value.jumpHostIds, next] });
                }}
              />
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

export function HostEditorDialog() {
  const editor = useApp((state) => state.editor);
  const closeEditor = useApp((state) => state.closeEditor);
  const saveHost = useApp((state) => state.saveHost);
  const refreshHost = useApp((state) => state.refreshHost);
  const groups = useApp((state) => state.groups);
  const createGroup = useApp((state) => state.createGroup);
  const groupFilter = useApp((state) => state.groupFilter);
  const vault = useApp((state) => state.vault);
  const toast = useApp((state) => state.toast);
  const authProfiles = useApp((state) => state.authProfiles);
  const refreshAuthProfiles = useApp((state) => state.refreshAuthProfiles);
  const hosts = useApp((state) => state.hosts);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const managedKeys = useKeys((state) => state.keys);
  const loadKeys = useKeys((state) => state.load);

  const host = editor?.host ?? null;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  // Only ever kept in this component's local state, and cleared with it.
  const [secret, setSecret] = useState('');

  const open = editor !== null;
  useEffect(() => {
    if (open) {
      setForm(fromHost(host, groupFilter));
      setErrors({});
      setSecret('');
      setNewGroup('');
      setAdvancedOpen(false);
      void attempt(loadKeys);
    }
  }, [open, host, groupFilter, loadKeys]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
  };

  const updateOptions = (patch: Partial<OptionsForm>) => {
    setForm((current) => ({ ...current, options: { ...current.options, ...patch } }));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith('options.'))));
  };

  const usesProfile = form.authProfileId !== '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = {
      name: form.name,
      hostname: form.hostname,
      port: Number(form.port),
      username: form.username,
      authMethod: form.authMethod,
      keyReference: form.authMethod === 'key' ? form.keyReference.trim() || null : null,
      authProfileId: form.authProfileId || null,
      options: formToOptions(form.options),
      groupId: form.groupId || null,
      tags: [...new Set(form.tags.split(',').map((tag) => tag.trim()).filter(Boolean))],
      favorite: form.favorite
    };
    const parsed = hostInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = fieldOf(issue.path);
        next[field] = FIELD_ERRORS[field] ?? issue.message;
      }
      setErrors(next);
      if (Object.keys(next).some((key) => key.startsWith('options.'))) setAdvancedOpen(true);
      return;
    }
    // Checked here as well, so that a mistake shows while the form is open and not at connect time.
    const selfId = host?.id ?? crypto.randomUUID();
    const chain = flattenJumpChain(selfId, (id) =>
      id === selfId ? parsed.data.options.jumpHostIds : (hosts.find((item) => item.id === id)?.options.jumpHostIds ?? null)
    );
    if (!chain.ok) {
      setErrors({ 'options.jumpHostIds': CHAIN_PROBLEM[chain.problem.kind] });
      setAdvancedOpen(true);
      return;
    }
    setSaving(true);
    const ok = await attempt(async () => {
      const input = { ...parsed.data };
      if (newGroup.trim()) input.groupId = (await createGroup(newGroup.trim())).id;
      const saved = await saveHost(host?.id ?? null, input);
      await refreshAuthProfiles();
      if (secret && form.authMethod !== 'agent' && !usesProfile) {
        await api.invoke(Channels.secretsSet, {
          hostId: saved.id,
          kind: form.authMethod === 'key' ? 'passphrase' : 'password',
          value: secret
        });
        await refreshHost(saved.id);
      }
      toast('success', `„${saved.name}“ gespeichert`);
    });
    setSaving(false);
    setSecret('');
    if (ok) closeEditor();
  };

  const pickKey = async () => {
    const path = await api.invoke(Channels.dialogPickKeyFile);
    if (path) update('keyReference', path);
  };

  const clearStored = () => {
    if (!host) return;
    void attempt(async () => {
      await api.invoke(Channels.secretsClear, { hostId: host.id });
      await refreshHost(host.id);
      useApp.setState((state) => ({
        editor: state.editor?.host ? { host: { ...state.editor.host, hasStoredSecret: false } } : state.editor
      }));
      toast('success', 'Gespeicherte Zugangsdaten entfernt');
    });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && closeEditor()}
      title={host ? 'Host bearbeiten' : 'Host hinzufügen'}
      width={520}
    >
      <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col" noValidate>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <Field label="Name" htmlFor="host-name" error={errors.name}>
            <Input
              id="host-name"
              autoFocus
              placeholder="prod-web-01"
              maxLength={128}
              aria-invalid={Boolean(errors.name)}
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="Host oder IP" htmlFor="host-hostname" error={errors.hostname}>
              <Input
                id="host-hostname"
                placeholder="192.0.2.10"
                spellCheck={false}
                aria-invalid={Boolean(errors.hostname)}
                value={form.hostname}
                onChange={(event) => update('hostname', event.target.value)}
              />
            </Field>
            <Field label="Port" htmlFor="host-port" error={errors.port}>
              <Input
                id="host-port"
                inputMode="numeric"
                aria-invalid={Boolean(errors.port)}
                value={form.port}
                onChange={(event) => update('port', event.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Benutzer" htmlFor="host-username" error={errors.username}>
              <Input
                id="host-username"
                spellCheck={false}
                aria-invalid={Boolean(errors.username)}
                value={form.username}
                onChange={(event) => update('username', event.target.value)}
              />
            </Field>
            <Field label="Anmeldung" htmlFor="host-auth">
              <Select
                id="host-auth"
                value={form.authMethod}
                options={AUTH_OPTIONS}
                onChange={(value) => update('authMethod', value as AuthMethod)}
              />
            </Field>
          </div>

          {(authProfiles.length > 0 || usesProfile) && (
            <Field
              label="Anmeldeprofil"
              htmlFor="host-auth-profile"
              hint="Ein Profil ersetzt die Anmeldung dieses Hosts. Verwaltet unter Einstellungen › Anmeldeprofile."
            >
              <Select
                id="host-auth-profile"
                value={form.authProfileId}
                options={[
                  { value: '', label: 'Kein Profil' },
                  ...authProfiles.map((profile) => ({ value: profile.id, label: profile.name }))
                ]}
                onChange={(value) => update('authProfileId', value)}
              />
            </Field>
          )}

          {!usesProfile && form.authMethod === 'key' && managedKeys.length > 0 && (
            <Field label="Verwalteter Schlüssel" htmlFor="host-managed-key">
              <Select
                id="host-managed-key"
                value={managedKeys.find((key) => key.privateKeyPath === form.keyReference)?.id ?? ''}
                options={[
                  { value: '', label: 'Eigene Datei' },
                  ...managedKeys.map((key) => ({ value: key.id, label: `${key.name} (${key.type})` }))
                ]}
                onChange={(value) => {
                  const key = managedKeys.find((item) => item.id === value);
                  update('keyReference', key?.privateKeyPath ?? '');
                }}
              />
            </Field>
          )}

          {!usesProfile && form.authMethod === 'key' && (
            <Field
              label="Schlüsseldatei"
              htmlFor="host-key"
              error={errors.keyReference}
              hint="RYFT speichert nur den Pfad, nie den Schlüssel."
            >
              <div className="flex gap-2">
                <Input
                  id="host-key"
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.keyReference)}
                  value={form.keyReference}
                  onChange={(event) => update('keyReference', event.target.value)}
                />
                <Button onClick={() => void pickKey()} className="flex-none">
                  <FolderOpen size={14} /> Auswählen
                </Button>
              </div>
            </Field>
          )}

          {!usesProfile && form.authMethod !== 'agent' && (
            <Field
              label={form.authMethod === 'key' ? 'Passphrase (optional)' : 'Passwort (optional)'}
              htmlFor="host-secret"
              hint={
                vault.available
                  ? `Wird im Schlüsselbund des Betriebssystems gespeichert. Leer lassen, um beim Verbinden gefragt zu werden.`
                  : 'Kein Schlüsselbund verfügbar. Du wirst bei jeder Verbindung gefragt.'
              }
            >
              <Input
                id="host-secret"
                type="password"
                autoComplete="off"
                disabled={!vault.available}
                value={secret}
                placeholder={host?.hasStoredSecret ? 'Gespeichert – zum Ersetzen neu eingeben' : ''}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Field>
          )}

          {host?.hasStoredSecret && (
            <div className="flex items-center gap-2 rounded-control border border-border bg-card px-2.5 py-1.5 text-xs text-secondary">
              <ShieldCheck size={14} className="flex-none text-success" />
              <span className="flex-1">Zugangsdaten liegen im Schlüsselbund.</span>
              <Button variant="ghost" className="!h-6 !px-2 text-xs" onClick={clearStored}>
                Entfernen
              </Button>
            </div>
          )}
          {!usesProfile && form.authMethod === 'agent' && (
            <p className="flex items-center gap-2 text-xs text-secondary">
              <KeyRound size={14} className="flex-none text-cyan" />
              Nutzt den laufenden SSH-Agent des Betriebssystems oder Pageant.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Gruppe" htmlFor="host-group">
              <Select
                id="host-group"
                value={form.groupId}
                options={[
                  { value: '', label: 'Ohne Gruppe' },
                  ...groups.map((group) => ({ value: group.id, label: group.name }))
                ]}
                onChange={(value) => {
                  update('groupId', value);
                  setNewGroup('');
                }}
              />
            </Field>
            <Field label="Oder neue Gruppe" htmlFor="host-new-group">
              <Input
                id="host-new-group"
                maxLength={64}
                placeholder="Production"
                value={newGroup}
                onChange={(event) => setNewGroup(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Tags" htmlFor="host-tags" error={errors.tags} hint="Durch Komma getrennt, durchsuchbar">
            <Input
              id="host-tags"
              placeholder="web, linux"
              value={form.tags}
              onChange={(event) => update('tags', event.target.value)}
            />
          </Field>
          <Checkbox label="Favorit" checked={form.favorite} onChange={(value) => update('favorite', value)} />
          <AdvancedOptions
            value={form.options}
            errors={errors}
            hostId={host?.id ?? null}
            open={advancedOpen}
            onToggle={setAdvancedOpen}
            onChange={updateOptions}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={closeEditor}>Abbrechen</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            Speichern
          </Button>
        </div>
      </form>
    </Modal>
  );
}
