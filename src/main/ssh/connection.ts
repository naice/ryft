import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  Client,
  utils,
  type AgentAuthMethod,
  type AuthenticationType,
  type BaseAgent,
  type ConnectConfig,
  type KeyboardInteractiveAuthMethod,
  type NoAuthMethod,
  type ParsedKey,
  type PasswordAuthMethod,
  type PublicKeyAuthMethod
} from 'ssh2';
import type { AuthMethod, ProxyConfig, SecretKind } from '@shared/contracts';
import { describeHostKey, verifyHostKey, type HostKeyTrustSource } from '../security/knownHosts';
import type { Prompter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';
import { openProxySocket } from './proxy';

const MAX_KEY_FILE_BYTES = 1024 * 1024;
const MAX_SECRET_ATTEMPTS = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_KEEPALIVE_MS = 15_000;

export interface RememberedHostKey {
  host: string;
  port: number;
  keyType: string;
  keyBase64: string;
  fingerprint: string;
}

/** One SSH server on the way, with its credentials already resolved from host and auth profile. */
export interface HopConfig {
  label: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyReference: string | null;
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  getSecret(kind: SecretKind): string | null;
  setSecret(kind: SecretKind, value: string): void;
}

export interface SshConnectionDeps {
  /** Connection order, the actual target last. */
  hops: HopConfig[];
  trust: HostKeyTrustSource;
  /** Persists an explicit "always trust" decision. */
  rememberHostKey(entry: RememberedHostKey): void;
  /** Registers a changed RYFT-owned key so that it can be replaced deliberately. Returns the change's id. */
  registerHostKeyChange?(entry: RememberedHostKey): string;
  vaultAvailable(): boolean;
  prompt: Prompter;
  /** Overrides agent discovery; a path/pipe name or an agent instance. */
  agent?: string | BaseAgent;
  /** Applies to the first hop only: later hops are reached through the previous one. */
  proxy?: ProxyConfig;
}

export interface ConnectionHooks {
  onAuthenticating?(): void;
  /** Reports the hop being worked on when there is more than one. */
  onHop?(label: string): void;
}

export function discoverAgent(): string | null {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    return existsSync(pipe) ? pipe : 'pageant';
  }
  return null;
}

export function resolveKeyPath(reference: string): string {
  if (reference === '~') return homedir();
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return join(homedir(), reference.slice(2));
  return reference;
}

/** Connection level errors from sockets and ssh2, translated without echoing server-supplied detail blindly. */
export function translateConnectionError(error: Error & { code?: string; level?: string }, label: string): SessionFailure {
  switch (error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new SessionFailure('DNS_FAILED', `Hostname von ${label} konnte nicht aufgelöst werden.`);
    case 'ECONNREFUSED':
      return new SessionFailure('CONNECTION_REFUSED', `${label} hat die Verbindung abgelehnt. Läuft dort ein SSH-Dienst?`);
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new SessionFailure('CONNECTION_TIMEOUT', `${label} ist nicht erreichbar.`);
    case 'ECONNRESET':
    case 'EPIPE':
      return new SessionFailure('CONNECTION_LOST', `Die Verbindung zu ${label} wurde unterbrochen.`);
  }
  if (error.level === 'client-authentication') {
    return new SessionFailure('AUTH_FAILED', `Anmeldung an ${label} fehlgeschlagen.`);
  }
  if (error.level === 'client-timeout') {
    return new SessionFailure('CONNECTION_LOST', `${label} antwortet nicht mehr (Keepalive-Timeout).`);
  }
  return new SessionFailure('UNKNOWN', `Verbindung zu ${label} fehlgeschlagen: ${error.message}`);
}

type NextAuth = (
  method: NoAuthMethod | PasswordAuthMethod | PublicKeyAuthMethod | AgentAuthMethod | KeyboardInteractiveAuthMethod | false
) => void;

