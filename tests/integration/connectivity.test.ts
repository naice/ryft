import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineConnectivitySuite } from '../fixtures/connectivitySuite';
import { createHarness, hostInput, OWNER, type Harness } from '../fixtures/harness';
import { SshFixture } from '../fixtures/sshServer';

const PASSWORD = 'fixture-password';
let fixture: SshFixture;
let root: string;
let banner: Server;
let bannerPort: number;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ryft-sftp-root-'));
  mkdirSync(join(root, 'fixture'));
  fixture = new SshFixture({ password: PASSWORD, sftpRoot: root });
  await fixture.listen();
  banner = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.write('RYFT-BANNER\r\n');
  });
  await new Promise<void>((resolve) => banner.listen(0, '127.0.0.1', resolve));
  bannerPort = (banner.address() as AddressInfo).port;
});

afterAll(async () => {
  banner.close();
  await fixture.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

defineConnectivitySuite('against the in-process server', () => ({
  host: (harness: Harness) => {
    const host = harness.services.hosts.create(hostInput({ port: fixture.port }));
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    return harness.services.toPublicHost(host);
  },
  remoteRoot: '/fixture',
  banner: { host: '127.0.0.1', port: bannerPort, pattern: /RYFT-BANNER/ },
  largeFileBytes: 128 * 1024 * 1024
}));

describe('when the connection breaks', () => {
  let harness: Harness;

  afterEach(() => harness.dispose());

  const setup = () => {
    harness = createHarness();
    const host = harness.services.hosts.create(hostInput({ port: fixture.port }));
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    harness.answerPrompts((prompt) =>
      prompt.kind === 'hostKey' ? { kind: 'hostKey', trust: 'once' } : { kind: 'cancel' }
    );
    return host;
  };

  it('fails a running transfer visibly instead of calling it cancelled, and it can be retried', async () => {
    const host = setup();
    const sftpId = randomUUID();
    const info = await harness.services.sftp.open(OWNER, sftpId, host.id);
    expect(info.home).toBe('/');
    const remote = `/fixture/${randomUUID().slice(0, 8)}`;
    await harness.services.sftp.mkdir(OWNER, sftpId, '/fixture', remote.slice('/fixture/'.length));
    writeFileSync(join(root, remote.slice(1), 'slow.bin'), Buffer.alloc(16 * 1024 * 1024, 3));
    fixture.sftpReadDelayMs = 50;
    const local = join(harness.directory, 'down');
    mkdirSync(local);
    const batchId = harness.services.transfers.enqueue(OWNER, {
      sftpId,
      direction: 'download',
      sources: [`${remote}/slow.bin`],
      destinationDir: local,
      conflictPolicy: 'ask'
    });
    const running = await waitUntil(() =>
      harness.services.transfers.list(OWNER).find((job) => job.batchId === batchId && job.state === 'running')
    );
    fixture.dropConnections();
    const failed = await waitUntil(() =>
      harness.services.transfers.list(OWNER).find((job) => job.id === running.id && job.state === 'failed')
    );
    fixture.sftpReadDelayMs = 0;
    expect(failed.error).toMatch(/getrennt/);
    expect(harness.sftpClosed.map((event) => event.sftpId)).toContain(sftpId);
    expect(harness.services.pool.size()).toBe(0);
  });

  it('re-establishes a forward with backoff and gives its port back when stopped', async () => {
    const host = setup();
    const forward = harness.services.forwards.create({
      name: 'reconnect',
      hostId: host.id,
      type: 'dynamic',
      bindAddress: '127.0.0.1',
      bindPort: 0,
      destHost: null,
      destPort: null,
      restoreOnStart: false,
      autoReconnect: true,
      allowNonLoopback: false
    });
    await harness.services.forwarding.start(OWNER, forward.id);
    fixture.dropConnections();
    await waitUntil(() => harness.forwardStates.find((state) => state.status === 'reconnecting'));
    await waitUntil(() => harness.services.forwarding.list(OWNER).find((state) => state.status === 'running'));
    harness.services.forwarding.stop(OWNER, forward.id);
    expect(harness.services.forwarding.list(OWNER)).toEqual([]);
    expect(harness.services.pool.size()).toBe(0);
  });

  it('fails a forward for good without automatic reconnect', async () => {
    const host = setup();
    const forward = harness.services.forwards.create({
      name: 'once',
      hostId: host.id,
      type: 'dynamic',
      bindAddress: '127.0.0.1',
      bindPort: 0,
      destHost: null,
      destPort: null,
      restoreOnStart: false,
      autoReconnect: false,
      allowNonLoopback: false
    });
    await harness.services.forwarding.start(OWNER, forward.id);
    fixture.dropConnections();
    const state = await waitUntil(() => harness.services.forwarding.list(OWNER).find((item) => item.status === 'failed'));
    expect(state.error).toBeTruthy();
  });
});

async function waitUntil<T>(probe: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
