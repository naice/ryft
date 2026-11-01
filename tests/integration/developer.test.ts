import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DockerEndpoint, PromptResponse, SessionPrompt } from '@shared/contracts';
import type { AiChunkEvent, AiMessage } from '@shared/features/ai';
import type { SessionLogStateEvent } from '@shared/features/sessionLogs';
import { AiError } from '../../src/main/ai/aiProvider';
import { AiService, type AiSettings } from '../../src/main/ai/aiService';
import { OllamaProvider } from '../../src/main/ai/ollamaProvider';
import { remoteSetupLine } from '../../src/main/history/shellIntegration';
import { DockerError } from '../../src/main/docker/dockerService';
import { SessionLogError, SessionLogger, type SessionLogSettings } from '../../src/main/logging/sessionLogger';
import { openDatabase } from '../../src/main/storage/database';
import { WslService } from '../../src/main/wsl/wslService';
import { createHarness, hostInput, OWNER, type Harness } from '../fixtures/harness';
import { OllamaFixture } from '../fixtures/ollamaFixture';
import { SshFixture } from '../fixtures/sshServer';

async function waitUntil<T>(probe: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((done) => setTimeout(done, 25));
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Ollama provider against the protocol fixture', () => {
  let fixture: OllamaFixture;
  let chunks: AiChunkEvent[];
  let settings: AiSettings;
  let service: AiService;
  const run = (prompt = 'Frage', context: string | null = null) =>
    service.run(OWNER, { requestId: randomUUID(), task: 'command', prompt, context });

  beforeEach(async () => {
    fixture = new OllamaFixture();
    await fixture.listen();
    chunks = [];
    settings = { aiEnabled: true, aiEndpoint: fixture.url, aiModel: 'tiny:1' };
    service = new AiService(() => settings, { aiChunk: (event) => chunks.push(event) });
  });

  afterEach(async () => {
    service.disposeAll();
    await fixture.close();
  });

  it('discovers models without assuming a specific one', async () => {
    fixture.models = ['whatever:latest'];
    expect(await service.models()).toEqual([{ name: 'whatever:latest', sizeBytes: 1000, family: 'fixture' }]);
  });

  it('streams an answer piece by piece and sends only what it was given', async () => {
    expect(await run('Liste Dateien', 'markierter Text')).toBe('done');
    expect(chunks.map((chunk) => chunk.text).join('')).toContain('echo ryft-from-model');
    expect(chunks.length).toBeGreaterThan(1);
    const request = fixture.requests[0];
    expect(request?.model).toBe('tiny:1');
    expect(request?.messages[1]?.content).toContain('Liste Dateien');
    expect(request?.messages[1]?.content).toContain('markierter Text');
    expect(service.activeRequests()).toBe(0);
  });

  it('cancels a running answer and closes the connection', async () => {
    fixture.hang = true;
    const requestId = randomUUID();
    const answer = service.run(OWNER, { requestId, task: 'explain', prompt: 'x', context: null });
    await waitUntil(() => chunks.length > 0);
    service.cancel(OWNER + 1, requestId);
    expect(service.activeRequests()).toBe(1);
    service.cancel(OWNER, requestId);
    await expect(answer).resolves.toBe('cancelled');
    await waitUntil(() => fixture.clientGone === 1);
    expect(service.activeRequests()).toBe(0);
  });

  it('does nothing at all while turned off', async () => {
    settings.aiEnabled = false;
    await expect(service.models()).rejects.toThrow(AiError);
    await expect(run()).rejects.toThrow('ausgeschaltet');
    expect(fixture.requests).toHaveLength(0);
  });

  it('refuses a remote endpoint even if one got into the settings', async () => {
    settings.aiEndpoint = 'https://api.example.com';
    await expect(run()).rejects.toThrow('lokale Adressen');
  });

  it('needs a chosen model instead of guessing one', async () => {
    settings.aiModel = null;
    await expect(run()).rejects.toThrow('Modell');
    expect(fixture.requests).toHaveLength(0);
  });

  it('does not follow a redirect away from the checked address', async () => {
    const elsewhere = new OllamaFixture();
    await elsewhere.listen();
    fixture.redirectTo = `${elsewhere.url}/api/chat`;
    await expect(run()).rejects.toThrow(AiError);
    expect(elsewhere.requests).toHaveLength(0);
    await elsewhere.close();
  });

  it('explains an error and an unreachable service', async () => {
    fixture.errorStatus = 500;
    await expect(run()).rejects.toThrow('model not loaded');
    fixture.errorStatus = null;
    await fixture.close();
    await expect(run()).rejects.toThrow('nicht erreichbar');
    fixture = new OllamaFixture();
    await fixture.listen();
  });

  it('is not reachable through anything but text: the service has no way to run a command', () => {
    const members = Object.getOwnPropertyNames(AiService.prototype);
    expect(members.sort()).toEqual(['activeRequests', 'cancel', 'constructor', 'disposeAll', 'disposeOwner', 'models', 'provider', 'run']);
  });
});

