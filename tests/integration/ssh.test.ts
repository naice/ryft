import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseAgent, utils, type ParsedKey } from 'ssh2';
import type { HostInput, PromptResponse, SessionPrompt } from '@shared/contracts';
import { describeHostKey } from '../../src/main/security/knownHosts';
import { createHarness, hostInput, OWNER, type Harness } from '../fixtures/harness';
import { generateOpenSshKey, SshFixture } from '../fixtures/sshServer';

const PASSWORD = 'correct-horse-battery';

let harness: Harness;
const fixtures: SshFixture[] = [];

async function startFixture(options: ConstructorParameters<typeof SshFixture>[0], port = 0): Promise<SshFixture> {
  const fixture = new SshFixture(options);
  await fixture.listen(port);
  fixtures.push(fixture);
  return fixture;
}

function acceptHostKey(prompt: SessionPrompt, extra: Partial<Record<SessionPrompt['kind'], PromptResponse>> = {}): PromptResponse {
  if (extra[prompt.kind]) return extra[prompt.kind] as PromptResponse;
  if (prompt.kind === 'hostKey') return { kind: 'hostKey', trust: 'once' };
  return { kind: 'cancel' };
}

function fixtureHost(fixture: SshFixture, overrides: Partial<HostInput> = {}) {
  return harness.services.hosts.create(hostInput({ port: fixture.port, ...overrides }));
}

async function open(hostId: string): Promise<string> {
  const sessionId = harness.sessionId();
  await harness.services.sessions.open(OWNER, sessionId, { kind: 'ssh', hostId }, 80, 24);
  return sessionId;
}

function trustedKeyOf(fixture: SshFixture): { keyType: string; keyBase64: string; fingerprint: string } {
  const parsed = utils.parseKey(fixture.hostKey) as ParsedKey;
  return describeHostKey(parsed.getPublicSSH());
}

beforeEach(() => {
  harness = createHarness();
});

afterEach(async () => {
  harness.dispose();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('password authentication', () => {
  it('connects, transports input and output, resizes and reports the exit', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const stop = harness.answerPrompts((prompt) =>
      acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: false } })
    );
    const sessionId = await open(host.id);
    stop();

    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
    expect(harness.states.filter((event) => event.sessionId === sessionId).map((event) => event.state)).toEqual([
      'connecting',
      'authenticating',
      'connected'
    ]);
    expect(fixture.lastPty).toEqual({ cols: 80, rows: 24 });
    await harness.waitForOutput(sessionId, /fixture\$ /);

    harness.services.sessions.write(OWNER, sessionId, 'hello\r');
    await harness.waitForOutput(sessionId, /hello/);
    expect(fixture.received).toContain('hello');

    harness.services.sessions.resize(OWNER, sessionId, 120, 40);
    await expect.poll(() => fixture.lastWindow).toEqual({ cols: 120, rows: 40 });

    harness.services.sessions.write(OWNER, sessionId, 'exit\r');
    const closed = await harness.waitForState(sessionId, 'closed');
    expect(closed.exitCode).toBe(7);
  });

  it('re-prompts after a wrong password and then succeeds', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const answers = ['wrong', PASSWORD];
    const seenRetry: boolean[] = [];
    const stop = harness.answerPrompts((prompt) => {
      if (prompt.kind === 'password') {
        seenRetry.push(prompt.retry);
        return { kind: 'secret', value: answers.shift()!, remember: false };
      }
      return acceptHostKey(prompt);
    });
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
    expect(seenRetry).toEqual([false, true]);
  });

  it('fails after three wrong passwords', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    let attempts = 0;
    const stop = harness.answerPrompts((prompt) => {
      if (prompt.kind !== 'password') return acceptHostKey(prompt);
      attempts += 1;
      return { kind: 'secret', value: 'wrong', remember: false };
    });
    const sessionId = await open(host.id);
    stop();
    const failed = await harness.waitForState(sessionId, 'failed');
    expect(failed.error?.code).toBe('AUTH_FAILED');
    expect(attempts).toBe(3);
  });

  it('stores a remembered password only after it worked and uses it next time', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const stop = harness.answerPrompts((prompt) =>
      acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: true } })
    );
    const first = await open(host.id);
    stop();
    expect(harness.services.secrets.get(host.id, 'password')).toBe(PASSWORD);
    harness.services.sessions.close(OWNER, first);

    const prompted: string[] = [];
    const stopSecond = harness.answerPrompts((prompt) => {
      prompted.push(prompt.kind);
      return acceptHostKey(prompt);
    });
    const second = await open(host.id);
    stopSecond();
    expect(harness.services.sessions.stateOf(second)).toBe('connected');
    expect(prompted).not.toContain('password');
  });

  it('does not store a wrong password that was marked to remember', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const stop = harness.answerPrompts((prompt) =>
      acceptHostKey(prompt, { password: { kind: 'secret', value: 'wrong', remember: true } })
    );
    const sessionId = await open(host.id);
    stop();
    await harness.waitForState(sessionId, 'failed');
    expect(harness.services.secrets.get(host.id, 'password')).toBeNull();
  });

  it('asks again when the stored password no longer works', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    harness.services.secrets.set(host.id, 'password', 'outdated');
    const stop = harness.answerPrompts((prompt) =>
      acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: false } })
    );
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
  });

  it('reports cancel as a cancelled login', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    const failed = await harness.waitForState(sessionId, 'failed');
    expect(failed.error?.code).toBe('AUTH_CANCELLED');
  });

  it('keeps secrets out of the database and history', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const stop = harness.answerPrompts((prompt) =>
      acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: true } })
    );
    const sessionId = await open(host.id);
    stop();
    harness.services.sessions.close(OWNER, sessionId);
    harness.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const raw = readFileSync(join(harness.directory, 'test.sqlite'));
    expect(raw.includes(PASSWORD)).toBe(false);
    expect(harness.services.history.list(5)[0]).toMatchObject({ label: 'fixture', outcome: 'connected' });
  });
});

