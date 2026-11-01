import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Copy, Download, FileUp, KeyRound, Link2, Loader2, Pencil, Plus, ServerCog, Trash2 } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { ManagedKey } from '@shared/contracts';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { registerPromptContext, unregisterPromptContext } from '../../state/workspaceStore';
import { Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Modal, Select } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';
import { useKeys } from './keyStore';

function PassphraseFields({
  passphrase,
  setPassphrase,
  repeat,
  setRepeat,
  remember,
  setRemember,
  error
}: {
  passphrase: string;
  setPassphrase(value: string): void;
  repeat?: string;
  setRepeat?(value: string): void;
  remember: boolean;
  setRemember(value: boolean): void;
  error?: string;
}) {
  const vault = useApp((state) => state.vault);
  return (
    <>
      <div className={cx('grid gap-3', setRepeat ? 'grid-cols-2' : 'grid-cols-1')}>
        <Field label="Passphrase" htmlFor="key-passphrase" error={error} hint={setRepeat ? 'Empfohlen. Leer bedeutet: ohne Schutz.' : undefined}>
          <Input
            id="key-passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </Field>
        {setRepeat && (
          <Field label="Passphrase wiederholen" htmlFor="key-passphrase-repeat">
            <Input
              id="key-passphrase-repeat"
              type="password"
              autoComplete="off"
              value={repeat ?? ''}
              onChange={(event) => setRepeat(event.target.value)}
            />
          </Field>
        )}
      </div>
      <Checkbox
        label="Passphrase im Schlüsselbund speichern"
        hint={vault.available ? undefined : 'Auf diesem System ist kein Schlüsselbund verfügbar.'}
        disabled={!vault.available || passphrase === ''}
        checked={remember && vault.available && passphrase !== ''}
        onChange={setRemember}
      />
    </>
  );
}

function GenerateDialog({ onClose }: { onClose(): void }) {
  const load = useKeys((state) => state.load);
  const toast = useApp((state) => state.toast);
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [remember, setRemember] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; passphrase?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setErrors({ name: 'Name erforderlich' });
    if (passphrase !== repeat) return setErrors({ passphrase: 'Die beiden Eingaben stimmen nicht überein' });
    setBusy(true);
    void attempt(async () => {
      const key = await api.invoke(Channels.keysGenerate, {
        name,
        comment,
        passphrase: passphrase || null,
        rememberPassphrase: remember && passphrase !== ''
      });
      await load();
      toast('success', `„${key.name}“ erzeugt`);
      onClose();
    }).finally(() => setBusy(false));
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title="ED25519-Schlüssel erzeugen" width={480}>
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <Field label="Name" htmlFor="key-name" error={errors.name}>
            <Input id="key-name" autoFocus maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Kommentar" htmlFor="key-comment" hint="Steht am Ende des öffentlichen Schlüssels.">
            <Input id="key-comment" maxLength={128} spellCheck={false} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <PassphraseFields
            passphrase={passphrase}
            setPassphrase={setPassphrase}
            repeat={repeat}
            setRepeat={setRepeat}
            remember={remember}
            setRemember={setRemember}
            error={errors.passphrase}
          />
          <p className="text-xs text-secondary">
            Der private Schlüssel liegt nur für dich lesbar im Datenordner von RYFT. RYFT zeigt ihn nicht an und speichert ihn nicht in der
            Datenbank.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Loader2 size={14} className="ryft-spin" />} Erzeugen
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface PickedKey {
  token: string;
  path: string;
  suggestedName: string;
  needsPassphrase: boolean;
}