describe('session log writer', () => {
  const NOW = 1_800_000_000_000;
  let directory: string;
  let db: DatabaseSync;
  let settings: SessionLogSettings;
  let states: SessionLogStateEvent[];
  let time: number;
  let logger: SessionLogger;
  const logDirectory = () => join(directory, 'logs');
  const create = () =>
    new SessionLogger({ db, directory: logDirectory(), settings: () => settings, sink: { sessionLogState: (event) => states.push(event) }, now: () => time });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ryft-log-test-'));
    db = openDatabase(join(directory, 'db.sqlite'));
    settings = { sessionLogDefault: false, sessionLogMaxMb: 500, sessionLogRetentionDays: 30 };
    states = [];
    time = NOW;
    logger = create();
  });

  afterEach(() => {
    logger.disposeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it('records nothing by default', () => {
    logger.sessionConnected('s', 'Host', 'ssh');
    logger.output('s', 'geheim');
    expect(logger.list()).toEqual([]);
    expect(states).toEqual([]);
  });

  it('follows the default when it is turned on, until someone says otherwise for that session', () => {
    settings.sessionLogDefault = true;
    logger.sessionConnected('s', 'Host', 'ssh');
    expect(logger.list()[0]?.active).toBe(true);
    logger.setRecording('s', false, 'Host', 'ssh');
    expect(logger.list()[0]?.active).toBe(false);
    logger.sessionConnected('s', 'Host', 'ssh');
    expect(logger.list()).toHaveLength(1);
    expect(states.map((state) => state.recording)).toEqual([true, false]);
  });

  it('exports structured events and clean text', () => {
    logger.setRecording('s', true, 'Host', 'ssh');
    logger.output('s', '\u001b[32mhallo\u001b[0m\r\n');
    logger.sessionState('s', 'reconnecting');
    logger.sessionEnded('s');
    const id = logger.list()[0]?.id as string;
    expect(logger.read(id, 'text')).toBe('hallo\n');
    const events = logger.read(id, 'jsonl').trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(['meta', 'output', 'state']);
    const summary = logger.list()[0];
    expect(summary?.endedAt).toBe(NOW);
    expect(summary?.sizeBytes).toBeGreaterThan(0);
  });

  it('searches across chunks, including a running log', async () => {
    logger.setRecording('a', true, 'Eins', 'ssh');
    logger.output('a', 'Feh');
    logger.output('a', 'ler in Zeile 3\nanderes\n');
    expect(await logger.search('FEHLER', 10)).toMatchObject([{ label: 'Eins', line: 'Fehler in Zeile 3' }]);
    logger.output('a', 'fehler zwei\nfehler drei\n');
    expect(await logger.search('fehler', 2)).toHaveLength(2);
    expect(await logger.search('gibtesnicht', 10)).toEqual([]);
  });

  it('will not delete a log being written, but one that is finished', () => {
    logger.setRecording('s', true, 'Host', 'ssh');
    const id = logger.list()[0]?.id as string;
    expect(() => logger.remove(id)).toThrow(SessionLogError);
    logger.sessionEnded('s');
    logger.remove(id);
    expect(logger.list()).toEqual([]);
    expect(readdirSync(logDirectory())).toEqual([]);
  });

  it('removes logs past their age and over the total size, oldest first, and leaves a running one', () => {
    settings.sessionLogRetentionDays = 1;
    logger.setRecording('old', true, 'Alt', 'ssh');
    logger.sessionEnded('old');
    time = NOW + 12 * 60 * 60 * 1000;
    logger.setRecording('running', true, 'Läuft', 'ssh');
    time = NOW + 30 * 60 * 60 * 1000;
    logger.setRecording('new', true, 'Neu', 'ssh');
    logger.sessionEnded('new');
    expect(logger.list().map((log) => log.label).sort()).toEqual(['Läuft', 'Neu']);

    settings.sessionLogMaxMb = 10;
    logger.output('running', 'x'.repeat(11 * 1024 * 1024));
    logger.read(logger.list().find((log) => log.active)?.id as string, 'jsonl');
    logger.enforceRetention();
    expect(logger.list().map((log) => log.label)).toEqual(['Läuft']);
  });

  it('marks a log as cut short instead of letting a flood fill the memory', () => {
    logger.setRecording('s', true, 'Host', 'ssh');
    const chunk = 'y'.repeat(1024 * 1024);
    for (let index = 0; index < 20; index += 1) logger.output('s', chunk);
    expect(logger.list()[0]?.truncated).toBe(true);
    logger.sessionEnded('s');
    const size = statSync(join(logDirectory(), `${logger.list()[0]?.id}.jsonl`)).size;
    expect(size).toBeLessThan(10 * 1024 * 1024);
    expect(logger.read(logger.list()[0]?.id as string, 'jsonl')).toContain('"type":"truncated"');
  });

  it('closes what a crash left open', () => {
    logger.setRecording('s', true, 'Host', 'ssh');
    const restarted = create();
    expect(restarted.list()[0]?.active).toBe(false);
    expect(restarted.list()[0]?.endedAt).toBe(NOW);
  });
});

