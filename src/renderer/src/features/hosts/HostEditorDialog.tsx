import { useEffect, useState, type FormEvent } from 'react';
import { FolderOpen, KeyRound, ShieldCheck } from 'lucide-react';
import { Channels } from '@shared/channels';
import { hostInputSchema, type AuthMethod, type Host } from '@shared/contracts';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { Button, Checkbox, Field, Input, Modal, Select } from '../../components/ui/primitives';

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
  favorite: false
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
    favorite: host.favorite
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
  tags: 'Maximal 16 Tags mit je bis zu 32 Zeichen'
};

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
    }
  }, [open, host, groupFilter]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = {
      name: form.name,
      hostname: form.hostname,
      port: Number(form.port),
      username: form.username,
      authMethod: form.authMethod,
      keyReference: form.authMethod === 'key' ? form.keyReference.trim() || null : null,
      groupId: form.groupId || null,
      tags: [...new Set(form.tags.split(',').map((tag) => tag.trim()).filter(Boolean))],
      favorite: form.favorite
    };
    const parsed = hostInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] = FIELD_ERRORS[field] ?? issue.message;
      }
      setErrors(next);
      return;
    }
    setSaving(true);
    const ok = await attempt(async () => {
      const input = { ...parsed.data };
      if (newGroup.trim()) input.groupId = (await createGroup(newGroup.trim())).id;
      const saved = await saveHost(host?.id ?? null, input);
      if (secret && form.authMethod !== 'agent') {
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

          {form.authMethod === 'key' && (
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

          {form.authMethod !== 'agent' && (
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
          {form.authMethod === 'agent' && (
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
