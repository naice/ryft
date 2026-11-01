import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_HOST_OPTIONS, type PromptResponse, type SessionPrompt, type WorkspaceDefinition } from '@shared/contracts';
import { detectShells } from '../../src/main/pty/shells';
import { createHarness, hostInput, OWNER, type Harness } from '../fixtures/harness';
import { generateOpenSshKey, SshFixture } from '../fixtures/sshServer';

const PASSWORD = 'correct horse';

async function waitUntil<T>(probe: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function acceptKeys(prompt: SessionPrompt): PromptResponse {
  return prompt.kind === 'hostKey' ? { kind: 'hostKey', trust: 'once' } : { kind: 'cancel' };
}

const TAB = randomUUID();
const PANE_A = randomUUID();
const PANE_B = randomUUID();

function definition(hostId: string, startupApproved = false): WorkspaceDefinition {
  return {
    version: 1,
    hostPanelWidth: 300,
    startupApproved,
    layout: {
      activeTabId: TAB,
      tabs: [
        {
          id: TAB,
          activePaneId: PANE_A,
          root: {
            type: 'split',
            direction: 'row',
            ratio: 0.4,
            first: { type: 'pane', id: PANE_A, target: { kind: 'ssh', hostId }, cwd: '/srv', startupCommands: ['ls'] },
            second: { type: 'pane', id: PANE_B, target: { kind: 'local', shellId: null } }
          }
        }
      ]
    }
  };
}

describe('workspaces', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => harness.dispose());

  it('saves, renames, duplicates and deletes, and keeps one default', () => {
    const { workspaces, hosts } = harness.services;
    const host = hosts.create(hostInput());
    const first = workspaces.create('Alpha', definition(host.id));
    expect(first).toMatchObject({ name: 'Alpha', tabCount: 1, paneCount: 2, isDefault: false });
    expect(workspaces.get(first.id).layout.tabs[0]!.root).toEqual(definition(host.id).layout.tabs[0]!.root);
    const copy = workspaces.duplicate(first.id);
    expect(copy.name).toBe('Alpha (Kopie)');
    workspaces.update(copy.id, { name: 'Beta' });
    workspaces.setDefault(first.id);
    workspaces.setDefault(copy.id);
    expect(workspaces.defaultId()).toBe(copy.id);
    expect(workspaces.list().filter((item) => item.isDefault).map((item) => item.name)).toEqual(['Beta']);
    workspaces.delete(copy.id);
    expect(workspaces.defaultId()).toBeNull();
    expect(workspaces.list().map((item) => item.name)).toEqual(['Alpha']);
  });

  it('exports no secrets and remaps hosts on import, with startup commands withdrawn', () => {
    const { workspaces, hosts, secrets } = harness.services;
    const host = hosts.create(hostInput({ name: 'prod', hostname: 'prod.example', port: 2222 }));
    secrets.set(host.id, 'password', 'top-secret-value');
    const saved = workspaces.create('Ops', definition(host.id, true));
    const { content } = workspaces.exportFile(saved.id, hosts.list());
    expect(content).not.toContain('top-secret-value');
    expect(JSON.parse(content).hosts).toEqual([
      { id: host.id, name: 'prod', hostname: 'prod.example', port: 2222, username: 'tester' }
    ]);

    // Another installation: same server, different local id.
    const other = createHarness();
    try {
      const local = other.services.hosts.create(hostInput({ name: 'P', hostname: 'prod.example', port: 2222 }));
      const imported = other.services.workspaces.importFile(content, other.services.hosts.list());
      expect(imported.unresolvedHosts).toEqual([]);
      const restored = other.services.workspaces.get(imported.workspace.id);
      expect(restored.startupApproved).toBe(false);
      const root = restored.layout.tabs[0]!.root;
      expect(root.type === 'split' && root.first.type === 'pane' && root.first.target).toEqual({ kind: 'ssh', hostId: local.id });

      // An installation that does not know the server reports it instead of guessing.
      const unknown = createHarness();
      try {
        expect(unknown.services.workspaces.importFile(content, []).unresolvedHosts).toEqual(['prod']);
      } finally {
        unknown.dispose();
      }
    } finally {
      other.dispose();
    }
  });

  it('refuses files that are not workspaces', () => {
    expect(() => harness.services.workspaces.importFile('{nope', [])).toThrow(/JSON/);
    expect(() => harness.services.workspaces.importFile('{"format":"other"}', [])).toThrow(/RYFT/);
  });

  it('keeps an unreadable row instead of discarding it', () => {
    const { workspaces } = harness.services;
    const saved = workspaces.create('Alt', definition(randomUUID()));
    harness.db.prepare('UPDATE workspaces SET data = ? WHERE id = ?').run('{"version":99}', saved.id);
    expect(workspaces.list()[0]).toMatchObject({ name: 'Alt', tabCount: 0 });
    expect(() => workspaces.get(saved.id)).toThrow(/Format/);
  });
});

