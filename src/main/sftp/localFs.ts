import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DirectoryListing, FileEntry } from '@shared/contracts';

export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileAccessError';
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A single path segment that is safe to create below a chosen folder. Remote servers are not trusted
 * to name their files harmlessly: a name like `..\..\evil` must not walk out of the download folder.
 */
export function isSafeFileName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (platform === 'win32') {
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED.test(name)) return false;
  }
  return true;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The local files the renderer may reach: the home folder and folders the user granted through a
 * native dialog. Symlinks are resolved first, so that one cannot lead out of the granted folders.
 */
export class LocalFsScope {
  private readonly roots = new Set<string>();

  constructor(roots: string[] = [homedir()]) {
    for (const root of roots) this.roots.add(resolve(root));
  }

  get home(): string {
    return [...this.roots][0] as string;
  }

  grant(path: string): void {
    this.roots.add(resolve(path));
  }

  /** Which of the given paths would need a new grant. */
  async outsideScope(paths: string[]): Promise<string[]> {
    const outside: string[] = [];
    for (const path of paths) {
      const real = isAbsolute(path) ? await realpath(path).catch(() => null) : null;
      if (real && !(await this.isAllowed(real))) outside.push(real);
    }
    return outside;
  }

  private async isAllowed(path: string): Promise<boolean> {
    for (const root of this.roots) {
      const realRoot = await realpath(root).catch(() => root);
      if (isInside(realRoot, path)) return true;
    }
    return false;
  }

  /** Resolves an existing path, refusing anything outside of the granted folders. */
  async existing(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new FileAccessError('Es sind nur absolute Pfade erlaubt.');
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new FileAccessError(`„${path}“ wurde nicht gefunden.`);
    }
    if (!(await this.isAllowed(real))) {
      throw new FileAccessError(`„${path}“ liegt außerhalb der freigegebenen Ordner.`);
    }
    return real;
  }

  /** For something about to be created: its existing parent has to be inside. */
  async creatable(parent: string, name: string): Promise<string> {
    if (!isSafeFileName(name)) throw new FileAccessError(`„${name}“ ist kein zulässiger Dateiname.`);
    return join(await this.existing(parent), name);
  }

  async list(path: string | null): Promise<DirectoryListing> {
    const directory = await this.existing(path ?? this.home);
    const names = await readdir(directory);
    const entries: FileEntry[] = [];
    for (const name of names) {
      const full = join(directory, name);
      try {
        entries.push(await describeLocal(full, name));
      } catch {
        // Vanished while listing, or a system file that refuses to be examined.
      }
    }
    const parent = dirname(directory);
    const canGoUp = parent !== directory && (await this.isAllowed(parent));
    return { path: directory, parent: canGoUp ? parent : null, entries };
  }

  async mkdir(parent: string, name: string): Promise<void> {
    const target = await this.creatable(parent, name);
    await mkdir(target);
  }

  async rename(path: string, name: string): Promise<void> {
    const source = await this.existing(path);
    const target = await this.creatable(dirname(source), name);
    if (await exists(target)) throw new FileAccessError(`„${name}“ existiert bereits.`);
    await rename(source, target);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    // lstat on the given path: deleting a symlink removes the link, never where it points to.
    const parent = await this.existing(dirname(path));
    const target = join(parent, basename(path));
    const info = await lstat(target);
    if (this.isRoot(target)) throw new FileAccessError('Ein freigegebener Stammordner kann nicht gelöscht werden.');
    await rm(target, { recursive: recursive && info.isDirectory(), force: false });
  }

  private isRoot(path: string): boolean {
    return [...this.roots].some((root) => resolve(root) === resolve(path));
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

async function describeLocal(path: string, name: string): Promise<FileEntry> {
  const info = await lstat(path);
  let linkTarget: FileEntry['linkTarget'] = null;
  if (info.isSymbolicLink()) {
    linkTarget = await stat(path).then(
      (target) => (target.isDirectory() ? 'directory' : 'file'),
      () => 'broken'
    );
  }
  return {
    name,
    path,
    type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    linkTarget,
    size: info.size,
    modifiedAt: info.mtimeMs,
    mode: process.platform === 'win32' ? null : info.mode & 0o7777,
    hidden: name.startsWith('.')
  };
}
