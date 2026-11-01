import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, CornerDownLeft, Loader2, Play, RefreshCw, Square, TextCursorInput, Trash2, X } from 'lucide-react';
import { AI_TASK_LABEL, AI_TASKS, extractCommands, MAX_AI_CONTEXT_CHARS, type AiTask } from '@shared/features/ai';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, cx, Field, IconButton, Select, TEXTAREA } from '../../components/ui/primitives';
import { insertProblemText } from '../snippets/snippetStore';
import { insertCommand, selectionOf } from '../terminal/terminalRegistry';
import { useAi, type AiExchange } from './aiStore';

function activePaneId(): string | null {
  const { tabs, activeTabId } = useWorkspace.getState();
  return tabs.find((tab) => tab.id === activeTabId)?.activePaneId ?? null;
}

/** A proposal stays text until someone has seen the exact command and said what should happen with it. */
function CommandCard({ command }: { command: string }) {
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);

  const apply = (execute: boolean) => {
    const paneId = activePaneId();
    if (!paneId) {
      toast('info', 'Öffne zuerst eine Sitzung.');
      return;
    }
    askConfirm({
      title: execute ? 'Vorschlag des Modells ausführen?' : 'Vorschlag des Modells einfügen?',
      message: `${command}\n\nDieser Befehl kommt von einem Sprachmodell und kann falsch oder durch manipulierte Ausgaben beeinflusst sein. Prüfe ihn, bevor du ihn in der aktiven Sitzung ${execute ? 'ausführst' : 'einfügst'}.`,
      confirmLabel: execute ? 'Ausführen' : 'Einfügen',
      danger: execute,
      onConfirm: () => {
        const result = insertCommand(paneId, command, execute);
        if (result !== 'ok') toast('error', insertProblemText(result));
      }
    });
  };

  return (
    <div data-testid="ai-command" className="mt-2 rounded-control border border-border bg-terminal">
      <pre className="overflow-x-auto p-2 font-terminal text-[11px] text-text select-text">{command}</pre>
      <div className="flex justify-end gap-1 border-t border-border p-1">
        <Button className="!h-6 text-[11px]" onClick={() => apply(false)}>
          <CornerDownLeft size={12} /> Einfügen…
        </Button>
        <Button className="!h-6 text-[11px]" onClick={() => apply(true)}>
          <Play size={12} /> Ausführen…
        </Button>
      </div>
    </div>
  );
}

function ExchangeView({ exchange }: { exchange: AiExchange }) {
  const cancel = useAi((state) => state.cancel);
  const commands = exchange.status === 'done' ? extractCommands(exchange.answer) : [];
  return (
    <article data-testid="ai-exchange" data-status={exchange.status} className="flex flex-none flex-col gap-1.5">
      <div className="rounded-control bg-raised px-2.5 py-1.5 text-xs text-text">
        <div className="text-[11px] text-subtle">
          {AI_TASK_LABEL[exchange.task]}
          {exchange.contextChars > 0 && ` · ${exchange.contextChars} Zeichen Auswahl`}
        </div>
        <div className="whitespace-pre-wrap break-words select-text">{exchange.prompt}</div>
      </div>
      {/* Plain text on purpose: an answer may quote terminal output, and neither gets to render anything. */}
      <div data-testid="ai-answer" className="px-1 text-xs leading-[1.5] whitespace-pre-wrap break-words text-text select-text">
        {exchange.answer}
      </div>
      {exchange.status === 'streaming' && (
        <div className="flex items-center gap-2 px-1">
          <Loader2 size={13} className="ryft-spin text-secondary" />
          <Button className="!h-6 text-[11px]" onClick={() => cancel(exchange.id)}>
            <Square size={11} /> Abbrechen
          </Button>
        </div>
      )}
      {exchange.status === 'cancelled' && <p className="px-1 text-[11px] text-subtle">Abgebrochen</p>}
      {exchange.error && (
        <p role="alert" className="px-1 text-xs text-error">
          {exchange.error}
        </p>
      )}
      {commands.map((command) => (
        <CommandCard key={command} command={command} />
      ))}
    </article>
  );
}

function OptIn() {
  const setPreferences = useApp((state) => state.setPreferences);
  const endpoint = useApp((state) => state.preferences?.aiEndpoint);
  return (
    <div className="flex flex-col gap-3 p-4 text-xs text-secondary" data-testid="ai-optin">
      <p className="text-[13px] font-medium text-text">Der KI-Assistent ist ausgeschaltet.</p>
      <p>Er spricht mit einem lokalen Modell über Ollama unter {endpoint}. Nichts geht an einen Clouddienst.</p>
      <p>
        Das Modell sieht nur, was du schreibst und ausdrücklich anhängst, nie Verläufe, Zugangsdaten oder Schlüssel. Es kann nichts selbst ausführen.
        Vorgeschlagene Befehle laufen erst, wenn du sie geprüft und bestätigt hast.
      </p>
      <div>
        <Button variant="primary" onClick={() => void attempt(() => setPreferences({ aiEnabled: true }))}>
          Einschalten
        </Button>
      </div>
    </div>
  );
}

