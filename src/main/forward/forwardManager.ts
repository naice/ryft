import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ForwardProfile, ForwardRuntime } from '@shared/contracts';
import { isLoopbackAddress } from '@shared/features/forwards';
import { NotFoundError } from '../storage/repositories';
import type { Prompter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';
import type { ConnectionLease } from '../ssh/connectionPool';
import { readSocksRequest, SocksError, writeSocksReply } from './socks5';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000];
/** Decisions the server or the user made: retrying cannot change them. */
const PERMANENT_FAILURES = new Set(['AUTH_FAILED', 'AUTH_CANCELLED', 'HOST_KEY_MISMATCH', 'HOST_KEY_REVOKED', 'HOST_KEY_REJECTED']);

export interface ForwardEventSink {
  forwardState(runtime: ForwardRuntime): void;
}

export interface ForwardManagerDeps {
  profile(id: string): ForwardProfile;
  acquire(ownerId: number, hostId: string, prompt: Prompter): Promise<ConnectionLease>;
  createPrompter(ownerId: number, contextId: string): Prompter;
  cancelPrompts(contextId: string): void;
  sink: ForwardEventSink;
  backoffMs?: readonly number[];
}

interface ActiveForward {
  profile: ForwardProfile;
  ownerId: number;
  runtime: ForwardRuntime;
  lease: ConnectionLease | null;
  server: Server | null;
  stopRemote: (() => void) | null;
  sockets: Set<Duplex>;
  retry: NodeJS.Timeout | null;
  /** Set when the user stopped it: everything still in flight has to give up. */
  stopped: boolean;
}

function pipeBoth(a: Duplex, b: Duplex, track: Set<Duplex>): void {
  track.add(a);
  track.add(b);
  const close = (): void => {
    track.delete(a);
    track.delete(b);
    a.destroy();
    b.destroy();
  };
  a.on('error', close);
  b.on('error', close);
  a.on('close', close);
  b.on('close', close);
  a.pipe(b);
  b.pipe(a);
}

export class ForwardManager {
  private readonly active = new Map<string, ActiveForward>();

  constructor(private readonly deps: ForwardManagerDeps) {}

  list(ownerId: number): ForwardRuntime[] {
    return [...this.active.values()].filter((item) => item.ownerId === ownerId).map((item) => ({ ...item.runtime }));
  }

  async start(ownerId: number, id: string): Promise<ForwardRuntime> {
    const existing = this.active.get(id);
    if (existing && !existing.stopped && existing.runtime.status !== 'failed') return { ...existing.runtime };
    if (existing) this.stop(ownerId, id);
    const profile = this.deps.profile(id);
    if (!isLoopbackAddress(profile.bindAddress) && !profile.allowNonLoopback) {
      throw new ForwardConfigError(
        `„${profile.bindAddress}“ wäre aus dem Netz erreichbar und wurde für diese Weiterleitung nicht ausdrücklich erlaubt.`
      );
    }
    const item: ActiveForward = {
      profile,
      ownerId,
      runtime: { id, status: 'starting', boundPort: null, connections: 0, error: null, attempt: null },
      lease: null,
      server: null,
      stopRemote: null,
      sockets: new Set(),
      retry: null,
      stopped: false
    };
    this.active.set(id, item);
    this.emit(item);
    await this.establish(item);
    return { ...item.runtime };
  }

  stop(ownerId: number, id: string): void {
    const item = this.active.get(id);
    if (!item) return;
    if (item.ownerId !== ownerId) throw new NotFoundError('Port-Weiterleitung');
    item.stopped = true;
    this.deps.cancelPrompts(id);
    this.teardown(item);
    this.active.delete(id);
    this.deps.sink.forwardState({ id, status: 'stopped', boundPort: null, connections: 0, error: null, attempt: null });
  }

  disposeOwner(ownerId: number): void {
    for (const item of [...this.active.values()]) {
      if (item.ownerId === ownerId) this.stop(ownerId, item.profile.id);
    }
  }

  disposeAll(): void {
    for (const item of [...this.active.values()]) this.stop(item.ownerId, item.profile.id);
  }

  private emit(item: ActiveForward): void {
    this.deps.sink.forwardState({ ...item.runtime });
  }

  private async establish(item: ActiveForward): Promise<void> {
    const { profile } = item;
    try {
      const lease = await this.deps.acquire(item.ownerId, profile.hostId, this.deps.createPrompter(item.ownerId, profile.id));
      if (item.stopped) {
        lease.release();
        return;
      }
      item.lease = lease;
      lease.onLost((failure) => this.handleLost(item, failure));
      if (profile.type === 'remote') await this.startRemote(item, lease);
      else await this.startListener(item, lease);
      if (item.stopped) return;
      item.runtime.status = 'running';
      item.runtime.error = null;
      item.runtime.attempt = null;
      this.emit(item);
    } catch (error) {
      if (item.stopped) return;
      this.teardown(item);
      const failure = error as Error & { code?: string };
      this.scheduleRetryOrFail(item, failure, PERMANENT_FAILURES.has(failure.code ?? '') || isBindConflict(failure));
    }
  }

