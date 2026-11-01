import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Braces, Copy, History, Library, Lock, Pencil, Play, Plus, Search, Star, Trash2 } from 'lucide-react';
import type { Snippet, SnippetInput, SnippetParam, SnippetParamType, SnippetPlatform, SnippetShell } from '@shared/contracts';
import { fuzzyScore } from '@shared/features/commandHistory';
import { platformLabel } from '@shared/features/snippetCompat';
import {
  placeholdersOf,
  snippetInputSchema,
  SNIPPET_PARAM_TYPES,
  SNIPPET_PLATFORMS,
  SNIPPET_SHELLS,
  validateParamValue
} from '@shared/features/snippets';
import { attempt, useApp } from '../../state/appStore';
import { Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Modal, Select, TEXTAREA } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';
import { HistoryTab } from './HistoryTab';
import { PARAM_TYPE_LABEL, PresetBrowser } from './PresetBrowser';
import { RiskBadge } from './snippetBadges';
import { useSnippets } from './snippetStore';

const SHELL_LABEL: Record<SnippetShell, string> = { posix: 'POSIX (bash, zsh, sh)', powershell: 'PowerShell', cmd: 'Eingabeaufforderung' };

interface ParamDraft {
  defaultValue: string;
  description: string;
  type: SnippetParamType | '';
  required: boolean;
  options: string;
}

const EMPTY_DRAFT: ParamDraft = { defaultValue: '', description: '', type: '', required: true, options: '' };

const listOf = (text: string) => [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))];