function Assistant() {
  const endpoint = useApp((state) => state.preferences?.aiEndpoint ?? '');
  const model = useApp((state) => state.preferences?.aiModel ?? null);
  const setPreferences = useApp((state) => state.setPreferences);
  const toast = useApp((state) => state.toast);
  const models = useAi((state) => state.models);
  const modelsError = useAi((state) => state.modelsError);
  const loadingModels = useAi((state) => state.loadingModels);
  const loadModels = useAi((state) => state.loadModels);
  const exchanges = useAi((state) => state.exchanges);
  const ask = useAi((state) => state.ask);
  const clear = useAi((state) => state.clear);
  const streaming = exchanges.some((item) => item.status === 'streaming');
  const [task, setTask] = useState<AiTask>('command');
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadModels();
  }, [loadModels, endpoint]);

  const answerLength = exchanges.reduce((sum, item) => sum + item.answer.length, 0);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [exchanges.length, answerLength]);

  const attachSelection = () => {
    const paneId = activePaneId();
    const selection = paneId ? selectionOf(paneId) : '';
    if (!selection) {
      toast('info', 'Markiere zuerst Text im aktiven Terminal.');
      return;
    }
    if (selection.length > MAX_AI_CONTEXT_CHARS) toast('info', 'Die Auswahl ist lang. Angehängt wird nur ihr Ende.');
    setContext(selection.slice(-MAX_AI_CONTEXT_CHARS));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || streaming || !model) return;
    void ask(task, prompt.trim(), context);
    setPrompt('');
    setContext(null);
  };

  const options = [
    ...(model && !models.some((item) => item.name === model) ? [{ value: model, label: `${model} (nicht gefunden)` }] : []),
    ...(!model ? [{ value: '', label: models.length ? 'Modell wählen…' : 'Kein Modell gefunden' }] : []),
    ...models.map((item) => ({ value: item.name, label: item.name }))
  ];

  return (
    <>
      <div className="flex flex-none flex-col gap-1.5 border-b border-border p-2.5">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <Select
              ariaLabel="KI-Modell"
              value={model ?? ''}
              onChange={(value) => void attempt(() => setPreferences({ aiModel: value || null }))}
              options={options}
            />
          </div>
          <IconButton label="Modelle neu laden" size={30} onClick={() => void loadModels()}>
            <RefreshCw size={13} className={cx(loadingModels && 'ryft-spin')} />
          </IconButton>
          <IconButton label="Unterhaltung leeren" size={30} onClick={clear}>
            <Trash2 size={13} />
          </IconButton>
        </div>
        <p data-testid="ai-endpoint" className="truncate text-[11px] text-subtle" title={endpoint}>
          Ollama · {endpoint}
        </p>
        {modelsError && (
          <p role="alert" className="text-xs text-error">
            {modelsError}
          </p>
        )}
      </div>
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2.5">
        {exchanges.length === 0 && (
          <p className="text-xs text-subtle">
            Frag nach einem Befehl, oder markiere eine Fehlermeldung im Terminal und hänge sie an. Das Modell sieht nur, was unten steht.
          </p>
        )}
        {exchanges.map((exchange) => (
          <ExchangeView key={exchange.id} exchange={exchange} />
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-none flex-col gap-1.5 border-t border-border p-2.5">
        <Select
          ariaLabel="Aufgabe"
          value={task}
          onChange={(value) => setTask(value as AiTask)}
          options={AI_TASKS.map((value) => ({ value, label: AI_TASK_LABEL[value] }))}
        />
        {context !== null && (
          <div data-testid="ai-context" className="rounded-control border border-border bg-card">
            <div className="flex items-center justify-between px-2 pt-1 text-[11px] text-secondary">
              <span>Wird mitgeschickt ({context.length} Zeichen)</span>
              <IconButton label="Auswahl entfernen" size={20} onClick={() => setContext(null)}>
                <X size={12} />
              </IconButton>
            </div>
            <pre className="max-h-24 overflow-auto px-2 pb-1.5 font-terminal text-[10px] text-text">{context}</pre>
          </div>
        )}
        <Field label="Frage" htmlFor="ai-prompt">
          <textarea
            id="ai-prompt"
            rows={3}
            maxLength={8192}
            className={TEXTAREA}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event);
            }}
          />
        </Field>
        <div className="flex justify-between gap-2">
          <Button onClick={attachSelection}>
            <TextCursorInput size={14} /> Auswahl anhängen
          </Button>
          <Button type="submit" variant="primary" disabled={!prompt.trim() || streaming || !model}>
            Senden
          </Button>
        </div>
      </form>
    </>
  );
}

export function AiPanel() {
  const setOpen = useAi((state) => state.setOpen);
  const enabled = useApp((state) => state.preferences?.aiEnabled ?? false);
  return (
    <aside aria-label="AI Assistant" data-testid="ai-panel" className="flex h-full min-h-0 flex-col rounded-panel border border-border bg-host-panel">
      <header className="flex h-[50px] flex-none items-center gap-2 border-b border-border pr-2 pl-3">
        <Bot size={16} className="flex-none text-cyan" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">AI Assistant</h2>
        <IconButton label="AI Assistant einklappen" size={26} onClick={() => setOpen(false)}>
          <X size={14} />
        </IconButton>
      </header>
      {enabled ? <Assistant /> : <OptIn />}
    </aside>
  );
}
