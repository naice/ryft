import { describe, expect, it } from 'vitest';
import { authProfileInputSchema } from '../../src/shared/features/authProfiles';
import { forwardInputSchema, isLoopbackAddress } from '../../src/shared/features/forwards';
import { DEFAULT_HOST_OPTIONS, hostOptionsSchema } from '../../src/shared/features/hostOptions';
import { flattenJumpChain, MAX_JUMP_HOPS } from '../../src/shared/features/jumpChain';
import { CredentialResolver } from '../../src/main/security/credentials';
import { scopedSecretReference, type SecretStore } from '../../src/main/security/secretVault';
import type { StoredAuthProfile, StoredHost } from '../../src/main/storage/repositories';
import { breadcrumbs, selectRange, visibleEntries } from '../../src/renderer/src/features/sftp/fileList';
import type { FileEntry } from '../../src/shared/contracts';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';

function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    status: () => ({ available: true, backend: 'test', keyLost: false }) as ReturnType<SecretStore['status']>,
    get: (reference) => values.get(reference) ?? null,
    set: (reference, value) => void values.set(reference, value),
    delete: (reference) => void values.delete(reference),
    has: (reference) => values.has(reference)
  } as SecretStore & { values: Map<string, string> };
}

const host = {
  id: HOST_ID,
  username: 'host-user',
  authMethod: 'password',
  keyReference: null,
  authProfileId: null
} as unknown as StoredHost;

const profile = {
  id: PROFILE_ID,
  name: 'Deploy',
  method: 'key',
  username: 'profile-user',
  keyReference: '~/.ssh/deploy'
} as unknown as StoredAuthProfile;

describe('credential references', () => {
  const resolverWith = (store: SecretStore, known: StoredAuthProfile | null = profile) =>
    new CredentialResolver(store, (id) => (known && known.id === id ? known : null));

  it('keeps host and profile secrets apart', () => {
    expect(scopedSecretReference('host', HOST_ID, 'password')).not.toBe(scopedSecretReference('profile', HOST_ID, 'password'));
  });

  it('uses the host itself without a profile', () => {
    const store = memoryStore();
    const resolved = resolverWith(store).resolve(host);
    expect(resolved.username).toBe('host-user');
    expect(resolved.authMethod).toBe('password');
    resolved.setSecret('password', 'hunter2');
    expect([...store.values.keys()]).toEqual([scopedSecretReference('host', HOST_ID, 'password')]);
  });

  it('prefers the profile: its user, method, key and secret', () => {
    const store = memoryStore();
    store.set(scopedSecretReference('profile', PROFILE_ID, 'passphrase'), 'phrase');
    const resolved = resolverWith(store).resolve({ ...host, authProfileId: PROFILE_ID });
    expect(resolved.username).toBe('profile-user');
    expect(resolved.authMethod).toBe('key');
    expect(resolved.keyReference).toBe('~/.ssh/deploy');
    expect(resolved.getSecret('passphrase')).toBe('phrase');
    expect(resolved.getSecret('password')).toBeNull();
  });

  it('falls back to the login of the host when a profile no longer exists', () => {
    const store = memoryStore();
    const resolved = resolverWith(store, null).resolve({ ...host, authProfileId: PROFILE_ID });
    expect(resolved.username).toBe('host-user');
    resolved.setSecret('password', 'x');
    expect(store.has(scopedSecretReference('host', HOST_ID, 'password'))).toBe(true);
  });

  it('keeps the user of the host if the profile sets none', () => {
    const resolved = resolverWith(memoryStore(), { ...profile, username: null }).resolve({ ...host, authProfileId: PROFILE_ID });
    expect(resolved.username).toBe('host-user');
  });

  it('clears every kind of secret of a scope', () => {
    const store = memoryStore();
    const resolver = resolverWith(store);
    resolver.set('profile', PROFILE_ID, 'password', 'a');
    resolver.set('profile', PROFILE_ID, 'passphrase', 'b');
    expect(resolver.hasAny('profile', PROFILE_ID)).toBe(true);
    resolver.clear('profile', PROFILE_ID);
    expect(resolver.hasAny('profile', PROFILE_ID)).toBe(false);
    expect(store.values.size).toBe(0);
  });

  it('has no field for secret material in a profile', () => {
    const parsed = authProfileInputSchema.safeParse({
      name: 'x',
      method: 'password',
      username: null,
      keyReference: null,
      password: 'hunter2'
    });
    expect(parsed.success).toBe(false);
  });

  it('demands a key file for the key method', () => {
    expect(authProfileInputSchema.safeParse({ name: 'x', method: 'key', username: null, keyReference: null }).success).toBe(false);
  });
});

