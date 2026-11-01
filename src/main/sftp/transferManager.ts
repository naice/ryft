import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileEntry as SshFileEntry, SFTPWrapper, Stats } from 'ssh2';
import type { ConflictAction, ConflictPolicy, TransferDirection, TransferJob } from '@shared/contracts';
import { FileAccessError, isInside, isSafeFileName, type LocalFsScope } from './localFs';
import { promisify, translateSftpError, type OpenSftp } from './sftpManager';

const DEFAULT_CONCURRENCY = 3;
const MAX_JOBS_PER_BATCH = 50_000;
const MAX_RETAINED_FINISHED = 500;
const UPDATE_INTERVAL_MS = 100;
const STREAM_HIGH_WATER = 64 * 1024;

export interface TransferEventSink {
  transferUpdate(jobs: TransferJob[]): void;
  transferRemoved(ids: string[]): void;
}

export interface TransferManagerDeps {
  session(ownerId: number, sftpId: string): OpenSftp;
  scope: LocalFsScope;
  sink: TransferEventSink;
  concurrency?: number;
}

interface InternalJob {
  job: TransferJob;
  ownerId: number;
  /** Paths mean something on this host only, whichever session carries the job. */
  hostId: string;
  mode: number | null;
  policy: ConflictPolicy;
  abort: AbortController | null;
  /** A lost connection also aborts the stream, but must not read as "cancelled by the user". */
  sessionLost: boolean;
  /** Set on the placeholder of a batch while its sources are scanned: a retry scans again. */
  scan: ScanInput | null;
  sampleBytes: number;
  sampleAt: number;
}

interface ScanInput {
  sftpId: string;
  direction: TransferDirection;
  sources: string[];
  destinationDir: string;
  conflictPolicy: ConflictPolicy;
}

interface Batch {
  id: string;
  ownerId: number;
  hostId: string;
  /** Set when "apply to all" was chosen for the conflicts of this batch. */
  policy: ConflictPolicy;
  scanAbort: AbortController;
  createdDirs: Set<string>;
}

interface PlannedFile {
  source: string;
  destination: string;
  name: string;
  size: number;
  mode: number | null;
}

interface StatInfo {
  size: number;
  modifiedAt: number;
}

const FINISHED: ReadonlySet<TransferJob['state']> = new Set(['done', 'failed', 'cancelled', 'skipped']);

/**
 * The transfer queue. Files stream through bounded buffers, at most `concurrency` at a time, and land
 * under a temporary name first: an interrupted transfer never leaves a truncated file under the real
 * name and never damages the file it was going to replace.
 */