describe('session logging through a real SSH session', () => {
  const PASSWORD = 'correct horse';
  let fixture: SshFixture;
  let harness: Harness;

  beforeAll(async () => {
    fixture = new SshFixture({ password: PASSWORD });
    await fixture.listen();
  });
  afterAll(() => fixture.close());
  beforeEach(() => {
    harness = createHarness({ dockerBinary: null, wslBinary: null });
    harness.answerPrompts((prompt: SessionPrompt): PromptResponse => {
      if (prompt.kind === 'hostKey') return { kind: 'hostKey', trust: 'once' };
      return { kind: 'secret', value: PASSWORD, remember: false };
    });
  });
  afterEach(() => {
    fixture.echoInput = true;
    harness.dispose();
  });

  async function connect(): Promise<string> {
    const host = harness.services.hosts.create(hostInput({ port: fixture.port, username: 'tester' }));
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
    await harness.waitForState(id, 'connected');
    return id;
  }

  it('keeps what the session shows and never what was typed', async () => {
    fixture.echoInput = false;
    const id = await connect();
    const { sessionLogs, sessions, labelOf } = harness.services;
    const target = sessions.targetOf(OWNER, id);
    sessionLogs.setRecording(id, true, labelOf(target), target.kind);
    sessions.write(OWNER, id, 'typed-secret-value\r');
    await waitUntil(() => fixture.received.includes('typed-secret-value'));
    for (const shell of fixture.openShells) shell.write('server-said-this\r\n');
    await harness.waitForOutput(id, /server-said-this/);
    await waitUntil(() => sessionLogs.read(sessionLogs.list()[0]?.id as string, 'text').includes('server-said-this'));
    const log = sessionLogs.list()[0]?.id as string;
    expect(sessionLogs.read(log, 'jsonl')).not.toContain('typed-secret-value');
    expect(harness.sessionLogStates.at(-1)).toMatchObject({ sessionId: id, recording: true });
  });

  it('ends the log with the session, and closing leaves no writer behind', async () => {
    const id = await connect();
    const { sessionLogs, sessions, labelOf } = harness.services;
    const target = sessions.targetOf(OWNER, id);
    sessionLogs.setRecording(id, true, labelOf(target), target.kind);
    sessions.close(OWNER, id);
    await waitUntil(() => sessionLogs.list()[0]?.active === false);
    expect(harness.sessionLogStates.at(-1)).toMatchObject({ sessionId: id, recording: false });
  });
});

