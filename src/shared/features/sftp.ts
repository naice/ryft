import { z } from 'zod';

export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  /** Where a symlink leads, when that could be determined. */
  linkTarget: 'file' | 'directory' | 'broken' | null;
  size: number;
  /** Milliseconds since the epoch. */
  modifiedAt: number;
  /** POSIX permission bits, null where the platform has none. */
  mode: number | null;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface SftpSessionInfo {
  sftpId: string;
  hostId: string;
  home: string;
  startPath: string;
}

export type TransferDirection = 'upload' | 'download';
export type TransferState = 'scanning' | 'queued' | 'running' | 'conflict' | 'done' | 'failed' | 'cancelled' | 'skipped';
export type ConflictAction = 'overwrite' | 'skip' | 'rename';
export type ConflictPolicy = ConflictAction | 'ask';

export interface TransferJob {
  id: string;
  batchId: string;
  sftpId: string;
  direction: TransferDirection;
  source: string;
  destination: string;
  name: string;
  size: number;
  transferred: number;
  bytesPerSecond: number;
  state: TransferState;
  error: string | null;
  /** What exists at the destination while in the conflict state. */
  conflict: { size: number; modifiedAt: number } | null;
}

const path = z.string().min(1).max(8192);
const fileName = z.string().min(1).max(1024);

export const sftpSchemas = {
  open: z.strictObject({ sftpId: z.uuid(), hostId: z.uuid() }),
  close: z.strictObject({ sftpId: z.uuid() }),
  list: z.strictObject({ sftpId: z.uuid(), path }),
  mkdir: z.strictObject({ sftpId: z.uuid(), parent: path, name: fileName }),
  rename: z.strictObject({ sftpId: z.uuid(), path, name: fileName }),
  remove: z.strictObject({ sftpId: z.uuid(), path, recursive: z.boolean() }),
  chmod: z.strictObject({ sftpId: z.uuid(), path, mode: z.number().int().min(0).max(0o7777) }),
  localList: z.strictObject({ path: path.nullable() }),
  localMkdir: z.strictObject({ parent: path, name: fileName }),
  localRename: z.strictObject({ path, name: fileName }),
  localRemove: z.strictObject({ path, recursive: z.boolean() }),
  grantDropped: z.strictObject({ paths: z.array(path).min(1).max(1000) }),
  enqueue: z.strictObject({
    sftpId: z.uuid(),
    direction: z.enum(['upload', 'download']),
    sources: z.array(path).min(1).max(1000),
    destinationDir: path,
    conflictPolicy: z.enum(['ask', 'overwrite', 'skip', 'rename'])
  }),
  cancel: z.strictObject({ jobId: z.uuid().nullable(), batchId: z.uuid().nullable() }),
  retry: z.strictObject({ jobId: z.uuid(), sftpId: z.uuid().optional() }),
  resolveConflict: z.strictObject({
    jobId: z.uuid(),
    action: z.enum(['overwrite', 'skip', 'rename']),
    applyToBatch: z.boolean()
  })
};

export type ResolveConflictInput = z.infer<typeof sftpSchemas.resolveConflict>;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Renders permission bits like `rwxr-xr-x`. */
export function formatMode(mode: number | null): string {
  if (mode === null) return '–';
  const part = (bits: number): string => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  return part((mode >> 6) & 7) + part((mode >> 3) & 7) + part(mode & 7);
}