export class TransferManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly batches = new Map<string, Batch>();
  private readonly dirty = new Set<string>();
  private readonly concurrency: number;
  private running = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: TransferManagerDeps) {
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  }

  list(ownerId: number): TransferJob[] {
    return [...this.jobs.values()].filter((item) => item.ownerId === ownerId).map((item) => item.job);
  }

  /** Scans in the background and returns right away, so that a huge folder does not block the caller. */
  enqueue(ownerId: number, input: ScanInput): string {
    // Fails right here when the session does not belong to the caller.
    const { hostId } = this.deps.session(ownerId, input.sftpId);
    const batch: Batch = {
      id: randomUUID(),
      ownerId,
      hostId,
      policy: input.conflictPolicy,
      scanAbort: new AbortController(),
      createdDirs: new Set()
    };
    this.batches.set(batch.id, batch);
    void this.scan(batch, input);
    return batch.id;
  }

  private async scan(batch: Batch, input: ScanInput): Promise<void> {
    const marker = this.addJob(batch, input.sftpId, input.direction, {
      source: input.sources[0] as string,
      destination: input.destinationDir,
      name: input.sources.length === 1 ? baseOf(input.direction, input.sources[0] as string) : `${input.sources.length} Elemente`,
      size: 0,
      mode: null
    });
    marker.scan = input;
    this.setState(marker, 'scanning');
    try {
      const { sftp } = this.deps.session(batch.ownerId, input.sftpId);
      const destination =
        input.direction === 'upload' ? input.destinationDir : await this.deps.scope.existing(input.destinationDir);
      const files: PlannedFile[] = [];
      for (const source of input.sources) {
        if (input.direction === 'upload') await this.planUpload(batch, sftp, source, destination, files, true);
        else await this.planDownload(batch, sftp, source, destination, destination, files, true);
      }
      this.jobs.delete(marker.job.id);
      this.dirty.delete(marker.job.id);
      this.deps.sink.transferRemoved([marker.job.id]);
      if (batch.scanAbort.signal.aborted) return;
      for (const file of files) this.addJob(batch, input.sftpId, input.direction, file);
      this.scheduleFlush();
      this.pump();
    } catch (error) {
      if (batch.scanAbort.signal.aborted) {
        this.finish(marker, 'cancelled', null);
      } else {
        this.finish(marker, 'failed', translateSftpError(error).message);
      }
    }
  }

  private guardScan(batch: Batch, files: PlannedFile[]): void {
    if (batch.scanAbort.signal.aborted) throw new FileAccessError('Abgebrochen.');
    if (files.length >= MAX_JOBS_PER_BATCH) {
      throw new FileAccessError(`Mehr als ${MAX_JOBS_PER_BATCH} Dateien auf einmal werden nicht unterstützt.`);
    }
  }

  private async planUpload(
    batch: Batch,
    sftp: SFTPWrapper,
    source: string,
    remoteDir: string,
    files: PlannedFile[],
    topLevel: boolean
  ): Promise<void> {
    this.guardScan(batch, files);
    const local = topLevel ? await this.deps.scope.existing(source) : source;
    const info = await lstat(local);
    // Only what the user picked directly is followed: a link deep inside a tree could lead anywhere.
    if (info.isSymbolicLink() && !topLevel) return;
    const resolved = info.isSymbolicLink() ? await stat(local) : info;
    const name = basename(topLevel ? source : local);
    if (resolved.isDirectory()) {
      const target = posix.join(remoteDir, name);
      await this.ensureRemoteDir(batch, sftp, target);
      for (const child of await readdir(local)) {
        await this.planUpload(batch, sftp, join(local, child), target, files, false);
      }
      return;
    }
    if (!resolved.isFile()) return;
    files.push({
      source: local,
      destination: posix.join(remoteDir, name),
      name,
      size: resolved.size,
      // Windows has no meaningful permission bits to carry over.
      mode: process.platform === 'win32' ? null : resolved.mode & 0o777
    });
  }

  private async planDownload(
    batch: Batch,
    sftp: SFTPWrapper,
    source: string,
    localRoot: string,
    localDir: string,
    files: PlannedFile[],
    topLevel: boolean
  ): Promise<void> {
    this.guardScan(batch, files);
    const name = posix.basename(source);
    // Names come from the server: this is what stops `..\..\evil` from leaving the chosen folder.
    if (!isSafeFileName(name)) return;
    const target = join(localDir, name);
    if (!isInside(localRoot, target)) return;
    const link = await promisify<Stats>((done) => sftp.lstat(source, done));
    if (link.isSymbolicLink() && !topLevel) return;
    const info = link.isSymbolicLink() ? await promisify<Stats>((done) => sftp.stat(source, done)) : link;
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      const children = await promisify<SshFileEntry[]>((done) => sftp.readdir(source, done));
      for (const child of children) {
        await this.planDownload(batch, sftp, posix.join(source, child.filename), localRoot, target, files, false);
      }
      return;
    }
    if (!info.isFile()) return;
    files.push({ source, destination: target, name, size: info.size, mode: info.mode & 0o777 });
  }

  private async ensureRemoteDir(batch: Batch, sftp: SFTPWrapper, path: string): Promise<void> {
    if (batch.createdDirs.has(path)) return;
    const existing = await promisify<Stats>((done) => sftp.stat(path, done)).catch(() => null);
    if (existing) {
      if (!existing.isDirectory()) throw new FileAccessError(`„${path}“ existiert und ist kein Ordner.`);
    } else {
      await promisify<void>((done) => sftp.mkdir(path, done));
    }
    batch.createdDirs.add(path);
  }

  private addJob(batch: Batch, sftpId: string, direction: TransferDirection, file: PlannedFile): InternalJob {
    const item: InternalJob = {
      ownerId: batch.ownerId,
      hostId: batch.hostId,
      mode: file.mode,
      policy: batch.policy,
      abort: null,
      sessionLost: false,
      scan: null,
      sampleBytes: 0,
      sampleAt: 0,
      job: {
        id: randomUUID(),
        batchId: batch.id,
        sftpId,
        direction,
        source: file.source,
        destination: file.destination,
        name: file.name,
        size: file.size,
        transferred: 0,
        bytesPerSecond: 0,
        state: 'queued',
        error: null,
        conflict: null
      }
    };
    this.jobs.set(item.job.id, item);
    this.markDirty(item);
    this.pruneFinished();
    return item;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = [...this.jobs.values()].find((item) => item.job.state === 'queued');
      if (!next) return;
      this.running += 1;
      this.setState(next, 'running');
      void this.run(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(item: InternalJob): Promise<void> {
    const { job } = item;
    const abort = new AbortController();
    item.abort = abort;
    item.sampleBytes = 0;
    item.sampleAt = Date.now();
    job.transferred = 0;
    let tempPath: string | null = null;
    item.sessionLost = false;
    let session: OpenSftp;
    try {
      session = this.deps.session(item.ownerId, job.sftpId);
    } catch {
      this.finish(item, 'failed', 'Die SFTP-Sitzung ist nicht mehr offen.');
      return;
    }
    const { sftp } = session;
    try {
      const existing = await this.statDestination(sftp, job);
      if (existing) {
        const policy = this.batches.get(job.batchId)?.policy ?? item.policy;
        const decision = policy === 'ask' ? item.policy : policy;
        if (decision === 'ask') {
          job.conflict = existing;
          // Waiting for the user must not hold a slot of the queue.
          this.setState(item, 'conflict');
          return;
        }
        if (decision === 'skip') {
          this.finish(item, 'skipped', null);
          return;
        }
        if (decision === 'rename') job.destination = await this.freeName(sftp, job);
      }
      tempPath = temporaryPath(job);
      const counter = new Transform({
        highWaterMark: STREAM_HIGH_WATER,
        transform: (chunk: Buffer, _encoding, callback) => {
          job.transferred += chunk.length;
          this.sampleSpeed(item);
          this.markDirty(item);
          callback(null, chunk);
        }
      });
      const { read, write } = this.openStreams(sftp, job, tempPath);
      await pipeline(read, counter, write, { signal: abort.signal });
      await this.commit(sftp, item, tempPath);
      tempPath = null;
      this.finish(item, 'done', null);
    } catch (error) {
      if (tempPath) await this.removeTemp(sftp, job.direction, tempPath);
      if (item.sessionLost) this.finish(item, 'failed', 'Die SFTP-Verbindung wurde getrennt.');
      else if (abort.signal.aborted) this.finish(item, 'cancelled', null);
      else this.finish(item, 'failed', translateSftpError(error, job.name).message);
    } finally {
      item.abort = null;
    }
  }

  private async statDestination(sftp: SFTPWrapper, job: TransferJob): Promise<StatInfo | null> {
    if (job.direction === 'upload') {
      const info = await promisify<Stats>((done) => sftp.lstat(job.destination, done)).catch(() => null);
      return info ? { size: info.size, modifiedAt: info.mtime * 1000 } : null;
    }
    const info = await lstat(job.destination).catch(() => null);
    return info ? { size: info.size, modifiedAt: info.mtimeMs } : null;
  }

  private openStreams(sftp: SFTPWrapper, job: TransferJob, tempPath: string): { read: Readable; write: Writable } {
    if (job.direction === 'upload') {
      return {
        read: createReadStream(job.source, { highWaterMark: STREAM_HIGH_WATER }),
        write: sftp.createWriteStream(tempPath, { flags: 'wx' })
      };
    }
    return {
      read: sftp.createReadStream(job.source),
      write: createWriteStream(tempPath, { flags: 'wx', mode: 0o600, highWaterMark: STREAM_HIGH_WATER })
    };
  }

  /** Atomic where the server allows it; only a server without POSIX rename gets the unlink fallback. */
  private async commit(sftp: SFTPWrapper, item: InternalJob, tempPath: string): Promise<void> {
    const { job, mode } = item;
    if (job.direction === 'download') {
      if (mode !== null && process.platform !== 'win32') await chmod(tempPath, mode);
      await rename(tempPath, job.destination);
      return;
    }
    if (mode !== null) await promisify<void>((done) => sftp.chmod(tempPath, mode, done)).catch(() => undefined);
    try {
      await promisify<void>((done) => sftp.ext_openssh_rename(tempPath, job.destination, done));
    } catch {
      await promisify<void>((done) => sftp.unlink(job.destination, done)).catch(() => undefined);
      await promisify<void>((done) => sftp.rename(tempPath, job.destination, done));
    }
  }

  private async removeTemp(sftp: SFTPWrapper, direction: TransferDirection, tempPath: string): Promise<void> {
    if (direction === 'download') {
      await unlink(tempPath).catch(() => undefined);
      return;
    }
    // With a lost connection this cannot work; the leftover `.ryftpart` is documented.
    await promisify<void>((done) => sftp.unlink(tempPath, done)).catch(() => undefined);
  }

  private async freeName(sftp: SFTPWrapper, job: TransferJob): Promise<string> {
    const pathApi = job.direction === 'upload' ? posix : { dirname: localDirname, join };
    const directory = pathApi.dirname(job.destination);
    const dot = job.name.lastIndexOf('.');
    const stem = dot > 0 ? job.name.slice(0, dot) : job.name;
    const extension = dot > 0 ? job.name.slice(dot) : '';
    for (let index = 1; index < 1000; index += 1) {
      const candidate = pathApi.join(directory, `${stem} (${index})${extension}`);
      if (!(await this.statDestination(sftp, { ...job, destination: candidate }))) return candidate;
    }
    throw new FileAccessError(`Für „${job.name}“ wurde kein freier Name gefunden.`);
  }

  cancel(ownerId: number, target: { jobId: string | null; batchId: string | null }): void {
    if (target.batchId) {
      const batch = this.batches.get(target.batchId);
      if (batch?.ownerId === ownerId) batch.scanAbort.abort();
    }
    for (const item of this.jobs.values()) {
      if (item.ownerId !== ownerId) continue;
      if (item.job.id !== target.jobId && item.job.batchId !== target.batchId) continue;
      this.cancelItem(item);
    }
    this.pump();
  }

  private cancelItem(item: InternalJob): void {
    const { state } = item.job;
    if (state === 'scanning') this.batches.get(item.job.batchId)?.scanAbort.abort();
    else if (state === 'running' && item.abort) item.abort.abort();
    else if (state === 'queued' || state === 'conflict') this.finish(item, 'cancelled', null);
  }

  /** With `sftpId`, the job moves to that session: the one it started on may have been lost by now. */
  retry(ownerId: number, jobId: string, sftpId?: string): void {
    const item = this.jobs.get(jobId);
    if (!item || item.ownerId !== ownerId) return;
    if (item.job.state !== 'failed' && item.job.state !== 'cancelled') return;
    if (sftpId) {
      if (this.deps.session(ownerId, sftpId).hostId !== item.hostId) {
        throw new FileAccessError('Diese Übertragung gehört zu einem anderen Host. Verbinde dich mit ihm, um sie zu wiederholen.');
      }
      item.job.sftpId = sftpId;
    }
    if (item.scan) {
      const input = { ...item.scan, sftpId: item.job.sftpId };
      // Throws if the session is gone, in which case the failed entry stays visible.
      this.deps.session(ownerId, input.sftpId);
      this.jobs.delete(jobId);
      this.dirty.delete(jobId);
      this.deps.sink.transferRemoved([jobId]);
      this.enqueue(ownerId, input);
      return;
    }
    item.sessionLost = false;
    item.job.error = null;
    item.job.transferred = 0;
    this.setState(item, 'queued');
    this.pump();
  }

  resolveConflict(ownerId: number, input: { jobId: string; action: ConflictAction; applyToBatch: boolean }): void {
    const item = this.jobs.get(input.jobId);
    if (!item || item.ownerId !== ownerId || item.job.state !== 'conflict') return;
    if (input.applyToBatch) {
      const batch = this.batches.get(item.job.batchId);
      if (batch) batch.policy = input.action;
      for (const other of this.jobs.values()) {
        if (other.job.batchId === item.job.batchId && other.job.state === 'conflict') {
          other.job.conflict = null;
          other.policy = input.action;
          this.setState(other, 'queued');
        }
      }
    } else {
      item.policy = input.action;
      item.job.conflict = null;
      this.setState(item, 'queued');
    }
    this.pump();
  }

  clearFinished(ownerId: number): void {
    const removed: string[] = [];
    for (const [id, item] of this.jobs) {
      if (item.ownerId === ownerId && FINISHED.has(item.job.state)) {
        this.jobs.delete(id);
        this.dirty.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) this.deps.sink.transferRemoved(removed);
    const inUse = new Set([...this.jobs.values()].map((item) => item.job.batchId));
    for (const [id, batch] of [...this.batches]) {
      if (batch.ownerId === ownerId && !inUse.has(id)) this.batches.delete(id);
    }
  }

  /** Queued work of a session that went away fails visibly and can be retried once it is open again. */
  handleSessionClosed(sftpId: string): void {
    for (const item of this.jobs.values()) {
      if (item.job.sftpId !== sftpId) continue;
      if (item.job.state === 'running') {
        item.sessionLost = true;
        item.abort?.abort();
      } else if (item.job.state === 'queued' || item.job.state === 'conflict') {
        this.finish(item, 'failed', 'Die SFTP-Verbindung wurde getrennt.');
      }
    }
  }

  disposeOwner(ownerId: number): void {
    for (const batch of this.batches.values()) {
      if (batch.ownerId === ownerId) batch.scanAbort.abort();
    }
    for (const [id, item] of [...this.jobs]) {
      if (item.ownerId !== ownerId) continue;
      item.abort?.abort();
      this.jobs.delete(id);
      this.dirty.delete(id);
    }
    for (const [id, batch] of [...this.batches]) {
      if (batch.ownerId === ownerId) this.batches.delete(id);
    }
  }

  disposeAll(): void {
    for (const ownerId of new Set([...this.jobs.values()].map((item) => item.ownerId))) this.disposeOwner(ownerId);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private sampleSpeed(item: InternalJob): void {
    const now = Date.now();
    const elapsed = now - item.sampleAt;
    if (elapsed < 500) return;
    item.job.bytesPerSecond = Math.round(((item.job.transferred - item.sampleBytes) * 1000) / elapsed);
    item.sampleBytes = item.job.transferred;
    item.sampleAt = now;
  }

  private setState(item: InternalJob, state: TransferJob['state']): void {
    item.job.state = state;
    this.markDirty(item);
  }

  private finish(item: InternalJob, state: TransferJob['state'], error: string | null): void {
    item.job.error = error;
    item.job.bytesPerSecond = 0;
    item.job.conflict = null;
    this.setState(item, state);
    this.pump();
  }

  private markDirty(item: InternalJob): void {
    this.dirty.add(item.job.id);
    this.scheduleFlush();
  }

  /** Progress is coalesced: a fast transfer must not flood the renderer with one event per chunk. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const updates: TransferJob[] = [];
      for (const id of this.dirty) {
        const item = this.jobs.get(id);
        if (item) updates.push({ ...item.job });
      }
      this.dirty.clear();
      if (updates.length > 0) this.deps.sink.transferUpdate(updates);
    }, UPDATE_INTERVAL_MS);
  }

  private pruneFinished(): void {
    const finished = [...this.jobs.values()].filter((item) => FINISHED.has(item.job.state));
    const excess = finished.length - MAX_RETAINED_FINISHED;
    if (excess <= 0) return;
    const removed = finished.slice(0, excess).map((item) => item.job.id);
    for (const id of removed) {
      this.jobs.delete(id);
      this.dirty.delete(id);
    }
    this.deps.sink.transferRemoved(removed);
  }
}

function baseOf(direction: TransferDirection, path: string): string {
  return direction === 'upload' ? basename(path) : posix.basename(path);
}

function localDirname(path: string): string {
  return join(path, '..');
}

function temporaryPath(job: TransferJob): string {
  const name = `.${job.name}.${job.id.slice(0, 8)}.ryftpart`;
  if (job.direction === 'upload') return posix.join(posix.dirname(job.destination), name);
  return join(localDirname(job.destination), name);
}
