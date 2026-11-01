import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer, type AddressInfo, type Server } from 'node:net';
import { join, posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirectoryListing, ForwardInput, Host, PromptResponse, SessionPrompt, TransferJob } from '@shared/contracts';
import { createHarness, OWNER, type Harness } from './harness';

export interface ConnectivityTarget {
  /** Creates the host in the given harness and returns it with a writable remote folder. */
  host(harness: Harness): Host;
  remoteRoot: string;
  /** Loopback address and port of a server that greets first, reachable from the SSH server itself. */
  banner: { host: string; port: number; pattern: RegExp };
  largeFileBytes: number;
}

function acceptKeys(prompt: SessionPrompt): PromptResponse {
  return prompt.kind === 'hostKey' ? { kind: 'hostKey', trust: 'once' } : { kind: 'cancel' };
}

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Reads what a server sends first, without sending anything. */
function readGreeting(port: number, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('No greeting received'));
    }, timeoutMs);
    socket.once('data', (data) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(data.toString('latin1'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Runs SFTP and port forwarding through the real services, against whichever server is given. */
export function defineConnectivitySuite(name: string, makeTarget: () => ConnectivityTarget): void {
  describe(name, () => {
    let harness: Harness;
    let target: ConnectivityTarget;
    let host: Host;
    let local: string;
    let remote: string;
    let sftpId: string;
    let stopAnswering: () => void;
    const servers: Server[] = [];

    beforeEach(() => {
      harness = createHarness();
      target = makeTarget();
      host = target.host(harness);
      local = join(harness.directory, 'local');
      mkdirSync(local);
      remote = posix.join(target.remoteRoot, `suite-${randomUUID().slice(0, 8)}`);
      sftpId = randomUUID();
      stopAnswering = harness.answerPrompts(acceptKeys);
    });

    afterEach(async () => {
      await harness.services.sftp
        .open(OWNER, randomUUID(), host.id)
        .then((info) => harness.services.sftp.remove(OWNER, info.sftpId, remote, true))
        .catch(() => undefined);
      stopAnswering();
      for (const server of servers.splice(0)) server.close();
      harness.dispose();
    });

    const openWithFolder = async (): Promise<void> => {
      await harness.services.sftp.open(OWNER, sftpId, host.id);
      await harness.services.sftp.mkdir(OWNER, sftpId, posix.dirname(remote), posix.basename(remote));
    };

    const transfer = async (
      direction: 'upload' | 'download',
      sources: string[],
      destinationDir: string,
      conflictPolicy: 'ask' | 'overwrite' | 'skip' | 'rename' = 'ask'
    ): Promise<TransferJob[]> => {
      const batchId = harness.services.transfers.enqueue(OWNER, {
        sftpId,
        direction,
        sources,
        destinationDir,
        conflictPolicy
      });
      return waitFor(
        'the batch to settle',
        () => {
          const jobs = harness.services.transfers.list(OWNER).filter((job) => job.batchId === batchId);
          const settled = jobs.every((job) => ['done', 'failed', 'cancelled', 'skipped', 'conflict'].includes(job.state));
          return jobs.length > 0 && settled && jobs;
        },
        280_000
      );
    };

    const names = (listing: DirectoryListing): string[] => listing.entries.map((entry) => entry.name).sort();

    describe('SFTP', () => {
      it('lists, creates, renames, changes modes and deletes on the server', async () => {
        await openWithFolder();
        await harness.services.sftp.mkdir(OWNER, sftpId, remote, 'folder');
        writeFileSync(join(local, 'a.txt'), 'hello');
        expect((await transfer('upload', [join(local, 'a.txt')], remote))[0]?.state).toBe('done');
        await harness.services.sftp.rename(OWNER, sftpId, posix.join(remote, 'a.txt'), 'b.txt');
        await harness.services.sftp.chmod(OWNER, sftpId, posix.join(remote, 'b.txt'), 0o640);

        const listing = await harness.services.sftp.list(OWNER, sftpId, remote);
        expect(names(listing)).toEqual(['b.txt', 'folder']);
        const file = listing.entries.find((entry) => entry.name === 'b.txt');
        expect(file?.size).toBe(5);
        if (process.platform !== 'win32' || !target.remoteRoot.startsWith('/fixture')) expect(file?.mode).toBe(0o640);

        await expect(harness.services.sftp.rename(OWNER, sftpId, posix.join(remote, 'b.txt'), 'folder')).rejects.toThrow(
          /existiert bereits/
        );
        await expect(harness.services.sftp.rename(OWNER, sftpId, posix.join(remote, 'b.txt'), '../evil')).rejects.toThrow(
          /kein zulässiger/
        );
        await harness.services.sftp.remove(OWNER, sftpId, posix.join(remote, 'b.txt'), false);
        await harness.services.sftp.remove(OWNER, sftpId, posix.join(remote, 'folder'), false);
        expect((await harness.services.sftp.list(OWNER, sftpId, remote)).entries).toEqual([]);
      });

      it('transfers folders recursively in both directions, byte for byte', async () => {
        await openWithFolder();
        const tree = join(local, 'tree');
        mkdirSync(join(tree, 'sub', 'deep'), { recursive: true });
        writeFileSync(join(tree, 'one.bin'), Buffer.alloc(300_000, 7));
        writeFileSync(join(tree, 'sub', 'deep', 'two.txt'), 'zwei');

        const up = await transfer('upload', [tree], remote);
        expect(up.map((job) => job.state)).toEqual(['done', 'done']);

        const back = join(local, 'back');
        mkdirSync(back);
        const down = await transfer('download', [posix.join(remote, 'tree')], back);
        expect(down.map((job) => job.state)).toEqual(['done', 'done']);
        expect(sha256(join(back, 'tree', 'one.bin'))).toBe(sha256(join(tree, 'one.bin')));
        expect(readFileSync(join(back, 'tree', 'sub', 'deep', 'two.txt'), 'utf8')).toBe('zwei');
      });

      it('streams a large file without holding it in memory', async () => {
        await openWithFolder();
        const path = join(local, 'large.bin');
        const chunk = Buffer.alloc(1024 * 1024, 42);
        await new Promise<void>((resolve, reject) => {
          const stream = createWriteStream(path);
          stream.on('error', reject);
          let written = 0;
          const pump = (): void => {
            while (written < target.largeFileBytes) {
              written += chunk.length;
              if (!stream.write(chunk)) {
                stream.once('drain', pump);
                return;
              }
            }
            stream.end(resolve);
          };
          pump();
        });
        global.gc?.();
        const before = process.memoryUsage().rss;
        let peak = before;
        const sampler = setInterval(() => {
          peak = Math.max(peak, process.memoryUsage().rss);
        }, 25);
        const jobs = await transfer('upload', [path], remote);
        clearInterval(sampler);
        expect(jobs[0]?.state).toBe('done');
        expect(jobs[0]?.transferred).toBe(jobs[0]?.size);
        // Well below the file size: this is what a buffering implementation would fail.
        expect(peak - before).toBeLessThan(target.largeFileBytes * 0.6);
        const listing = await harness.services.sftp.list(OWNER, sftpId, remote);
        expect(listing.entries.find((entry) => entry.name === 'large.bin')?.size).toBe(jobs[0]?.size);
      }, 300_000);

      it('cancels a running transfer and leaves no partial file behind', async () => {
        await openWithFolder();
        const path = join(local, 'cancel.bin');
        writeFileSync(path, Buffer.alloc(64 * 1024 * 1024, 1));
        const batchId = harness.services.transfers.enqueue(OWNER, {
          sftpId,
          direction: 'upload',
          sources: [path],
          destinationDir: remote,
          conflictPolicy: 'ask'
        });
        const running = await waitFor('the transfer to run', () =>
          harness.services.transfers.list(OWNER).find((job) => job.batchId === batchId && job.state === 'running')
        );
        harness.services.transfers.cancel(OWNER, { jobId: running.id, batchId: null });
        await waitFor('the cancellation', () => {
          const job = harness.services.transfers.list(OWNER).find((item) => item.id === running.id);
          return job?.state === 'cancelled';
        });
        const listing = await harness.services.sftp.list(OWNER, sftpId, remote);
        expect(listing.entries).toEqual([]);
      });

      it('asks before overwriting, and honours skip, rename and overwrite', async () => {
        await openWithFolder();
        const path = join(local, 'clash.txt');
        writeFileSync(path, 'first');
        await transfer('upload', [path], remote);
        writeFileSync(path, 'second version');

        const [conflict] = await transfer('upload', [path], remote);
        expect(conflict?.state).toBe('conflict');
        expect(conflict?.conflict?.size).toBe(5);
        const settle = (id: string, state: string) =>
          waitFor(state, () => harness.services.transfers.list(OWNER).find((job) => job.id === id && job.state === state));

        harness.services.transfers.resolveConflict(OWNER, { jobId: conflict!.id, action: 'skip', applyToBatch: false });
        await settle(conflict!.id, 'skipped');

        const [renamed] = await transfer('upload', [path], remote, 'rename');
        expect(renamed?.destination).toBe(posix.join(remote, 'clash (1).txt'));

        const [replaced] = await transfer('upload', [path], remote, 'overwrite');
        expect(replaced?.state).toBe('done');
        const listing = await harness.services.sftp.list(OWNER, sftpId, remote);
        expect(listing.entries.find((entry) => entry.name === 'clash.txt')?.size).toBe(14);
      });

      it('refuses local paths outside of the granted folders', async () => {
        await openWithFolder();
        const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
        const [job] = await transfer('upload', [outside], remote);
        expect(job?.state).toBe('failed');
        expect(job?.error).toMatch(/außerhalb/);
        await expect(harness.services.localFs.list(process.platform === 'win32' ? 'C:\\Windows' : '/etc')).rejects.toThrow(
          /außerhalb/
        );
      });

      it('keeps another user of the connection alive when a pane closes', async () => {
        await openWithFolder();
        const second = randomUUID();
        await harness.services.sftp.open(OWNER, second, host.id);
        expect(harness.services.pool.size()).toBe(1);
        harness.services.sftp.close(OWNER, sftpId);
        const listing = await harness.services.sftp.list(OWNER, second, remote);
        expect(listing.path).toBe(remote);
        harness.services.sftp.close(OWNER, second);
        expect(harness.services.pool.size()).toBe(0);
      });
    });

    describe('port forwarding', () => {
      const profile = (overrides: Partial<ForwardInput>): ForwardInput => ({
        name: 'test',
        hostId: host.id,
        type: 'local',
        bindAddress: '127.0.0.1',
        bindPort: 0,
        destHost: null,
        destPort: null,
        restoreOnStart: false,
        autoReconnect: false,
        allowNonLoopback: false,
        ...overrides
      });

      const startEcho = async (): Promise<number> => {
        const echo = createServer((socket) => {
          socket.on('error', () => socket.destroy());
          socket.pipe(socket);
        });
        servers.push(echo);
        await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
        return (echo.address() as AddressInfo).port;
      };

      it('-L reaches a service on the far side and stops cleanly', async () => {
        const forward = harness.services.forwards.create(
          profile({ type: 'local', destHost: target.banner.host, destPort: target.banner.port })
        );
        const runtime = await harness.services.forwarding.start(OWNER, forward.id);
        expect(runtime.status).toBe('running');
        expect(await readGreeting(runtime.boundPort as number)).toMatch(target.banner.pattern);

        harness.services.forwarding.stop(OWNER, forward.id);
        await expect(readGreeting(runtime.boundPort as number, 1000)).rejects.toThrow();
        expect(harness.services.pool.size()).toBe(0);
      });

      it('-D speaks SOCKS5 and reaches the destination through the server', async () => {
        const forward = harness.services.forwards.create(profile({ type: 'dynamic' }));
        const runtime = await harness.services.forwarding.start(OWNER, forward.id);
        const reply = await new Promise<string>((resolve, reject) => {
          const socket = netConnect(runtime.boundPort as number, '127.0.0.1');
          let stage = 0;
          socket.on('error', reject);
          socket.write(Buffer.from([5, 1, 0]));
          socket.on('data', (data) => {
            if (stage === 0) {
              expect([...data]).toEqual([5, 0]);
              stage = 1;
              const host = Buffer.from(target.banner.host);
              const portBytes = Buffer.alloc(2);
              portBytes.writeUInt16BE(target.banner.port);
              socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, portBytes]));
              return;
            }
            if (stage === 1) {
              expect(data[1]).toBe(0);
              stage = 2;
              if (data.length > 10) {
                socket.destroy();
                resolve(data.subarray(10).toString('latin1'));
              }
              return;
            }
            socket.destroy();
            resolve(data.toString('latin1'));
          });
        });
        expect(reply).toMatch(target.banner.pattern);
      });

      it('-R brings a connection from the server back to a local service', async () => {
        const echoPort = await startEcho();
        const reverse = harness.services.forwards.create(
          profile({ type: 'remote', destHost: '127.0.0.1', destPort: echoPort })
        );
        const remoteSide = await harness.services.forwarding.start(OWNER, reverse.id);
        expect(remoteSide.status).toBe('running');
        expect(remoteSide.boundPort).toBeGreaterThan(0);
        // A local forward to the remotely bound port closes the circle without any tool on the server.
        const circle = harness.services.forwards.create(
          profile({ type: 'local', destHost: '127.0.0.1', destPort: remoteSide.boundPort })
        );
        const entry = await harness.services.forwarding.start(OWNER, circle.id);
        const echoed = await new Promise<string>((resolve, reject) => {
          const socket = netConnect(entry.boundPort as number, '127.0.0.1');
          socket.on('error', reject);
          socket.once('data', (data) => {
            socket.destroy();
            resolve(data.toString());
          });
          socket.write('ping über -R');
        });
        expect(echoed).toBe('ping über -R');
      });

      it('reports a port conflict and refuses public listeners without consent', async () => {
        const blocker = createServer();
        servers.push(blocker);
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const taken = (blocker.address() as AddressInfo).port;
        const forward = harness.services.forwards.create(
          profile({ type: 'local', bindPort: taken, destHost: '127.0.0.1', destPort: 80 })
        );
        const runtime = await harness.services.forwarding.start(OWNER, forward.id);
        expect(runtime.status).toBe('failed');
        expect(runtime.error).toMatch(/belegt/);

        const open = harness.services.forwards.create(
          profile({ type: 'dynamic', bindAddress: '0.0.0.0' })
        );
        await expect(harness.services.forwarding.start(OWNER, open.id)).rejects.toThrow(/nicht ausdrücklich erlaubt/);
      });
    });
  });
}
