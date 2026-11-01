import { posix } from 'node:path';
import type { FileEntry as SshFileEntry, SFTPWrapper, Stats } from 'ssh2';
import type { DirectoryListing, FileEntry, SftpSessionInfo } from '@shared/contracts';
import { SessionAccessError } from '../sessions/sessionManager';
import type { Prompter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';
import type { ConnectionLease } from '../ssh/connectionPool';
import { FileAccessError, isSafeFileName } from './localFs';

const SYMLINK_STAT_CONCURRENCY = 8;

export interface SftpEventSink {
  sftpClosed(event: { sftpId: string; message: string }): void;
}

export interface SftpManagerDeps {
  acquire(ownerId: number, hostId: string, prompt: Prompter): Promise<ConnectionLease>;
  defaultDirOf(hostId: string): string;
  createPrompter(ownerId: number, contextId: string): Prompter;
  cancelPrompts(contextId: string): void;
  sink: SftpEventSink;
}

export interface OpenSftp {
  id: string;
  ownerId: number;
  hostId: string;
  sftp: SFTPWrapper;
  lease: ConnectionLease;
}

/** The same check the remote side gets for names typed into RYFT: a name, not a path. */
function assertRemoteName(name: string): void {
  if (!isSafeFileName(name, 'linux')) throw new FileAccessError(`„${name}“ ist kein zulässiger Dateiname.`);
}

export function promisify<T>(call: (done: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    call((error, value) => (error ? reject(error) : resolve(value)));
  });
}

export function translateSftpError(error: unknown, path?: string): Error {
  const code = (error as { code?: number | string }).code;
  const subject = path ? `„${path}“` : 'Das Ziel';
  if (error instanceof FileAccessError || error instanceof SessionFailure) return error;
  switch (code) {
    case 2:
    case 'ENOENT':
      return new FileAccessError(`${subject} wurde nicht gefunden.`);
    case 3:
    case 'EACCES':
    case 'EPERM':
      return new FileAccessError(`Keine Berechtigung für ${subject}.`);
    case 'ENOSPC':
      return new FileAccessError('Auf dem Zieldatenträger ist kein Platz mehr.');
    case 'EEXIST':
      return new FileAccessError(`${subject} existiert bereits.`);
    default:
      return new FileAccessError(`Dateioperation fehlgeschlagen: ${(error as Error).message}`);
  }
}

export function entryFromStats(path: string, name: string, attrs: Stats): FileEntry {
  return {
    name,
    path,
    type: attrs.isSymbolicLink()
      ? 'symlink'
      : attrs.isDirectory()
        ? 'directory'
        : attrs.isFile()
          ? 'file'
          : 'other',
    linkTarget: null,
    size: attrs.size,
    modifiedAt: attrs.mtime * 1000,
    mode: attrs.mode & 0o7777,
    hidden: name.startsWith('.')
  };
}

/** SFTP panes, one per window and server connection, sharing that connection with tunnels. */
export class SftpManager {
  private readonly open_ = new Map<string, OpenSftp>();
  private readonly closedListeners = new Set<(sftpId: string) => void>();

  constructor(private readonly deps: SftpManagerDeps) {}

  onClosed(listener: (sftpId: string) => void): void {
    this.closedListeners.add(listener);
  }

  async open(ownerId: number, sftpId: string, hostId: string): Promise<SftpSessionInfo> {
    const existing = this.open_.get(sftpId);
    if (existing) {
      if (existing.ownerId !== ownerId) throw new SessionAccessError();
      this.forget(existing);
    }
    const lease = await this.deps.acquire(ownerId, hostId, this.deps.createPrompter(ownerId, sftpId));
    let sftp: SFTPWrapper;
    try {
      sftp = await promisify<SFTPWrapper>((done) => lease.client.sftp(done));
    } catch (error) {
      lease.release();
      throw new FileAccessError(`Der Server bietet kein SFTP an: ${(error as Error).message}`);
    }
    const session: OpenSftp = { id: sftpId, ownerId, hostId, sftp, lease };
    this.open_.set(sftpId, session);
    lease.onLost((failure) => {
      if (this.open_.get(sftpId) !== session) return;
      this.forget(session);
      this.deps.sink.sftpClosed({ sftpId, message: failure.message });
    });
    const home = await promisify<string>((done) => sftp.realpath('.', done));
    const configured = this.deps.defaultDirOf(hostId);
    let startPath = home;
    if (configured) {
      // A configured folder that is gone must not stop the pane from opening.
      startPath = await promisify<string>((done) => sftp.realpath(configured, done)).catch(() => home);
    }
    return { sftpId, hostId, home, startPath };
  }

