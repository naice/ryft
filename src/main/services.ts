import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseAgent } from 'ssh2';
import type { Host, SessionLaunch, SessionTarget } from '@shared/contracts';
import { isCommandRecordable } from '@shared/features/commandHistory';
import { flattenJumpChain } from '@shared/features/jumpChain';
import { AiService, type AiEventSink } from './ai/aiService';
import type { AiProvider } from './ai/aiProvider';
import { DockerService, type DockerBinary, type DockerEventSink } from './docker/dockerService';
import { ForwardManager, type ForwardEventSink } from './forward/forwardManager';
import { CommandHistoryRepository } from './history/commandHistoryRepository';
import {
  prepareLocalIntegration,
  remoteSetupLine,
  ShellIntegrationParser,
  type ShellCommandEvent
} from './history/shellIntegration';
import { KeyManager, KeyManagerError } from './keys/keyManager';
import { SessionLogger, type SessionLogEventSink } from './logging/sessionLogger';
import { LocalPtyAdapter } from './pty/localPtyAdapter';
import { findOnPath, resolveShell, type ShellDefinition } from './pty/shells';
import { CredentialResolver } from './security/credentials';
import { HostKeyChanges } from './security/hostKeyChanges';
import { readOpenSshKnownHosts } from './security/knownHosts';
import { HostSecrets, type SecretStore } from './security/secretVault';
import { SessionManager } from './sessions/sessionManager';
import { SnippetRepository } from './snippets/snippetRepository';
import { SessionFailure, type Prompter, type SessionEventSink } from './sessions/types';
import { LocalFsScope } from './sftp/localFs';
import { SftpManager, type SftpEventSink } from './sftp/sftpManager';
import { TransferManager, type TransferEventSink } from './sftp/transferManager';
import type { HopConfig, SshConnectionDeps } from './ssh/connection';
import { SshConnectionPool } from './ssh/connectionPool';
import { SshAdapter } from './ssh/sshAdapter';
import {
  AuthProfileRepository,
  ForwardRepository,
  GroupRepository,
  HistoryRepository,
  HostRepository,
  NotFoundError,
  PreferenceRepository,
  TrustedHostKeyRepository,
  type StoredHost
} from './storage/repositories';
import { WorkspaceRepository } from './workspaces/workspaceRepository';
import { WslService } from './wsl/wslService';