describe('snippets', () => {
  it('stores, updates, marks and deletes', () => {
    const harness = createHarness();
    try {
      const { snippets } = harness.services;
      const created = snippets.create({
        name: 'Logs',
        description: '',
        command: 'docker logs --tail {{lines}} {{container}}',
        category: 'Docker',
        tags: ['logs'],
        shells: ['posix'],
        params: [{ name: 'lines', defaultValue: '100', description: '' }],
        favorite: false
      });
      expect(snippets.get(created.id).params[0]!.defaultValue).toBe('100');
      const updated = snippets.update(created.id, { ...created, name: 'Container-Logs' });
      expect(updated.name).toBe('Container-Logs');
      expect(snippets.setFavorite(created.id, true).favorite).toBe(true);
      snippets.delete(created.id);
      expect(snippets.list().filter((item) => item.source === 'user')).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});

describe('managed keys', () => {
  let harness: Harness;
  let fixture: SshFixture | null = null;
  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(async () => {
    harness.dispose();
    await fixture?.close();
    fixture = null;
  });

  const candidates = [
    'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe',
    'C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe',
    '/usr/bin/ssh-keygen'
  ];
  const keygen = candidates.find((path) => existsSync(path));

  it('generates an ED25519 key the real ssh-keygen understands, and never returns the private part', () => {
    const key = harness.services.keys.generate({ name: 'deploy', comment: 'deploy@ryft', passphrase: null, rememberPassphrase: false });
    expect(key.type).toBe('ssh-ed25519');
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ deploy@ryft$/);
    expect(JSON.stringify(key)).not.toContain('PRIVATE KEY');
    expect(readFileSync(key.privateKeyPath, 'utf8')).toContain('OPENSSH PRIVATE KEY');
    if (process.platform !== 'win32') expect(statSync(key.privateKeyPath).mode & 0o777).toBe(0o600);
    expect(keygen, 'ssh-keygen must exist on this machine').toBeTruthy();
    const listed = execFileSync(keygen!, ['-l', '-f', `${key.privateKeyPath}.pub`], { encoding: 'utf8' });
    expect(listed).toContain(key.fingerprint);
    const derived = spawnSync(keygen!, ['-y', '-f', key.privateKeyPath], { encoding: 'utf8' });
    expect(derived.stderr).toBe('');
    expect(derived.stdout.split(' ').slice(0, 2)).toEqual(key.publicKey.split(' ').slice(0, 2));
  });

  it('authenticates with a generated key and its stored passphrase', async () => {
    const key = harness.services.keys.generate({ name: 'locked', comment: 'x', passphrase: 'pw', rememberPassphrase: true });
    expect(key).toMatchObject({ encrypted: true, hasStoredPassphrase: true });
    fixture = new SshFixture({ authorizedKey: key.publicKey });
    await fixture.listen();
    const host = harness.services.hosts.create(hostInput({ port: fixture.port, authMethod: 'key', keyReference: key.privateKeyPath }));
    harness.answerPrompts(acceptKeys);
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
    await harness.waitForState(id, 'connected');
    expect(harness.services.keys.get(key.id).usedBy).toEqual(['fixture']);
  });

  it('imports by reference and handles passphrases, public files and duplicates', () => {
    const { keys } = harness.services;
    const plain = generateOpenSshKey();
    const plainPath = join(harness.directory, 'id_plain');
    writeFileSync(plainPath, plain.privateKey);
    const first = keys.inspectImport(plainPath);
    expect(first).toMatchObject({ suggestedName: 'id_plain', needsPassphrase: false });
    const imported = keys.import({ name: 'plain', passphrase: null, rememberPassphrase: false, pickToken: first.token });
    expect(imported).toMatchObject({ origin: 'imported', encrypted: false, privateKeyPath: plainPath });
    expect(() =>
      keys.import({ name: 'again', passphrase: null, rememberPassphrase: false, pickToken: keys.inspectImport(plainPath).token })
    ).toThrow(/bereits/);

    const locked = generateOpenSshKey('secret');
    const lockedPath = join(harness.directory, 'id_locked');
    writeFileSync(lockedPath, locked.privateKey);
    const pick = keys.inspectImport(lockedPath);
    expect(pick.needsPassphrase).toBe(true);
    expect(() => keys.import({ name: 'l', passphrase: null, rememberPassphrase: false, pickToken: pick.token })).toThrow(/Passphrase/);
    expect(() => keys.import({ name: 'l', passphrase: 'wrong', rememberPassphrase: false, pickToken: pick.token })).toThrow(/Passphrase/);
    expect(keys.import({ name: 'l', passphrase: 'secret', rememberPassphrase: false, pickToken: pick.token })).toMatchObject({
      encrypted: true,
      hasStoredPassphrase: false
    });

    const publicPath = join(harness.directory, 'id.pub');
    writeFileSync(publicPath, plain.publicKey);
    expect(() => keys.inspectImport(publicPath)).toThrow(/öffentlicher/);
    const junkPath = join(harness.directory, 'junk');
    writeFileSync(junkPath, 'hello');
    expect(() => keys.inspectImport(junkPath)).toThrow(/kein unterstützter/);
    expect(() => keys.import({ name: 'x', passphrase: null, rememberPassphrase: false, pickToken: randomUUID() })).toThrow(/Auswahl/);
  });

  it('refuses a public file that belongs to another key', () => {
    const { keys } = harness.services;
    const path = join(harness.directory, 'id_mixed');
    writeFileSync(path, generateOpenSshKey().privateKey);
    writeFileSync(`${path}.pub`, generateOpenSshKey().publicKey);
    const pick = keys.inspectImport(path);
    expect(() => keys.import({ name: 'mixed', passphrase: null, rememberPassphrase: false, pickToken: pick.token })).toThrow(/gehört nicht/);
  });

  it('removes entries, and files only where RYFT made them and the user said so', () => {
    const { keys, secretStore } = { ...harness.services, secretStore: harness.secretStore };
    const made = keys.generate({ name: 'a', comment: '', passphrase: 'p', rememberPassphrase: true });
    const kept = keys.generate({ name: 'b', comment: '', passphrase: null, rememberPassphrase: false });
    expect(secretStore.values.size).toBe(1);
    keys.remove(made.id, true);
    expect(existsSync(made.privateKeyPath)).toBe(false);
    expect(existsSync(`${made.privateKeyPath}.pub`)).toBe(false);
    expect(secretStore.values.size).toBe(0);
    keys.remove(kept.id, false);
    expect(existsSync(kept.privateKeyPath)).toBe(true);

    const path = join(harness.directory, 'mine');
    writeFileSync(path, generateOpenSshKey().privateKey);
    const imported = keys.import({ name: 'mine', passphrase: null, rememberPassphrase: false, pickToken: keys.inspectImport(path).token });
    expect(() => keys.remove(imported.id, true)).toThrow(/nicht gelöscht/);
    keys.remove(imported.id, false);
    expect(existsSync(path)).toBe(true);
  });

  it('installs through an authorized connection and reports what the server did', async () => {
    const commands: string[] = [];
    const answers = ['RYFT_KEY_ADDED\n', 'RYFT_KEY_PRESENT\n', 'something else\n'];
    fixture = new SshFixture({
      password: PASSWORD,
      exec: (command) => {
        commands.push(command);
        return { stdout: answers.shift() ?? '', code: 0 };
      }
    });
    await fixture.listen();
    const host = harness.services.hosts.create(hostInput({ port: fixture.port }));
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    harness.answerPrompts(acceptKeys);
    const key = harness.services.keys.generate({ name: 'k', comment: 'c', passphrase: null, rememberPassphrase: false });
    await expect(harness.services.installKey(OWNER, key.id, host.id, randomUUID())).resolves.toBe('added');
    await expect(harness.services.installKey(OWNER, key.id, host.id, randomUUID())).resolves.toBe('present');
    await expect(harness.services.installKey(OWNER, key.id, host.id, randomUUID())).rejects.toThrow(/unerwartete/);
    expect(commands[0]).toContain(key.publicKey.split(' ')[1]);
    expect(harness.services.pool.size()).toBe(0);
  });
});

describe('jump hosts', () => {
  let harness: Harness;
  let jump: SshFixture;
  let target: SshFixture;
  const root = join(tmpdir(), `ryft-jump-${randomUUID()}`);

  beforeAll(() => mkdirSync(root, { recursive: true }));
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  beforeEach(async () => {
    harness = createHarness();
    jump = new SshFixture({ password: 'jump-pass' });
    target = new SshFixture({ password: PASSWORD, sftpRoot: root });
    await jump.listen();
    await target.listen();
  });
  afterEach(async () => {
    harness.dispose();
    await jump.close();
    await target.close();
  });

  const chain = () => {
    const { hosts, secrets } = harness.services;
    const bastion = hosts.create(hostInput({ name: 'bastion', port: jump.port }));
    secrets.set(bastion.id, 'password', 'jump-pass');
    const host = hosts.create(
      hostInput({ name: 'inner', port: target.port, options: { ...DEFAULT_HOST_OPTIONS, jumpHostIds: [bastion.id] } })
    );
    secrets.set(host.id, 'password', PASSWORD);
    return { bastion, host };
  };

  it('verifies the host key of each hop on its own and shows the chain status', async () => {
    const { host } = chain();
    const asked: number[] = [];
    harness.answerPrompts((prompt) => {
      if (prompt.kind === 'hostKey') asked.push(prompt.port);
      return acceptKeys(prompt);
    });
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
    await harness.waitForState(id, 'connected');
    expect(asked).toEqual([jump.port, target.port]);
    expect(harness.states.some((event) => event.sessionId === id && /bastion/.test(event.detail ?? ''))).toBe(true);
    expect(harness.states.some((event) => event.sessionId === id && /inner/.test(event.detail ?? ''))).toBe(true);
    harness.services.sessions.write(OWNER, id, 'hello-through-jump');
    await waitUntil(() => target.received.includes('hello-through-jump'));
    expect(jump.received).toBe('');
  });

  it('stops at an untrusted hop before anything reaches the target', async () => {
    const { host } = chain();
    harness.answerPrompts(() => ({ kind: 'cancel' }));
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
    const failed = await harness.waitForState(id, 'failed');
    expect(failed.error?.code).toBe('HOST_KEY_REJECTED');
    expect(failed.error?.message).toMatch(/bastion/);
    expect(target.connectionCount).toBe(0);
  });

  it('names the failing hop when the chain breaks in the middle', async () => {
    const { host, bastion } = chain();
    harness.services.secrets.set(bastion.id, 'password', 'wrong');
    let passwordPrompts = 0;
    harness.answerPrompts((prompt) => {
      if (prompt.kind === 'password') passwordPrompts += 1;
      return acceptKeys(prompt);
    });
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
    const failed = await harness.waitForState(id, 'failed');
    expect(failed.error?.message).toMatch(/Sprunghost bastion/);
    expect(passwordPrompts).toBe(1);
    expect(target.connectionCount).toBe(0);
  });

  it('rejects cycles before connecting anywhere', async () => {
    const { hosts } = harness.services;
    const a = hosts.create(hostInput({ name: 'a', port: jump.port }));
    const b = hosts.create(hostInput({ name: 'b', port: jump.port, options: { ...DEFAULT_HOST_OPTIONS, jumpHostIds: [a.id] } }));
    const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = a;
    hosts.update(a.id, { ...input, options: { ...DEFAULT_HOST_OPTIONS, jumpHostIds: [b.id] } });
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: b.id }, 80, 24);
    const failed = await harness.waitForState(id, 'failed');
    expect(failed.error?.code).toBe('JUMP_CHAIN_INVALID');
    expect(jump.connectionCount).toBe(0);
  });

  it('runs SFTP and port forwarding through the chain', async () => {
    const { host } = chain();
    harness.answerPrompts(acceptKeys);
    const name = `jump-${randomUUID().slice(0, 8)}.txt`;
    writeFileSync(join(root, name), 'through the jump');
    const sftpId = randomUUID();
    await harness.services.sftp.open(OWNER, sftpId, host.id);
    const listing = await harness.services.sftp.list(OWNER, sftpId, '/');
    expect(listing.entries.map((entry) => entry.name)).toContain(name);

    const servers: Server[] = [];
    const banner = createServer((socket) => socket.end('JUMP-BANNER'));
    servers.push(banner);
    await new Promise<void>((resolve) => banner.listen(0, '127.0.0.1', resolve));
    const forward = harness.services.forwards.create({
      name: 'through',
      hostId: host.id,
      type: 'local',
      bindAddress: '127.0.0.1',
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: (banner.address() as AddressInfo).port,
      restoreOnStart: false,
      autoReconnect: false,
      allowNonLoopback: false
    });
    await harness.services.forwarding.start(OWNER, forward.id);
    const running = await waitUntil(() => harness.services.forwarding.list(OWNER).find((state) => state.status === 'running' && state.boundPort));
    const text = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(running.boundPort!, '127.0.0.1');
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.once('error', reject);
    });
    expect(text).toBe('JUMP-BANNER');
    harness.services.forwarding.stop(OWNER, forward.id);
    for (const server of servers) server.close();
  });
});