function SnippetEditor({ snippet, onClose }: { snippet: Snippet | null; onClose(): void }) {
  const save = useSnippets((state) => state.save);
  const [name, setName] = useState(snippet?.name ?? '');
  const [description, setDescription] = useState(snippet?.description ?? '');
  const [command, setCommand] = useState(snippet?.command ?? '');
  const [category, setCategory] = useState(snippet?.category ?? '');
  const [tags, setTags] = useState(snippet?.tags.join(', ') ?? '');
  const [shells, setShells] = useState<SnippetShell[]>(snippet?.shells ?? []);
  const [platforms, setPlatforms] = useState<SnippetPlatform[]>(snippet?.platforms ?? []);
  const [requiredTools, setRequiredTools] = useState(snippet?.requiredTools.join(', ') ?? '');
  const [favorite, setFavorite] = useState(snippet?.favorite ?? false);
  const [params, setParams] = useState<Record<string, ParamDraft>>(() =>
    Object.fromEntries(
      (snippet?.params ?? []).map((param) => [
        param.name,
        {
          defaultValue: param.defaultValue ?? '',
          description: param.description,
          type: param.type ?? '',
          required: param.required !== false,
          options: param.options?.join(', ') ?? ''
        }
      ])
    )
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const placeholders = useMemo(() => placeholdersOf(command), [command]);
  const setParam = (param: string, change: Partial<ParamDraft>) =>
    setParams((current) => ({ ...current, [param]: { ...EMPTY_DRAFT, ...current[param], ...change } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const candidate: SnippetInput = {
      name,
      description,
      command,
      category,
      tags: listOf(tags),
      shells,
      platforms,
      requiredTools: listOf(requiredTools),
      favorite,
      params: placeholders.map(({ name: param, inlineDefault }): SnippetParam => {
        const draft = params[param];
        const original = snippet?.params.find((item) => item.name === param);
        const type = draft?.type || undefined;
        return {
          // What this form has no field for, such as the limits of a number, stays as it was.
          ...original,
          name: param,
          defaultValue: draft?.defaultValue || inlineDefault || null,
          description: draft?.description ?? '',
          type,
          required: draft?.required === false ? false : undefined,
          options: type === 'enum' ? listOf(draft?.options ?? '') : undefined
        };
      })
    };
    const parsed = snippetInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] =
          field === 'name'
            ? 'Name erforderlich'
            : field === 'command'
              ? 'Befehl erforderlich, ohne Steuerzeichen'
              : field === 'params'
                ? 'Standardwerte dürfen keine Steuerzeichen enthalten'
                : field === 'tags'
                  ? 'Höchstens 16 Tags mit je 32 Zeichen'
                  : field === 'requiredTools'
                    ? 'Höchstens 16 Namen, nur Buchstaben, Ziffern und . _ + -'
                    : issue.message;
      }
      setErrors(next);
      return;
    }
    const wrongDefaults = Object.fromEntries(
      parsed.data.params
        .filter((param) => param.defaultValue && validateParamValue(param, param.defaultValue))
        .map((param) => [`default-${param.name}`, validateParamValue(param, param.defaultValue as string) as string])
    );
    if (Object.keys(wrongDefaults).length > 0) {
      setErrors(wrongDefaults);
      return;
    }
    void attempt(async () => {
      await save(snippet?.id ?? null, parsed.data);
      onClose();
    });
  };

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={snippet ? 'Snippet bearbeiten' : 'Snippet hinzufügen'} width={560}>
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" htmlFor="snippet-name" error={errors.name}>
              <Input id="snippet-name" autoFocus maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Kategorie" htmlFor="snippet-category" error={errors.category}>
              <Input id="snippet-category" maxLength={64} value={category} onChange={(event) => setCategory(event.target.value)} />
            </Field>
          </div>
          <Field label="Beschreibung" htmlFor="snippet-description" error={errors.description}>
            <Input id="snippet-description" maxLength={1024} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field
            label="Befehl"
            htmlFor="snippet-command"
            error={errors.command}
            hint="Parameter schreibst du als {{name}} oder mit Standardwert als {{name:wert}}. Werte werden beim Einsetzen für die Shell maskiert."
          >
            <textarea
              id="snippet-command"
              rows={4}
              spellCheck={false}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              className={TEXTAREA}
            />
          </Field>
          {placeholders.map(({ name: param, inlineDefault }) => (
            <div key={param} className="flex flex-col gap-2 rounded-control border border-border p-2.5">
              <div className="grid grid-cols-[1fr_1.4fr] gap-3">
                <Field label={`${param}: Standardwert`} htmlFor={`snippet-default-${param}`} error={errors[`default-${param}`] ?? errors.params}>
                  <Input
                    id={`snippet-default-${param}`}
                    spellCheck={false}
                    placeholder={inlineDefault ?? ''}
                    value={params[param]?.defaultValue ?? ''}
                    onChange={(event) => setParam(param, { defaultValue: event.target.value })}
                  />
                </Field>
                <Field label={`${param}: Beschreibung`} htmlFor={`snippet-param-description-${param}`}>
                  <Input
                    id={`snippet-param-description-${param}`}
                    maxLength={256}
                    value={params[param]?.description ?? ''}
                    onChange={(event) => setParam(param, { description: event.target.value })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-[1fr_1.4fr] items-end gap-3">
                <Field label={`${param}: Typ`} htmlFor={`snippet-type-${param}`}>
                  <Select
                    id={`snippet-type-${param}`}
                    value={params[param]?.type ?? ''}
                    onChange={(value) => setParam(param, { type: value as SnippetParamType | '' })}
                    options={[
                      { value: '', label: 'Ohne Prüfung' },
                      ...SNIPPET_PARAM_TYPES.map((type) => ({ value: type, label: PARAM_TYPE_LABEL[type] }))
                    ]}
                  />
                </Field>
                {params[param]?.type === 'enum' ? (
                  <Field label={`${param}: Erlaubte Werte`} htmlFor={`snippet-options-${param}`} hint="Durch Kommas getrennt">
                    <Input
                      id={`snippet-options-${param}`}
                      spellCheck={false}
                      value={params[param]?.options ?? ''}
                      onChange={(event) => setParam(param, { options: event.target.value })}
                    />
                  </Field>
                ) : (
                  <Checkbox
                    label={`${param}: Pflichtfeld`}
                    checked={params[param]?.required !== false}
                    onChange={(required) => setParam(param, { required })}
                  />
                )}
              </div>
            </div>
          ))}
          <Field label="Tags" htmlFor="snippet-tags" hint="Durch Kommas getrennt" error={errors.tags}>
            <Input id="snippet-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-secondary">Passende Shells (keine Auswahl: alle)</span>
            {SNIPPET_SHELLS.map((shell) => (
              <Checkbox
                key={shell}
                label={SHELL_LABEL[shell]}
                checked={shells.includes(shell)}
                onChange={(checked) => setShells((current) => (checked ? [...current, shell] : current.filter((item) => item !== shell)))}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-secondary">Passende Systeme (keine Auswahl: alle)</span>
            {SNIPPET_PLATFORMS.map((platform) => (
              <Checkbox
                key={platform}
                label={platformLabel(platform)}
                checked={platforms.includes(platform)}
                onChange={(checked) => setPlatforms((current) => (checked ? [...current, platform] : current.filter((item) => item !== platform)))}
              />
            ))}
          </div>
          <Field label="Benötigte Programme" htmlFor="snippet-tools" hint="Durch Kommas getrennt, zum Beispiel docker, jq" error={errors.requiredTools}>
            <Input id="snippet-tools" spellCheck={false} value={requiredTools} onChange={(event) => setRequiredTools(event.target.value)} />
          </Field>
          <Checkbox label="Favorit" checked={favorite} onChange={setFavorite} />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary">
            Speichern
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SnippetRow({ snippet, onEdit, onCopied }: { snippet: Snippet; onEdit(): void; onCopied(copy: Snippet): void }) {
  const duplicate = useSnippets((state) => state.duplicate);
  const setFavorite = useSnippets((state) => state.setFavorite);
  const remove = useSnippets((state) => state.remove);
  const openRun = useSnippets((state) => state.openRun);
  const askConfirm = useApp((state) => state.askConfirm);
  return (
    <div data-testid="snippet-row" className="flex flex-none items-center gap-3 border-b border-border px-4 py-2">
      <IconButton
        label={snippet.favorite ? `${snippet.name} aus Favoriten entfernen` : `${snippet.name} als Favorit markieren`}
        aria-pressed={snippet.favorite}
        onClick={() => void attempt(() => setFavorite(snippet))}
      >
        <Star size={14} className={snippet.favorite ? 'fill-current text-cyan' : undefined} />
      </IconButton>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text">{snippet.name}</span>
          {snippet.source === 'builtin' && (
            <span className="flex flex-none items-center gap-1 text-[11px] text-subtle" title="Aus der Bibliothek, nur lesbar">
              <Lock size={11} aria-hidden /> Bibliothek
            </span>
          )}
          {snippet.risk !== 'safe' && <RiskBadge risk={snippet.risk} compact />}
          {snippet.category && <span className="flex-none rounded-full bg-raised px-2 text-[11px] leading-[18px] text-secondary">{snippet.category}</span>}
          {snippet.tags.map((tag) => (
            <span key={tag} className="flex-none text-[11px] text-subtle">
              #{tag}
            </span>
          ))}
        </div>
        <code className="truncate font-terminal text-[11px] text-secondary" title={snippet.command}>
          {snippet.command}
        </code>
        {snippet.description && <span className="truncate text-[11px] text-subtle">{snippet.description}</span>}
      </div>
      <div className="flex flex-none items-center gap-0.5">
        <IconButton label={`${snippet.name} einfügen oder ausführen`} onClick={() => openRun(snippet)}>
          <Play size={13} className="text-cyan" />
        </IconButton>
        <IconButton label={`${snippet.name} als Kopie bearbeiten`} onClick={() => void attempt(async () => onCopied(await duplicate(snippet.id)))}>
          <Copy size={13} />
        </IconButton>
        {snippet.source === 'user' && (
          <>
            <IconButton label={`${snippet.name} bearbeiten`} onClick={onEdit}>
              <Pencil size={13} />
            </IconButton>
            <IconButton
              label={`${snippet.name} löschen`}
              onClick={() =>
                askConfirm({
                  title: `„${snippet.name}“ löschen?`,
                  message: 'Das Snippet wird entfernt.',
                  confirmLabel: 'Löschen',
                  danger: true,
                  onConfirm: () => void attempt(() => remove(snippet.id))
                })
              }
            >
              <Trash2 size={13} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

function SnippetList({ snippets, onEdit, onCopied }: { snippets: readonly Snippet[]; onEdit(snippet: Snippet): void; onCopied(copy: Snippet): void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const categories = useMemo(() => [...new Set(snippets.map((item) => item.category).filter(Boolean))].sort(), [snippets]);
  const visible = useMemo(() => {
    const scored = snippets
      .filter((item) => (!category || item.category === category) && (!onlyFavorites || item.favorite))
      .map((item) => {
        const haystacks = [item.name, item.command, item.description, item.category, item.tags.join(' ')];
        const scores = haystacks.map((text) => fuzzyScore(query, text)).filter((score): score is number => score !== null);
        return { item, score: scores.length > 0 ? Math.max(...scores) : null };
      })
      .filter((entry) => entry.score !== null);
    return query.trim() ? scored.sort((a, b) => (b.score as number) - (a.score as number)).map(({ item }) => item) : scored.map(({ item }) => item);
  }, [snippets, query, category, onlyFavorites]);

  return (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border border-border bg-canvas px-2 focus-within:border-border-active">
          <Search size={14} className="flex-none text-subtle" />
          <input
            aria-label="Snippets suchen"
            placeholder="Snippets suchen…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="ryft-bare-input min-w-0 flex-1 bg-transparent text-xs text-text select-text placeholder:text-subtle"
          />
        </div>
        <div className="w-44 flex-none">
          <Select
            ariaLabel="Kategorie"
            value={category}
            onChange={setCategory}
            options={[{ value: '', label: 'Alle Kategorien' }, ...categories.map((value) => ({ value, label: value }))]}
          />
        </div>
        <Checkbox label="Nur Favoriten" checked={onlyFavorites} onChange={setOnlyFavorites} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {visible.map((snippet) => (
          <SnippetRow key={snippet.id} snippet={snippet} onEdit={() => onEdit(snippet)} onCopied={onCopied} />
        ))}
        {visible.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-secondary">Keine Treffer</p>}
      </div>
    </>
  );
}

export function SnippetsView() {
  const snippets = useSnippets((state) => state.snippets);
  const load = useSnippets((state) => state.load);
  const [tab, setTab] = useState<'snippets' | 'library' | 'history'>('snippets');
  const [editing, setEditing] = useState<{ snippet: Snippet | null } | null>(null);

  useEffect(() => {
    void attempt(load);
  }, [load]);

  const personal = useMemo(() => snippets.filter((item) => item.source === 'user'), [snippets]);
  // The library has its own tab. Here it only shows what someone chose to keep at hand.
  const mine = useMemo(() => snippets.filter((item) => item.source === 'user' || item.favorite), [snippets]);
  const openCopy = (copy: Snippet) => {
    setTab('snippets');
    setEditing({ snippet: copy });
  };

  return (
    <ToolView
      testId="snippets-view"
      title="Snippets"
      description={personal.length === 1 ? '1 gespeicherter Befehl' : `${personal.length} gespeicherte Befehle`}
      actions={
        <Button variant="primary" onClick={() => setEditing({ snippet: null })}>
          <Plus size={14} /> Snippet
        </Button>
      }
    >
      <div role="tablist" aria-label="Snippets und Verlauf" className="flex flex-none gap-1 border-b border-border px-3 py-1.5">
        {(
          [
            { id: 'snippets', label: 'Snippets', icon: <Braces size={14} /> },
            { id: 'library', label: 'Bibliothek', icon: <Library size={14} /> },
            { id: 'history', label: 'Verlauf', icon: <History size={14} /> }
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cx(
              'flex h-7 items-center gap-1.5 rounded-control px-2.5 text-xs transition-colors duration-120',
              tab === item.id ? 'bg-selected-strong text-text' : 'text-secondary hover:bg-hover hover:text-text'
            )}
          >
            {item.icon} {item.label}
          </button>
        ))}
      </div>
      {tab === 'history' ? (
        <HistoryTab />
      ) : tab === 'library' ? (
        <PresetBrowser onCopied={openCopy} />
      ) : mine.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Braces size={26} />}
            title="Noch keine Snippets"
            description="Speichere Befehle, die du oft brauchst. Mit {{name}} fragt RYFT beim Einsetzen nach einem Wert."
            action={
              <div className="flex gap-2">
                <Button onClick={() => setTab('library')}>
                  <Library size={14} /> Bibliothek öffnen
                </Button>
                <Button onClick={() => setEditing({ snippet: null })}>
                  <Plus size={14} /> Snippet hinzufügen
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <SnippetList snippets={mine} onEdit={(snippet) => setEditing({ snippet })} onCopied={openCopy} />
      )}
      {editing && <SnippetEditor snippet={editing.snippet} onClose={() => setEditing(null)} />}
    </ToolView>
  );
}
