import type { FileEntry } from '@shared/contracts';

export type SortKey = 'name' | 'size' | 'type' | 'modifiedAt';
export interface SortOrder {
  key: SortKey;
  ascending: boolean;
}

export function isFolderLike(entry: FileEntry): boolean {
  return entry.type === 'directory' || (entry.type === 'symlink' && entry.linkTarget === 'directory');
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** Filters by name and sorts; folders always come first, as in every file manager. */
export function visibleEntries(entries: FileEntry[], filter: string, showHidden: boolean, sort: SortOrder): FileEntry[] {
  const needle = filter.trim().toLowerCase();
  const direction = sort.ascending ? 1 : -1;
  const compareName = (a: FileEntry, b: FileEntry): number =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return entries
    .filter((entry) => (showHidden || !entry.hidden) && (!needle || entry.name.toLowerCase().includes(needle)))
    .sort((a, b) => {
      const folders = Number(isFolderLike(b)) - Number(isFolderLike(a));
      if (folders !== 0) return folders;
      let order = 0;
      if (sort.key === 'size') order = a.size - b.size;
      else if (sort.key === 'modifiedAt') order = a.modifiedAt - b.modifiedAt;
      else if (sort.key === 'type') order = extensionOf(a.name).localeCompare(extensionOf(b.name));
      return (order || compareName(a, b)) * direction;
    });
}

export interface Crumb {
  label: string;
  path: string;
}

/** Splits an absolute POSIX or Windows path into clickable parts. */
export function breadcrumbs(path: string): Crumb[] {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  const separator = windows ? '\\' : '/';
  const parts = path.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  const crumbs: Crumb[] = windows ? [] : [{ label: '/', path: '/' }];
  let current = '';
  parts.forEach((part, index) => {
    if (windows) {
      current = index === 0 ? (path.startsWith('\\\\') ? `\\\\${part}` : `${part}${separator}`) : `${current.replace(/\\$/, '')}${separator}${part}`;
    } else {
      current = `${current}/${part}`;
    }
    crumbs.push({ label: part, path: current });
  });
  return crumbs;
}

/** A range selection needs the order on screen, not the order of clicks. */
export function selectRange(ordered: string[], anchor: string | null, target: string): string[] {
  const from = anchor ? ordered.indexOf(anchor) : -1;
  const to = ordered.indexOf(target);
  if (from < 0 || to < 0) return [target];
  return ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
}
