import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CornerLeftUp,
  Eye,
  EyeOff,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  Loader2,
  RefreshCw
} from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import type { FileEntry } from '@shared/contracts';
import { formatBytes, formatMode } from '@shared/features/sftp';
import { attempt, useApp } from '../../state/appStore';
import { Button, cx, EmptyState, IconButton, Input, Modal } from '../../components/ui/primitives';
import { breadcrumbs, isFolderLike, selectRange, visibleEntries, type SortKey, type SortOrder } from './fileList';
import { useSftp, type PaneSide } from './sftpStore';

const MENU_ITEM =
  'flex h-[30px] cursor-default items-center rounded-[4px] px-2.5 text-[13px] text-text outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40';
const INTERNAL_DRAG = 'application/x-ryft-paths';
const DATE_FORMAT = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']);
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'sh', 'rs', 'go', 'c', 'h', 'cpp', 'java', 'rb', 'php', 'yml', 'yaml', 'toml', 'html', 'css', 'xml']);
const TEXT = new Set(['txt', 'md', 'log', 'csv', 'ini', 'conf', 'cfg']);

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === 'symlink' && !isFolderLike(entry)) return <Link2 size={15} className="flex-none text-[var(--ryft-purple)]" />;
  if (isFolderLike(entry)) return <Folder size={15} className="flex-none text-cyan" />;
  const extension = entry.name.includes('.') ? (entry.name.split('.').pop() ?? '').toLowerCase() : '';
  const className = 'flex-none text-secondary';
  if (IMAGE.has(extension)) return <FileImage size={15} className={className} />;
  if (ARCHIVE.has(extension)) return <FileArchive size={15} className={className} />;
  if (CODE.has(extension)) return <FileCode2 size={15} className={className} />;
  if (TEXT.has(extension)) return <FileText size={15} className={className} />;
  return <FileIcon size={15} className={className} />;
}