describe('workspace launch', () => {
  let harness: Harness;
  let fixture: SshFixture;
  beforeEach(async () => {
    harness = createHarness();
    fixture = new SshFixture({ password: PASSWORD });
    await fixture.listen();
  });
  afterEach(async () => {
    harness.dispose();
    await fixture.close();
  });

  const openHost = async (allowed: boolean) => {
    harness.services.preferences.setMany({ workspaceStartupCommands: allowed });
    const host = harness.services.hosts.create(hostInput({ port: fixture.port }));
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    harness.answerPrompts(acceptKeys);
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24, {
      cwd: "/srv/o'brien",
      startupCommands: ['uptime-marker']
    });
    await harness.waitForState(id, 'connected');
    return id;
  };

  it('quotes the folder and leaves startup commands alone while the setting is off', async () => {
    await openHost(false);
    await waitUntil(() => fixture.received.includes('cd -- '));
    expect(fixture.received).toContain(`cd -- '/srv/o'\\''brien'`);
    expect(fixture.received).not.toContain('uptime-marker');
  });

  it('runs startup commands once and not again after a reconnect', async () => {
    harness.services.preferences.setMany({ autoReconnect: true });
    const id = await openHost(true);
    await waitUntil(() => fixture.received.includes('uptime-marker'));
    fixture.received = '';
    fixture.dropConnections();
    await waitUntil(() => harness.states.filter((event) => event.sessionId === id && event.state === 'connected').length > 1);
    await waitUntil(() => fixture.received.includes('cd -- '));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fixture.received).not.toContain('uptime-marker');
  });

  it('adds the history hook over SSH only for hosts that opted in', async () => {
    const id = await openHost(false);
    await waitUntil(() => fixture.received.includes('cd -- '));
    expect(fixture.received).not.toContain('7777');
    harness.services.sessions.close(OWNER, id);

    fixture.received = '';
    const host = harness.services.hosts.create(
      hostInput({ port: fixture.port, options: { ...DEFAULT_HOST_OPTIONS, shellIntegration: true } })
    );
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    const second = harness.sessionId();
    await harness.services.sessions.open(OWNER, second, { kind: 'ssh', hostId: host.id }, 80, 24);
    await harness.waitForState(second, 'connected');
    await waitUntil(() => fixture.received.includes('7777'));
  });
});

