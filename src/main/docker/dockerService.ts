import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  isInsecureDockerUrl,
  type DockerAction,
  type DockerContainer,
  type DockerContainerDetails,
  type DockerEndpoint,
  type DockerEndpointInfo,
  type DockerLogEndEvent,
  type DockerLogEvent,
  type DockerStatus
} from '@shared/features/docker';
import type { ShellDefinition } from '../pty/shells';
import { SessionFailure } from '../sessions/types';
import type { WslService } from '../wsl/wslService';
import { explainDockerFailure, parseContainers, parseContexts, summarizeInspect } from './dockerParsers';

const CLI_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 90_000;
const LOG_FLUSH_MS = 60;
/** A chatty container cannot fill up memory: what the window has not taken yet is dropped from the front. */
const MAX_PENDING_LOG_CHARS = 1024 * 1024;
const OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface DockerEventSink {
  dockerLog(event: DockerLogEvent): void;
  dockerLogEnd(event: DockerLogEndEvent): void;
}

export interface DockerBinary {
  file: string;
  /** Leading arguments, so that tests can run the CLI stand-in through Node. */
  args: string[];
}

interface LogStream {
  ownerId: number;
  child: ChildProcess;
  pending: string;
  timer: NodeJS.Timeout | null;
}

/**
 * Adapter over the Docker CLI. It already knows the contexts, TLS material and remote transports of
 * the user, and RYFT opens no socket or endpoint of its own. Everything runs as an argument array,
 * never through a shell, and ids and names are validated before they get here.
 */
export class DockerService {
  private readonly streams = new Map<string, LogStream>();
  private readonly insecure = new Map<string, boolean>();

  constructor(
    private readonly binary: DockerBinary | null,
    private readonly wsl: WslService,
    private readonly sink: DockerEventSink
  ) {}

  async status(): Promise<DockerStatus> {
    const endpoints: DockerEndpointInfo[] = [];
    let error: string | null = null;
    if (this.binary) {
      try {
        endpoints.push(...(await this.endpointsOf(null)));
      } catch (failure) {
        error = (failure as Error).message;
      }
    }
    const stoppedDistros: string[] = [];
    for (const distro of await this.wsl.distros()) {
      if (!distro.running) {
        stoppedDistros.push(distro.name);
        continue;
      }
      // A distribution without Docker is the normal case.
      endpoints.push(...(await this.endpointsOf(distro.name).catch(() => [])));
    }
    return { available: endpoints.length > 0, endpoints, stoppedDistros, error: endpoints.length > 0 ? null : error };
  }

  /** Boots the distribution if necessary. Only ever called because the user asked for exactly this. */
  async probeDistro(distro: string): Promise<DockerEndpointInfo[]> {
    await this.wsl.assertDistro(distro);
    return this.endpointsOf(distro);
  }

  async list(endpoint: DockerEndpoint): Promise<DockerContainer[]> {
    await this.assertUsable(endpoint);
    return parseContainers(await this.run(endpoint, ['ps', '--all', '--no-trunc', '--format', '{{json .}}']));
  }

  async inspect(endpoint: DockerEndpoint, containerId: string): Promise<DockerContainerDetails> {
    await this.assertUsable(endpoint);
    const details = summarizeInspect(await this.run(endpoint, ['inspect', '--type', 'container', containerId]));
    if (!details) throw new DockerError('Docker hat keine lesbaren Details geliefert.');
    return details;
  }

  async act(endpoint: DockerEndpoint, containerId: string, action: DockerAction): Promise<void> {
    await this.assertUsable(endpoint);
    await this.run(endpoint, [action, containerId], ACTION_TIMEOUT_MS);
  }

  async startLogs(ownerId: number, streamId: string, endpoint: DockerEndpoint, containerId: string, tail: number): Promise<void> {
    await this.assertUsable(endpoint);
    this.stopLogs(ownerId, streamId);
    const { file, args } = this.command(endpoint, ['logs', '--follow', '--timestamps', '--tail', String(tail), containerId]);
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stream: LogStream = { ownerId, child, pending: '', timer: null };
    this.streams.set(streamId, stream);
    const accept = (chunk: Buffer) => {
      stream.pending = (stream.pending + chunk.toString('utf8')).slice(-MAX_PENDING_LOG_CHARS);
      stream.timer ??= setTimeout(() => {
        stream.timer = null;
        this.flushLogs(streamId, stream);
      }, LOG_FLUSH_MS);
    };
    child.stdout?.on('data', accept);
    child.stderr?.on('data', accept);
    child.once('error', () => this.endLogs(streamId, stream, 'Docker konnte nicht gestartet werden.'));
    child.once('close', (code) => this.endLogs(streamId, stream, code ? 'Der Log-Stream wurde mit einem Fehler beendet.' : null));
  }

