import { useEffect, useState } from 'react';
import { Channels } from '@shared/channels';
import type { Preferences, WslStatus } from '@shared/contracts';
import { aiEndpointSchema, DEFAULT_AI_ENDPOINT } from '@shared/features/ai';
import { wslDirectorySchema } from '@shared/features/wsl';
import { api } from '../../lib/api';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui/primitives';

interface SectionProps {
  preferences: Preferences;
  update(patch: Partial<Preferences>): void;
}

export function AiSection({ preferences, update }: SectionProps) {
  const [endpoint, setEndpoint] = useState(preferences.aiEndpoint);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setEndpoint(preferences.aiEndpoint), [preferences.aiEndpoint]);

  const save = () => {
    const parsed = aiEndpointSchema.safeParse(endpoint.trim());
    if (!parsed.success) {
      setError('Nur Adressen auf diesem Rechner oder im lokalen Netz sind erlaubt, ohne Anmeldedaten in der Adresse.');
      return;
    }
    setError(null);
    if (parsed.data !== preferences.aiEndpoint) update({ aiEndpoint: parsed.data, aiModel: null });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">KI-Assistent</h2>
      <Checkbox
        label="KI-Assistent verwenden"
        hint="Ausgeschaltet stellt RYFT keine einzige Anfrage an ein Modell."
        checked={preferences.aiEnabled}
        onChange={(aiEnabled) => update({ aiEnabled })}
      />
      <Field label="Ollama-Adresse" htmlFor="ai-endpoint-input" error={error} hint={`Standard: ${DEFAULT_AI_ENDPOINT}`}>
        <div className="flex gap-2">
          <Input
            id="ai-endpoint-input"
            spellCheck={false}
            value={endpoint}
            onChange={(event) => {
              setEndpoint(event.target.value);
              setError(null);
            }}
            onBlur={save}
          />
          <Button className="flex-none" onClick={save}>
            Übernehmen
          </Button>
        </div>
      </Field>
      <p className="text-xs text-secondary">
        Das Modell wählst du im Panel „AI Assistant“. Es sieht nur deine Fragen und ausdrücklich angehängte Auswahl, kann selbst nichts ausführen, und jeder
        vorgeschlagene Befehl braucht deine Bestätigung.
      </p>
    </section>
  );
}

export function LoggingSection({ preferences, update }: SectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">Sitzungsprotokolle</h2>
      <Checkbox
        label="Neue Sitzungen automatisch aufzeichnen"
        hint="Zeichnet auf, was Sitzungen anzeigen, nicht was du tippst. Sensible Ausgaben und Echos landen trotzdem im Protokoll, unverschlüsselt im Datenordner."
        checked={preferences.sessionLogDefault}
        onChange={(sessionLogDefault) => update({ sessionLogDefault })}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Höchstens gesamt (MB)" htmlFor="log-max-mb" hint="Darüber fallen die ältesten Protokolle weg.">
          <Input
            id="log-max-mb"
            type="number"
            min={10}
            max={100000}
            value={preferences.sessionLogMaxMb}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 10 && value <= 100_000) update({ sessionLogMaxMb: value });
            }}
          />
        </Field>
        <Field label="Aufbewahren (Tage)" htmlFor="log-days" hint="Ältere Protokolle werden gelöscht.">
          <Input
            id="log-days"
            type="number"
            min={1}
            max={3650}
            value={preferences.sessionLogRetentionDays}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 1 && value <= 3650) update({ sessionLogRetentionDays: value });
            }}
          />
        </Field>
      </div>
    </section>
  );
}

export function WslSection({ preferences, update }: SectionProps) {
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [directory, setDirectory] = useState(preferences.wslStartDirectory ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke(Channels.wslStatus).then(setStatus).catch(() => setStatus({ available: false, distros: [], error: null }));
  }, []);

  if (status && !status.available) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold text-text">WSL</h2>
        <p className="text-xs text-secondary">Das Windows-Subsystem für Linux ist auf diesem System nicht verfügbar.</p>
      </section>
    );
  }

  const saveDirectory = () => {
    const value = directory.trim();
    if (value && !wslDirectorySchema.safeParse(value).success) {
      setError('Absoluter Linux-Pfad oder ~ erwartet.');
      return;
    }
    setError(null);
    update({ wslStartDirectory: value || null });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">WSL</h2>
      <Field label="Standard-Distribution" htmlFor="wsl-default" hint="Gilt für Sitzungen ohne eigene Auswahl.">
        <Select
          id="wsl-default"
          value={preferences.wslDefaultDistro ?? ''}
          onChange={(value) => update({ wslDefaultDistro: value || null })}
          options={[
            { value: '', label: 'Standard von WSL' },
            ...(status?.distros ?? []).map((distro) => ({
              value: distro.name,
              label: `${distro.name}${distro.running ? ' (läuft)' : ''}`
            }))
          ]}
        />
      </Field>
      <Field label="Startordner" htmlFor="wsl-directory" error={error} hint="Leer bedeutet: wie von WSL vorgegeben.">
        <Input
          id="wsl-directory"
          spellCheck={false}
          placeholder="~"
          value={directory}
          onChange={(event) => {
            setDirectory(event.target.value);
            setError(null);
          }}
          onBlur={saveDirectory}
        />
      </Field>
    </section>
  );
}