/** One authenticated ssh2 client: host key verification, credentials and the connect watchdog of one server. */
class Hop {
  readonly client = new Client();
  private established = false;
  private closed = false;
  private rejection: SessionFailure | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private watchdogExpired: (() => void) | null = null;
  private pendingRemember: { kind: SecretKind; value: string } | null = null;
  private secretAttempts = 0;
  private triedCredential = false;
  private triedKeyboard = false;
  private storedSecretFailed = false;
  private abortStart: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly config: HopConfig,
    private readonly shared: SshConnectionDeps
  ) {}

  private get label(): string {
    return this.config.label;
  }

  connect(
    sock: Duplex | undefined,
    hooks: { onAuthenticating?(): void; onLost(failure: SessionFailure): void }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const { client } = this;
      let settled = false;

      const fail = (failure: SessionFailure): void => {
        this.clearWatchdog();
        if (!settled) {
          settled = true;
          reject(failure);
        }
        client.destroy();
      };
      // Closing a pane mid-connect must settle the pending start, otherwise the caller waits forever.
      this.abortStart = () => {
        if (!settled) {
          settled = true;
          reject(new SessionFailure('AUTH_CANCELLED', 'Verbindungsaufbau abgebrochen.'));
        }
      };
      this.watchdogExpired = () => {
        fail(new SessionFailure('CONNECTION_TIMEOUT', `Zeitüberschreitung beim Verbinden mit ${this.label}.`));
      };
      this.armWatchdog();

      client.on('handshake', () => hooks.onAuthenticating?.());

      client.on('ready', () => {
        this.clearWatchdog();
        this.commitRememberedSecret();
        this.established = true;
        settled = true;
        resolve();
      });

      client.on('error', (error: Error & { code?: string; level?: string }) => {
        const failure = this.rejection ?? translateConnectionError(error, this.label);
        if (this.established) {
          this.reportLost(failure, hooks.onLost);
          return;
        }
        fail(failure);
      });

      client.on('close', () => {
        this.clearWatchdog();
        if (this.established) {
          // The transport went away while in use: that is a lost connection, not an exit.
          this.reportLost(
            new SessionFailure('CONNECTION_LOST', `Die Verbindung zu ${this.label} wurde unterbrochen.`),
            hooks.onLost
          );
          return;
        }
        fail(
          this.rejection ?? new SessionFailure('CONNECTION_LOST', `${this.label} hat die Verbindung vorzeitig beendet.`)
        );
      });

      const { hostname, port, username, authMethod } = this.config;
      if (authMethod === 'agent' && !(this.shared.agent ?? discoverAgent())) {
        fail(new SessionFailure('AGENT_UNAVAILABLE', 'Kein SSH-Agent gefunden (SSH_AUTH_SOCK ist nicht gesetzt).'));
        return;
      }

      const keepaliveMs = this.config.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
      client.connect({
        host: hostname,
        port,
        username,
        sock,
        // User decisions must not count against the handshake; `armWatchdog` replaces this timeout.
        readyTimeout: 0,
        keepaliveInterval: keepaliveMs,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          void this.verifyHost(key).then(verify);
        },
        authHandler: (methodsLeft, _partial, next) => {
          void this.nextAuth(methodsLeft, next as NextAuth);
        }
      } as ConnectConfig);
    });
  }

  private reportLost(failure: SessionFailure, onLost: (failure: SessionFailure) => void): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    onLost(failure);
  }

  forward(hostname: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, hostname, port, (error, channel) => {
        if (error) {
          reject(
            new SessionFailure('CONNECTION_REFUSED', `${this.label} erreicht ${hostname}:${port} nicht: ${error.message}`)
          );
          return;
        }
        resolve(channel);
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearWatchdog();
    this.pendingRemember = null;
    this.abortStart?.();
    this.client.removeAllListeners();
    // A socket error may still surface while tearing down.
    this.client.on('error', () => undefined);
    this.client.destroy();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(
      () => this.watchdogExpired?.(),
      this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    );
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** The connect timeout runs only while waiting on the network, never while the user decides. */
  private async ask(request: Parameters<Prompter>[0]): ReturnType<Prompter> {
    this.clearWatchdog();
    try {
      return await this.shared.prompt(request);
    } finally {
      if (!this.established && !this.disposed) this.armWatchdog();
    }
  }

  private async verifyHost(blob: Buffer): Promise<boolean> {
    const { hostname, port } = this.config;
    const presented = describeHostKey(blob);
    const verdict = verifyHostKey(this.shared.trust, hostname, port, presented);
    switch (verdict.status) {
      case 'trusted':
        return true;
      case 'revoked':
        this.rejection = new SessionFailure(
          'HOST_KEY_REVOKED',
          `Der Host-Schlüssel von ${this.label} ist in known_hosts als widerrufen markiert (${presented.fingerprint}).`
        );
        return false;
      case 'mismatch':
        this.rejection = new SessionFailure(
          'HOST_KEY_MISMATCH',
          `WARNUNG: Der Host-Schlüssel von ${this.label} hat sich geändert! Erwartet ${verdict.expectedFingerprint}, ` +
            `erhalten ${presented.fingerprint}. Verbindung blockiert – es könnte ein Man-in-the-Middle-Angriff vorliegen. ` +
            (verdict.source === 'ryft'
              ? 'Ersetze den Schlüssel nur, wenn du die Änderung auf einem anderen Weg bestätigt hast.'
              : `Falls die Änderung erwartet ist, entferne den Eintrag mit „ssh-keygen -R ${hostname}“.`),
          {
            host: hostname,
            port,
            keyType: presented.keyType,
            expectedFingerprint: verdict.expectedFingerprint,
            presentedFingerprint: presented.fingerprint,
            source: verdict.source === 'ryft' ? 'ryft' : 'openssh',
            changeId:
              verdict.source === 'ryft'
                ? (this.shared.registerHostKeyChange?.({ host: hostname, port, ...presented }) ?? null)
                : null
          }
        );
        return false;
      case 'unknown': {
        const response = await this.ask({
          kind: 'hostKey',
          host: hostname,
          port,
          keyType: presented.keyType,
          fingerprint: presented.fingerprint,
          otherTypesKnown: verdict.otherTypesKnown
        });
        if (response.kind !== 'hostKey') {
          this.rejection = new SessionFailure(
            'HOST_KEY_REJECTED',
            `Der Host-Schlüssel von ${this.label} wurde nicht bestätigt.`
          );
          return false;
        }
        if (response.trust === 'always') {
          this.shared.rememberHostKey({ host: hostname, port, ...presented });
        }
        return true;
      }
    }
  }

  private async nextAuth(methodsLeft: AuthenticationType[] | null, next: NextAuth): Promise<void> {
    if (this.disposed) return;
    const host = this.config;
    // Ask the server what it accepts first, so that nobody gets prompted for a method it would refuse.
    if (methodsLeft === null) {
      next({ type: 'none', username: host.username });
      return;
    }
    const serverAllows = (method: AuthenticationType): boolean => methodsLeft.includes(method);
    try {
      // A failed attempt with a credential the user typed or stored gets a new prompt, not a dead end.
      if (host.authMethod === 'password' && serverAllows('password')) {
        const password = await this.nextSecret('password', `Passwort für ${host.username}@${host.hostname}`);
        if (password !== null) {
          next({ type: 'password', username: host.username, password });
          return;
        }
      }

      if (host.authMethod === 'key' && !this.triedCredential && serverAllows('publickey')) {
        this.triedCredential = true;
        const key = await this.loadPrivateKey();
        next({ type: 'publickey', username: host.username, key });
        return;
      }

      if (host.authMethod === 'agent' && !this.triedCredential && serverAllows('publickey')) {
        this.triedCredential = true;
        const agent = this.shared.agent ?? discoverAgent();
        if (!agent) throw new SessionFailure('AGENT_UNAVAILABLE', 'Kein SSH-Agent gefunden.');
        next({ type: 'agent', username: host.username, agent });
        return;
      }

      // Servers using 2FA or PAM ask through keyboard-interactive, also as second factor after a key.
      if (!this.triedKeyboard && serverAllows('keyboard-interactive')) {
        this.triedKeyboard = true;
        next({
          type: 'keyboard-interactive',
          username: host.username,
          prompt: (name, instructions, _lang, prompts, finish) => {
            void this.ask({
              kind: 'keyboardInteractive',
              label: `${host.username}@${host.hostname}`,
              // Servers use either field for their explanation, for example the name of the second factor.
              instructions: [name, instructions].filter(Boolean).join('\n'),
              prompts: prompts.map((item) => ({ prompt: item.prompt, echo: item.echo === true }))
            }).then((response) => {
              if (response.kind === 'answers') {
                finish(response.answers);
              } else {
                this.rejection = new SessionFailure('AUTH_CANCELLED', 'Anmeldung abgebrochen.');
                finish([]);
              }
            });
          }
        });
        return;
      }

      if (!this.rejection) {
        this.rejection = new SessionFailure(
          'AUTH_FAILED',
          host.authMethod === 'agent'
            ? `Der SSH-Agent konnte sich an ${this.label} nicht anmelden.`
            : `Anmeldung an ${this.label} fehlgeschlagen.`
        );
      }
      next(false);
    } catch (error) {
      this.rejection =
        error instanceof SessionFailure
          ? error
          : new SessionFailure('UNKNOWN', `Anmeldung fehlgeschlagen: ${(error as Error).message}`);
      next(false);
    }
  }

  /** Returns the next credential to try; null when attempts are exhausted. Throws when the user cancels. */
  private async nextSecret(kind: SecretKind, label: string): Promise<string | null> {
    this.secretAttempts += 1;
    if (this.secretAttempts === 1) {
      const stored = this.config.getSecret(kind);
      if (stored !== null) {
        this.storedSecretFailed = true;
        return stored;
      }
    }
    // The very first attempt with a stored secret does not count against the typed attempts.
    if (this.secretAttempts > MAX_SECRET_ATTEMPTS + (this.storedSecretFailed ? 1 : 0)) {
      this.rejection = new SessionFailure('AUTH_FAILED', `Anmeldung an ${this.label} fehlgeschlagen: zu viele Versuche.`);
      return null;
    }
    const response = await this.ask({
      kind,
      label,
      retry: this.secretAttempts > 1,
      canRemember: this.shared.vaultAvailable()
    });
    if (response.kind !== 'secret') {
      throw new SessionFailure('AUTH_CANCELLED', 'Anmeldung abgebrochen.');
    }
    this.pendingRemember = response.remember ? { kind, value: response.value } : null;
    return response.value;
  }

  private async loadPrivateKey(): Promise<ParsedKey> {
    const reference = this.config.keyReference;
    if (!reference) throw new SessionFailure('KEY_UNREADABLE', 'Für diesen Host ist keine Schlüsseldatei hinterlegt.');
    const path = resolveKeyPath(reference);
    let material: Buffer;
    try {
      if (statSync(path).size > MAX_KEY_FILE_BYTES) throw new Error('too large');
      material = readFileSync(path);
    } catch {
      throw new SessionFailure('KEY_UNREADABLE', `Schlüsseldatei „${path}“ konnte nicht gelesen werden.`);
    }

    let parsed = utils.parseKey(material);
    if (!(parsed instanceof Error)) return firstKey(parsed);
    if (!isPassphraseError(parsed)) {
      throw new SessionFailure('KEY_UNREADABLE', `„${path}“ ist kein unterstützter privater SSH-Schlüssel.`);
    }

    const stored = this.config.getSecret('passphrase');
    if (stored !== null) {
      parsed = utils.parseKey(material, stored);
      if (!(parsed instanceof Error)) return firstKey(parsed);
    }
    for (let attempt = 0; attempt < MAX_SECRET_ATTEMPTS; attempt += 1) {
      const response = await this.ask({
        kind: 'passphrase',
        label: `Passphrase für ${path}`,
        retry: attempt > 0 || stored !== null,
        canRemember: this.shared.vaultAvailable()
      });
      if (response.kind !== 'secret') throw new SessionFailure('AUTH_CANCELLED', 'Anmeldung abgebrochen.');
      parsed = utils.parseKey(material, response.value);
      if (!(parsed instanceof Error)) {
        this.pendingRemember = response.remember ? { kind: 'passphrase', value: response.value } : null;
        return firstKey(parsed);
      }
    }
    throw new SessionFailure('AUTH_FAILED', 'Falsche Passphrase: zu viele Versuche.');
  }

  /** Secrets chosen to be remembered are stored only after they were proven to work. */
  private commitRememberedSecret(): void {
    const pending = this.pendingRemember;
    this.pendingRemember = null;
    if (!pending) return;
    try {
      this.config.setSecret(pending.kind, pending.value);
    } catch {
      // Vault became unavailable: the session still works, the user will be asked again next time.
    }
  }
}

/**
 * An authenticated route to the target, directly or through jump hosts. Every hop verifies its own
 * host key and authenticates on its own, and losing any hop means losing the whole route.
 */
export class SshConnection {
  private readonly hops: Hop[] = [];
  private readonly lostListeners = new Set<(failure: SessionFailure) => void>();
  private readonly abort = new AbortController();
  private disposed = false;
  private isLost = false;

  constructor(private readonly deps: SshConnectionDeps) {}

  /** The authenticated client of the target. Only valid after `connect` resolved. */
  get client(): Client {
    const last = this.hops[this.hops.length - 1];
    if (!last) throw new Error('Not connected');
    return last.client;
  }

  async connect(hooks: ConnectionHooks = {}): Promise<Client> {
    const { hops: configs, proxy } = this.deps;
    let sock: Duplex | undefined;
    for (const [index, config] of configs.entries()) {
      if (this.disposed) throw new SessionFailure('AUTH_CANCELLED', 'Verbindungsaufbau abgebrochen.');
      const isTarget = index === configs.length - 1;
      if (configs.length > 1) hooks.onHop?.(config.label);
      const hop = new Hop(config, this.deps);
      this.hops.push(hop);
      try {
        if (index === 0 && proxy && proxy.type !== 'none') {
          sock = await openProxySocket(proxy, config.hostname, config.port, this.abort.signal);
        }
        await hop.connect(sock, {
          onAuthenticating: isTarget ? hooks.onAuthenticating : undefined,
          onLost: (failure) => this.handleLost(isTarget ? failure : withHopPrefix(failure, config.label))
        });
        const following = configs[index + 1];
        if (following) sock = await hop.forward(following.hostname, following.port);
      } catch (error) {
        this.disposeHops();
        throw !isTarget && error instanceof SessionFailure ? withHopPrefix(error, config.label) : error;
      }
    }
    return this.client;
  }

  onLost(listener: (failure: SessionFailure) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** Ends the session politely; only the transport going away afterwards tears down the rest. */
  end(): void {
    this.isLost = true;
    const last = this.hops[this.hops.length - 1];
    if (!last) return;
    last.client.once('close', () => this.disposeHops());
    last.client.end();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.lostListeners.clear();
    this.disposeHops();
  }

  private handleLost(failure: SessionFailure): void {
    if (this.isLost || this.disposed) return;
    this.isLost = true;
    for (const listener of [...this.lostListeners]) listener(failure);
    this.disposeHops();
  }

  private disposeHops(): void {
    for (const hop of this.hops.splice(0).reverse()) hop.dispose();
  }
}

function withHopPrefix(failure: SessionFailure, label: string): SessionFailure {
  return new SessionFailure(failure.code, `Sprunghost ${label}: ${failure.message}`, failure.hostKeyChange);
}

/** ssh2 returns an array for files holding several keys. */
function firstKey(parsed: ParsedKey | ParsedKey[]): ParsedKey {
  return Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
}

function isPassphraseError(error: Error): boolean {
  return /encrypted|passphrase/i.test(error.message);
}