  stopLogs(ownerId: number, streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.ownerId !== ownerId) return;
    this.release(streamId, stream);
    this.sink.dockerLogEnd({ streamId, error: null });
  }

  /** How many log followers are alive, for the leak checks of the tests. */
  activeLogStreams(): number {
    return this.streams.size;
  }

  /** Refuses a stopped container with a message that says so, instead of a cryptic exit of the CLI. */
  async assertRunning(endpoint: DockerEndpoint, containerId: string, label: string): Promise<void> {
    let running: string;
    try {
      await this.assertUsable(endpoint);
      running = await this.run(endpoint, ['inspect', '--type', 'container', '--format', '{{.State.Running}}', containerId]);
    } catch (error) {
      throw new SessionFailure('SPAWN_FAILED', (error as Error).message);
    }
    if (running.trim() !== 'true') throw new SessionFailure('SPAWN_FAILED', `Der Container „${label}“ läuft nicht. Starte ihn zuerst.`);
  }

  /** An interactive shell in the container, as a program the terminal infrastructure can run. */
  shellDefinitionUnchecked(endpoint: DockerEndpoint, containerId: string, label: string): ShellDefinition {
    const script = 'command -v bash >/dev/null 2>&1 && exec bash; exec sh';
    const { file, args } = this.command(endpoint, ['exec', '--interactive', '--tty', containerId, 'sh', '-c', script]);
    return { id: 'docker', label, file, args };
  }

  disposeOwner(ownerId: number): void {
    for (const [streamId, stream] of [...this.streams]) {
      if (stream.ownerId === ownerId) this.release(streamId, stream);
    }
  }

  disposeAll(): void {
    for (const [streamId, stream] of [...this.streams]) this.release(streamId, stream);
  }

  private async endpointsOf(distro: string | null): Promise<DockerEndpointInfo[]> {
    const contexts = parseContexts(await this.runRaw(distro, ['context', 'ls', '--format', '{{json .}}'], CLI_TIMEOUT_MS));
    const infos: DockerEndpointInfo[] = [];
    for (const context of contexts) {
      const endpoint = { distro, context: context.name };
      const insecure = isInsecureDockerUrl(context.url, await this.hasTls(distro, context.name, context.url));
      this.insecure.set(endpointKey(endpoint), insecure);
      infos.push({
        endpoint,
        label: distro ? `${context.name} (WSL: ${distro})` : context.name,
        url: context.url,
        isCurrent: context.isCurrent,
        insecure
      });
    }
    return infos;
  }

  private async hasTls(distro: string | null, context: string, url: string): Promise<boolean> {
    if (!/^(tcp|http):/i.test(url)) return false;
    const material = await this.runRaw(distro, ['context', 'inspect', context, '--format', '{{json .TLSMaterial}}'], CLI_TIMEOUT_MS).catch(() => '');
    return /docker/i.test(material);
  }

  private async assertUsable(endpoint: DockerEndpoint): Promise<void> {
    const key = endpointKey(endpoint);
    if (!this.insecure.has(key)) await this.endpointsOf(endpoint.distro);
    const insecure = this.insecure.get(key);
    if (insecure === undefined) throw new DockerError('Diesen Docker-Kontext gibt es nicht mehr.');
    if (insecure) throw new DockerError('Dieser Docker-Kontext nutzt unverschlüsseltes TCP zu einem anderen Rechner. RYFT verwendet ihn nicht.');
  }

  private command(endpoint: DockerEndpoint, args: string[]): DockerBinary {
    return this.resolve(endpoint.distro, ['--context', endpoint.context, ...args]);
  }

  private resolve(distro: string | null, args: string[]): DockerBinary {
    if (distro) {
      if (!this.wsl.binaryPath) throw new DockerError('WSL ist auf diesem System nicht verfügbar.');
      return { file: this.wsl.binaryPath, args: ['--distribution', distro, '--exec', 'docker', ...args] };
    }
    if (!this.binary) throw new DockerError('Die Docker-CLI wurde nicht gefunden.');
    return { file: this.binary.file, args: [...this.binary.args, ...args] };
  }

  private run(endpoint: DockerEndpoint, args: string[], timeout = CLI_TIMEOUT_MS): Promise<string> {
    return this.runRaw(endpoint.distro, ['--context', endpoint.context, ...args], timeout);
  }

  private runRaw(distro: string | null, args: string[], timeout: number): Promise<string> {
    const command = this.resolve(distro, args);
    return new Promise((resolve, reject) => {
      execFile(
        command.file,
        command.args,
        { windowsHide: true, timeout, maxBuffer: OUTPUT_LIMIT_BYTES, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const code = (error as NodeJS.ErrnoException).code;
          reject(new DockerError(code === 'ENOENT' ? 'Die Docker-CLI wurde nicht gefunden.' : explainDockerFailure(stderr)));
        }
      );
    });
  }

  private flushLogs(streamId: string, stream: LogStream): void {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    if (!stream.pending) return;
    const data = stream.pending;
    stream.pending = '';
    this.sink.dockerLog({ streamId, data });
  }

  private endLogs(streamId: string, stream: LogStream, error: string | null): void {
    if (this.streams.get(streamId) !== stream) return;
    this.flushLogs(streamId, stream);
    this.streams.delete(streamId);
    this.sink.dockerLogEnd({ streamId, error });
  }

  private release(streamId: string, stream: LogStream): void {
    this.streams.delete(streamId);
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    stream.child.stdout?.removeAllListeners('data');
    stream.child.stderr?.removeAllListeners('data');
    stream.child.kill();
  }
}

function endpointKey(endpoint: DockerEndpoint): string {
  return `${endpoint.distro ?? ''}|${endpoint.context}`;
}
