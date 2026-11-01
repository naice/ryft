import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Braces, History, Pencil, Play, Plus, Search, Star, Trash2 } from 'lucide-react';
import type { Snippet, SnippetInput, SnippetShell } from '@shared/contracts';
import { fuzzyScore } from '@shared/features/commandHistory';
import { placeholdersOf, snippetInputSchema, SNIPPET_SHELLS } from '@shared/features/snippets';
import { attempt, useApp } from '../../state/appStore';
import { Button, Checkbox, cx, EmptyState, Field, IconButton, Input, Modal, Select, TEXTAREA } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';
import { HistoryTab } from './HistoryTab';
import { useSnippets } from './snippetStore';

const SHELL_LABEL: Record<SnippetShell, string> = { posix: 'POSIX (bash, zsh, sh)', powershell: 'PowerShell', cmd: 'Eingabeaufforderung' };

interface ParamDraft {
  defaultValue: string;
  description: string;
}

function SnippetEditor({ snippet, onClose }: { snippet: Snippet | null; onClose(): void }) {
  const save = useSnippets((state) => state.save);
  const [name, setName] = useState(snippet?.name ?? '');
  const [description, setDescription] = useState(snippet?.description ?? '');
  const [command, setCommand] = useState(snippet?.command ?? '');
  const [category, setCategory] = useState(snippet?.category ?? '');
  const [tags, setTags] = useState(snippet?.tags.join(', ') ?? '');
  const [shells, setShells] = useState<SnippetShell[]>(snippet?.shells ?? []);
  const [favorite, setFavorite] = useState(snippet?.favorite ?? false);
  const [params, setParams] = useState<Record<string, ParamDraft>>(() =>
    Object.fromEntries(
      (snippet?.params ?? []).map((param) => [param.name, { defaultValue: param.defaultValue ?? '', description: param.description }])
    )
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const placeholders = useMemo(() => placeholdersOf(command), [command]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const candidate: SnippetInput = {
      name,
      description,
      command,
      category,
      tags: [...new Set(tags.split(',').map((tag) => tag.trim()).filter(Boolean))],
      shells,
      favorite,
      params: placeholders.map(({ name: param, inlineDefault }) => ({
        name: param,
        defaultValue: params[param]?.defaultValue || inlineDefault || null,
        description: params[param]?.description ?? ''
      }))
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
                  : issue.message;
      }
      setErrors(next);
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
            <div key={param} className="grid grid-cols-[1fr_1.4fr] gap-3">
              <Field label={`${param}: Standardwert`} htmlFor={`snippet-default-${param}`} error={errors.params}>
                <Input
                  id={`snippet-default-${param}`}
                  spellCheck={false}
                  placeholder={inlineDefault ?? ''}
                  value={params[param]?.defaultValue ?? ''}
                  onChange={(event) =>
                    setParams((current) => ({
                      ...current,
                      [param]: { description: current[param]?.description ?? '', defaultValue: event.target.value }
                    }))
                  }
                />
              </Field>
              <Field label={`${param}: Beschreibung`} htmlFor={`snippet-param-description-${param}`}>
                <Input
                  id={`snippet-param-description-${param}`}
                  maxLength={256}
                  value={params[param]?.description ?? ''}
                  onChange={(event) =>
                    setParams((current) => ({
                      ...current,
                      [param]: { defaultValue: current[param]?.defaultValue ?? '', description: event.target.value }
                    }))
                  }
                />
              </Field>
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

function SnippetRow({ snippet, onEdit }: { snippet: Snippet; onEdit(): void }) {
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
      </div>
    </div>
  );
}

function SnippetList({ onEdit }: { onEdit(snippet: Snippet): void }) {
  const snippets = useSnippets((state) => state.snippets);
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
          <SnippetRow key={snippet.id} snippet={snippet} onEdit={() => onEdit(snippet)} />
        ))}
        {visible.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-secondary">Keine Treffer</p>}
      </div>
    </>
  );
}

export function SnippetsView() {
  const snippets = useSnippets((state) => state.snippets);
  const load = useSnippets((state) => state.load);
  const [tab, setTab] = useState<'snippets' | 'history'>('snippets');
  const [editing, setEditing] = useState<{ snippet: Snippet | null } | null>(null);

  useEffect(() => {
    void attempt(load);
  }, [load]);

  return (
    <ToolView
      testId="snippets-view"
      title="Snippets"
      description={snippets.length === 1 ? '1 gespeicherter Befehl' : `${snippets.length} gespeicherte Befehle`}
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
      ) : snippets.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Braces size={26} />}
            title="Noch keine Snippets"
            description="Speichere Befehle, die du oft brauchst. Mit {{name}} fragt RYFT beim Einsetzen nach einem Wert."
            action={
              <Button onClick={() => setEditing({ snippet: null })}>
                <Plus size={14} /> Snippet hinzufügen
              </Button>
            }
          />
        </div>
      ) : (
        <SnippetList onEdit={(snippet) => setEditing({ snippet })} />
      )}
      {editing && <SnippetEditor snippet={editing.snippet} onClose={() => setEditing(null)} />}
    </ToolView>
  );
}
