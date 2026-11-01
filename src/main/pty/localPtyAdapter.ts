import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePty from 'node-pty';
import type { AdapterHooks, SessionAdapter } from '../sessions/types';
import { SessionFailure } from '../sessions/types';
import type { ShellDefinition } from './shells';

/** Variables of the host process that must not leak into user shells. */
const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL'];

function shellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_ENV.includes(key) && !key.startsWith('ELECTRON_RENDERER')) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export interface LocalPtyOptions {
  /** Falls back to the home folder when it does not exist (any more). */
  cwd?: string | null;
  env?: Record<string, string>;
  filterOutput?: (text: string) => string;
  /** Asynchronous checks that decide whether this program may start at all. */
  beforeStart?: () => Promise<void>;
}

export class LocalPtyAdapter implements SessionAdapter {
  private pty: nodePty.IPty | null = null;
  private disposables: nodePty.IDisposable[] = [];
  private disposed = false;
  readonly filterOutput?: (text: string) => string;

  constructor(
    private readonly shell: ShellDefinition,
    private readonly options: LocalPtyOptions = {}
  ) {
    this.filterOutput = options.filterOutput;
  }

  async start(hooks: AdapterHooks, size: { cols: number; rows: number }): Promise<void> {
    await this.options.beforeStart?.();
    if (this.disposed) return;
    let pty: nodePty.IPty;
    const { cwd } = this.options;
    try {
      pty = nodePty.spawn(this.shell.file, this.shell.args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: cwd && existsSync(cwd) ? cwd : homedir(),
        env: { ...shellEnvironment(), ...this.options.env }
      });
    } catch (error) {
      throw new SessionFailure(
        'SPAWN_FAILED',
        `Shell „${this.shell.label}“ konnte nicht gestartet werden: ${(error as Error).message}`
      );
    }
    this.pty = pty;
    this.disposables.push(
      pty.onData((data) => hooks.onData(data)),
      pty.onExit(({ exitCode }) => {
        this.pty = null;
        hooks.onEnd({ kind: 'exit', code: exitCode });
      })
    );
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows);
    } catch {
      // The process can exit between the check and the ioctl; the exit event handles that case.
    }
  }

  pause(): void {
    this.pty?.pause();
  }

  resume(): void {
    this.pty?.resume();
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    const pty = this.pty;
    this.pty = null;
    try {
      pty?.kill();
    } catch {
      // Already gone.
    }
  }
}
