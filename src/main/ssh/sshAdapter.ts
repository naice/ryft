import type { ClientChannel } from 'ssh2';
import type { AdapterHooks, SessionAdapter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';
import { SshConnection, type SshConnectionDeps } from './connection';

export { discoverAgent, resolveKeyPath, translateConnectionError } from './connection';

const DEFAULT_SHELL_TIMEOUT_MS = 20_000;

export interface SshAdapterDeps extends SshConnectionDeps {
  terminalType?: string;
  /** Requested for the shell; the server decides what it accepts (OpenSSH: AcceptEnv). */
  env?: Record<string, string>;
  /** How terminal bytes map to characters. The session manager decodes with the same setting. */
  encoding?: 'utf8' | 'latin1';
  /** Sent once the shell is up, only when the user switched this on for the host. */
  startupCommands?: string[];
  /** Written before anything else: the opt-in history hook and the folder of a workspace pane. */
  setupLines?: string[];
  filterOutput?(text: string): string;
  onHop?(label: string): void;
}

/** One pane on an SSH server: a dedicated connection with one shell channel. */
export class SshAdapter implements SessionAdapter {
  private readonly connection: SshConnection;
  private channel: ClientChannel | null = null;
  private disposed = false;
  private ended = false;
  private abortShell: ((failure: SessionFailure) => void) | null = null;
  readonly filterOutput?: (text: string) => string;

  constructor(private readonly deps: SshAdapterDeps) {
    this.connection = new SshConnection(deps);
    this.filterOutput = deps.filterOutput;
  }

  private get label(): string {
    return this.deps.hops[this.deps.hops.length - 1]?.label ?? 'Host';
  }

  async start(hooks: AdapterHooks, size: { cols: number; rows: number }): Promise<void> {
    this.connection.onLost((failure) => {
      if (this.ended || this.disposed) return;
      this.ended = true;
      hooks.onEnd({ kind: 'lost', error: failure.toSessionError() });
    });
    const client = await this.connection.connect({
      onAuthenticating: () => hooks.onAuthenticating(),
      onHop: this.deps.onHop
    });
    if (this.disposed) throw new SessionFailure('AUTH_CANCELLED', 'Verbindungsaufbau abgebrochen.');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SessionFailure('CONNECTION_TIMEOUT', `Zeitüberschreitung beim Verbinden mit ${this.label}.`)),
        this.deps.hops[this.deps.hops.length - 1]?.connectTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
      );
      this.abortShell = (failure) => {
        clearTimeout(timer);
        reject(failure);
      };
      const window = { term: this.deps.terminalType ?? 'xterm-256color', cols: size.cols, rows: size.rows };
      client.shell(window, { env: this.deps.env ?? {} }, (error, channel) => {
        clearTimeout(timer);
        this.abortShell = null;
        if (error) {
          reject(new SessionFailure('SHELL_FAILED', `Shell auf ${this.label} konnte nicht geöffnet werden: ${error.message}`));
          return;
        }
        if (this.disposed) {
          channel.close();
          return;
        }
        this.channel = channel;
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
          this.connection.end();
        });
        for (const line of this.deps.setupLines ?? []) this.write(line);
        for (const command of this.deps.startupCommands ?? []) this.write(`${command}\r`);
        resolve();
      });
    });
  }

  write(data: string): void {
    this.channel?.write(this.deps.encoding === 'latin1' ? Buffer.from(data, 'latin1') : data);
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
    this.abortShell?.(new SessionFailure('AUTH_CANCELLED', 'Verbindungsaufbau abgebrochen.'));
    this.abortShell = null;
    this.channel?.removeAllListeners();
    this.channel = null;
    this.connection.dispose();
  }
}
