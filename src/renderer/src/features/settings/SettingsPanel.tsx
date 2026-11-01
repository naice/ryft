import { useEffect, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Channels } from '@shared/channels';
import { ANSI_COLOR_KEYS, DEFAULT_PREFERENCES, type AnsiColorKey, type KnownHostEntry, type Preferences } from '@shared/contracts';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { Button, Checkbox, cx, Field, IconButton, Input, Modal, Select } from '../../components/ui/primitives';
import { buildTerminalTheme } from '../terminal/terminalTheme';

type Section = 'appearance' | 'terminal' | 'connections' | 'security' | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'appearance', label: 'Darstellung' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'connections', label: 'Verbindungen' },
  { id: 'security', label: 'Sicherheit' },
  { id: 'about', label: 'Über RYFT' }
];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

function NumberField({
  label,
  id,
  value,
  min,
  max,
  step = 1,
  onCommit
}: {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      return;
    }
    onCommit(parsed);
  };
  return (
    <Field label={label} htmlFor={id} hint={`${min}–${max}`}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </Field>
  );
}

const ANSI_LABELS: Record<AnsiColorKey, string> = {
  black: 'Schwarz',
  red: 'Rot',
  green: 'Grün',
  yellow: 'Gelb',
  blue: 'Blau',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'Weiß',
  brightBlack: 'Hell Schwarz',
  brightRed: 'Hell Rot',
  brightGreen: 'Hell Grün',
  brightYellow: 'Hell Gelb',
  brightBlue: 'Hell Blau',
  brightMagenta: 'Hell Magenta',
  brightCyan: 'Hell Cyan',
  brightWhite: 'Hell Weiß'
};

function AnsiEditor({ preferences, update }: { preferences: Preferences; update(patch: Partial<Preferences>): void }) {
  const theme = buildTerminalTheme(preferences);
  return (
    <Group title="ANSI-Farben">
      <div className="grid grid-cols-4 gap-2">
        {ANSI_COLOR_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-[11px] text-secondary">
            <input
              type="color"
              aria-label={ANSI_LABELS[key]}
              value={String(theme[key]).toLowerCase()}
              onChange={(event) =>
                update({ ansiOverrides: { ...preferences.ansiOverrides, [key]: event.target.value } })
              }
              className="size-6 flex-none cursor-pointer rounded-[4px] border border-border bg-transparent p-0"
            />
            <span className="truncate">{ANSI_LABELS[key]}</span>
          </label>
        ))}
      </div>
      <div>
        <Button
          disabled={Object.keys(preferences.ansiOverrides).length === 0}
          onClick={() => update({ ansiOverrides: {} })}
        >
          Farben zurücksetzen
        </Button>
      </div>
    </Group>
  );
}

function KnownHosts() {
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const askConfirm = useApp((state) => state.askConfirm);
  const homeSshDir = useApp((state) => state.info?.homeSshDir ?? '');

  useEffect(() => {
    void attempt(async () => setEntries(await api.invoke(Channels.knownHostsList)));
  }, []);

  return (
    <Group title="Bekannte Hosts">
      <p className="text-xs text-secondary">
        Von RYFT gespeicherte Vertrauensentscheidungen. Zusätzlich liest RYFT <code className="font-terminal">{homeSshDir}/known_hosts</code>,
        ändert diese Datei aber nie.
      </p>
      {entries.length === 0 && <p className="text-xs text-subtle">Keine Einträge.</p>}
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-2 rounded-control border border-border bg-card p-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs font-medium text-text">
                {entry.host}:{entry.port} <span className="font-normal text-secondary">{entry.keyType}</span>
              </span>
              <code className="font-terminal text-[11px] break-all text-secondary select-text">{entry.fingerprint}</code>
            </div>
            <IconButton
              label={`Eintrag für ${entry.host} entfernen`}
              onClick={() =>
                askConfirm({
                  title: `Vertrauen für ${entry.host} entfernen?`,
                  message: 'Beim nächsten Verbinden musst du den Host-Schlüssel erneut bestätigen.',
                  confirmLabel: 'Entfernen',
                  danger: true,
                  onConfirm: () =>
                    void attempt(async () => {
                      await api.invoke(Channels.knownHostsRemove, { id: entry.id });
                      setEntries(await api.invoke(Channels.knownHostsList));
                    })
                })
              }
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </Group>
  );
}