describe('Docker adapter against a CLI stand-in', () => {
  const RUNNING = 'a'.repeat(64);
  const STOPPED = 'b'.repeat(64);
  const endpoint: DockerEndpoint = { distro: null, context: 'default' };
  let callLog: string;
  let directory: string;
  let harness: Harness;
  const calls = (): string[][] =>
    existsSync(callLog)
      ? readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
      : [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ryft-docker-test-'));
    callLog = join(directory, 'calls.log');
    process.env.FAKE_DOCKER_LOG = callLog;
    harness = createHarness({ dockerBinary: { file: process.execPath, args: [resolve('tests/fixtures/fakeDocker.cjs')] }, wslBinary: null });
  });

  afterEach(() => {
    harness.dispose();
    delete process.env.FAKE_DOCKER_LOG;
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  it('finds contexts and flags plain TCP to another machine, but not TLS', async () => {
    const status = await harness.services.docker.status();
    expect(status.available).toBe(true);
    expect(status.endpoints.map((item) => [item.endpoint.context, item.insecure, item.isCurrent])).toEqual([
      ['default', false, true],
      ['plain', true, false],
      ['secured', false, false]
    ]);
  });

  it('refuses to use an insecure context for anything', async () => {
    const plain = { distro: null, context: 'plain' };
    await expect(harness.services.docker.list(plain)).rejects.toThrow(DockerError);
    await expect(harness.services.docker.act(plain, RUNNING, 'stop')).rejects.toThrow('unverschlüsselt');
    expect(calls().some((call) => call.includes('plain') && call.includes('stop'))).toBe(false);
  });

  it('lists containers with the columns the view shows', async () => {
    const list = await harness.services.docker.list(endpoint);
    expect(list.map((item) => [item.name, item.image, item.state, item.ports, item.runningFor])).toEqual([
      ['web', 'nginx:1', 'running', '0.0.0.0:80->80/tcp', '2 hours ago'],
      ['job', 'busybox', 'exited', '', '3 days ago']
    ]);
  });

  it('runs lifecycle actions as argument arrays on the chosen context', async () => {
    for (const action of ['start', 'stop', 'restart'] as const) await harness.services.docker.act(endpoint, RUNNING, action);
    expect(calls().filter((call) => ['start', 'stop', 'restart'].includes(call[2] as string))).toEqual([
      ['--context', 'default', 'start', RUNNING],
      ['--context', 'default', 'stop', RUNNING],
      ['--context', 'default', 'restart', RUNNING]
    ]);
  });

  it('explains a container that is gone', async () => {
    await expect(harness.services.docker.act(endpoint, 'c'.repeat(64), 'stop')).rejects.toThrow('gibt es nicht mehr');
  });

  it('shows details without the values of the environment', async () => {
    const details = await harness.services.docker.inspect(endpoint, RUNNING);
    expect(details).toMatchObject({ name: 'web', environmentCount: 2, restartCount: 1, ports: ['0.0.0.0:80 → 80/tcp', '443/tcp'] });
    expect(JSON.stringify(details)).not.toContain('fake-env-secret');
  });

  it('streams logs from stdout and stderr, and stopping ends the process', async () => {
    const streamId = randomUUID();
    await harness.services.docker.startLogs(OWNER, streamId, endpoint, RUNNING, 50);
    const text = () => harness.dockerLogs.filter((event) => event.streamId === streamId).map((event) => event.data).join('');
    await waitUntil(() => /first line/.test(text()) && /from stderr/.test(text()) && /tick/.test(text()));
    expect(calls().at(-1)).toEqual(['--context', 'default', 'logs', '--follow', '--timestamps', '--tail', '50', RUNNING]);
    const pid = Number(/pid=(\d+)/.exec(text())?.[1]);
    expect(isAlive(pid)).toBe(true);

    harness.services.docker.stopLogs(OWNER + 1, streamId);
    expect(harness.services.docker.activeLogStreams()).toBe(1);
    harness.services.docker.stopLogs(OWNER, streamId);
    expect(harness.services.docker.activeLogStreams()).toBe(0);
    await waitUntil(() => !isAlive(pid));
    expect(harness.dockerLogEnds).toEqual([{ streamId, error: null }]);
  });

  it('ends log followers when their window goes away', async () => {
    const streamId = randomUUID();
    await harness.services.docker.startLogs(OWNER, streamId, endpoint, RUNNING, 10);
    const text = () => harness.dockerLogs.map((event) => event.data).join('');
    await waitUntil(() => /pid=\d+/.test(text()));
    const pid = Number(/pid=(\d+)/.exec(text())?.[1]);
    harness.services.docker.disposeOwner(OWNER);
    expect(harness.services.docker.activeLogStreams()).toBe(0);
    await waitUntil(() => !isAlive(pid));
  });

  it('opens an interactive shell through the terminal infrastructure', async () => {
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'docker', endpoint, containerId: RUNNING, containerName: 'web' }, 80, 24);
    await harness.waitForOutput(id, /in-container\$/);
    harness.services.sessions.write(OWNER, id, 'ping\r');
    await harness.waitForOutput(id, /seen:ping/);
    const exec = calls().find((call) => call[2] === 'exec');
    expect(exec?.slice(0, 6)).toEqual(['--context', 'default', 'exec', '--interactive', '--tty', RUNNING]);
    harness.services.sessions.close(OWNER, id);
  });

  it('says plainly that a stopped container has no shell', async () => {
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'docker', endpoint, containerId: STOPPED, containerName: 'job' }, 80, 24).catch(() => undefined);
    const failed = await harness.waitForState(id, 'failed');
    expect(failed.error?.message).toContain('läuft nicht');
  });

  it('reports a machine without Docker as such', async () => {
    const empty = createHarness({ dockerBinary: null, wslBinary: null });
    expect(await empty.services.docker.status()).toEqual({ available: false, endpoints: [], stoppedDistros: [], error: null });
    empty.dispose();
  });
});