describe('forward validation', () => {
  const valid = {
    name: 'db',
    hostId: HOST_ID,
    type: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 5433,
    destHost: 'db.internal',
    destPort: 5432,
    restoreOnStart: false,
    autoReconnect: false,
    allowNonLoopback: false
  };

  it.each(['127.0.0.1', '127.1.2.3', '::1', 'localhost', 'LOCALHOST'])('treats %s as loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.5', '127.0.0.1.example.org', '127.evil.example', 'example.org'])(
    'does not treat %s as loopback',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  );

  it('accepts a loopback forward', () => {
    expect(forwardInputSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a public listener without an explicit decision', () => {
    expect(forwardInputSchema.safeParse({ ...valid, bindAddress: '0.0.0.0' }).success).toBe(false);
    expect(forwardInputSchema.safeParse({ ...valid, bindAddress: '0.0.0.0', allowNonLoopback: true }).success).toBe(true);
  });

  it('needs a destination except for -D', () => {
    expect(forwardInputSchema.safeParse({ ...valid, destHost: null }).success).toBe(false);
    expect(forwardInputSchema.safeParse({ ...valid, type: 'remote', destPort: null }).success).toBe(false);
    expect(forwardInputSchema.safeParse({ ...valid, type: 'dynamic', destHost: null, destPort: null }).success).toBe(true);
  });

  it('refuses ports out of range', () => {
    expect(forwardInputSchema.safeParse({ ...valid, bindPort: 65536 }).success).toBe(false);
    expect(forwardInputSchema.safeParse({ ...valid, bindPort: 0 }).success).toBe(true);
    expect(forwardInputSchema.safeParse({ ...valid, destPort: 0 }).success).toBe(false);
  });

  it.each(['-oProxyCommand=x', 'a b', ''])('refuses the address %j', (bad) => {
    expect(forwardInputSchema.safeParse({ ...valid, destHost: bad }).success).toBe(false);
  });

  it('refuses unknown fields', () => {
    expect(forwardInputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});

describe('jump chain validation', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'];
  const lookup = (graph: Record<string, string[]>) => (id: string) => graph[id] ?? null;

  it('is empty for a direct host', () => {
    expect(flattenJumpChain(a!, lookup({ a: [] }))).toEqual({ ok: true, hops: [a] });
  });

  it('orders a multi-hop chain from the client to the target', () => {
    const result = flattenJumpChain(a!, lookup({ a: [b!], b: [c!], c: [] }));
    expect(result).toEqual({ ok: true, hops: [c, b, a] });
  });

  it('detects a cycle, also one through the target', () => {
    const through = flattenJumpChain(a!, lookup({ a: [b!], b: [a!] }));
    expect(through).toMatchObject({ ok: false, problem: { kind: 'cycle' } });
    const self = flattenJumpChain(a!, lookup({ a: [a!] }));
    expect(self).toMatchObject({ ok: false, problem: { kind: 'cycle' } });
    const behind = flattenJumpChain(a!, lookup({ a: [b!], b: [c!], c: [b!] }));
    expect(behind).toMatchObject({ ok: false, problem: { kind: 'cycle' } });
  });

  it('names a jump host which no longer exists', () => {
    expect(flattenJumpChain(a!, lookup({ a: [d!] }))).toEqual({ ok: false, problem: { kind: 'missing', hostId: d } });
  });

  it('limits the length', () => {
    const graph: Record<string, string[]> = {};
    for (let index = 0; index <= MAX_JUMP_HOPS + 1; index += 1) graph[`h${index}`] = index > MAX_JUMP_HOPS ? [] : [`h${index + 1}`];
    expect(flattenJumpChain('h0', lookup(graph))).toEqual({ ok: false, problem: { kind: 'tooLong' } });
  });
});

describe('host options', () => {
  it('defaults everything, so hosts saved before the options existed keep working', () => {
    expect(hostOptionsSchema.parse({})).toEqual(DEFAULT_HOST_OPTIONS);
    expect(DEFAULT_HOST_OPTIONS.runStartupCommands).toBe(false);
  });

  it('refuses terminal types and variable names that could smuggle anything', () => {
    expect(hostOptionsSchema.safeParse({ terminalType: 'xterm; rm -rf /' }).success).toBe(false);
    expect(hostOptionsSchema.safeParse({ env: [{ name: 'A=B', value: 'x' }] }).success).toBe(false);
  });
});

describe('file list', () => {
  const entry = (name: string, patch: Partial<FileEntry> = {}): FileEntry =>
    ({ name, path: `/${name}`, type: 'file', size: 1, modifiedAt: 1, hidden: name.startsWith('.'), ...patch }) as FileEntry;

  it('puts folders first and sorts numerically by name', () => {
    const sorted = visibleEntries([entry('b10'), entry('b2'), entry('z', { type: 'directory' })], '', false, {
      key: 'name',
      ascending: true
    });
    expect(sorted.map((item) => item.name)).toEqual(['z', 'b2', 'b10']);
  });

  it('keeps folders first when descending and sorts by size', () => {
    const sorted = visibleEntries(
      [entry('small', { size: 1 }), entry('big', { size: 9 }), entry('dir', { type: 'directory' })],
      '',
      false,
      { key: 'size', ascending: false }
    );
    expect(sorted.map((item) => item.name)).toEqual(['dir', 'big', 'small']);
  });

  it('hides hidden files until asked and filters by name', () => {
    const items = [entry('.env'), entry('app.log'), entry('readme')];
    const sort = { key: 'name', ascending: true } as const;
    expect(visibleEntries(items, '', false, sort).map((item) => item.name)).toEqual(['app.log', 'readme']);
    expect(visibleEntries(items, '', true, sort)).toHaveLength(3);
    expect(visibleEntries(items, 'LOG', true, sort).map((item) => item.name)).toEqual(['app.log']);
  });

  it('builds breadcrumbs for POSIX and Windows paths', () => {
    expect(breadcrumbs('/var/log').map((crumb) => crumb.path)).toEqual(['/', '/var', '/var/log']);
    expect(breadcrumbs('C:\\Users\\me').map((crumb) => crumb.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\me']);
  });

  it('selects a range in the order on screen', () => {
    expect(selectRange(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
    expect(selectRange(['a', 'b'], null, 'b')).toEqual(['b']);
  });
});