describe('key authentication', () => {
  it('connects with an unencrypted key file', async () => {
    const key = generateOpenSshKey();
    const keyPath = join(harness.directory, 'id_test');
    writeFileSync(keyPath, key.privateKey);
    const fixture = await startFixture({ authorizedKey: key.publicKey });
    const host = fixtureHost(fixture, { authMethod: 'key', keyReference: keyPath });
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
  });

  it('asks for the passphrase of an encrypted key and retries', async () => {
    const key = generateOpenSshKey('open sesame');
    const keyPath = join(harness.directory, 'id_enc');
    writeFileSync(keyPath, key.privateKey);
    const fixture = await startFixture({ authorizedKey: key.publicKey });
    const host = fixtureHost(fixture, { authMethod: 'key', keyReference: keyPath });
    const answers = ['wrong', 'open sesame'];
    const stop = harness.answerPrompts((prompt) =>
      prompt.kind === 'passphrase'
        ? { kind: 'secret', value: answers.shift()!, remember: true }
        : acceptHostKey(prompt)
    );
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
    expect(harness.services.secrets.get(host.id, 'passphrase')).toBe('open sesame');
  });

  it('rejects a key the server does not accept', async () => {
    const authorized = generateOpenSshKey();
    const other = generateOpenSshKey();
    const keyPath = join(harness.directory, 'id_other');
    writeFileSync(keyPath, other.privateKey);
    const fixture = await startFixture({ authorizedKey: authorized.publicKey });
    const host = fixtureHost(fixture, { authMethod: 'key', keyReference: keyPath });
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    expect((await harness.waitForState(sessionId, 'failed')).error?.code).toBe('AUTH_FAILED');
  });

  it.each([
    ['a missing file', (dir: string) => join(dir, 'nope')],
    [
      'a file that is no key',
      (dir: string) => {
        const path = join(dir, 'garbage');
        writeFileSync(path, 'not a key');
        return path;
      }
    ]
  ])('explains %s', async (_name, makePath) => {
    const fixture = await startFixture({ authorizedKey: generateOpenSshKey().publicKey });
    const host = fixtureHost(fixture, { authMethod: 'key', keyReference: makePath(harness.directory) });
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    expect((await harness.waitForState(sessionId, 'failed')).error?.code).toBe('KEY_UNREADABLE');
  });
});

