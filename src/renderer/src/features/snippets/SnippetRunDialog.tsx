import { useMemo, useState } from 'react';
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { Snippet, SnippetParam, SnippetShell } from '@shared/contracts';
import { evaluateCompatibility, mergeContext } from '@shared/features/snippetCompat';
import { classifyCommand, higherRisk, RISK_LABEL, type RiskAssessment } from '@shared/features/snippetRisk';
import { expandSnippet, placeholdersOf, SnippetExpansionError, validateParamValue } from '@shared/features/snippets';
import { liveTargets, type LiveTarget } from '../../lib/sessionTargets';
import { useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { Button, Checkbox, cx, Field, Input, Modal, Select } from '../../components/ui/primitives';
import { focusTerminal, insertCommand, insertProblem } from '../terminal/terminalRegistry';
import { insertProblemText, useSnippets } from './snippetStore';

const SHELL_LABEL: Record<SnippetShell, string> = { posix: 'POSIX', powershell: 'PowerShell', cmd: 'cmd' };

type Expanded = { ok: true; command: string; warnings: string[] } | { ok: false; message: string; parameter: string | null };

function expand(snippet: Snippet, values: Record<string, string>, shell: SnippetShell): Expanded {
  try {
    const result = expandSnippet(snippet.command, values, shell, snippet.params);
    return { ok: true, command: result.command, warnings: result.warnings };
  } catch (error) {
    if (error instanceof SnippetExpansionError) return { ok: false, message: error.message, parameter: error.parameter };
    throw error;
  }
}

/** What is about to run, not what the template looks like: a value can make it worse, never better. */
function assess(snippet: Snippet, expansions: readonly Expanded[]): RiskAssessment {
  const risk: RiskAssessment = { level: snippet.risk, reasons: [] };
  for (const expanded of expansions) {
    if (!expanded.ok) continue;
    const found = classifyCommand(expanded.command);
    risk.level = higherRisk(risk.level, found.level);
    for (const reason of found.reasons) if (!risk.reasons.includes(reason)) risk.reasons.push(reason);
  }
  return risk;
}

function initialValue(param: SnippetParam | undefined, inlineDefault: string | null): string {
  return param?.defaultValue ?? inlineDefault ?? (param?.type === 'enum' ? (param.options?.[0] ?? '') : '');
}

function RunForm({ snippet, onClose }: { snippet: Snippet; onClose(): void }) {
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const activateTab = useWorkspace((state) => state.activateTab);
  const hosts = useApp((state) => state.hosts);
  const shells = useApp((state) => state.shells);
  const preferences = useApp((state) => state.preferences);
  const nodePlatform = useApp((state) => state.info?.platform);
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const showTerminals = useApp((state) => state.showTerminals);
  const contexts = useSnippets((state) => state.contexts);
  const runningPane = useSnippets((state) => state.runningPane);

  const targets = useMemo(
    () => liveTargets(tabs, panes, hosts, shells, preferences, nodePlatform),
    [tabs, panes, hosts, shells, preferences, nodePlatform]
  );
  const contextOf = (target: LiveTarget) => mergeContext(target.context, contexts[target.paneId]);
  // An undetected session gets the quoting of the shell it most likely has, and says so next to its name.
  const shellOf = (target: LiveTarget) => contextOf(target).shell ?? target.shell;
  /** Only the shell can rule a target out, because the quoting depends on it. The rest is a warning. */
  const shellProblem = (target: LiveTarget): string | undefined => {
    if (snippet.shells.length === 0 || snippet.shells.includes(shellOf(target))) return undefined;
    const only = `Nur für ${snippet.shells.map((shell) => SHELL_LABEL[shell]).join(', ')}`;
    return contextOf(target).shell === null ? `${only}. Die Shell ist nicht erkannt, in der Bibliothek auf „Erkennen“ klicken.` : only;
  };
  const targetNote = (target: LiveTarget): string | undefined => {
    const problem = shellProblem(target);
    if (problem) return problem;
    const context = contextOf(target);
    const compatibility = evaluateCompatibility(snippet, context);
    const notes = compatibility.status === 'incompatible' ? [...compatibility.reasons] : [];
    if (context.shell === null) notes.unshift(`Shell nicht erkannt, ${SHELL_LABEL[target.shell]} angenommen`);
    return notes.length > 0 ? notes.join('. ') : undefined;
  };
  const placeholders = useMemo(() => placeholdersOf(snippet.command), [snippet.command]);

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      placeholders.map(({ name, inlineDefault }) => [
        name,
        initialValue(snippet.params.find((param) => param.name === name), inlineDefault)
      ])
    )
  );
  const [selected, setSelected] = useState<string[]>(() => {
    const active = runningPane ?? tabs.find((tab) => tab.id === activeTabId)?.activePaneId;
    const target = targets.find((item) => item.paneId === active);
    return target && !shellProblem(target) ? [target.paneId] : [];
  });

  // A session which ends while the dialog is open silently stops being a target.
  const chosen = targets.filter((target) => selected.includes(target.paneId) && !shellProblem(target));
  const results = chosen.map((target) => ({ target, expanded: expand(snippet, values, shellOf(target)) }));
  const ready = results.length > 0 && results.every(({ expanded }) => expanded.ok);
  const previewShell = chosen[0] ? shellOf(chosen[0]) : targets[0] ? shellOf(targets[0]) : (snippet.shells[0] ?? 'posix');
  const preview = results.length === 0 ? expand(snippet, values, previewShell) : null;
  const risk = assess(snippet, preview ? [preview] : results.map(({ expanded }) => expanded));

  /** A value which is wrong however it would be quoted belongs to its field. */
  const fieldErrors: Record<string, string | null> = Object.fromEntries(
    placeholders.map(({ name }) => {
      const value = values[name] ?? '';
      const param = snippet.params.find((item) => item.name === name) ?? { name, defaultValue: null, description: '' };
      return [name, value === '' ? null : validateParamValue(param, value)];
    })
  );

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
    const many = results.length > 1;
    const lines = results.map(({ target, expanded }) => `• ${target.label}\n${expanded.ok ? expanded.command : ''}`);
    const notes = results
      .map(({ target }) => {
        const compatibility = evaluateCompatibility(snippet, contextOf(target));
        return compatibility.status === 'incompatible' ? `${target.label}: ${compatibility.reasons.join(', ')}` : null;
      })
      .filter((note): note is string => note !== null);
    const warning = [risk.level === 'safe' ? '' : `${RISK_LABEL[risk.level]}: ${risk.reasons.join(', ') || 'laut Bibliothek'}`, ...notes].filter(Boolean);
    askConfirm({
      title: many ? `Befehl auf ${results.length} Sitzungen ausführen?` : 'Befehl ausführen?',
      message: [...lines, ...warning].join('\n\n'),
      confirmLabel: many ? `Auf ${results.length} ausführen` : 'Ausführen',
      danger: many || risk.level === 'danger',
      acknowledge:
        risk.level === 'danger'
          ? 'Ich habe den Befehl geprüft und weiß, was er anrichten kann.'
          : many && risk.level === 'caution'
            ? `Ich will diese Änderung auf ${results.length} Sitzungen zugleich machen.`
            : undefined,
      onConfirm: () => send(true)
    });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
        {placeholders.map(({ name }, index) => {
          const param = snippet.params.find((item) => item.name === name);
          const setValue = (value: string) => setValues((current) => ({ ...current, [name]: value }));
          return (
            <Field
              key={name}
              label={param?.required === false ? `${name} (optional)` : name}
              htmlFor={`snippet-param-${name}`}
              hint={param?.description || undefined}
              error={fieldErrors[name]}
            >
              {param?.type === 'enum' ? (
                <Select
                  id={`snippet-param-${name}`}
                  value={values[name] ?? ''}
                  onChange={setValue}
                  options={(param.options ?? []).map((option) => ({ value: option, label: option }))}
                />
              ) : (
                <Input
                  id={`snippet-param-${name}`}
                  autoFocus={index === 0}
                  spellCheck={false}
                  aria-invalid={Boolean(fieldErrors[name])}
                  inputMode={param?.type === 'integer' || param?.type === 'port' ? 'numeric' : undefined}
                  value={values[name] ?? ''}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </Field>
          );
        })}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-secondary">Ziele ({chosen.length} von {targets.length})</span>
          {targets.length === 0 && <p className="text-xs text-subtle">Keine verbundene Sitzung. Öffne zuerst ein Terminal.</p>}
          {targets.map((target) => {
            const problem = shellProblem(target);
            return (
              <Checkbox
                key={target.paneId}
                label={`${target.label} (${SHELL_LABEL[shellOf(target)]})`}
                hint={targetNote(target)}
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
          {preview && <PreviewBlock expanded={preview} fieldErrors={fieldErrors} />}
          {results.map(({ target, expanded }) => (
            <div key={target.paneId} className="flex flex-col gap-0.5">
              {results.length > 1 && <span className="text-[11px] text-subtle">{target.label}</span>}
              <PreviewBlock expanded={expanded} fieldErrors={fieldErrors} problem={expanded.ok ? insertProblem(target.paneId, expanded.command) : 'ok'} />
            </div>
          ))}
        </div>

        <RiskNotice risk={risk} />
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button disabled={!ready} onClick={confirmRun}>
          Ausführen…
        </Button>
        <Button variant="primary" disabled={!ready} onClick={() => send(false)}>
          Einfügen
        </Button>
      </div>
    </div>
  );
}

function RiskNotice({ risk }: { risk: RiskAssessment }) {
  const Icon = risk.level === 'safe' ? ShieldCheck : risk.level === 'caution' ? AlertTriangle : ShieldAlert;
  return (
    <p
      data-testid="snippet-risk"
      data-risk={risk.level}
      className={cx(
        'flex items-start gap-1.5 text-[11px]',
        risk.level === 'safe' ? 'text-subtle' : risk.level === 'caution' ? 'text-warning' : 'text-error'
      )}
    >
      <Icon size={12} className="mt-px flex-none" aria-hidden />
      <span>
        {RISK_LABEL[risk.level]}
        {risk.reasons.length > 0 ? `: ${risk.reasons.join(', ')}` : ''}
      </span>
    </p>
  );
}

function PreviewBlock({
  expanded,
  fieldErrors,
  problem = 'ok'
}: {
  expanded: Expanded;
  fieldErrors: Record<string, string | null>;
  problem?: ReturnType<typeof insertProblem>;
}) {
  if (!expanded.ok) {
    // The field shows it already; here it only needs to say why there is no command.
    const shownAtField = expanded.parameter !== null && Boolean(fieldErrors[expanded.parameter]);
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-error">
        <AlertTriangle size={13} className="mt-px flex-none" />
        {shownAtField ? 'Bitte korrigiere das markierte Feld.' : expanded.message}
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
      title={running ? `„${running.name}“ einfügen oder ausführen` : ''}
      description={running?.description || undefined}
      width={560}
    >
      {running && <RunForm key={running.id} snippet={running} onClose={close} />}
    </Modal>
  );
}