export function SettingsPanel() {
  const open = useApp((state) => state.settingsOpen);
  const setOpen = useApp((state) => state.setSettingsOpen);
  const preferences = useApp((state) => state.preferences);
  const setPreferences = useApp((state) => state.setPreferences);
  const shells = useApp((state) => state.shells);
  const vault = useApp((state) => state.vault);
  const info = useApp((state) => state.info);
  const [section, setSection] = useState<Section>('appearance');

  if (!preferences) return null;
  const update = (patch: Partial<Preferences>) => void attempt(() => setPreferences(patch));

  return (
    <Modal open={open} onOpenChange={setOpen} title="Einstellungen" width={720}>
      <div className="flex h-[480px] min-h-0 border-t border-border">
        <div role="tablist" aria-orientation="vertical" className="flex w-40 flex-none flex-col gap-0.5 border-r border-border p-2">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              onClick={() => setSection(item.id)}
              className={cx(
                'h-8 rounded-control px-2.5 text-left text-[13px] transition-colors duration-120',
                section === item.id ? 'bg-selected-strong text-text' : 'text-secondary hover:bg-hover hover:text-text'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          {section === 'appearance' && (
            <Group title="Design">
              <Field label="Theme" htmlFor="pref-theme">
                <Select
                  id="pref-theme"
                  value={preferences.theme}
                  options={[
                    { value: 'ryft-dark', label: 'RYFT Dark' },
                    { value: 'ryft-midnight', label: 'RYFT Midnight' },
                    { value: 'ryft-light', label: 'RYFT Light' }
                  ]}
                  onChange={(value) => update({ theme: value as Preferences['theme'] })}
                />
              </Field>
              <Checkbox
                label="Hoher Kontrast"
                checked={preferences.highContrast}
                onChange={(highContrast) => update({ highContrast })}
              />
            </Group>
          )}

          {section === 'terminal' && (
            <>
              <Group title="Schrift und Cursor">
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    id="pref-font-size"
                    label="Schriftgröße"
                    value={preferences.terminalFontSize}
                    min={9}
                    max={28}
                    onCommit={(terminalFontSize) => update({ terminalFontSize })}
                  />
                  <NumberField
                    id="pref-line-height"
                    label="Zeilenhöhe"
                    value={preferences.terminalLineHeight}
                    min={1}
                    max={2}
                    step={0.1}
                    onCommit={(terminalLineHeight) => update({ terminalLineHeight })}
                  />
                  <Field label="Cursor" htmlFor="pref-cursor">
                    <Select
                      id="pref-cursor"
                      value={preferences.terminalCursorStyle}
                      options={[
                        { value: 'block', label: 'Block' },
                        { value: 'bar', label: 'Balken' },
                        { value: 'underline', label: 'Unterstrich' }
                      ]}
                      onChange={(value) => update({ terminalCursorStyle: value as Preferences['terminalCursorStyle'] })}
                    />
                  </Field>
                  <NumberField
                    id="pref-scrollback"
                    label="Scrollback (Zeilen)"
                    value={preferences.terminalScrollback}
                    min={100}
                    max={100000}
                    step={100}
                    onCommit={(terminalScrollback) => update({ terminalScrollback })}
                  />
                </div>
                <Checkbox
                  label="Cursor blinkt"
                  checked={preferences.terminalCursorBlink}
                  onChange={(terminalCursorBlink) => update({ terminalCursorBlink })}
                />
                <Field label="Renderer" htmlFor="pref-renderer" hint="DOM ist langsamer, hilft aber bei GPU-Problemen.">
                  <Select
                    id="pref-renderer"
                    value={preferences.terminalRenderer}
                    options={[
                      { value: 'webgl', label: 'WebGL' },
                      { value: 'dom', label: 'DOM' }
                    ]}
                    onChange={(value) => update({ terminalRenderer: value as Preferences['terminalRenderer'] })}
                  />
                </Field>
                <Checkbox
                  label="App-Kürzel im Terminal abfangen"
                  hint="Aus: Ctrl+K/T/W gehen an die Shell. Ctrl+Shift+P/T/W funktionieren immer."
                  checked={preferences.captureTerminalShortcuts}
                  onChange={(captureTerminalShortcuts) => update({ captureTerminalShortcuts })}
                />
              </Group>
              <AnsiEditor preferences={preferences} update={update} />
            </>
          )}

          {section === 'connections' && (
            <Group title="Sitzungen">
              <Field label="Standard-Shell" htmlFor="pref-shell">
                <Select
                  id="pref-shell"
                  value={preferences.defaultShellId ?? ''}
                  options={[
                    { value: '', label: `Automatisch (${shells[0]?.label ?? 'keine'})` },
                    ...shells.map((shell) => ({ value: shell.id, label: shell.label }))
                  ]}
                  onChange={(value) => update({ defaultShellId: value || null })}
                />
              </Field>
              <Checkbox
                label="Automatisch neu verbinden"
                hint="Bis zu drei Versuche, wenn eine SSH-Verbindung abreißt."
                checked={preferences.autoReconnect}
                onChange={(autoReconnect) => update({ autoReconnect })}
              />
              <Checkbox
                label="Vor dem Schließen laufender Sitzungen fragen"
                checked={preferences.confirmCloseRunning}
                onChange={(confirmCloseRunning) => update({ confirmCloseRunning })}
              />
              <Checkbox
                label="Tabs und Teilung beim Start wiederherstellen"
                hint="Wiederhergestellte Bereiche starten getrennt. Es wird nie automatisch verbunden."
                checked={preferences.restoreLayout}
                onChange={(restoreLayout) =>
                  update(restoreLayout ? { restoreLayout } : { restoreLayout, workspaceLayout: null })
                }
              />
            </Group>
          )}

          {section === 'security' && (
            <>
              <Group title="Schlüsselbund">
                <p className="text-xs text-secondary">
                  {vault.available
                    ? `Secrets werden über den Schlüsselbund des Betriebssystems verschlüsselt (${vault.backend}).`
                    : 'Auf diesem System ist kein Schlüsselbund verfügbar. RYFT speichert deshalb keine Secrets und fragt bei jeder Verbindung.'}
                </p>
              </Group>
              <KnownHosts />
            </>
          )}

          {section === 'about' && (
            <Group title="RYFT">
              <p className="text-xs text-secondary">
                Version {info?.version}. SFTP und Port Forwarding sind noch nicht enthalten.
              </p>
              <div>
                <Button
                  onClick={() => {
                    // Layout state is not a setting, so resetting must not close anyone's tabs.
                    const { workspaceLayout: _layout, hostPanelWidth: _width, collapsedGroups: _collapsed, ...defaults } =
                      DEFAULT_PREFERENCES;
                    update(defaults);
                  }}
                >
                  Einstellungen zurücksetzen
                </Button>
              </div>
            </Group>
          )}
        </div>
      </div>
    </Modal>
  );
}
