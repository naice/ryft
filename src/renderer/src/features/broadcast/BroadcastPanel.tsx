import { useEffect, useState, type FormEvent } from 'react';
import { RadioTower, Send, X } from 'lucide-react';
import { liveTargets } from '../../lib/sessionTargets';
import { useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, Checkbox, Field, IconButton, Input, Modal, Select } from '../../components/ui/primitives';
import { labelsOf, useBroadcast, type BroadcastMode } from './broadcastStore';

/** Stays on screen in every view for as long as a broadcast runs. */
export function BroadcastBar() {
  const active = useBroadcast((state) => state.active);
  const mode = useBroadcast((state) => state.mode);
  const targets = useBroadcast((state) => state.targets);
  const deactivate = useBroadcast((state) => state.deactivate);
  const send = useBroadcast((state) => state.send);
  const askConfirm = useApp((state) => state.askConfirm);
  const [command, setCommand] = useState('');
  if (!active) return null;
  const labels = labelsOf(targets);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = command.trim();
    if (!text) return;
    askConfirm({
      title: `Befehl an ${targets.length} Sitzungen senden?`,
      message: `Befehl:\n${text}\n\nZiele:\n${labels.join('\n')}\n\nEr läuft in jeder dieser Sitzungen sofort.`,
      confirmLabel: 'Überall ausführen',
      danger: true,
      onConfirm: () => {
        send(text);
        setCommand('');
      }
    });
  };

  return (
    <div
      role="alert"
      data-testid="broadcast-bar"
      className="mx-3 mb-2 flex min-h-9 flex-none flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-warning bg-raised px-3 py-1"
    >
      <RadioTower size={15} className="flex-none text-warning" />
      <span className="flex-none text-xs font-semibold text-text">Broadcast aktiv</span>
      <span className="min-w-0 flex-[1_1_160px] truncate text-xs text-secondary" title={labels.join(', ')} data-testid="broadcast-targets">
        {targets.length} Sitzungen: {labels.join(', ')}
      </span>
      {mode === 'command' ? (
        <form onSubmit={submit} className="flex min-w-[260px] flex-[2_1_260px] gap-1.5">
          <Input
            aria-label="Befehl für alle Ziele"
            spellCheck={false}
            className="!h-7 font-terminal text-xs"
            placeholder="Befehl für alle Ziele…"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
          <Button type="submit" className="!h-7 flex-none text-xs" disabled={!command.trim()}>
            <Send size={13} /> Senden…
          </Button>
        </form>
      ) : (
        <span className="flex-[2_1_260px] text-xs font-medium text-warning">Jeder Tastendruck in einem Ziel geht an alle Ziele, auch Passwörter.</span>
      )}
      <Button variant="danger" className="!h-7 flex-none text-xs" onClick={deactivate}>
        <X size={13} /> Ausschalten (Ctrl+Shift+B)
      </Button>
    </div>
  );
}

export function BroadcastDialog() {
  const open = useBroadcast((state) => state.dialogOpen);
  const setOpen = useBroadcast((state) => state.setDialogOpen);
  const activate = useBroadcast((state) => state.activate);
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const preferences = useApp((state) => state.preferences);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<BroadcastMode>('command');
  const [error, setError] = useState<string | null>(null);
  const targets = liveTargets(tabs, panes, hosts, shells, preferences);

  useEffect(() => {
    if (open) {
      setSelected([]);
      setMode('command');
      setError(null);
    }
  }, [open]);

  const start = () => setError(activate(selected, mode));

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Broadcast starten"
      description="Sendet an die Sitzungen, die du hier auswählst. Später geöffnete Sitzungen kommen nie von selbst dazu."
      width={480}
    >
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
        <div className="flex max-h-[200px] flex-col gap-1.5 overflow-y-auto" data-testid="broadcast-choices">
          {targets.map((target) => (
            <Checkbox
              key={target.paneId}
              label={target.label}
              checked={selected.includes(target.paneId)}
              onChange={(checked) =>
                setSelected((current) => (checked ? [...current, target.paneId] : current.filter((id) => id !== target.paneId)))
              }
            />
          ))}
          {targets.length === 0 && <p className="text-xs text-subtle">Keine verbundenen Sitzungen.</p>}
        </div>
        <Field
          label="Art"
          htmlFor="broadcast-mode"
          hint={
            mode === 'command'
              ? 'Du tippst den Befehl in die Leiste und bestätigst ihn mit Zielen, bevor er läuft.'
              : 'Tastendrücke werden ohne Rückfrage weitergegeben. Auch Passwörter und Strg+C gehen an alle Ziele.'
          }
        >
          <Select
            id="broadcast-mode"
            value={mode}
            onChange={(value) => setMode(value as BroadcastMode)}
            options={[
              { value: 'command', label: 'Befehle mit Bestätigung' },
              { value: 'keys', label: 'Tastatur spiegeln' }
            ]}
          />
        </Field>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={() => setOpen(false)}>Abbrechen</Button>
        <Button variant="primary" disabled={selected.length < 2} onClick={start}>
          Broadcast für {selected.length} Sitzungen starten
        </Button>
      </div>
    </Modal>
  );
}

/** The toggle in the tab row. */
export function BroadcastToggle() {
  const active = useBroadcast((state) => state.active);
  const deactivate = useBroadcast((state) => state.deactivate);
  const setDialogOpen = useBroadcast((state) => state.setDialogOpen);
  return (
    <IconButton
      label={active ? 'Broadcast ausschalten' : 'Broadcast starten'}
      shortcut="Ctrl+Shift+B"
      size={26}
      onClick={() => (active ? deactivate() : setDialogOpen(true))}
    >
      <RadioTower size={15} className={active ? 'text-warning' : undefined} />
    </IconButton>
  );
}
