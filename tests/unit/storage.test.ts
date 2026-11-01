import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '@shared/contracts';
import { NotFoundError } from '../../src/main/storage/repositories';
import { openDatabase } from '../../src/main/storage/database';
import { createHarness, hostInput, type Harness } from '../fixtures/harness';

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.dispose());

describe('hosts', () => {
  it('creates, reads, updates and deletes', () => {
    const { hosts } = harness.services;
    const created = hosts.create(hostInput({ name: 'alpha', tags: ['a', 'b'], favorite: true }));
    expect(hosts.get(created.id)).toMatchObject({ name: 'alpha', tags: ['a', 'b'], favorite: true });

    const updated = hosts.update(created.id, hostInput({ name: 'beta', port: 2222 }));
    expect(updated).toMatchObject({ name: 'beta', port: 2222, favorite: false });

    hosts.delete(created.id);
    expect(hosts.list()).toEqual([]);
    expect(() => hosts.get(created.id)).toThrow(NotFoundError);
  });

  it('lists case-insensitively by name', () => {
    const { hosts } = harness.services;
    for (const name of ['beta', 'Alpha', 'gamma']) hosts.create(hostInput({ name }));
    expect(hosts.list().map((host) => host.name)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('duplicates metadata as a new, non-favorite host and does not copy secrets', () => {
    const { hosts, secrets, toPublicHost } = harness.services;
    const source = hosts.create(hostInput({ favorite: true }));
    secrets.set(source.id, 'password', 'hunter2');
    const copy = hosts.duplicate(source.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('fixture (Kopie)');
    expect(copy.favorite).toBe(false);
    expect(toPublicHost(source).hasStoredSecret).toBe(true);
    expect(toPublicHost(copy).hasStoredSecret).toBe(false);
  });

  it('survives a restart', () => {
    const { hosts } = harness.services;
    const created = hosts.create(hostInput({ name: 'persisted' }));
    const reopened = openDatabase(join(harness.directory, 'test.sqlite'));
    const row = reopened.prepare('SELECT name FROM hosts WHERE id = ?').get(created.id) as { name: string };
    reopened.close();
    expect(row.name).toBe('persisted');
  });
});

describe('groups', () => {
  it('keeps hosts when their group is deleted', () => {
    const { groups, hosts } = harness.services;
    const group = groups.create('Production');
    const host = hosts.create(hostInput({ groupId: group.id }));
    groups.delete(group.id);
    expect(groups.list()).toEqual([]);
    expect(hosts.get(host.id).groupId).toBeNull();
  });

  it('renames and orders by creation', () => {
    const { groups } = harness.services;
    const first = groups.create('B');
    groups.create('A');
    expect(groups.list().map((group) => group.name)).toEqual(['B', 'A']);
    expect(groups.rename(first.id, 'C').name).toBe('C');
  });
});

describe('preferences', () => {
  it('returns defaults and merges stored values', () => {
    const { preferences } = harness.services;
    expect(preferences.getAll()).toEqual(DEFAULT_PREFERENCES);
    expect(preferences.setMany({ terminalFontSize: 16 }).terminalFontSize).toBe(16);
    expect(preferences.getAll().theme).toBe(DEFAULT_PREFERENCES.theme);
  });

  it('falls back to the default for corrupt or invalid stored values', () => {
    const insert = harness.db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?)');
    insert.run('terminalFontSize', '"huge"');
    insert.run('theme', '{not json');
    insert.run('removedSetting', '1');
    const preferences = harness.services.preferences.getAll();
    expect(preferences.terminalFontSize).toBe(DEFAULT_PREFERENCES.terminalFontSize);
    expect(preferences.theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(preferences).not.toHaveProperty('removedSetting');
  });
});

describe('history', () => {
  it('records metadata only and caps its size', () => {
    const { history } = harness.services;
    const id = history.start({ hostId: null, label: 'cmd', kind: 'local' });
    history.setOutcome(id, 'connected');
    history.finish(id);
    const [entry] = history.list(10);
    expect(entry).toMatchObject({ label: 'cmd', kind: 'local', outcome: 'connected' });
    expect(entry?.endedAt).not.toBeNull();
    expect(Object.keys(entry!).sort()).toEqual(['endedAt', 'hostId', 'id', 'kind', 'label', 'outcome', 'startedAt']);
    for (let index = 0; index < 510; index += 1) history.start({ hostId: null, label: 'x', kind: 'local' });
    expect(history.list(200)).toHaveLength(200);
    const { count } = harness.db.prepare('SELECT COUNT(*) AS count FROM sessionHistory').get() as { count: number };
    expect(count).toBe(500);
  });
});

describe('trusted host keys', () => {
  it('does not replace a key of the same type', () => {
    const { trustedKeys } = harness.services;
    const entry = { host: 'Example.org', port: 22, keyType: 'ssh-ed25519', keyBase64: 'AAA', fingerprint: 'SHA256:a' };
    trustedKeys.add(entry);
    trustedKeys.add({ ...entry, keyBase64: 'BBB', fingerprint: 'SHA256:b' });
    const stored = trustedKeys.forEndpoint('example.org', 22);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.keyBase64).toBe('AAA');
    trustedKeys.remove(stored[0]!.id);
    expect(trustedKeys.list()).toEqual([]);
  });
});

describe('secrets at rest', () => {
  it('never places a secret in the database file', () => {
    const { hosts, secrets } = harness.services;
    const host = hosts.create(hostInput());
    secrets.set(host.id, 'password', 'correct-horse-battery-staple');
    harness.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const raw = readFileSync(join(harness.directory, 'test.sqlite'));
    expect(raw.includes('correct-horse-battery-staple')).toBe(false);
  });
});