describe('agent authentication', () => {
  class TestAgent extends BaseAgent {
    constructor(private readonly key: ParsedKey) {
      super();
    }
    override getIdentities(callback: (error: Error | null, identities?: ParsedKey[]) => void): void {
      callback(null, [this.key]);
    }
    override sign(
      _publicKey: ParsedKey,
      data: Buffer,
      options: unknown,
      callback?: (error: Error | null, signature?: Buffer) => void
    ): void {
      const done = (typeof options === 'function' ? options : callback) as (error: Error | null, signature?: Buffer) => void;
      done(null, this.key.sign(data));
    }
  }

  it('authenticates through an agent without ever reading a key file', async () => {
    const key = generateOpenSshKey();
    const parsed = utils.parseKey(key.privateKey) as ParsedKey;
    harness.dispose();
    harness = createHarness({ agent: new TestAgent(parsed) });
    const fixture = await startFixture({ authorizedKey: key.publicKey });
    const host = fixtureHost(fixture, { authMethod: 'agent' });
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
  });
});

describe('keyboard-interactive authentication', () => {
  it('passes server prompts to the user', async () => {
    const fixture = await startFixture({ keyboardAnswer: '424242' });
    const host = fixtureHost(fixture);
    let seen: SessionPrompt | null = null;
    const stop = harness.answerPrompts((prompt) => {
      if (prompt.kind !== 'keyboardInteractive') return acceptHostKey(prompt);
      seen = prompt;
      return { kind: 'answers', answers: ['424242'] };
    });
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
    expect(seen).toMatchObject({ prompts: [{ prompt: 'Code: ', echo: false }], instructions: 'Zweiter Faktor' });
  });
});

describe('host key trust', () => {
  it('shows the real fingerprint and persists "always" only on request', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const expected = trustedKeyOf(fixture);

    let shown: SessionPrompt | null = null;
    const stopOnce = harness.answerPrompts((prompt) => {
      if (prompt.kind === 'hostKey') shown = prompt;
      return acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: false } });
    });
    const once = await open(host.id);
    stopOnce();
    expect(shown).toMatchObject({ kind: 'hostKey', fingerprint: expected.fingerprint, keyType: expected.keyType });
    expect(harness.services.trustedKeys.list()).toEqual([]);
    harness.services.sessions.close(OWNER, once);

    const stopAlways = harness.answerPrompts((prompt) =>
      acceptHostKey(prompt, {
        hostKey: { kind: 'hostKey', trust: 'always' },
        password: { kind: 'secret', value: PASSWORD, remember: false }
      })
    );
    const always = await open(host.id);
    stopAlways();
    harness.services.sessions.close(OWNER, always);
    expect(harness.services.trustedKeys.list()).toMatchObject([{ fingerprint: expected.fingerprint, port: fixture.port }]);

    const prompted: string[] = [];
    const stopThird = harness.answerPrompts((prompt) => {
      prompted.push(prompt.kind);
      return acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: false } });
    });
    await open(host.id);
    stopThird();
    expect(prompted).not.toContain('hostKey');
  });

  it('aborts before authentication when the key is rejected', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const prompted: string[] = [];
    const stop = harness.answerPrompts((prompt) => {
      prompted.push(prompt.kind);
      return { kind: 'cancel' };
    });
    const sessionId = await open(host.id);
    stop();
    expect((await harness.waitForState(sessionId, 'failed')).error?.code).toBe('HOST_KEY_REJECTED');
    expect(prompted).toEqual(['hostKey']);
    expect(fixture.received).toBe('');
  });

  it('blocks a changed key from the RYFT store without offering a prompt', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const genuine = trustedKeyOf(new SshFixture({}));
    harness.services.trustedKeys.add({ host: '127.0.0.1', port: fixture.port, ...{ ...genuine, keyType: trustedKeyOf(fixture).keyType } });

    const prompted: string[] = [];
    const stop = harness.answerPrompts((prompt) => {
      prompted.push(prompt.kind);
      return { kind: 'cancel' };
    });
    const sessionId = await open(host.id);
    stop();
    const failed = await harness.waitForState(sessionId, 'failed');
    expect(failed.error?.code).toBe('HOST_KEY_MISMATCH');
    expect(failed.error?.message).toContain(trustedKeyOf(fixture).fingerprint);
    expect(prompted).toEqual([]);
    expect(harness.services.trustedKeys.list()).toHaveLength(1);
  });

  it('blocks a key that conflicts with OpenSSH known_hosts and never edits that file', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const other = trustedKeyOf(new SshFixture({}));
    const line = `[127.0.0.1]:${fixture.port} ${other.keyType} ${other.keyBase64}\n`;
    const file = join(harness.directory, 'known_hosts');
    writeFileSync(file, line);
    const sessionId = await open(host.id);
    const failed = await harness.waitForState(sessionId, 'failed');
    expect(failed.error?.code).toBe('HOST_KEY_MISMATCH');
    expect(failed.error?.message).toContain('ssh-keygen -R');
    expect(readFileSync(file, 'utf8')).toBe(line);
  });

  it('trusts a matching OpenSSH known_hosts entry without a prompt', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const key = trustedKeyOf(fixture);
    writeFileSync(join(harness.directory, 'known_hosts'), `[127.0.0.1]:${fixture.port} ${key.keyType} ${key.keyBase64}\n`);
    const prompted: string[] = [];
    const stop = harness.answerPrompts((prompt) => {
      prompted.push(prompt.kind);
      return acceptHostKey(prompt, { password: { kind: 'secret', value: PASSWORD, remember: false } });
    });
    const sessionId = await open(host.id);
    stop();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
    expect(prompted).toEqual(['password']);
  });
});

