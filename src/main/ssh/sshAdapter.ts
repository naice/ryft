import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  utils,
  type AgentAuthMethod,
  type AuthenticationType,
  type BaseAgent,
  type ClientChannel,
  type ConnectConfig,
  type KeyboardInteractiveAuthMethod,
  type NoAuthMethod,
  type ParsedKey,
  type PasswordAuthMethod,
  type PublicKeyAuthMethod
} from 'ssh2';
import type { Host, SecretKind } from '@shared/contracts';
import { describeHostKey, verifyHostKey, type HostKeyTrustSource } from '../security/knownHosts';
import type { AdapterHooks, Prompter, SessionAdapter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';

const MAX_KEY_FILE_BYTES = 1024 * 1024;
const MAX_SECRET_ATTEMPTS = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

export interface SshAdapterDeps {
  host: Pick<Host, 'id' | 'name' | 'hostname' | 'port' | 'username' | 'authMethod' | 'keyReference'>;
  trust: HostKeyTrustSource;
  /** Persists an explicit "always trust" decision. */
  rememberHostKey(entry: { host: string; port: number; keyType: string; keyBase64: string; fingerprint: string }): void;
  getSecret(kind: SecretKind): string | null;
  setSecret(kind: SecretKind, value: string): void;
  vaultAvailable(): boolean;
  prompt: Prompter;
  /** Overrides agent discovery; a path/pipe name or an agent instance. */
  agent?: string | BaseAgent;
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
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

export class SshAdapter implements SessionAdapter {
  private client: Client | null = null;
  private channel: ClientChannel | null = null;
  private disposed = false;
  private established = false;
  private ended = false;
  private rejection: SessionFailure | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private watchdogExpired: (() => void) | null = null;
  private pendingRemember: { kind: SecretKind; value: string } | null = null;
  private secretAttempts = 0;
  private triedCredential = false;
  private triedKeyboard = false;
  private storedSecretFailed = false;
  private abortStart: (() => void) | null = null;

  constructor(private readonly deps: SshAdapterDeps) {}

  private get label(): string {
    return this.deps.host.name;
  }

  start(hooks: AdapterHooks, size: { cols: number; rows: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
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

      client.on('handshake', () => hooks.onAuthenticating());

      client.on('ready', () => {
        this.commitRememberedSecret();
        client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (error, channel) => {
          this.clearWatchdog();
          if (error) {
            fail(new SessionFailure('SHELL_FAILED', `Shell auf ${this.label} konnte nicht geöffnet werden: ${error.message}`));
            return;
          }
          if (this.disposed) {
            channel.close();
            return;
          }
          this.channel = channel;
          this.established = true;
          let exitCode: number | null = null;
          channel.on('data', (data: Buffer) => hooks.onData(data));
          channel.stderr.on('data', (data: Buffer) => hooks.onData(data));
          channel.on('exit', (code: number | null) => {
            exitCode = typeof code === 'number' ? code : null;
          });
          channel.on('close', () => {
            this.channel = null;
            if (!this.ended) {
              this.ended = true;
              hooks.onEnd({ kind: 'exit', code: exitCode });
            }
            client.end();
          });
          settled = true;
          resolve();
        });
      });

      client.on('error', (error: Error & { code?: string; level?: string }) => {
        const failure = this.rejection ?? translateConnectionError(error, this.label);
        if (this.established) {
          if (!this.ended && !this.disposed) {
            this.ended = true;
            hooks.onEnd({ kind: 'lost', error: failure.toSessionError() });
          }
          return;
        }
        fail(failure);
      });

      client.on('close', () => {
        this.clearWatchdog();
        if (this.established) {
          // The transport went away while the channel was open: that is a lost connection, not an exit.
          if (!this.ended && !this.disposed) {
            this.ended = true;
            hooks.onEnd({
              kind: 'lost',
              error: { code: 'CONNECTION_LOST', message: `Die Verbindung zu ${this.label} wurde unterbrochen.` }
            });
          }
          return;
        }
        fail(
          this.rejection ?? new SessionFailure('CONNECTION_LOST', `${this.label} hat die Verbindung vorzeitig beendet.`)
        );
      });

      const { hostname, port, username, authMethod } = this.deps.host;
      if (authMethod === 'agent' && !(this.deps.agent ?? discoverAgent())) {
        fail(new SessionFailure('AGENT_UNAVAILABLE', 'Kein SSH-Agent gefunden (SSH_AUTH_SOCK ist nicht gesetzt).'));
        return;
      }

      client.connect({
        host: hostname,
        port,
        username,
        // User decisions must not count against the handshake; `armWatchdog` replaces this timeout.
        readyTimeout: 0,
        keepaliveInterval: this.deps.keepaliveIntervalMs ?? 15_000,
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

  write(data: string): void {
    this.channel?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.channel?.setWindow(rows, cols, 0, 0);
  }

  pause(): void {
    this.channel?.pause();
  }

  resume(): void {
    this.channel?.resume();
  }

  dispose(): void {
    this.disposed = true;
    this.clearWatchdog();
    this.pendingRemember = null;
    this.abortStart?.();
    this.channel?.removeAllListeners();
    this.channel = null;
    const client = this.client;
    this.client = null;
    client?.removeAllListeners();
    // A socket error may still surface while tearing down.
    client?.on('error', () => undefined);
    client?.destroy();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(
      () => this.watchdogExpired?.(),
      this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
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
      return await this.deps.prompt(request);
    } finally {
      if (!this.established && !this.disposed) this.armWatchdog();
    }
  }

  private async verifyHost(blob: Buffer): Promise<boolean> {
    const { hostname, port } = this.deps.host;
    const presented = describeHostKey(blob);
    const verdict = verifyHostKey(this.deps.trust, hostname, port, presented);
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
              ? 'Falls die Änderung erwartet ist, entferne den Eintrag unter Einstellungen › Bekannte Hosts.'
              : `Falls die Änderung erwartet ist, entferne den Eintrag mit „ssh-keygen -R ${hostname}“.`)
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
          this.deps.rememberHostKey({ host: hostname, port, ...presented });
        }
        return true;
      }
    }
  }

  private async nextAuth(methodsLeft: AuthenticationType[] | null, next: NextAuth): Promise<void> {
    if (this.disposed) return;
    const { host } = this.deps;
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
        const agent = this.deps.agent ?? discoverAgent();
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
      const stored = this.deps.getSecret(kind);
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
      canRemember: this.deps.vaultAvailable()
    });
    if (response.kind !== 'secret') {
      throw new SessionFailure('AUTH_CANCELLED', 'Anmeldung abgebrochen.');
    }
    this.pendingRemember = response.remember ? { kind, value: response.value } : null;
    return response.value;
  }

  private async loadPrivateKey(): Promise<ParsedKey> {
    const reference = this.deps.host.keyReference;
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

    const stored = this.deps.getSecret('passphrase');
    if (stored !== null) {
      parsed = utils.parseKey(material, stored);
      if (!(parsed instanceof Error)) return firstKey(parsed);
    }
    for (let attempt = 0; attempt < MAX_SECRET_ATTEMPTS; attempt += 1) {
      const response = await this.ask({
        kind: 'passphrase',
        label: `Passphrase für ${path}`,
        retry: attempt > 0 || stored !== null,
        canRemember: this.deps.vaultAvailable()
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
      this.deps.setSecret(pending.kind, pending.value);
    } catch {
      // Vault became unavailable: the session still works, the user will be asked again next time.
    }
  }
}

/** ssh2 returns an array for files holding several keys. */
function firstKey(parsed: ParsedKey | ParsedKey[]): ParsedKey {
  return Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
}

function isPassphraseError(error: Error): boolean {
  return /encrypted|passphrase/i.test(error.message);
}