function NameDialog({
  title,
  label,
  initial,
  confirmLabel,
  onSubmit,
  onClose
}: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  onSubmit(name: string): void;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={title} width={400}>
      <form
        className="flex flex-col gap-3 px-5 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] font-medium text-secondary">
          {label}
          <Input autoFocus spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const MODE_BITS: { label: string; shift: number }[] = [
  { label: 'Besitzer', shift: 6 },
  { label: 'Gruppe', shift: 3 },
  { label: 'Andere', shift: 0 }
];

function ChmodDialog({ entry, onSubmit, onClose }: { entry: FileEntry; onSubmit(mode: number): void; onClose(): void }) {
  const [mode, setMode] = useState((entry.mode ?? 0o644) & 0o7777);
  const toggle = (bit: number) => setMode((current) => current ^ bit);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Rechte von „${entry.name}“`}
      description={`${formatMode(mode & 0o777)} (${(mode & 0o7777).toString(8).padStart(4, '0')})`}
      width={380}
    >
      <div className="flex flex-col gap-2 px-5 pb-4">
        {MODE_BITS.map(({ label, shift }) => (
          <div key={label} className="flex items-center gap-3 text-[13px] text-text">
            <span className="w-20 text-secondary">{label}</span>
            {(['Lesen', 'Schreiben', 'Ausführen'] as const).map((name, index) => {
              const bit = (4 >> index) << shift;
              return (
                <label key={name} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`${label} ${name}`}
                    checked={(mode & bit) !== 0}
                    onChange={() => toggle(bit)}
                    className="size-3.5 accent-[var(--ryft-cyan)]"
                  />
                  {name}
                </label>
              );
            })}
          </div>
        ))}
        <div className="mt-2 flex justify-end gap-2">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={() => onSubmit(mode)}>
            Übernehmen
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className
}: {
  label: string;
  column: SortKey;
  sort: SortOrder;
  onSort(key: SortKey): void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <button
      type="button"
      aria-sort={active ? (sort.ascending ? 'ascending' : 'descending') : undefined}
      onClick={() => onSort(column)}
      className={cx('flex items-center gap-1 truncate hover:text-text', active && 'text-text', className)}
    >
      {label}
      {active && (sort.ascending ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

export interface FileOperations {
  mkdir(parent: string, name: string): Promise<void>;
  rename(path: string, name: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
}

export function FilePane({
  side,
  title,
  operations,
  toolbar,
  transferLabel,
  onTransfer,
  onDropPaths,
  onDropFiles,
  empty
}: {
  side: PaneSide;
  title: string;
  operations: FileOperations;
  toolbar?: ReactNode;
  transferLabel: string | null;
  onTransfer(paths: string[]): void;
  onDropPaths(paths: string[]): void;
  /** Files dragged in from the operating system. */
  onDropFiles?(files: File[]): void;
  empty?: ReactNode;
}) {
  const pane = useSftp((state) => state.panes[side]);
  const showHidden = useSftp((state) => state.showHidden);
  const setShowHidden = useSftp((state) => state.setShowHidden);
  const navigate = useSftp((state) => state.navigate);
  const refresh = useSftp((state) => state.refresh);
  const askConfirm = useApp((state) => state.askConfirm);

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortOrder>({ key: 'name', ascending: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'mkdir' } | { kind: 'rename' | 'chmod'; entry: FileEntry } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const listing = pane.listing;
  const currentPath = listing?.path ?? null;
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [currentPath]);

  const entries = useMemo(
    () => (listing ? visibleEntries(listing.entries, filter, showHidden, sort) : []),
    [listing, filter, showHidden, sort]
  );
  const crumbs = useMemo(() => (currentPath ? breadcrumbs(currentPath) : []), [currentPath]);
  const selectedEntries = entries.filter((entry) => selected.has(entry.path));

  const act = (action: () => Promise<unknown>) =>
    void attempt(async () => {
      await action();
      await refresh(side);
    });

  const onSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, ascending: !current.ascending } : { key, ascending: true }));

  const onRowClick = (entry: FileEntry, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (event.shiftKey) {
      setSelected(new Set(selectRange(entries.map((item) => item.path), anchor, entry.path)));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next);
    } else {
      setSelected(new Set([entry.path]));
    }
    setAnchor(entry.path);
  };

  const open = (entry: FileEntry) => {
    if (isFolderLike(entry)) void navigate(side, entry.path);
    else if (transferLabel) onTransfer([entry.path]);
  };

  const confirmRemove = (targets: FileEntry[]) => {
    if (targets.length === 0) return;
    const folders = targets.filter((entry) => entry.type === 'directory').length;
    const names = targets.slice(0, 5).map((entry) => entry.name).join(', ');
    askConfirm({
      title: targets.length === 1 ? `„${targets[0]!.name}“ löschen?` : `${targets.length} Einträge löschen?`,
      message: `${targets.length > 1 ? `${names}${targets.length > 5 ? ' …' : ''}\n` : ''}${
        folders > 0 ? 'Ordner werden samt Inhalt gelöscht. ' : ''
      }Das lässt sich nicht rückgängig machen.`,
      confirmLabel: 'Löschen',
      danger: true,
      onConfirm: () =>
        act(async () => {
          for (const entry of targets) await operations.remove(entry.path, entry.type === 'directory');
        })
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const paths = entries.map((entry) => entry.path);
    const focusIndex = anchor ? paths.indexOf(anchor) : -1;
    const moveTo = (index: number) => {
      const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
      if (!entry) return;
      event.preventDefault();
      onRowClick(entry, { ctrlKey: false, metaKey: false, shiftKey: event.shiftKey });
      listRef.current?.querySelector(`[data-index="${entries.indexOf(entry)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    switch (event.key) {
      case 'ArrowDown':
        moveTo(focusIndex + 1);
        break;
      case 'ArrowUp':
        moveTo(focusIndex <= 0 ? 0 : focusIndex - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(entries.length - 1);
        break;
      case 'Enter': {
        const entry = entries[focusIndex];
        if (entry) {
          event.preventDefault();
          open(entry);
        }
        break;
      }
      case 'Backspace':
        if (listing?.parent) {
          event.preventDefault();
          void navigate(side, listing.parent);
        }
        break;
      case 'Delete':
        event.preventDefault();
        confirmRemove(selectedEntries);
        break;
      case 'F2': {
        const entry = selectedEntries[0];
        if (entry) {
          event.preventDefault();
          setDialog({ kind: 'rename', entry });
        }
        break;
      }
      case 'F5':
        event.preventDefault();
        if (transferLabel && selectedEntries.length > 0) onTransfer(selectedEntries.map((item) => item.path));
        break;
      case 'a':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          setSelected(new Set(paths));
        }
        break;
    }
  };

  const onDragStart = (event: DragEvent, entry: FileEntry) => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path];
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
    event.dataTransfer.setData(INTERNAL_DRAG, JSON.stringify({ side, paths }));
    event.dataTransfer.effectAllowed = 'copy';
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    const internal = event.dataTransfer.getData(INTERNAL_DRAG);
    if (internal) {
      const parsed = JSON.parse(internal) as { side: PaneSide; paths: string[] };
      if (parsed.side !== side) onDropPaths(parsed.paths);
      return;
    }
    if (onDropFiles && event.dataTransfer.files.length > 0) onDropFiles([...event.dataTransfer.files]);
  };

  return (
    <section
      aria-label={title}
      data-testid={`sftp-pane-${side}`}
      className={cx(
        'flex min-h-0 min-w-0 flex-1 flex-col rounded-card border bg-card',
        dropActive ? 'border-border-active' : 'border-border'
      )}
      onDragOver={(event) => {
        if (!listing) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex h-9 flex-none items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 truncate text-xs font-semibold text-text">{title}</span>
        <div className="flex-1" />
        {toolbar}
        <IconButton label="Eine Ebene höher" disabled={!listing?.parent} onClick={() => listing?.parent && void navigate(side, listing.parent)}>
          <CornerLeftUp size={14} />
        </IconButton>
        <IconButton label="Aktualisieren" disabled={!listing} onClick={() => void refresh(side)}>
          <RefreshCw size={14} className={pane.loading ? 'ryft-spin' : ''} />
        </IconButton>
        <IconButton label="Neuer Ordner" disabled={!listing} onClick={() => setDialog({ kind: 'mkdir' })}>
          <FolderPlus size={14} />
        </IconButton>
        <IconButton
          label={showHidden ? 'Versteckte Dateien ausblenden' : 'Versteckte Dateien anzeigen'}
          aria-pressed={showHidden}
          onClick={() => setShowHidden(!showHidden)}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
      </div>

      {listing && (
        <div className="flex h-8 flex-none items-center gap-2 border-b border-border px-2">
          {editingPath !== null ? (
            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                void navigate(side, editingPath.trim());
                setEditingPath(null);
              }}
            >
              <input
                aria-label="Pfad"
                autoFocus
                spellCheck={false}
                value={editingPath}
                onChange={(event) => setEditingPath(event.target.value)}
                onBlur={() => setEditingPath(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditingPath(null);
                }}
                className="ryft-bare-input w-full bg-transparent font-terminal text-[11px] text-text select-text"
              />
            </form>
          ) : (
            <nav
              aria-label="Pfad"
              onDoubleClick={() => setEditingPath(listing.path)}
              title={`${listing.path} – Doppelklick zum Eingeben`}
              className="flex min-w-0 flex-1 items-center overflow-hidden text-[11px] text-secondary"
            >
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex min-w-0 items-center">
                  {index > 0 && crumbs[index - 1]!.label !== '/' && <ChevronRight size={11} className="flex-none text-subtle" />}
                  <button
                    type="button"
                    onClick={() => void navigate(side, crumb.path)}
                    aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                    className={cx('truncate rounded-[3px] px-0.5 hover:text-text', index === crumbs.length - 1 && 'text-text')}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          )}
          <input
            aria-label={`${title} filtern`}
            placeholder="Filtern…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="ryft-bare-input w-24 flex-none rounded-[4px] border border-border bg-canvas px-1.5 text-[11px] leading-5 text-text select-text placeholder:text-subtle focus:border-border-active"
          />
        </div>
      )}

      {pane.error && (
        <div role="alert" className="flex flex-none items-start gap-2 border-b border-border px-2.5 py-1.5 text-xs text-error">
          <AlertTriangle size={13} className="mt-0.5 flex-none" />
          <span className="min-w-0 break-words select-text">{pane.error}</span>
        </div>
      )}

      {!listing && !pane.loading && !pane.error && empty}
      {!listing && pane.loading && (
        <div className="flex flex-1 items-center justify-center text-secondary">
          <Loader2 size={18} className="ryft-spin" aria-label="Lädt" />
        </div>
      )}

      {listing && (
        <>
          <div className="grid h-6 flex-none grid-cols-[minmax(0,1fr)_72px_56px_108px] items-center gap-2 border-b border-border px-2.5 text-[11px] text-subtle">
            <SortHeader label="Name" column="name" sort={sort} onSort={onSort} />
            <SortHeader label="Größe" column="size" sort={sort} onSort={onSort} className="justify-end" />
            <SortHeader label="Typ" column="type" sort={sort} onSort={onSort} />
            <SortHeader label="Geändert" column="modifiedAt" sort={sort} onSort={onSort} />
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label={`Dateien in ${listing.path}`}
            aria-multiselectable
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="ryft-focus-inset min-h-0 flex-1 overflow-y-auto"
          >
            {entries.map((entry, index) => (
              <ContextMenu.Root key={entry.path}>
                <ContextMenu.Trigger asChild>
                  <div
                    role="option"
                    aria-selected={selected.has(entry.path)}
                    data-index={index}
                    data-testid="sftp-entry"
                    draggable
                    onDragStart={(event) => onDragStart(event, entry)}
                    onClick={(event) => onRowClick(entry, event)}
                    onDoubleClick={() => open(entry)}
                    onContextMenu={() => {
                      if (!selected.has(entry.path)) {
                        setSelected(new Set([entry.path]));
                        setAnchor(entry.path);
                      }
                    }}
                    className={cx(
                      'grid h-[26px] grid-cols-[minmax(0,1fr)_72px_56px_108px] items-center gap-2 px-2.5 text-xs',
                      selected.has(entry.path) ? 'bg-selected-strong text-text' : 'text-text hover:bg-hover'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <EntryIcon entry={entry} />
                      <span className={cx('truncate', entry.hidden && 'text-secondary')}>{entry.name}</span>
                    </span>
                    <span className="truncate text-right text-[11px] text-secondary">
                      {isFolderLike(entry) ? '' : formatBytes(entry.size)}
                    </span>
                    <span className="truncate text-[11px] text-secondary">
                      {isFolderLike(entry) ? 'Ordner' : entry.type === 'symlink' ? 'Link' : entry.type === 'other' ? 'Spezial' : 'Datei'}
                    </span>
                    <span className="truncate text-[11px] text-secondary">{DATE_FORMAT.format(new Date(entry.modifiedAt))}</span>
                  </div>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className="z-[55] min-w-44 rounded-card border border-border bg-raised p-1 shadow-float">
                    {transferLabel && (
                      <ContextMenu.Item
                        className={MENU_ITEM}
                        onSelect={() => onTransfer(selected.has(entry.path) ? [...selected] : [entry.path])}
                      >
                        {transferLabel}
                      </ContextMenu.Item>
                    )}
                    <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: 'rename', entry })}>
                      Umbenennen
                    </ContextMenu.Item>
                    {operations.chmod && (
                      <ContextMenu.Item className={MENU_ITEM} onSelect={() => setDialog({ kind: 'chmod', entry })}>
                        Rechte ändern
                      </ContextMenu.Item>
                    )}
                    <ContextMenu.Separator className="my-1 h-px bg-border" />
                    <ContextMenu.Item
                      className={cx(MENU_ITEM, 'text-error')}
                      onSelect={() => confirmRemove(selected.has(entry.path) ? selectedEntries : [entry])}
                    >
                      Löschen
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            ))}
            {entries.length === 0 && !pane.loading && (
              <EmptyState
                icon={<Folder size={22} />}
                title={filter ? 'Keine Treffer' : 'Dieser Ordner ist leer'}
                description={filter ? 'Kein Eintrag passt zum Filter.' : 'Ziehe Dateien hierher, um sie zu übertragen.'}
              />
            )}
          </div>
          <div className="flex h-6 flex-none items-center border-t border-border px-2.5 text-[11px] text-subtle">
            {selected.size > 0 ? `${selected.size} ausgewählt · ` : ''}
            {entries.length} Einträge
          </div>
        </>
      )}

      {dialog?.kind === 'mkdir' && listing && (
        <NameDialog
          title="Neuer Ordner"
          label="Name"
          initial=""
          confirmLabel="Anlegen"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            setDialog(null);
            act(() => operations.mkdir(listing.path, name));
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title={`„${dialog.entry.name}“ umbenennen`}
          label="Neuer Name"
          initial={dialog.entry.name}
          confirmLabel="Umbenennen"
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            const { entry } = dialog;
            setDialog(null);
            if (name !== entry.name) act(() => operations.rename(entry.path, name));
          }}
        />
      )}
      {dialog?.kind === 'chmod' && operations.chmod && (
        <ChmodDialog
          entry={dialog.entry}
          onClose={() => setDialog(null)}
          onSubmit={(mode) => {
            const { entry } = dialog;
            setDialog(null);
            act(() => operations.chmod!(entry.path, mode));
          }}
        />
      )}
    </section>
  );
}