/** POSIX quoting for the folder a workspace pane starts in; the leading space keeps it out of the shell history. */
function changeDirectoryLine(directory: string): string {
  return ` cd -- '${directory.replace(/'/g, `'\\''`)}'\r`;
}

export interface ServicesConfig {
  db: DatabaseSync;
  /** Holds generated keys and the shell integration scripts. */
  dataDirectory: string;
  secretStore: SecretStore;
  sink: SessionEventSink & SftpEventSink & TransferEventSink & ForwardEventSink & DockerEventSink & AiEventSink & SessionLogEventSink;
  shells: ShellDefinition[];
  sshDirectory?: string;
  agent?: string | BaseAgent;
  reconnectDelaysMs?: readonly number[];
  /** Replaces the per-host timeout, for tests that must not wait for it. */
  connectTimeoutMs?: number;
  localRoots?: string[];
  forwardBackoffMs?: readonly number[];
  /** Replaces the CLI found on the PATH; null means there is none. */
  dockerBinary?: DockerBinary | null;
  wslBinary?: string | null;
  createAiProvider?: (endpoint: string) => AiProvider;
}

function defaultDockerBinary(): DockerBinary | null {
  const file = findOnPath(process.platform === 'win32' ? 'docker.exe' : 'docker');
  return file ? { file, args: [] } : null;
}

function defaultWslBinary(shells: ShellDefinition[]): string | null {
  return shells.find((shell) => shell.id === 'wsl')?.file ?? null;
}

/** Wires storage, secrets and sessions together, free of Electron so that tests can run it for real. */
export function createServices(config: ServicesConfig) {
  const hosts = new HostRepository(config.db);
  const groups = new GroupRepository(config.db);
  const preferences = new PreferenceRepository(config.db);
  const history = new HistoryRepository(config.db);
  const trustedKeys = new TrustedHostKeyRepository(config.db);
  const authProfiles = new AuthProfileRepository(config.db);
  const forwards = new ForwardRepository(config.db);
  const secrets = new HostSecrets(config.secretStore);
  const workspaces = new WorkspaceRepository(config.db);
  const snippets = new SnippetRepository(config.db);
  const commandHistory = new CommandHistoryRepository(config.db);
  const wsl = new WslService(config.wslBinary === undefined ? defaultWslBinary(config.shells) : config.wslBinary);
  const docker = new DockerService(config.dockerBinary === undefined ? defaultDockerBinary() : config.dockerBinary, wsl, config.sink);
  const ai = new AiService(() => preferences.getAll(), config.sink, config.createAiProvider);
  const sessionLogs = new SessionLogger({
    db: config.db,
    directory: join(config.dataDirectory, 'session-logs'),
    settings: () => preferences.getAll(),
    sink: config.sink
  });

  const labelOf = (target: SessionTarget): string => {
    const prefs = preferences.getAll();
    switch (target.kind) {
      case 'local':
        return resolveShell(config.shells, target.shellId ?? prefs.defaultShellId)?.label ?? 'Local';
      case 'ssh':
        return hosts.find(target.hostId)?.name ?? 'Gelöschter Host';
      case 'wsl':
        return `WSL: ${target.distro ?? prefs.wslDefaultDistro ?? 'Standard'}`;
      case 'docker':
        return `Docker: ${target.containerName}`;
    }
  };
  const credentials: CredentialResolver = new CredentialResolver(
    config.secretStore,
    (id) => authProfiles.find(id),
    (keyReference) => keys.passphraseForPath(keyReference)
  );
  const keys: KeyManager = new KeyManager({
    db: config.db,
    directory: join(config.dataDirectory, 'keys'),
    credentials,
    usersOf: (path) => [
      ...hosts
        .list()
        .filter((host) => host.authProfileId === null && host.authMethod === 'key' && host.keyReference === path)
        .map((host) => host.name),
      ...authProfiles
        .list()
        .filter((profile) => profile.method === 'key' && profile.keyReference === path)
        .map((profile) => profile.name)
    ]
  });

  const recordCommand = (sessionLabel: string, hostId: string | null, event: ShellCommandEvent): void => {
    const { commandHistoryEnabled, historyExclusions } = preferences.getAll();
    if (!commandHistoryEnabled || !isCommandRecordable(event.command, historyExclusions)) return;
    commandHistory.add({ command: event.command.trim(), sessionLabel, hostId, cwd: event.cwd, exitCode: event.exitCode });
  };
  const hostKeyChanges = new HostKeyChanges(trustedKeys);

  const toPublicHost = (host: StoredHost): Host => ({
    ...host,
    hasStoredSecret: credentials.hasStoredSecret(host)
  });

  const findHost = (hostId: string): StoredHost => {
    try {
      return hosts.get(hostId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new SessionFailure('HOST_NOT_FOUND', 'Dieser Host existiert nicht mehr.');
      }
      throw error;
    }
  };

  const toHop = (host: StoredHost): HopConfig => {
    const resolved = credentials.resolve(host);
    const { connectTimeoutSec, keepaliveIntervalSec } = host.options;
    return {
      label: host.name,
      hostname: host.hostname,
      port: host.port,
      username: resolved.username,
      authMethod: resolved.authMethod,
      keyReference: resolved.keyReference,
      connectTimeoutMs: config.connectTimeoutMs ?? connectTimeoutSec * 1000,
      keepaliveIntervalMs: keepaliveIntervalSec * 1000,
      getSecret: resolved.getSecret,
      setSecret: resolved.setSecret
    };
  };

  /** Everything a connection to a host needs, with its whole jump chain checked up front. */
  const connectionDepsFor = (target: StoredHost, prompt: Prompter): SshConnectionDeps => {
    const chain = flattenJumpChain(target.id, (id) => {
      try {
        return hosts.get(id).options.jumpHostIds;
      } catch {
        return null;
      }
    });
    if (!chain.ok) {
      const problem = {
        cycle: 'Die Sprunghost-Kette enthält einen Kreis.',
        missing: 'Ein Sprunghost dieser Kette existiert nicht mehr.',
        tooLong: 'Die Sprunghost-Kette ist zu lang.'
      }[chain.problem.kind];
      throw new SessionFailure('JUMP_CHAIN_INVALID', problem);
    }
    const chainHosts = chain.hops.map((id) => hosts.get(id));
    return {
      hops: chainHosts.map(toHop),
      trust: {
        ryftEntries: (hostname, port) => trustedKeys.forEndpoint(hostname, port),
        openSshLines: () => readOpenSshKnownHosts(config.sshDirectory)
      },
      rememberHostKey: (entry) => trustedKeys.add(entry),
      registerHostKeyChange: (entry) => hostKeyChanges.register(entry),
      vaultAvailable: () => secrets.status().available,
      prompt,
      agent: config.agent,
      // The first server of the route is the one the proxy has to reach.
      proxy: (chainHosts[0] as StoredHost).options.proxy
    };
  };

  const sessions = new SessionManager({
    sink: config.sink,
    autoReconnectEnabled: (target) => {
      const policy = target.kind === 'ssh' ? hosts.find(target.hostId)?.options.reconnectPolicy : 'inherit';
      if (policy === 'never') return false;
      if (policy === 'auto') return true;
      return preferences.getAll().autoReconnect;
    },
    encodingOf: (target) => (target.kind === 'ssh' ? (hosts.find(target.hostId)?.options.encoding ?? 'utf8') : 'utf8'),
    reconnectDelaysMs: config.reconnectDelaysMs,
    startupCommandsAllowed: () => preferences.getAll().workspaceStartupCommands,
    observer: {
      connected: (sessionId, target) => sessionLogs.sessionConnected(sessionId, labelOf(target), target.kind),
      output: (sessionId, text) => sessionLogs.output(sessionId, text),
      state: (sessionId, state) => sessionLogs.sessionState(sessionId, state),
      ended: (sessionId) => sessionLogs.sessionEnded(sessionId)
    },
    history: {
      start: (target: SessionTarget) => {
        if (target.kind !== 'ssh') return history.start({ hostId: null, label: labelOf(target), kind: 'local' });
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
    createAdapter: (target, prompt, onDetail, launch: SessionLaunch | null) => {
      const prefs = preferences.getAll();
      if (target.kind === 'local') {
        const shell = resolveShell(config.shells, target.shellId ?? prefs.defaultShellId);
        if (!shell) throw new SessionFailure('SPAWN_FAILED', 'Auf diesem System wurde keine Shell gefunden.');
        const integration = prefs.commandHistoryEnabled
          ? prepareLocalIntegration(shell, join(config.dataDirectory, 'shell-integration'), randomUUID(), (event) =>
              recordCommand(shell.label, null, event)
            )
          : null;
        return new LocalPtyAdapter(integration?.shell ?? shell, {
          cwd: launch?.cwd,
          env: integration?.env,
          filterOutput: integration ? (text) => integration.parser.filter(text) : undefined
        });
      }
      if (target.kind === 'wsl') {
        const distro = target.distro ?? prefs.wslDefaultDistro;
        const directory = launch?.cwd ?? prefs.wslStartDirectory;
        const binary = wsl.binaryPath;
        if (!binary) throw new SessionFailure('SPAWN_FAILED', 'WSL ist auf diesem System nicht verfügbar.');
        return new LocalPtyAdapter(
          {
            id: 'wsl',
            label: labelOf(target),
            file: binary,
            args: [...(distro ? ['--distribution', distro] : []), ...(directory ? ['--cd', directory] : [])]
          },
          { beforeStart: distro ? () => wsl.assertDistro(distro) : undefined }
        );
      }
      if (target.kind === 'docker') {
        const label = target.containerName;
        return new LocalPtyAdapter(docker.shellDefinitionUnchecked(target.endpoint, target.containerId, label), {
          beforeStart: () => docker.assertRunning(target.endpoint, target.containerId, label)
        });
      }
      const host = findHost(target.hostId);
      const { options } = host;
      const nonce = randomUUID();
      const reporting = prefs.commandHistoryEnabled && options.shellIntegration;
      const parser = reporting
        ? new ShellIntegrationParser(nonce, (event) => recordCommand(host.name, host.id, event))
        : null;
      return new SshAdapter({
        ...connectionDepsFor(host, prompt),
        terminalType: options.terminalType,
        env: Object.fromEntries(options.env.map(({ name, value }) => [name, value])),
        encoding: options.encoding,
        startupCommands: options.runStartupCommands ? options.startupCommands : [],
        setupLines: [
          ...(reporting ? [remoteSetupLine(nonce)] : []),
          ...(launch?.cwd ? [changeDirectoryLine(launch.cwd)] : [])
        ],
        filterOutput: parser ? (text) => parser.filter(text) : undefined,
        onHop: (label) => onDetail(`Verbinde über ${label} …`)
      });
    }
  });

  const pool = new SshConnectionPool({
    depsFor: (hostId, prompt) => connectionDepsFor(findHost(hostId), prompt)
  });

  const localFs = new LocalFsScope(config.localRoots);

  const sftp = new SftpManager({
    acquire: (ownerId, hostId, prompt) => pool.acquire(ownerId, hostId, prompt),
    defaultDirOf: (hostId) => hosts.find(hostId)?.options.defaultRemoteDir ?? '',
    createPrompter: (ownerId, contextId) => sessions.createPrompter(ownerId, contextId),
    cancelPrompts: (contextId) => sessions.cancelContext(contextId),
    sink: config.sink
  });

  const transfers = new TransferManager({
    session: (ownerId, sftpId) => sftp.session(ownerId, sftpId),
    scope: localFs,
    sink: config.sink
  });
  sftp.onClosed((sftpId) => transfers.handleSessionClosed(sftpId));

  const forwarding = new ForwardManager({
    profile: (id) => forwards.get(id),
    acquire: (ownerId, hostId, prompt) => pool.acquire(ownerId, hostId, prompt),
    createPrompter: (ownerId, contextId) => sessions.createPrompter(ownerId, contextId),
    cancelPrompts: (contextId) => sessions.cancelContext(contextId),
    sink: config.sink,
    backoffMs: config.forwardBackoffMs
  });

  /** Borrows a connection only for the moment it takes to append one line to `authorized_keys`. */
  const installKey = async (ownerId: number, keyId: string, hostId: string, contextId: string) => {
    const prompt = sessions.createPrompter(ownerId, contextId);
    const lease = await pool.acquire(ownerId, hostId, prompt).catch((error: unknown) => {
      if (error instanceof SessionFailure) throw new KeyManagerError(error.message);
      throw error;
    });
    try {
      return await keys.installOn(lease.client, keyId);
    } finally {
      lease.release();
      sessions.cancelContext(contextId);
    }
  };

  /** The documented shutdown order: stop users of a connection first, then the connections themselves. */
  const disposeOwner = (ownerId: number): void => {
    ai.disposeOwner(ownerId);
    docker.disposeOwner(ownerId);
    transfers.disposeOwner(ownerId);
    forwarding.disposeOwner(ownerId);
    sftp.disposeOwner(ownerId);
    pool.disposeOwner(ownerId);
    sessions.disposeOwner(ownerId);
  };
  const disposeAll = (): void => {
    ai.disposeAll();
    docker.disposeAll();
    transfers.disposeAll();
    forwarding.disposeAll();
    sftp.disposeAll();
    pool.disposeAll();
    sessions.disposeAll();
    sessionLogs.disposeAll();
  };

  return {
    hosts,
    groups,
    preferences,
    history,
    trustedKeys,
    secrets,
    sessions,
    toPublicHost,
    authProfiles,
    forwards,
    credentials,
    hostKeyChanges,
    pool,
    localFs,
    sftp,
    transfers,
    forwarding,
    workspaces,
    snippets,
    commandHistory,
    keys,
    installKey,
    wsl,
    docker,
    ai,
    sessionLogs,
    labelOf,
    discardUnreadableSecrets: () => config.secretStore.discardUnreadable?.() ?? 0,
    disposeOwner,
    disposeAll
  };
}

export type Services = ReturnType<typeof createServices>;