const powershell = detectShells().find((shell) => shell.id === 'powershell' || shell.id === 'pwsh');

describe.runIf(powershell)('command history through a real local shell', () => {
  let harness: Harness;
  let id: string;

  beforeEach(() => {
    harness = createHarness();
    id = harness.sessionId();
  });
  afterEach(() => harness.dispose());

  const open = async () => {
    await harness.services.sessions.open(OWNER, id, { kind: 'local', shellId: powershell!.id }, 120, 30);
    await harness.waitForState(id, 'connected');
    await harness.waitForOutput(id, />\s*$/, 30_000);
  };
  const history = (): string[] =>
    harness.services.commandHistory.list({ query: '', hostId: null, limit: 50 }).map((entry) => entry.command);

  it('records finished commands, honours exclusions, and leaves nothing of the protocol in the output', async () => {
    harness.services.preferences.setMany({ historyExclusions: ['skipme'] });
    await open();
    harness.services.sessions.write(OWNER, id, 'Write-Output ryft-recorded\r');
    await waitUntil(() => history().includes('Write-Output ryft-recorded'), 30_000);
    harness.services.sessions.write(OWNER, id, 'Write-Output skipme-marker\r');
    harness.services.sessions.write(OWNER, id, '$env:RYFT_PASSWORD = "hunter2"\r');
    harness.services.sessions.write(OWNER, id, 'Write-Output ryft-after\r');
    await waitUntil(() => history().includes('Write-Output ryft-after'), 30_000);
    expect(history().join('\n')).not.toMatch(/hunter2|skipme/);
    expect(harness.output.get(id)).not.toContain('7777;');
    const entry = harness.services.commandHistory.list({ query: 'ryft-recorded', hostId: null, limit: 1 })[0]!;
    expect(entry).toMatchObject({ exitCode: 0, hostId: null });
    expect(entry.cwd).toBeTruthy();
  });

  it('records nothing when switched off', async () => {
    harness.services.preferences.setMany({ commandHistoryEnabled: false });
    await open();
    harness.services.sessions.write(OWNER, id, 'Write-Output ryft-off\r');
    await harness.waitForOutput(id, /ryft-off[\s\S]*ryft-off/, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(history()).toEqual([]);
  });
});

describe('command history storage', () => {
  it('searches literally, filters by host, deletes and prunes', () => {
    const harness = createHarness();
    try {
      const { commandHistory, hosts } = harness.services;
      const host = hosts.create(hostInput());
      const add = (command: string, hostId: string | null = null) =>
        commandHistory.add({ command, sessionLabel: 's', hostId, cwd: null, exitCode: 0 });
      add('100%_done');
      add('100xydone');
      add('on-host', host.id);
      expect(commandHistory.list({ query: '%_', hostId: null, limit: 10 }).map((entry) => entry.command)).toEqual(['100%_done']);
      expect(commandHistory.list({ query: '', hostId: host.id, limit: 10 }).map((entry) => entry.command)).toEqual(['on-host']);
      const [newest] = commandHistory.list({ query: '', hostId: null, limit: 1 });
      commandHistory.delete(newest!.id);
      expect(commandHistory.list({ query: '', hostId: null, limit: 10 })).toHaveLength(2);
      commandHistory.prune(1);
      expect(commandHistory.list({ query: '', hostId: null, limit: 10 })).toHaveLength(1);
      commandHistory.clear();
      expect(commandHistory.list({ query: '', hostId: null, limit: 10 })).toEqual([]);
    } finally {
      harness.dispose();
    }
  });
});
