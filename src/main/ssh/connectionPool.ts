import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2';
import { log } from '../logger';
import type { Prompter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';
import { SshConnection, type SshConnectionDeps } from './connection';

type TcpConnectionHandler = (info: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void;

/** A shared use of one authenticated connection. Releasing it never affects other users. */
export interface ConnectionLease {
  readonly client: Client;
  release(): void;
  onLost(listener: (failure: SessionFailure) => void): () => void;
  /** Incoming `-R` connections arrive centrally on the client, so they are dispatched by bound port. */
  handleRemotePort(port: number, handler: TcpConnectionHandler): () => void;
}

interface PoolEntry {
  key: string;
  connection: SshConnection;
  ready: Promise<Client>;
  refs: number;
  remotePorts: Map<number, TcpConnectionHandler>;
  lost: Set<(failure: SessionFailure) => void>;
  closed: boolean;
}

export interface ConnectionPoolDeps {
  depsFor(hostId: string, prompt: Prompter): SshConnectionDeps;
}

/**
 * Connections shared by SFTP and port forwarding, one per window and host. They are reference counted,
 * so that closing an SFTP pane does not take down a tunnel to the same server. Terminals keep their own
 * connection per pane, which isolates a busy transfer from interactive input.
 */
export class SshConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(private readonly deps: ConnectionPoolDeps) {}

  async acquire(ownerId: number, hostId: string, prompt: Prompter): Promise<ConnectionLease> {
    const key = `${ownerId}:${hostId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.createEntry(key, hostId, prompt);
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    let client: Client;
    try {
      client = await entry.ready;
    } catch (error) {
      entry.refs -= 1;
      throw error;
    }
    return this.lease(entry, client);
  }

  /** Number of live connections, for tests and the shutdown log. */
  size(): number {
    return this.entries.size;
  }

  disposeOwner(ownerId: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.key.startsWith(`${ownerId}:`)) this.closeEntry(entry);
    }
  }

  disposeAll(): void {
    for (const entry of [...this.entries.values()]) this.closeEntry(entry);
  }

  private createEntry(key: string, hostId: string, prompt: Prompter): PoolEntry {
    const connection = new SshConnection(this.deps.depsFor(hostId, prompt));
    const entry: PoolEntry = {
      key,
      connection,
      ready: Promise.resolve(null as unknown as Client),
      refs: 0,
      remotePorts: new Map(),
      lost: new Set(),
      closed: false
    };
    connection.onLost((failure) => {
      this.entries.delete(key);
      entry.closed = true;
      for (const listener of [...entry.lost]) listener(failure);
      entry.lost.clear();
    });
    entry.ready = connection.connect().then(
      (client) => {
        client.on('tcp connection', (info, accept, reject) => {
          const handler = entry.remotePorts.get(info.destPort);
          if (handler) handler(info, accept, reject);
          else reject();
        });
        return client;
      },
      (error: unknown) => {
        this.entries.delete(key);
        entry.closed = true;
        connection.dispose();
        throw error;
      }
    );
    return entry;
  }

  private lease(entry: PoolEntry, client: Client): ConnectionLease {
    let released = false;
    const listeners = new Set<(failure: SessionFailure) => void>();
    return {
      client,
      release: () => {
        if (released) return;
        released = true;
        for (const listener of listeners) entry.lost.delete(listener);
        entry.refs -= 1;
        if (entry.refs <= 0) this.closeEntry(entry);
      },
      onLost: (listener) => {
        // The connection may already have gone away between connecting and subscribing.
        if (entry.closed) {
          setImmediate(() => listener(new SessionFailure('CONNECTION_LOST', 'Die Verbindung wurde unterbrochen.')));
          return () => undefined;
        }
        listeners.add(listener);
        entry.lost.add(listener);
        return () => {
          listeners.delete(listener);
          entry.lost.delete(listener);
        };
      },
      handleRemotePort: (port, handler) => {
        entry.remotePorts.set(port, handler);
        return () => entry.remotePorts.delete(port);
      }
    };
  }

  private closeEntry(entry: PoolEntry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.closed) return;
    entry.closed = true;
    entry.lost.clear();
    try {
      entry.connection.dispose();
    } catch (error) {
      log.warn('Closing a pooled connection failed', { error });
    }
  }
}