describe('connection lifecycle', () => {
  it('reports a refused connection with a readable error', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const port = fixture.port;
    await fixture.close();
    const host = harness.services.hosts.create(hostInput({ port }));
    const sessionId = await open(host.id);
    const failed = await harness.waitForState(sessionId, 'failed');
    expect(failed.error?.code).toBe('CONNECTION_REFUSED');
    expect(failed.error?.message).toContain('fixture');
  });

  it('reconnects after an unclean drop', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt, { hostKey: { kind: 'hostKey', trust: 'always' } }));
    const sessionId = await open(host.id);
    fixture.dropConnections();
    await harness.waitForState(sessionId, 'reconnecting');
    await expect
      .poll(() => harness.states.filter((event) => event.sessionId === sessionId && event.state === 'connected').length)
      .toBe(2);
    stop();
  });

  it('gives up on reconnecting when the server stays away', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    await fixture.close();
    const failed = await harness.waitForState(sessionId, 'failed');
    expect(failed.error?.code).toMatch(/CONNECTION_(LOST|REFUSED)/);
    expect(harness.states.filter((event) => event.sessionId === sessionId && event.state === 'reconnecting')).toHaveLength(3);
  });

  it('does not reconnect when the preference is off', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    harness.services.preferences.setMany({ autoReconnect: false });
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    fixture.dropConnections();
    expect((await harness.waitForState(sessionId, 'failed')).error?.code).toBe('CONNECTION_LOST');
  });

  it('closing during a pending prompt tears the session down', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    const sessionId = harness.sessionId();
    const opening = harness.services.sessions.open(OWNER, sessionId, { kind: 'ssh', hostId: host.id }, 80, 24);
    await harness.nextPrompt();
    harness.services.sessions.close(OWNER, sessionId);
    await opening;
    expect(harness.services.sessions.stateOf(sessionId)).toBeNull();
    expect(harness.services.sessions.count()).toBe(0);
  });

  it('refuses access to a session of another window', async () => {
    const fixture = await startFixture({ password: PASSWORD });
    const host = fixtureHost(fixture);
    harness.services.secrets.set(host.id, 'password', PASSWORD);
    const stop = harness.answerPrompts((prompt) => acceptHostKey(prompt));
    const sessionId = await open(host.id);
    stop();
    expect(() => harness.services.sessions.write(OWNER + 1, sessionId, 'x')).toThrow();
    expect(() => harness.services.sessions.close(OWNER + 1, sessionId)).toThrow();
    expect(harness.services.sessions.stateOf(sessionId)).toBe('connected');
  });

  it('reports a deleted host as such', async () => {
    const sessionId = await open('6f9a7f4e-4f6d-4f5a-9f3a-000000000000');
    expect((await harness.waitForState(sessionId, 'failed')).error?.code).toBe('HOST_NOT_FOUND');
  });
});