function ImportDialog({ picked, onClose }: { picked: PickedKey; onClose(): void }) {
  const load = useKeys((state) => state.load);
  const toast = useApp((state) => state.toast);
  const [name, setName] = useState(picked.suggestedName);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      const key = await api.invoke(Channels.keysImport, {
        name,
        passphrase: passphrase || null,
        rememberPassphrase: remember && passphrase !== '',
        pickToken: picked.token
      });
      await load();
      toast('success', `„${key.name}“ importiert`);
      onClose();
    });
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title="Schlüssel importieren" description={picked.path} width={480}>
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <Field label="Name" htmlFor="key-import-name">
            <Input id="key-import-name" autoFocus maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          {picked.needsPassphrase && (
            <PassphraseFields passphrase={passphrase} setPassphrase={setPassphrase} remember={remember} setRemember={setRemember} />
          )}
          <p className="text-xs text-secondary">Die Datei bleibt, wo sie ist. RYFT merkt sich nur den Pfad und den öffentlichen Schlüssel.</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Importieren
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameDialog({ keyItem, onClose }: { keyItem: ManagedKey; onClose(): void }) {
  const load = useKeys((state) => state.load);
  const [name, setName] = useState(keyItem.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      await api.invoke(Channels.keysRename, { id: keyItem.id, name });
      await load();
      onClose();
    });
  };
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title="Schlüssel umbenennen" width={400}>
      <form onSubmit={submit} noValidate className="flex flex-col">
        <div className="px-5 pb-4">
          <Field label="Name" htmlFor="key-rename">
            <Input id="key-rename" autoFocus maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Speichern
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AssignDialog({ keyItem, onClose }: { keyItem: ManagedKey; onClose(): void }) {
  const load = useKeys((state) => state.load);
  const hosts = useApp((state) => state.hosts);
  const refreshHost = useApp((state) => state.refreshHost);
  const toast = useApp((state) => state.toast);
  const [selected, setSelected] = useState<string[]>([]);
  const usesKey = (keyReference: string | null) => keyReference === keyItem.privateKeyPath;

  const submit = () => {
    void attempt(async () => {
      await api.invoke(Channels.keysAssign, { id: keyItem.id, hostIds: selected });
      await refreshHost(selected[0] as string);
      await load();
      toast('success', `„${keyItem.name}“ ${selected.length} Host(s) zugewiesen`);
      onClose();
    });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`„${keyItem.name}“ zuweisen`}
      description="Die gewählten Hosts melden sich danach mit diesem Schlüssel an. Eine bisherige Anmeldeart oder ein Anmeldeprofil wird dort ersetzt."
      width={480}
    >
      <div className="flex max-h-[320px] min-h-0 flex-col gap-1.5 overflow-y-auto px-5 pb-4">
        {hosts.length === 0 && <p className="text-xs text-subtle">Noch keine Hosts.</p>}
        {hosts.map((host) => (
          <Checkbox
            key={host.id}
            label={`${host.name} (${host.username}@${host.hostname})`}
            hint={usesKey(host.keyReference) ? 'Verwendet diesen Schlüssel bereits' : undefined}
            disabled={usesKey(host.keyReference)}
            checked={usesKey(host.keyReference) || selected.includes(host.id)}
            onChange={(checked) =>
              setSelected((current) => (checked ? [...current, host.id] : current.filter((id) => id !== host.id)))
            }
          />
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" disabled={selected.length === 0} onClick={submit}>
          Zuweisen
        </Button>
      </div>
    </Modal>
  );
}

function InstallDialog({ keyItem, onClose }: { keyItem: ManagedKey; onClose(): void }) {
  const hosts = useApp((state) => state.hosts);
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const [hostId, setHostId] = useState('');
  const [busy, setBusy] = useState(false);
  const host = hosts.find((item) => item.id === hostId);

  const install = () => {
    if (!host) return;
    askConfirm({
      title: `Schlüssel auf ${host.name} installieren?`,
      message: `RYFT meldet sich als ${host.username} an und ergänzt ~/.ssh/authorized_keys um diese Zeile:\n\n${keyItem.publicKey}\n\nWer den privaten Schlüssel besitzt, kann sich danach dort anmelden. Bestehende Einträge bleiben unverändert.`,
      confirmLabel: 'Installieren',
      danger: true,
      onConfirm: () => {
        const contextId = crypto.randomUUID();
        registerPromptContext(contextId);
        setBusy(true);
        void attempt(async () => {
          const result = await api.invoke(Channels.keysInstall, { id: keyItem.id, hostId: host.id, contextId });
          toast('success', result === 'added' ? `Auf ${host.name} installiert` : `War auf ${host.name} bereits eingetragen`);
          onClose();
        }).finally(() => {
          unregisterPromptContext(contextId);
          setBusy(false);
        });
      }
    });
  };

  return (
    <Modal open onOpenChange={(open) => !open && !busy && onClose()} title={`„${keyItem.name}“ auf Server installieren`} width={480}>
      <div className="flex flex-col gap-3 px-5 pb-4">
        <Field label="Host" htmlFor="key-install-host">
          <Select
            id="key-install-host"
            value={hostId}
            onChange={setHostId}
            options={[{ value: '', label: 'Host wählen…' }, ...hosts.map((item) => ({ value: item.id, label: item.name }))]}
          />
        </Field>
        <p className="text-xs text-secondary">Die Anmeldung läuft über die aktuelle Anmeldeart des Hosts und prüft dessen Host-Schlüssel wie jede Verbindung.</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button disabled={busy} onClick={onClose}>
          Abbrechen
        </Button>
        <Button variant="primary" disabled={!host || busy} onClick={install}>
          {busy && <Loader2 size={14} className="ryft-spin" />} Installieren…
        </Button>
      </div>
    </Modal>
  );
}

function RemoveDialog({ keyItem, onClose }: { keyItem: ManagedKey; onClose(): void }) {
  const load = useKeys((state) => state.load);
  const [deleteFile, setDeleteFile] = useState(false);
  const generated = keyItem.origin === 'generated';
  const remove = () => {
    void attempt(async () => {
      await api.invoke(Channels.keysRemove, { id: keyItem.id, deleteFile: generated && deleteFile });
      await load();
      onClose();
    });
  };
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={`„${keyItem.name}“ entfernen?`} width={460}>
      <div className="flex flex-col gap-3 px-5 pb-4 text-xs text-secondary">
        {keyItem.usedBy.length > 0 && (
          <p role="alert" className="flex items-start gap-2 rounded-control border border-warning p-2.5 text-text">
            <AlertTriangle size={15} className="mt-px flex-none text-warning" />
            <span>Wird noch verwendet von: {keyItem.usedBy.join(', ')}. Diese Einträge verweisen weiter auf die Datei.</span>
          </p>
        )}
        <p>{generated ? 'RYFT vergisst den Schlüssel. Die Datei bleibt, wenn du sie nicht ausdrücklich löschst.' : 'RYFT vergisst den Schlüssel. Die importierte Datei wird nie gelöscht.'}</p>
        {generated && (
          <Checkbox
            label="Auch die private Schlüsseldatei löschen"
            hint="Kann nicht rückgängig gemacht werden. Server, die nur diesen Schlüssel kennen, sind danach nicht mehr erreichbar."
            checked={deleteFile}
            onChange={setDeleteFile}
          />
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="danger" onClick={remove}>
          Entfernen
        </Button>
      </div>
    </Modal>
  );
}

type Dialog =
  | { kind: 'generate' }
  | { kind: 'import'; picked: PickedKey }
  | { kind: 'rename' | 'assign' | 'install' | 'remove'; key: ManagedKey };

const COLUMNS = 'grid-cols-[minmax(120px,1.1fr)_88px_minmax(180px,1.8fr)_minmax(110px,1fr)_142px]';

function KeyRow({ keyItem, onDialog }: { keyItem: ManagedKey; onDialog(dialog: Dialog): void }) {
  const toast = useApp((state) => state.toast);
  return (
    <div role="row" data-testid="key-row" className={cx('grid min-h-11 flex-none items-center gap-3 border-b border-border px-4 py-1.5', COLUMNS)}>
      <span role="cell" className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium text-text" title={keyItem.privateKeyPath}>
          {keyItem.name}
        </span>
        <span className="truncate text-[11px] text-subtle">
          {keyItem.origin === 'generated' ? 'Erzeugt' : 'Importiert'}
          {keyItem.encrypted ? ' · Passphrase' : ' · Ohne Passphrase'}
        </span>
      </span>
      <span role="cell" className="truncate text-xs text-secondary">
        {keyItem.type}
      </span>
      <code role="cell" className="truncate font-terminal text-[11px] text-text select-text" title={keyItem.fingerprint} data-testid="key-fingerprint">
        {keyItem.fingerprint}
      </code>
      <span role="cell" className="truncate text-xs text-secondary" title={keyItem.usedBy.join(', ')}>
        {keyItem.usedBy.length > 0 ? keyItem.usedBy.join(', ') : '–'}
      </span>
      <span role="cell" className="flex items-center justify-end gap-0.5">
        <IconButton
          label={`Öffentlichen Schlüssel von ${keyItem.name} kopieren`}
          onClick={() =>
            void attempt(async () => {
              await api.invoke(Channels.clipboardWrite, { text: keyItem.publicKey });
              toast('success', 'Öffentlicher Schlüssel kopiert');
            })
          }
        >
          <Copy size={13} />
        </IconButton>
        <IconButton
          label={`Öffentlichen Schlüssel von ${keyItem.name} exportieren`}
          onClick={() =>
            void attempt(async () => {
              if (await api.invoke(Channels.keysExportPublic, { id: keyItem.id })) toast('success', 'Öffentlicher Schlüssel exportiert');
            })
          }
        >
          <Download size={13} />
        </IconButton>
        <IconButton label={`${keyItem.name} Hosts zuweisen`} onClick={() => onDialog({ kind: 'assign', key: keyItem })}>
          <Link2 size={13} />
        </IconButton>
        <IconButton label={`${keyItem.name} auf Server installieren`} onClick={() => onDialog({ kind: 'install', key: keyItem })}>
          <ServerCog size={13} />
        </IconButton>
        <IconButton label={`${keyItem.name} umbenennen`} onClick={() => onDialog({ kind: 'rename', key: keyItem })}>
          <Pencil size={13} />
        </IconButton>
        <IconButton label={`${keyItem.name} entfernen`} onClick={() => onDialog({ kind: 'remove', key: keyItem })}>
          <Trash2 size={13} />
        </IconButton>
      </span>
    </div>
  );
}

export function KeysView() {
  const keys = useKeys((state) => state.keys);
  const load = useKeys((state) => state.load);
  const hostCount = useApp((state) => state.hosts.length);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    void attempt(load);
    // Hosts name their keys, so the "used by" column follows them.
  }, [load, hostCount]);

  const pickImport = () =>
    void attempt(async () => {
      const picked = await api.invoke(Channels.keysPickImport);
      if (picked) setDialog({ kind: 'import', picked });
    });
  const close = () => setDialog(null);

  return (
    <ToolView
      testId="keys-view"
      title="SSH Keys"
      description={keys.length === 1 ? '1 verwalteter Schlüssel' : `${keys.length} verwaltete Schlüssel`}
      actions={
        <>
          <Button onClick={pickImport}>
            <FileUp size={14} /> Importieren
          </Button>
          <Button variant="primary" onClick={() => setDialog({ kind: 'generate' })}>
            <Plus size={14} /> Erzeugen
          </Button>
        </>
      }
    >
      {keys.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<KeyRound size={26} />}
            title="Noch keine Schlüssel"
            description="Erzeuge einen ED25519-Schlüssel oder importiere einen vorhandenen. Private Schlüssel bleiben Dateien auf diesem Rechner."
          />
        </div>
      ) : (
        <div role="table" aria-label="SSH-Schlüssel" className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div role="row" className={cx('grid h-7 flex-none items-center gap-3 border-b border-border px-4 text-[11px] text-subtle', COLUMNS)}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Typ</span>
            <span role="columnheader">Fingerprint</span>
            <span role="columnheader">Verwendet von</span>
            <span role="columnheader" className="sr-only">
              Aktionen
            </span>
          </div>
          {keys.map((item) => (
            <KeyRow key={item.id} keyItem={item} onDialog={setDialog} />
          ))}
        </div>
      )}
      {dialog?.kind === 'generate' && <GenerateDialog onClose={close} />}
      {dialog?.kind === 'import' && <ImportDialog picked={dialog.picked} onClose={close} />}
      {dialog?.kind === 'rename' && <RenameDialog keyItem={dialog.key} onClose={close} />}
      {dialog?.kind === 'assign' && <AssignDialog keyItem={dialog.key} onClose={close} />}
      {dialog?.kind === 'install' && <InstallDialog keyItem={dialog.key} onClose={close} />}
      {dialog?.kind === 'remove' && <RemoveDialog keyItem={dialog.key} onClose={close} />}
    </ToolView>
  );
}
