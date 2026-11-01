import { generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Connection, type ServerChannel } from 'ssh2';

export interface FixtureOptions {
  password?: string;
  authorizedKey?: string;
  keyboardAnswer?: string;
  /** Host key in OpenSSH format; generated when omitted so that a restart can simulate a key change. */
  hostKey?: string;
}

export function generateOpenSshKey(passphrase?: string): { privateKey: string; publicKey: string } {
  const pair = utils.generateKeyPairSync('ed25519', passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 4 } : {});
  return { privateKey: pair.private, publicKey: pair.public };
}

/** A pure in-process SSH server on 127.0.0.1 with real handshakes, used instead of any live host. */
export class SshFixture {
  readonly hostKey: string;
  private server: Server | null = null;
  private connections = new Set<Connection>();
  port = 0;
  /** Everything the shell channel received, to prove that input arrived. */
  received = '';
  lastPty: { cols: number; rows: number } | null = null;
  lastWindow: { cols: number; rows: number } | null = null;
  openShells: ServerChannel[] = [];

  constructor(private readonly options: FixtureOptions) {
    this.hostKey = options.hostKey ?? generateOpenSshKey().privateKey;
  }

  listen(port = 0): Promise<void> {
    const authorized = this.options.authorizedKey ? utils.parseKey(this.options.authorizedKey) : null;
    if (authorized instanceof Error) throw authorized;
    const server = new Server({ hostKeys: [this.hostKey] }, (client) => {
      this.connections.add(client);
      client.on('close', () => this.connections.delete(client));
      client.on('error', () => undefined);
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && this.options.password !== undefined) {
          if (ctx.password === this.options.password) ctx.accept();
          else ctx.reject(['password']);
          return;
        }
        if (ctx.method === 'publickey' && authorized) {
          const key = Array.isArray(authorized) ? authorized[0]! : authorized;
          const sameKey = ctx.key.algo === key.type && ctx.key.data.equals(key.getPublicSSH());
          if (!sameKey) return ctx.reject();
          if (ctx.signature && ctx.blob) {
            if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) ctx.accept();
            else ctx.reject();
          } else {
            ctx.accept();
          }
          return;
        }
        if (ctx.method === 'keyboard-interactive' && this.options.keyboardAnswer !== undefined) {
          ctx.prompt([{ prompt: 'Code: ', echo: false }], 'Zweiter Faktor', (answers) => {
            if (answers[0] === this.options.keyboardAnswer) ctx.accept();
            else ctx.reject();
          });
          return;
        }
        const methods: ('password' | 'publickey' | 'keyboard-interactive')[] = [];
        if (this.options.password !== undefined) methods.push('password');
        if (authorized) methods.push('publickey');
        if (this.options.keyboardAnswer !== undefined) methods.push('keyboard-interactive');
        ctx.reject(methods);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (acceptPty, _reject, info) => {
            this.lastPty = { cols: info.cols, rows: info.rows };
            acceptPty?.();
          });
          session.on('window-change', (acceptChange, _reject, info) => {
            this.lastWindow = { cols: info.cols, rows: info.rows };
            acceptChange?.();
          });
          session.on('shell', (acceptShell) => {
            const channel = acceptShell();
            this.openShells.push(channel);
            channel.write('fixture$ ');
            // Keystrokes arrive one by one from a real terminal.
            let typed = '';
            channel.on('data', (data: Buffer) => {
              const text = data.toString('utf8');
              this.received += text;
              typed += text;
              channel.write(text);
              if (typed.includes('exit')) {
                channel.exit(7);
                channel.close();
              }
            });
          });
        });
      });
    });
    this.server = server;
    return new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Cuts every transport without a clean channel close, like a network failure. */
  dropConnections(): void {
    for (const connection of this.connections) {
      (connection as unknown as { _sock: { destroy(): void } })._sock.destroy();
    }
  }

  async close(): Promise<void> {
    this.dropConnections();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function newRsaPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
}
