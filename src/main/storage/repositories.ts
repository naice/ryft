import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_PREFERENCES,
  preferencesSchema,
  type Group,
  type HistoryEntry,
  type Host,
  type HostInput,
  type KnownHostEntry,
  type Preferences
} from '@shared/contracts';

export class NotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} nicht gefunden`);
    this.name = 'NotFoundError';
  }
}

export type StoredHost = Omit<Host, 'hasStoredSecret'>;

interface HostRow {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: Host['authMethod'];
  keyReference: string | null;
  groupId: string | null;
  tags: string;
  favorite: number;
  createdAt: string;
  updatedAt: string;
}

function toHost(row: HostRow): StoredHost {
  return { ...row, tags: JSON.parse(row.tags) as string[], favorite: row.favorite === 1 };
}

export class HostRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): StoredHost[] {
    const rows = this.db.prepare('SELECT * FROM hosts ORDER BY name COLLATE NOCASE').all() as unknown as HostRow[];
    return rows.map(toHost);
  }

  get(id: string): StoredHost {
    const row = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
    if (!row) throw new NotFoundError('Host');
    return toHost(row);
  }

  create(input: HostInput): StoredHost {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO hosts (id, name, hostname, port, username, authMethod, keyReference, groupId, tags, favorite, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.hostname,
        input.port,
        input.username,
        input.authMethod,
        input.keyReference,
        input.groupId,
        JSON.stringify(input.tags),
        input.favorite ? 1 : 0,
        now,
        now
      );
    return this.get(id);
  }

  update(id: string, input: HostInput): StoredHost {
    const result = this.db
      .prepare(
        `UPDATE hosts SET name = ?, hostname = ?, port = ?, username = ?, authMethod = ?, keyReference = ?,
         groupId = ?, tags = ?, favorite = ?, updatedAt = ? WHERE id = ?`
      )
      .run(
        input.name,
        input.hostname,
        input.port,
        input.username,
        input.authMethod,
        input.keyReference,
        input.groupId,
        JSON.stringify(input.tags),
        input.favorite ? 1 : 0,
        new Date().toISOString(),
        id
      );
    if (result.changes === 0) throw new NotFoundError('Host');
    return this.get(id);
  }

  setFavorite(id: string, favorite: boolean): StoredHost {
    const result = this.db
      .prepare('UPDATE hosts SET favorite = ?, updatedAt = ? WHERE id = ?')
      .run(favorite ? 1 : 0, new Date().toISOString(), id);
    if (result.changes === 0) throw new NotFoundError('Host');
    return this.get(id);
  }

  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    if (result.changes === 0) throw new NotFoundError('Host');
  }

  /** Copies metadata only: stored secrets belong to the original host. */
  duplicate(id: string): StoredHost {
    const source = this.get(id);
    return this.create({
      name: `${source.name} (Kopie)`.slice(0, 128),
      hostname: source.hostname,
      port: source.port,
      username: source.username,
      authMethod: source.authMethod,
      keyReference: source.keyReference,
      groupId: source.groupId,
      tags: source.tags,
      favorite: false
    });
  }
}

export class GroupRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Group[] {
    return this.db.prepare('SELECT * FROM groups ORDER BY sortOrder, name COLLATE NOCASE').all() as unknown as Group[];
  }

  private get(id: string): Group {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as unknown as Group | undefined;
    if (!row) throw new NotFoundError('Gruppe');
    return row;
  }

  create(name: string): Group {
    const id = randomUUID();
    const next = this.db.prepare('SELECT COALESCE(MAX(sortOrder), -1) + 1 AS next FROM groups').get() as {
      next: number;
    };
    this.db.prepare('INSERT INTO groups (id, name, sortOrder) VALUES (?, ?, ?)').run(id, name, next.next);
    return this.get(id);
  }

  rename(id: string, name: string): Group {
    const result = this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
    if (result.changes === 0) throw new NotFoundError('Gruppe');
    return this.get(id);
  }

  /** Hosts of a deleted group are kept and become ungrouped (ON DELETE SET NULL). */
  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    if (result.changes === 0) throw new NotFoundError('Gruppe');
  }
}

export class PreferenceRepository {
  constructor(private readonly db: DatabaseSync) {}

  getAll(): Preferences {
    const rows = this.db.prepare('SELECT key, value FROM preferences').all() as unknown as {
      key: string;
      value: string;
    }[];
    const merged: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
    for (const { key, value } of rows) {
      if (!(key in DEFAULT_PREFERENCES)) continue;
      const shape = preferencesSchema.shape[key as keyof Preferences];
      try {
        const parsed = shape.safeParse(JSON.parse(value));
        // A stored value that no longer validates falls back to its default rather than breaking startup.
        if (parsed.success) merged[key] = parsed.data;
      } catch {
        // Corrupt JSON: keep the default.
      }
    }
    return merged as Preferences;
  }

  setMany(patch: Partial<Preferences>): Preferences {
    const statement = this.db.prepare(
      'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) statement.run(key, JSON.stringify(value));
    }
    return this.getAll();
  }
}

export class HistoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  start(entry: { hostId: string | null; label: string; kind: 'ssh' | 'local' }): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO sessionHistory (id, hostId, label, kind, startedAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, entry.hostId, entry.label, entry.kind, new Date().toISOString());
    this.db
      .prepare(
        'DELETE FROM sessionHistory WHERE id NOT IN (SELECT id FROM sessionHistory ORDER BY startedAt DESC LIMIT 500)'
      )
      .run();
    return id;
  }

  setOutcome(id: string, outcome: 'connected' | 'failed'): void {
    this.db.prepare('UPDATE sessionHistory SET outcome = ? WHERE id = ?').run(outcome, id);
  }

  finish(id: string): void {
    this.db.prepare('UPDATE sessionHistory SET endedAt = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  list(limit: number): HistoryEntry[] {
    return this.db
      .prepare('SELECT * FROM sessionHistory ORDER BY startedAt DESC LIMIT ?')
      .all(limit) as unknown as HistoryEntry[];
  }
}

export interface TrustedHostKey extends KnownHostEntry {
  keyBase64: string;
}

export class TrustedHostKeyRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): KnownHostEntry[] {
    return this.db
      .prepare('SELECT id, host, port, keyType, fingerprint, addedAt FROM trustedHostKeys ORDER BY host, port, keyType')
      .all() as unknown as KnownHostEntry[];
  }

  forEndpoint(host: string, port: number): TrustedHostKey[] {
    return this.db
      .prepare('SELECT * FROM trustedHostKeys WHERE host = ? AND port = ?')
      .all(host.toLowerCase(), port) as unknown as TrustedHostKey[];
  }

  /**
   * Adds a first-use trust decision. A differing key of the same type is never replaced here:
   * it has to be removed explicitly in the settings first.
   */
  add(entry: { host: string; port: number; keyType: string; keyBase64: string; fingerprint: string }): void {
    this.db
      .prepare(
        `INSERT INTO trustedHostKeys (id, host, port, keyType, keyBase64, fingerprint, addedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host, port, keyType) DO NOTHING`
      )
      .run(
        randomUUID(),
        entry.host.toLowerCase(),
        entry.port,
        entry.keyType,
        entry.keyBase64,
        entry.fingerprint,
        new Date().toISOString()
      );
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM trustedHostKeys WHERE id = ?').run(id);
  }
}