  private startListener(item: ActiveForward, lease: ConnectionLease): Promise<void> {
    const { profile } = item;
    const server = createServer((socket) => {
      socket.on('error', () => socket.destroy());
      if (profile.type === 'dynamic') this.handleSocks(item, lease, socket);
      else this.handleLocal(item, lease, socket);
    });
    item.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (error: Error & { code?: string }) => {
        reject(error.code === 'EADDRINUSE' ? new ForwardConfigError(portInUseMessage(profile), 'EADDRINUSE') : error);
      });
      server.listen(profile.bindPort, profile.bindAddress, () => {
        const address = server.address();
        item.runtime.boundPort = typeof address === 'object' && address ? address.port : profile.bindPort;
        resolve();
      });
    });
  }

  private openChannel(lease: ConnectionLease, source: Socket, host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      lease.client.forwardOut(source.remoteAddress ?? '127.0.0.1', source.remotePort ?? 0, host, port, (error, channel) => {
        if (error) reject(error);
        else resolve(channel);
      });
    });
  }

  private handleLocal(item: ActiveForward, lease: ConnectionLease, socket: Socket): void {
    const { destHost, destPort } = item.profile;
    if (!destHost || !destPort) {
      socket.destroy();
      return;
    }
    item.sockets.add(socket);
    socket.pause();
    this.openChannel(lease, socket, destHost, destPort).then(
      (channel) => {
        this.track(item, channel, socket);
        socket.resume();
      },
      () => {
        item.sockets.delete(socket);
        socket.destroy();
      }
    );
  }

  private handleSocks(item: ActiveForward, lease: ConnectionLease, socket: Socket): void {
    item.sockets.add(socket);
    void readSocksRequest(socket).then(
      async (request) => {
        try {
          const channel = await this.openChannel(lease, socket, request.host, request.port);
          writeSocksReply(socket, 0);
          this.track(item, channel, socket);
          if (request.rest.length > 0) channel.write(request.rest);
          socket.resume();
        } catch {
          writeSocksReply(socket, 5);
          item.sockets.delete(socket);
          socket.end();
        }
      },
      (error: unknown) => {
        if (error instanceof SocksError && error.reply !== null) writeSocksReply(socket, error.reply);
        item.sockets.delete(socket);
        socket.destroy();
      }
    );
  }

  private track(item: ActiveForward, channel: Duplex, socket: Duplex): void {
    if (item.stopped) {
      channel.destroy();
      socket.destroy();
      return;
    }
    item.runtime.connections += 1;
    this.emit(item);
    socket.once('close', () => {
      item.runtime.connections = Math.max(0, item.runtime.connections - 1);
      if (!item.stopped) this.emit(item);
    });
    pipeBoth(socket, channel, item.sockets);
  }

  private startRemote(item: ActiveForward, lease: ConnectionLease): Promise<void> {
    const { profile } = item;
    const { destHost, destPort } = profile;
    return new Promise((resolve, reject) => {
      lease.client.forwardIn(profile.bindAddress, profile.bindPort, (error, assigned) => {
        if (error) {
          reject(new ForwardConfigError(`Der Server lehnt die Weiterleitung auf Port ${profile.bindPort} ab: ${error.message}`, 'EADDRINUSE'));
          return;
        }
        const port = profile.bindPort === 0 ? assigned : profile.bindPort;
        item.runtime.boundPort = port;
        const unhandle = lease.handleRemotePort(port, (_info, accept, deny) => {
          if (!destHost || !destPort || item.stopped) {
            deny();
            return;
          }
          const local = netConnect(destPort, destHost);
          local.once('error', () => {
            local.destroy();
            deny();
          });
          local.once('connect', () => {
            local.removeAllListeners('error');
            this.track(item, accept(), local);
          });
        });
        item.stopRemote = () => {
          unhandle();
          try {
            lease.client.unforwardIn(profile.bindAddress, port, () => undefined);
          } catch {
            // The connection can already be gone.
          }
        };
        resolve();
      });
    });
  }

  private handleLost(item: ActiveForward, failure: SessionFailure): void {
    if (item.stopped) return;
    item.lease = null;
    this.teardown(item);
    this.scheduleRetryOrFail(item, failure, false);
  }

  private scheduleRetryOrFail(item: ActiveForward, failure: Error, permanent: boolean): void {
    if (permanent || !item.profile.autoReconnect) {
      item.runtime.status = 'failed';
      item.runtime.boundPort = null;
      item.runtime.connections = 0;
      item.runtime.error = failure.message;
      item.runtime.attempt = null;
      this.emit(item);
      return;
    }
    const delays = this.deps.backoffMs ?? BACKOFF_MS;
    const attempt = (item.runtime.attempt ?? 0) + 1;
    const delay = delays[Math.min(attempt - 1, delays.length - 1)] as number;
    item.runtime.status = 'reconnecting';
    item.runtime.boundPort = null;
    item.runtime.connections = 0;
    item.runtime.error = failure.message;
    item.runtime.attempt = attempt;
    this.emit(item);
    item.retry = setTimeout(() => {
      item.retry = null;
      if (!item.stopped) void this.establish(item);
    }, delay);
  }

  private teardown(item: ActiveForward): void {
    if (item.retry) clearTimeout(item.retry);
    item.retry = null;
    item.stopRemote?.();
    item.stopRemote = null;
    item.server?.close();
    item.server = null;
    for (const socket of [...item.sockets]) socket.destroy();
    item.sockets.clear();
    item.lease?.release();
    item.lease = null;
  }
}

export class ForwardConfigError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ForwardConfigError';
  }
}

function isBindConflict(error: Error & { code?: string }): boolean {
  return error.code === 'EADDRINUSE';
}

function portInUseMessage(profile: ForwardProfile): string {
  return `Port ${profile.bindPort} auf ${profile.bindAddress} ist bereits belegt.`;
}