describe('WSL detection without WSL', () => {
  it('reports it as unavailable', async () => {
    expect(await new WslService(null).status()).toEqual({ available: false, distros: [], error: null });
  });

  it('survives a binary that does not work', async () => {
    const status = await new WslService(join(tmpdir(), 'ryft-no-such-wsl.exe')).status();
    expect(status.available).toBe(false);
    expect(status.distros).toEqual([]);
  });
});

/** RYFT_TEST_WSL=<running distribution>. Reads only and opens one shell in it. */
const wslDistro = process.env.RYFT_TEST_WSL;
describe.skipIf(!wslDistro)('real WSL', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness({ dockerBinary: null });
  });
  afterEach(() => harness.dispose());

  it('detects the distribution', async () => {
    const status = await harness.services.wsl.status();
    expect(status.available).toBe(true);
    expect(status.distros.find((distro) => distro.name === wslDistro)).toMatchObject({ running: true });
  });

  it('runs two independent sessions in it', async () => {
    const [first, second] = [harness.sessionId(), harness.sessionId()];
    for (const id of [first, second]) await harness.services.sessions.open(OWNER, id, { kind: 'wsl', distro: wslDistro as string }, 80, 24);
    harness.services.sessions.write(OWNER, first, 'echo one-$((40+2))\r');
    harness.services.sessions.write(OWNER, second, 'echo two-$((50+5))\r');
    await harness.waitForOutput(first, /one-42/);
    await harness.waitForOutput(second, /two-55/);
    harness.services.sessions.close(OWNER, first);
    harness.services.sessions.write(OWNER, second, 'echo still-$((1+1))\r');
    await harness.waitForOutput(second, /still-2/);
  });

  // The line is typed into whatever shell the server starts, and one that is neither bash nor zsh must not choke on it.
  it('the SSH history setup line passes through a plain POSIX shell', () => {
    const script = `${remoteSetupLine('nonce').replace(/\r$/, '')}\necho survived-$((40+2))\n`;
    const output = execFileSync('wsl.exe', ['-d', wslDistro as string, '-e', 'dash', '-s'], { input: script, encoding: 'utf8' });
    expect(output.trim()).toBe('survived-42');
  });

  it('refuses a distribution that does not exist', async () => {
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'wsl', distro: 'no-such-distro' }, 80, 24).catch(() => undefined);
    await harness.waitForState(id, 'failed');
  });
});

