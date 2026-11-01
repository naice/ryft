import { useEffect, useState, type FormEvent } from 'react';
import { FolderOpen, KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { AuthMethod, AuthProfile } from '@shared/contracts';
import { authProfileInputSchema } from '@shared/features/authProfiles';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { Button, Field, IconButton, Input, Select } from '../../components/ui/primitives';

const METHOD_LABEL: Record<AuthMethod, string> = {
  agent: 'SSH-Agent',
  key: 'Schlüsseldatei',
  password: 'Passwort'
};

const FIELD_ERRORS: Record<string, string> = {
  name: 'Name erforderlich',
  username: 'Ohne Leerzeichen',
  keyReference: 'Schlüsseldatei erforderlich'
};

function ProfileForm({ profile, onDone }: { profile: AuthProfile | null; onDone(): void }) {
  const vault = useApp((state) => state.vault);
  const refresh = useApp((state) => state.refreshAuthProfiles);
  const toast = useApp((state) => state.toast);
  const [name, setName] = useState(profile?.name ?? '');
  const [method, setMethod] = useState<AuthMethod>(profile?.method ?? 'agent');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [keyReference, setKeyReference] = useState(profile?.keyReference ?? '');
  // Only ever kept in this component's local state, like the host editor's.
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = authProfileInputSchema.safeParse({
      name,
      method,
      username: username.trim() || null,
      keyReference: method === 'key' ? keyReference.trim() || null : null
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] = FIELD_ERRORS[field] ?? issue.message;
      }
      setErrors(next);
      return;
    }
    void attempt(async () => {
      const saved = profile
        ? await api.invoke(Channels.authProfilesUpdate, { id: profile.id, input: parsed.data })
        : await api.invoke(Channels.authProfilesCreate, parsed.data);
      if (secret && method !== 'agent') {
        await api.invoke(Channels.authProfilesSetSecret, {
          id: saved.id,
          kind: method === 'key' ? 'passphrase' : 'password',
          value: secret
        });
      }
      await refresh();
      toast('success', `„${saved.name}“ gespeichert`);
      onDone();
    });
  };

  const pickKey = () =>
    void attempt(async () => {
      const path = await api.invoke(Channels.dialogPickKeyFile);
      if (path) setKeyReference(path);
    });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-control border border-border-active bg-card p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Profilname" htmlFor="profile-name" error={errors.name}>
          <Input id="profile-name" autoFocus maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Methode" htmlFor="profile-method">
          <Select
            id="profile-method"
            value={method}
            options={(Object.keys(METHOD_LABEL) as AuthMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))}
            onChange={(value) => setMethod(value as AuthMethod)}
          />
        </Field>
      </div>
      <Field label="Benutzer (optional)" htmlFor="profile-user" error={errors.username} hint="Ersetzt den Benutzer des Hosts, wenn gesetzt.">
        <Input id="profile-user" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
      </Field>
      {method === 'key' && (
        <Field label="Schlüsseldatei" htmlFor="profile-key" error={errors.keyReference} hint="RYFT speichert nur den Pfad, nie den Schlüssel.">
          <div className="flex gap-2">
            <Input id="profile-key" spellCheck={false} placeholder="~/.ssh/id_ed25519" value={keyReference} onChange={(event) => setKeyReference(event.target.value)} />
            <Button className="flex-none" onClick={pickKey}>
              <FolderOpen size={14} /> Auswählen
            </Button>
          </div>
        </Field>
      )}
      {method !== 'agent' && (
        <Field
          label={method === 'key' ? 'Passphrase (optional)' : 'Passwort (optional)'}
          htmlFor="profile-secret"
          hint={vault.available ? 'Wird im Schlüsselbund des Betriebssystems gespeichert.' : 'Kein Schlüsselbund verfügbar. Du wirst bei jeder Verbindung gefragt.'}
        >
          <Input
            id="profile-secret"
            type="password"
            autoComplete="off"
            disabled={!vault.available}
            placeholder={profile?.hasStoredSecret ? 'Gespeichert – zum Ersetzen neu eingeben' : ''}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Abbrechen</Button>
        <Button type="submit" variant="primary">
          Profil speichern
        </Button>
      </div>
    </form>
  );
}

export function AuthProfilesSection() {
  const profiles = useApp((state) => state.authProfiles);
  const refresh = useApp((state) => state.refreshAuthProfiles);
  const askConfirm = useApp((state) => state.askConfirm);
  const [editing, setEditing] = useState<{ profile: AuthProfile | null } | null>(null);

  useEffect(() => {
    // How many hosts use a profile changes whenever a host is saved or deleted.
    void attempt(refresh);
  }, [refresh]);

  const remove = (profile: AuthProfile) =>
    askConfirm({
      title: `Profil „${profile.name}“ löschen?`,
      message:
        profile.usedByHosts > 0
          ? `${profile.usedByHosts} Hosts nutzen dieses Profil. Sie fallen auf ihre eigene Anmeldung zurück und fragen beim Verbinden gegebenenfalls nach. Das gespeicherte Secret des Profils wird gelöscht.`
          : 'Das Profil und sein gespeichertes Secret werden gelöscht.',
      confirmLabel: 'Löschen',
      danger: true,
      onConfirm: () =>
        void attempt(async () => {
          await api.invoke(Channels.authProfilesDelete, { id: profile.id });
          await refresh();
          useApp.setState({ hosts: await api.invoke(Channels.hostsList) });
        })
    });

  const clearSecret = (profile: AuthProfile) =>
    void attempt(async () => {
      await api.invoke(Channels.authProfilesClearSecret, { id: profile.id });
      await refresh();
    });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[13px] font-semibold text-text">Anmeldeprofile</h2>
        <Button disabled={editing !== null} onClick={() => setEditing({ profile: null })}>
          <Plus size={14} /> Profil
        </Button>
      </div>
      <p className="text-xs text-secondary">
        Eine Anmeldung einmal festlegen und für mehrere Hosts verwenden. Secrets liegen nur im Schlüsselbund des Betriebssystems.
      </p>
      {editing && <ProfileForm key={editing.profile?.id ?? 'new'} profile={editing.profile} onDone={() => setEditing(null)} />}
      {profiles.length === 0 && !editing && <p className="text-xs text-subtle">Noch keine Profile.</p>}
      <div className="flex flex-col gap-1.5">
        {profiles.map((profile) => (
          <div key={profile.id} data-testid="auth-profile" className="flex items-center gap-2 rounded-control border border-border bg-card p-2">
            <KeyRound size={14} className="flex-none text-cyan" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-medium text-text">{profile.name}</span>
              <span className="truncate text-[11px] text-secondary">
                {METHOD_LABEL[profile.method]}
                {profile.username ? ` · ${profile.username}` : ''}
                {` · ${profile.usedByHosts} Hosts`}
              </span>
            </div>
            {profile.hasStoredSecret && (
              <Button variant="ghost" className="!h-6 !px-2 text-xs" onClick={() => clearSecret(profile)}>
                <ShieldCheck size={13} className="text-success" /> Secret entfernen
              </Button>
            )}
            <IconButton label={`${profile.name} bearbeiten`} onClick={() => setEditing({ profile })}>
              <Pencil size={14} />
            </IconButton>
            <IconButton label={`${profile.name} löschen`} onClick={() => remove(profile)}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </section>
  );
}
