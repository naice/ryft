import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Snippet, SnippetShell } from '@shared/contracts';
import { expandSnippet, placeholdersOf, SnippetExpansionError } from '@shared/features/snippets';
import { liveTargets, type LiveTarget } from '../../lib/sessionTargets';
import { useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, Checkbox, Field, Input, Modal } from '../../components/ui/primitives';
import { focusTerminal, insertCommand, insertProblem } from '../terminal/terminalRegistry';
import { insertProblemText, useSnippets } from './snippetStore';

const SHELL_LABEL: Record<SnippetShell, string> = { posix: 'POSIX', powershell: 'PowerShell', cmd: 'cmd' };

type Expanded = { ok: true; command: string; warnings: string[] } | { ok: false; message: string };

function expand(snippet: Snippet, values: Record<string, string>, shell: SnippetShell): Expanded {
  try {
    const result = expandSnippet(snippet.command, values, shell, snippet.params);
    return { ok: true, command: result.command, warnings: result.warnings };
  } catch (error) {
    if (error instanceof SnippetExpansionError) return { ok: false, message: error.message };
    throw error;
  }
}

function RunForm({ snippet, onClose }: { snippet: Snippet; onClose(): void }) {
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const activateTab = useWorkspace((state) => state.activateTab);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const preferences = useApp((state) => state.preferences);
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const showTerminals = useApp((state) => state.showTerminals);

  const targets = useMemo(() => liveTargets(tabs, panes, hosts, shells, preferences), [tabs, panes, hosts, shells, preferences]);
  const compatible = (target: LiveTarget) => snippet.shells.length === 0 || snippet.shells.includes(target.shell);
  const placeholders = useMemo(() => placeholdersOf(snippet.command), [snippet.command]);

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      placeholders.map(({ name, inlineDefault }) => [
        name,
        snippet.params.find((param) => param.name === name)?.defaultValue ?? inlineDefault ?? ''
      ])
    )
  );
  const [selected, setSelected] = useState<string[]>(() => {
    const active = tabs.find((tab) => tab.id === activeTabId)?.activePaneId;
    const target = targets.find((item) => item.paneId === active);
    return target && compatible(target) ? [target.paneId] : [];
  });

  // A session which ends while the dialog is open silently stops being a target.
  const chosen = targets.filter((target) => selected.includes(target.paneId) && compatible(target));
  const results = chosen.map((target) => ({ target, expanded: expand(snippet, values, target.shell) }));
  const ready = results.length > 0 && results.every(({ expanded }) => expanded.ok);
  const previewShell = chosen[0]?.shell ?? targets[0]?.shell ?? 'posix';
  const preview = results.length === 0 ? expand(snippet, values, previewShell) : null;

  const send = (execute: boolean) => {
    const failed: string[] = [];
    let first: string | null = null;
    for (const { target, expanded } of results) {
      if (!expanded.ok) continue;
      const result = insertCommand(target.paneId, expanded.command, execute);
      if (result === 'ok') first ??= target.paneId;
      else failed.push(`${target.label}: ${insertProblemText(result)}`);
    }
    onClose();
    if (failed.length > 0) toast('error', failed.join(' '));
    if (first) {
      toast('success', execute ? `An ${results.length - failed.length} Sitzung(en) gesendet` : 'Eingefügt, noch nicht ausgeführt');
      showTerminals();
      const paneId = first;
      const tab = tabs.find((item) => JSON.stringify(item.root).includes(paneId));
      if (tab && tab.id !== useWorkspace.getState().activeTabId) activateTab(tab.id);
      requestAnimationFrame(() => focusTerminal(paneId));
    }
  };

  const confirmRun = () => {
    const lines = results.map(({ target, expanded }) => `• ${target.label}\n${expanded.ok ? expanded.command : ''}`);
    askConfirm({
      title: results.length === 1 ? 'Befehl ausführen?' : `Befehl auf ${results.length} Sitzungen ausführen?`,
      message: lines.join('\n\n'),
      confirmLabel: results.length === 1 ? 'Ausführen' : `Auf ${results.length} ausführen`,
      danger: results.length > 1,
      onConfirm: () => send(true)
    });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
        {placeholders.map(({ name }, index) => {
          const param = snippet.params.find((item) => item.name === name);
          return (
            <Field key={name} label={name} htmlFor={`snippet-param-${name}`} hint={param?.description || undefined}>
              <Input
                id={`snippet-param-${name}`}
                autoFocus={index === 0}
                spellCheck={false}
                value={values[name] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
              />
            </Field>
          );
        })}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-secondary">Ziele ({chosen.length} von {targets.length})</span>
          {targets.length === 0 && <p className="text-xs text-subtle">Keine verbundene Sitzung. Öffne zuerst ein Terminal.</p>}
          {targets.map((target) => {
            const problem = !compatible(target) ? `Nur für ${snippet.shells.map((shell) => SHELL_LABEL[shell]).join(', ')}` : undefined;
            return (
              <Checkbox
                key={target.paneId}
                label={`${target.label} (${SHELL_LABEL[target.shell]})`}
                hint={problem}
                disabled={Boolean(problem)}
                checked={selected.includes(target.paneId) && !problem}
                onChange={(checked) =>
                  setSelected((current) => (checked ? [...current, target.paneId] : current.filter((id) => id !== target.paneId)))
                }
              />
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5" data-testid="snippet-preview">
          <span className="text-[11px] font-medium text-secondary">Endgültiger Befehl</span>
          {preview && <PreviewBlock expanded={preview} />}
          {results.map(({ target, expanded }) => (
            <div key={target.paneId} className="flex flex-col gap-0.5">
              {results.length > 1 && <span className="text-[11px] text-subtle">{target.label}</span>}
              <PreviewBlock expanded={expanded} problem={expanded.ok ? insertProblem(target.paneId, expanded.command) : 'ok'} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button disabled={!ready} onClick={() => send(false)}>
          Einfügen
        </Button>
        <Button variant="primary" disabled={!ready} onClick={confirmRun}>
          Ausführen…
        </Button>
      </div>
    </div>
  );
}

function PreviewBlock({ expanded, problem = 'ok' }: { expanded: Expanded; problem?: ReturnType<typeof insertProblem> }) {
  if (!expanded.ok) {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-error">
        <AlertTriangle size={13} className="mt-px flex-none" />
        {expanded.message}
      </p>
    );
  }
  return (
    <>
      <code className="block rounded-control border border-border bg-canvas px-2.5 py-1.5 font-terminal text-xs break-all whitespace-pre-wrap text-text select-text">
        {expanded.command}
      </code>
      {expanded.warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle size={12} className="mt-px flex-none" />
          {warning}
        </p>
      ))}
      {problem !== 'ok' && (
        <p className="flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle size={12} className="mt-px flex-none" />
          {insertProblemText(problem)}
        </p>
      )}
    </>
  );
}

export function SnippetRunDialog() {
  const running = useSnippets((state) => state.running);
  const close = useSnippets((state) => state.closeRun);

  return (
    <Modal
      open={running !== null}
      onOpenChange={(open) => !open && close()}
      title={running ? `„${running.name}“ ausführen` : ''}
      description={running?.description || undefined}
      width={560}
    >
      {running && <RunForm key={running.id} snippet={running} onClose={close} />}
    </Modal>
  );
}
