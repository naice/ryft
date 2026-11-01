import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync, chmodSync, type Stats } from 'node:fs';
import { join, posix } from 'node:path';
import { utils, type Attributes, type SFTPWrapper } from 'ssh2';

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

function toAttrs(info: Stats): Attributes {
  return {
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    atime: Math.floor(info.atimeMs / 1000),
    mtime: Math.floor(info.mtimeMs / 1000)
  };
}

function statusOf(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

/**
 * A small file server for the in-process fixture, backed by a temporary folder. Remote paths never leave
 * that folder. It behaves like a server without OpenSSH extensions, which also covers the fallback paths.
 */
export function serveSftp(sftp: SFTPWrapper, root: string, hooks: { readDelayMs?: () => number } = {}): void {
  const handles = new Map<string, { fd?: number; dir?: string; names?: string[] }>();
  let nextHandle = 0;
  const real = (remote: string): string => join(root, posix.normalize(`/${remote}`));
  const newHandle = (entry: { fd?: number; dir?: string; names?: string[] }): Buffer => {
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE((nextHandle += 1));
    handles.set(handle.toString('hex'), entry);
    return handle;
  };
  const guarded = (reqId: number, action: () => void): void => {
    try {
      action();
    } catch (error) {
      sftp.status(reqId, statusOf(error));
    }
  };

  sftp.on('REALPATH', (reqId, path) => {
    const resolved = posix.normalize(posix.isAbsolute(path) ? path : `/${path}`);
    sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }]);
  });
  sftp.on('OPEN', (reqId, path, flags) =>
    guarded(reqId, () => {
      const write = (flags & OPEN_MODE.WRITE) !== 0;
      let mode = 'r';
      if (write) {
        if (flags & OPEN_MODE.EXCL) mode = 'wx';
        else if (flags & OPEN_MODE.TRUNC) mode = 'w';
        else if (flags & OPEN_MODE.APPEND) mode = 'a';
        else mode = 'r+';
      }
      sftp.handle(reqId, newHandle({ fd: openSync(real(path), mode) }));
    })
  );
  sftp.on('READ', (reqId, handle, offset, length) =>
    guarded(reqId, () => {
      const entry = handles.get(handle.toString('hex'));
      if (entry?.fd === undefined) return void sftp.status(reqId, STATUS_CODE.FAILURE);
      const buffer = Buffer.alloc(length);
      const read = readSync(entry.fd, buffer, 0, length, offset);
      const reply = (): void => {
        if (read === 0) sftp.status(reqId, STATUS_CODE.EOF);
        else sftp.data(reqId, buffer.subarray(0, read));
      };
      const delay = hooks.readDelayMs?.() ?? 0;
      if (delay > 0) setTimeout(reply, delay);
      else reply();
    })
  );
  sftp.on('WRITE', (reqId, handle, offset, data) =>
    guarded(reqId, () => {
      const entry = handles.get(handle.toString('hex'));
      if (entry?.fd === undefined) return void sftp.status(reqId, STATUS_CODE.FAILURE);
      writeSync(entry.fd, data, 0, data.length, offset);
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
  sftp.on('CLOSE', (reqId, handle) =>
    guarded(reqId, () => {
      const key = handle.toString('hex');
      const entry = handles.get(key);
      if (entry?.fd !== undefined) closeSync(entry.fd);
      handles.delete(key);
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
  sftp.on('FSTAT', (reqId, handle) =>
    guarded(reqId, () => {
      const entry = handles.get(handle.toString('hex'));
      if (entry?.fd === undefined) return void sftp.status(reqId, STATUS_CODE.FAILURE);
      sftp.attrs(reqId, toAttrs(fstatSync(entry.fd)));
    })
  );
  sftp.on('FSETSTAT', (reqId) => sftp.status(reqId, STATUS_CODE.OK));
  sftp.on('STAT', (reqId, path) => guarded(reqId, () => sftp.attrs(reqId, toAttrs(statSync(real(path))))));
  sftp.on('LSTAT', (reqId, path) => guarded(reqId, () => sftp.attrs(reqId, toAttrs(lstatSync(real(path))))));
  sftp.on('SETSTAT', (reqId, path, attrs) =>
    guarded(reqId, () => {
      if (attrs.mode !== undefined) chmodSync(real(path), attrs.mode);
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
  sftp.on('OPENDIR', (reqId, path) =>
    guarded(reqId, () => {
      const dir = real(path);
      sftp.handle(reqId, newHandle({ dir, names: readdirSync(dir) }));
    })
  );
  sftp.on('READDIR', (reqId, handle) =>
    guarded(reqId, () => {
      const entry = handles.get(handle.toString('hex'));
      if (!entry?.dir || !entry.names) return void sftp.status(reqId, STATUS_CODE.FAILURE);
      if (entry.names.length === 0) return void sftp.status(reqId, STATUS_CODE.EOF);
      const batch = entry.names.splice(0, 64);
      const dir = entry.dir;
      sftp.name(
        reqId,
        batch.map((filename) => ({ filename, longname: filename, attrs: toAttrs(lstatSync(join(dir, filename))) }))
      );
    })
  );
  sftp.on('MKDIR', (reqId, path) =>
    guarded(reqId, () => {
      mkdirSync(real(path));
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
  sftp.on('RMDIR', (reqId, path) =>
    guarded(reqId, () => {
      rmdirSync(real(path));
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
  sftp.on('REMOVE', (reqId, path) =>
    guarded(reqId, () => {
      unlinkSync(real(path));
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
  sftp.on('RENAME', (reqId, from, to) =>
    guarded(reqId, () => {
      renameSync(real(from), real(to));
      sftp.status(reqId, STATUS_CODE.OK);
    })
  );
}