  close(ownerId: number, sftpId: string): void {
    this.deps.cancelPrompts(sftpId);
    const session = this.open_.get(sftpId);
    if (!session) return;
    if (session.ownerId !== ownerId) throw new SessionAccessError();
    this.forget(session);
  }

  disposeOwner(ownerId: number): void {
    for (const session of [...this.open_.values()]) {
      if (session.ownerId === ownerId) this.forget(session);
    }
  }

  disposeAll(): void {
    for (const session of [...this.open_.values()]) this.forget(session);
  }

  session(ownerId: number, sftpId: string): OpenSftp {
    const session = this.open_.get(sftpId);
    if (!session || session.ownerId !== ownerId) throw new SessionAccessError();
    return session;
  }

  async list(ownerId: number, sftpId: string, path: string): Promise<DirectoryListing> {
    const { sftp } = this.session(ownerId, sftpId);
    try {
      const directory = await promisify<string>((done) => sftp.realpath(path, done));
      const raw = await promisify<SshFileEntry[]>((done) => sftp.readdir(directory, done));
      const entries = raw.map((item) =>
        entryFromStats(posix.join(directory, item.filename), item.filename, item.attrs as Stats)
      );
      await this.resolveSymlinks(sftp, entries);
      const parent = posix.dirname(directory);
      return { path: directory, parent: parent === directory ? null : parent, entries };
    } catch (error) {
      throw translateSftpError(error, path);
    }
  }

  private async resolveSymlinks(sftp: SFTPWrapper, entries: FileEntry[]): Promise<void> {
    const links = entries.filter((entry) => entry.type === 'symlink');
    for (let index = 0; index < links.length; index += SYMLINK_STAT_CONCURRENCY) {
      await Promise.all(
        links.slice(index, index + SYMLINK_STAT_CONCURRENCY).map(async (entry) => {
          entry.linkTarget = await promisify<Stats>((done) => sftp.stat(entry.path, done)).then(
            (target) => (target.isDirectory() ? 'directory' : 'file'),
            () => 'broken'
          );
        })
      );
    }
  }

  async mkdir(ownerId: number, sftpId: string, parent: string, name: string): Promise<void> {
    assertRemoteName(name);
    const { sftp } = this.session(ownerId, sftpId);
    const path = posix.join(parent, name);
    await promisify<void>((done) => sftp.mkdir(path, done)).catch((error: unknown) => {
      throw translateSftpError(error, path);
    });
  }

  async rename(ownerId: number, sftpId: string, path: string, name: string): Promise<void> {
    assertRemoteName(name);
    const { sftp } = this.session(ownerId, sftpId);
    const target = posix.join(posix.dirname(path), name);
    const taken = await promisify<Stats>((done) => sftp.lstat(target, done)).then(
      () => true,
      () => false
    );
    if (taken) throw new FileAccessError(`„${name}“ existiert bereits.`);
    await promisify<void>((done) => sftp.rename(path, target, done)).catch((error: unknown) => {
      throw translateSftpError(error, path);
    });
  }

  async remove(ownerId: number, sftpId: string, path: string, recursive: boolean): Promise<void> {
    const { sftp } = this.session(ownerId, sftpId);
    if (posix.normalize(path) === '/') throw new FileAccessError('Das Wurzelverzeichnis kann nicht gelöscht werden.');
    try {
      await removeRemote(sftp, path, recursive);
    } catch (error) {
      throw translateSftpError(error, path);
    }
  }

  async chmod(ownerId: number, sftpId: string, path: string, mode: number): Promise<void> {
    const { sftp } = this.session(ownerId, sftpId);
    await promisify<void>((done) => sftp.chmod(path, mode, done)).catch((error: unknown) => {
      throw translateSftpError(error, path);
    });
  }

  private forget(session: OpenSftp): void {
    this.open_.delete(session.id);
    for (const listener of this.closedListeners) listener(session.id);
    try {
      session.sftp.end();
    } catch {
      // The channel can already be gone with the connection.
    }
    session.lease.release();
  }
}

/** Never follows symlinks: removing a link must not touch where it points to. */
async function removeRemote(sftp: SFTPWrapper, path: string, recursive: boolean): Promise<void> {
  const info = await promisify<Stats>((done) => sftp.lstat(path, done));
  if (!info.isDirectory()) {
    await promisify<void>((done) => sftp.unlink(path, done));
    return;
  }
  if (recursive) {
    const children = await promisify<SshFileEntry[]>((done) => sftp.readdir(path, done));
    for (const child of children) {
      // A hostile server could answer with a name that climbs upwards.
      if (!isSafeFileName(child.filename, 'linux')) continue;
      await removeRemote(sftp, posix.join(path, child.filename), true);
    }
  }
  await promisify<void>((done) => sftp.rmdir(path, done));
}