/**
 * RYFT_TEST_DOCKER_WSL=<running distribution>, RYFT_TEST_DOCKER_IMAGE=<local image with sh>. Creates one
 * uniquely named, labelled container without a network, works only on that one and removes it again.
 */
const dockerDistro = process.env.RYFT_TEST_DOCKER_WSL;
const dockerImage = process.env.RYFT_TEST_DOCKER_IMAGE;
describe.skipIf(!dockerDistro || !dockerImage)('real Docker in WSL', () => {
  const name = `ryft-test-${randomUUID()}`;
  const cli = (...args: string[]) => execFileSync('wsl.exe', ['-d', dockerDistro as string, '--exec', 'docker', ...args], { encoding: 'utf8' }).trim();
  const endpoint: DockerEndpoint = { distro: dockerDistro as string, context: 'default' };
  let containerId: string;
  let harness: Harness;

  beforeAll(() => {
    containerId = cli(
      'run', '--detach', '--name', name, '--label', 'ryft-test=1', '--network', 'none', '--entrypoint', 'sh', dockerImage as string,
      '-c', 'echo ryft-container-log; while true; do sleep 1; done'
    );
  });
  afterAll(() => {
    cli('rm', '--force', name);
  });
  beforeEach(() => {
    harness = createHarness({ dockerBinary: null });
  });
  afterEach(() => harness.dispose());

  it('finds the context and lists the container as running', async () => {
    const status = await harness.services.docker.status();
    expect(status.endpoints.some((item) => item.endpoint.distro === dockerDistro && item.endpoint.context === 'default')).toBe(true);
    const list = await harness.services.docker.list(endpoint);
    expect(list.find((item) => item.name === name)).toMatchObject({ id: containerId, state: 'running' });
  });

  it('streams its logs and stops following on request', async () => {
    const streamId = randomUUID();
    await harness.services.docker.startLogs(OWNER, streamId, endpoint, containerId, 50);
    await waitUntil(() => harness.dockerLogs.map((event) => event.data).join('').includes('ryft-container-log'));
    harness.services.docker.stopLogs(OWNER, streamId);
    expect(harness.services.docker.activeLogStreams()).toBe(0);
  });

  it('opens an interactive shell inside', async () => {
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'docker', endpoint, containerId, containerName: name }, 80, 24);
    harness.services.sessions.write(OWNER, id, 'echo inside-$((20+1))\r');
    await harness.waitForOutput(id, /inside-21/, 30_000);
    harness.services.sessions.close(OWNER, id);
  }, 60_000);

  it('stops and starts it', async () => {
    await harness.services.docker.act(endpoint, containerId, 'stop');
    let list = await harness.services.docker.list(endpoint);
    expect(list.find((item) => item.id === containerId)?.state).toBe('exited');
    await harness.services.docker.act(endpoint, containerId, 'start');
    list = await harness.services.docker.list(endpoint);
    expect(list.find((item) => item.id === containerId)?.state).toBe('running');
  }, 90_000);
});

/** RYFT_TEST_OLLAMA_URL=<a local Ollama>. Reads the model list and stops the smallest model after its first words. */
const ollamaUrl = process.env.RYFT_TEST_OLLAMA_URL;
describe.skipIf(!ollamaUrl)('real Ollama', () => {
  it('discovers models and streams from whichever is smallest', async () => {
    const provider = new OllamaProvider(ollamaUrl as string);
    const models = await provider.listModels(AbortSignal.timeout(10_000));
    expect(models.length).toBeGreaterThan(0);
    const smallest = [...models].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0];
    const controller = new AbortController();
    const received: string[] = [];
    const messages: AiMessage[] = [{ role: 'user', content: 'Say OK.' }];
    await provider
      .chat(smallest?.name as string, messages, (text) => {
        received.push(text);
        controller.abort();
      }, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    expect(received.length).toBeGreaterThan(0);
  }, 180_000);
});

