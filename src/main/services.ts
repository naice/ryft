import type { DatabaseSync } from 'node:sqlite';
import type { BaseAgent } from 'ssh2';
import type { Host, SessionTarget } from '@shared/contracts';
import { LocalPtyAdapter } from './pty/localPtyAdapter';
import { resolveShell, type ShellDefinition } from './pty/shells';
import { readOpenSshKnownHosts } from './security/knownHosts';
import { HostSecrets, type SecretStore } from './security/secretVault';
import { SessionManager } from './sessions/sessionManager';
import { SessionFailure, type SessionEventSink } from './sessions/types';
import { SshAdapter } from './ssh/sshAdapter';
import {
  GroupRepository,
  HistoryRepository,
  HostRepository,
  NotFoundError,
  PreferenceRepository,
  TrustedHostKeyRepository
} from './storage/repositories';

export interface ServicesConfig {
  db: DatabaseSync;
  secretStore: SecretStore;
  sink: SessionEventSink;
  shells: ShellDefinition[];
  sshDirectory?: string;
  agent?: string | BaseAgent;
  reconnectDelaysMs?: readonly number[];
  connectTimeoutMs?: number;
}

/** Wires storage, secrets and sessions together, free of Electron so that tests can run it for real. */
export function createServices(config: ServicesConfig) {
  const hosts = new HostRepository(config.db);
  const groups = new GroupRepository(config.db);
  const preferences = new PreferenceRepository(config.db);
  const history = new HistoryRepository(config.db);
  const trustedKeys = new TrustedHostKeyRepository(config.db);
  const secrets = new HostSecrets(config.secretStore);

  const toPublicHost = (host: Omit<Host, 'hasStoredSecret'>): Host => ({
    ...host,
    hasStoredSecret: secrets.hasAny(host.id)
  });

  const sessions = new SessionManager({
    sink: config.sink,
    autoReconnectEnabled: () => preferences.getAll().autoReconnect,
    reconnectDelaysMs: config.reconnectDelaysMs,
    history: {
      start: (target: SessionTarget) => {
        if (target.kind === 'local') {
          const shell = resolveShell(config.shells, target.shellId ?? preferences.getAll().defaultShellId);
          return history.start({ hostId: null, label: shell?.label ?? 'Local', kind: 'local' });
        }
        try {
          const host = hosts.get(target.hostId);
          return history.start({ hostId: host.id, label: host.name, kind: 'ssh' });
        } catch {
          return null;
        }
      },
      outcome: (id, outcome) => history.setOutcome(id, outcome),
      finish: (id) => history.finish(id)
    },
    createAdapter: (target, prompt) => {
      if (target.kind === 'local') {
        const shell = resolveShell(config.shells, target.shellId ?? preferences.getAll().defaultShellId);
        if (!shell) throw new SessionFailure('SPAWN_FAILED', 'Auf diesem System wurde keine Shell gefunden.');
        return new LocalPtyAdapter(shell);
      }
      let host: ReturnType<HostRepository['get']>;
      try {
        host = hosts.get(target.hostId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new SessionFailure('HOST_NOT_FOUND', 'Dieser Host existiert nicht mehr.');
        }
        throw error;
      }
      return new SshAdapter({
        host,
        trust: {
          ryftEntries: (hostname, port) => trustedKeys.forEndpoint(hostname, port),
          openSshLines: () => readOpenSshKnownHosts(config.sshDirectory)
        },
        rememberHostKey: (entry) => trustedKeys.add(entry),
        getSecret: (kind) => secrets.get(host.id, kind),
        setSecret: (kind, value) => secrets.set(host.id, kind, value),
        vaultAvailable: () => secrets.status().available,
        prompt,
        agent: config.agent,
        connectTimeoutMs: config.connectTimeoutMs
      });
    }
  });

  return { hosts, groups, preferences, history, trustedKeys, secrets, sessions, toPublicHost };
}

export type Services = ReturnType<typeof createServices>;
