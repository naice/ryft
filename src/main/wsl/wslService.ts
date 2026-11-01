import { execFile } from 'node:child_process';
import { decodeWslOutput, parseWslList, type WslDistro, type WslStatus } from '@shared/features/wsl';
import { SessionFailure } from '../sessions/types';

const LIST_TIMEOUT_MS = 10_000;

function runWsl(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { encoding: 'buffer', windowsHide: true, timeout: LIST_TIMEOUT_MS, env: { ...process.env, WSL_UTF8: '1' } },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(decodeWslOutput(stdout));
      }
    );
  });
}

/** Listing only reads the state of WSL. It never boots a distribution, unlike running anything inside one. */
export class WslService {
  constructor(private readonly binary: string | null) {}

  get binaryPath(): string | null {
    return this.binary;
  }

  async status(): Promise<WslStatus> {
    if (!this.binary) return { available: false, distros: [], error: null };
    try {
      const [verbose, running] = await Promise.all([
        runWsl(this.binary, ['--list', '--verbose']),
        // Exits with an error when nothing runs, which is a perfectly good answer.
        runWsl(this.binary, ['--list', '--running', '--quiet']).catch(() => '')
      ]);
      return { available: true, distros: parseWslList(verbose, running), error: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, distros: [], error: null };
      return { available: true, distros: [], error: 'WSL meldet keine Distributionen.' };
    }
  }

  async distros(): Promise<WslDistro[]> {
    return (await this.status()).distros;
  }

  /** Throws unless the name is a distribution that exists right now. */
  async assertDistro(name: string): Promise<void> {
    if (!this.binary) throw new SessionFailure('SPAWN_FAILED', 'WSL ist auf diesem System nicht verfügbar.');
    const distros = await this.distros();
    if (!distros.some((distro) => distro.name === name)) {
      throw new SessionFailure('SPAWN_FAILED', `Die WSL-Distribution „${name}“ existiert nicht.`);
    }
  }
}
