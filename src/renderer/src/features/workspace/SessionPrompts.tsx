import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Fingerprint, ShieldQuestion } from 'lucide-react';
import { Channels } from '@shared/channels';
import type { PromptResponse, SessionPrompt } from '@shared/contracts';
import { api } from '../../lib/api';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, Checkbox, Field, Input, Modal } from '../../components/ui/primitives';

function respond(prompt: SessionPrompt, response: PromptResponse): void {
  useWorkspace.getState().resolvePrompt(prompt.promptId);
  void api.invoke(Channels.sessionsRespondPrompt, { promptId: prompt.promptId, response }).catch(() => undefined);
}

function HostKeyPrompt({ prompt }: { prompt: Extract<SessionPrompt, { kind: 'hostKey' }> }) {
  const endpoint = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && respond(prompt, { kind: 'cancel' })}
      title="Unbekannter Host-Schlüssel"
      description={`RYFT kennt ${endpoint} noch nicht. Vergleiche den Fingerprint mit dem Wert, den dir der Server-Betreiber auf einem sicheren Weg nennt.`}
      width={520}
    >
      <div className="flex flex-col gap-3 px-5 pb-4">
        {prompt.otherTypesKnown && (
          <div role="alert" className="flex gap-2 rounded-control border border-warning p-2.5 text-xs text-text">
            <AlertTriangle size={16} className="flex-none text-warning" />
            <span>Für diesen Host ist bereits ein Schlüssel anderen Typs bekannt. Das kann harmlos sein, sollte aber geprüft werden.</span>
          </div>
        )}
        <div className="rounded-card border border-border bg-canvas p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-secondary">
            <Fingerprint size={14} className="text-cyan" /> {prompt.keyType}
          </div>
          <code data-testid="host-key-fingerprint" className="font-terminal text-xs break-all text-text select-text">
            {prompt.fingerprint}
          </code>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={() => respond(prompt, { kind: 'cancel' })}>Abbrechen</Button>
        <Button onClick={() => respond(prompt, { kind: 'hostKey', trust: 'once' })}>Nur diesmal</Button>
        <Button variant="primary" onClick={() => respond(prompt, { kind: 'hostKey', trust: 'always' })}>
          Vertrauen &amp; speichern
        </Button>
      </div>
    </Modal>
  );
}

function SecretPrompt({ prompt }: { prompt: Extract<SessionPrompt, { kind: 'password' | 'passphrase' }> }) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value) respond(prompt, { kind: 'secret', value, remember });
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && respond(prompt, { kind: 'cancel' })}
      title={prompt.kind === 'password' ? 'Passwort eingeben' : 'Passphrase eingeben'}
      description={prompt.label}
      width={440}
    >
      <form onSubmit={submit} className="flex flex-col">
        <div className="flex flex-col gap-3 px-5 pb-4">
          {prompt.retry && (
            <p role="alert" className="flex items-center gap-2 text-xs text-error">
              <AlertTriangle size={14} /> Das hat nicht funktioniert. Bitte erneut versuchen.
            </p>
          )}
          <Field label={prompt.kind === 'password' ? 'Passwort' : 'Passphrase'} htmlFor="prompt-secret">
            <Input
              id="prompt-secret"
              type="password"
              autoFocus
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <Checkbox
            label="Im Schlüsselbund speichern"
            checked={remember}
            disabled={!prompt.canRemember}
            hint={prompt.canRemember ? 'Wird erst nach erfolgreicher Anmeldung gespeichert.' : 'Auf diesem System ist kein Schlüsselbund verfügbar.'}
            onChange={setRemember}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={() => respond(prompt, { kind: 'cancel' })}>Abbrechen</Button>
          <Button type="submit" variant="primary" disabled={!value}>
            Anmelden
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function KeyboardPrompt({ prompt }: { prompt: Extract<SessionPrompt, { kind: 'keyboardInteractive' }> }) {
  const [answers, setAnswers] = useState<string[]>(() => prompt.prompts.map(() => ''));
  useEffect(() => setAnswers(prompt.prompts.map(() => '')), [prompt]);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && respond(prompt, { kind: 'cancel' })}
      title="Anmeldung erforderlich"
      description={prompt.label}
      width={440}
    >
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          respond(prompt, { kind: 'answers', answers });
        }}
      >
        <div className="flex flex-col gap-3 px-5 pb-4">
          {/* Text from the server, shown as plain text and marked as coming from there. */}
          {prompt.instructions && (
            <p className="flex gap-2 rounded-control bg-card p-2 text-xs whitespace-pre-wrap text-secondary">
              <ShieldQuestion size={14} className="flex-none text-subtle" />
              {prompt.instructions}
            </p>
          )}
          {prompt.prompts.map((item, index) => (
            <Field key={index} label={item.prompt} htmlFor={`kbd-${index}`}>
              <Input
                id={`kbd-${index}`}
                type={item.echo ? 'text' : 'password'}
                autoFocus={index === 0}
                autoComplete="off"
                value={answers[index] ?? ''}
                onChange={(event) =>
                  setAnswers((current) => current.map((answer, i) => (i === index ? event.target.value : answer)))
                }
              />
            </Field>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={() => respond(prompt, { kind: 'cancel' })}>Abbrechen</Button>
          <Button type="submit" variant="primary">
            Senden
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shows one prompt at a time, in the order the sessions asked. */
export function SessionPrompts() {
  const prompt = useWorkspace((state) => state.prompts[0]);
  if (!prompt) return null;
  switch (prompt.kind) {
    case 'hostKey':
      return <HostKeyPrompt key={prompt.promptId} prompt={prompt} />;
    case 'password':
    case 'passphrase':
      return <SecretPrompt key={prompt.promptId} prompt={prompt} />;
    case 'keyboardInteractive':
      return <KeyboardPrompt key={prompt.promptId} prompt={prompt} />;
  }
}
