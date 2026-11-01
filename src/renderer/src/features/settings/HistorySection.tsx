import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Preferences } from '@shared/contracts';
import { exclusionPatternSchema } from '@shared/features/commandHistory';
import { Button, Checkbox, Field, IconButton, Input } from '../../components/ui/primitives';

export function HistorySection({ preferences, update }: { preferences: Preferences; update(patch: Partial<Preferences>): void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const parsed = exclusionPatternSchema.safeParse(draft.trim());
    if (!parsed.success) {
      setError('Das ist kein gültiger regulärer Ausdruck.');
      return;
    }
    if (!preferences.historyExclusions.includes(parsed.data)) {
      update({ historyExclusions: [...preferences.historyExclusions, parsed.data] });
    }
    setDraft('');
    setError(null);
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-text">Befehlsverlauf</h2>
      <Checkbox
        label="Abgeschlossene Befehle aufzeichnen"
        hint="Grenzen kommen von der Shell-Integration: Eingaben an Passwortabfragen und in Vollbildprogrammen landen nie im Verlauf."
        checked={preferences.commandHistoryEnabled}
        onChange={(commandHistoryEnabled) => update({ commandHistoryEnabled })}
      />
      <p className="text-xs text-secondary">
        Befehle, die wie Zugangsdaten aussehen, und Zeilen mit führendem Leerzeichen zeichnet RYFT grundsätzlich nicht auf. Diese Erkennung
        ist eine Heuristik und ersetzt nicht, Secrets aus der Kommandozeile herauszuhalten.
      </p>
      <Field label="Eigene Ausschlüsse (regulärer Ausdruck)" htmlFor="history-exclusion" error={error}>
        <div className="flex gap-2">
          <Input
            id="history-exclusion"
            spellCheck={false}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
          />
          <Button className="flex-none" disabled={!draft.trim()} onClick={add}>
            Hinzufügen
          </Button>
        </div>
      </Field>
      <div className="flex flex-col gap-1.5">
        {preferences.historyExclusions.map((pattern) => (
          <div key={pattern} className="flex items-center gap-2 rounded-control border border-border bg-card px-2 py-1">
            <code className="min-w-0 flex-1 truncate font-terminal text-[11px] text-text">{pattern}</code>
            <IconButton
              label={`Ausschluss ${pattern} entfernen`}
              onClick={() => update({ historyExclusions: preferences.historyExclusions.filter((item) => item !== pattern) })}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </section>
  );
}
