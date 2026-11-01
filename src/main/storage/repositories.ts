import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_HOST_OPTIONS,
  DEFAULT_PREFERENCES,
  preferencesSchema,
  type AuthProfile,
  type AuthProfileInput,
  type ForwardInput,
  type ForwardProfile,
  type Group,
  type HistoryEntry,
  type Host,
  type HostInput,
  type HostOptions,
  type KnownHostEntry,
  type Preferences
} from '@shared/contracts';
import { hostOptionsSchema } from '@shared/features/hostOptions';

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
  authProfileId: string | null;
  options: string;
}

/** Options stored by another version may not validate; the connection then falls back to the defaults. */
function parseHostOptions(raw: string): HostOptions {
  try {
    const parsed = hostOptionsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_HOST_OPTIONS;
  } catch {
    return DEFAULT_HOST_OPTIONS;
  }
}

function toHost(row: HostRow): StoredHost {
  return {
    ...row,
    tags: JSON.parse(row.tags) as string[],
    favorite: row.favorite === 1,
    options: parseHostOptions(row.options)
  };
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
        `INSERT INTO hosts (id, name, hostname, port, username, authMethod, keyReference, groupId, tags, favorite, createdAt, updatedAt, authProfileId, options)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now,
        input.authProfileId,
        JSON.stringify(input.options)
      );
    return this.get(id);
  }

  update(id: string, input: HostInput): StoredHost {
    const result = this.db
      .prepare(
        `UPDATE hosts SET name = ?, hostname = ?, port = ?, username = ?, authMethod = ?, keyReference = ?,
         groupId = ?, tags = ?, favorite = ?, updatedAt = ?, authProfileId = ?, options = ? WHERE id = ?`
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
        input.authProfileId,
        JSON.stringify(input.options),
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
  find(id: string): StoredHost | null {
    const row = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
    return row ? toHost(row) : null;
  }

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
      favorite: false,
      authProfileId: source.authProfileId,
      options: source.options
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

  /** The deliberate replacement after the user confirmed a changed key. */
  replace(entry: { host: string; port: number; keyType: string; keyBase64: string; fingerprint: string }): void {
    this.db
      .prepare('DELETE FROM trustedHostKeys WHERE host = ? AND port = ? AND keyType = ?')
      .run(entry.host.toLowerCase(), entry.port, entry.keyType);
    this.add(entry);
  }
}

export type StoredAuthProfile = Omit<AuthProfile, 'hasStoredSecret' | 'usedByHosts'>;

export class AuthProfileRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): StoredAuthProfile[] {
    return this.db
      .prepare('SELECT * FROM authProfiles ORDER BY name COLLATE NOCASE')
      .all() as unknown as StoredAuthProfile[];
  }

  find(id: string): StoredAuthProfile | null {
    return (this.db.prepare('SELECT * FROM authProfiles WHERE id = ?').get(id) as unknown as StoredAuthProfile) ?? null;
  }

  get(id: string): StoredAuthProfile {
    const profile = this.find(id);
    if (!profile) throw new NotFoundError('Anmeldeprofil');
    return profile;
  }

  usedByHosts(id: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM hosts WHERE authProfileId = ?').get(id) as {
      count: number;
    };
    return row.count;
  }

  create(input: AuthProfileInput): StoredAuthProfile {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO authProfiles (id, name, method, username, keyReference, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.method, input.username, input.keyReference, now, now);
    return this.get(id);
  }

  update(id: string, input: AuthProfileInput): StoredAuthProfile {
    const result = this.db
      .prepare('UPDATE authProfiles SET name = ?, method = ?, username = ?, keyReference = ?, updatedAt = ? WHERE id = ?')
      .run(input.name, input.method, input.username, input.keyReference, new Date().toISOString(), id);
    if (result.changes === 0) throw new NotFoundError('Anmeldeprofil');
    return this.get(id);
  }

  /** Hosts using the profile fall back to their own settings (ON DELETE SET NULL). */
  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM authProfiles WHERE id = ?').run(id);
    if (result.changes === 0) throw new NotFoundError('Anmeldeprofil');
  }
}

interface ForwardRow extends Omit<ForwardProfile, 'restoreOnStart' | 'autoReconnect' | 'allowNonLoopback'> {
  restoreOnStart: number;
  autoReconnect: number;
  allowNonLoopback: number;
}

function toForward(row: ForwardRow): ForwardProfile {
  return {
    ...row,
    restoreOnStart: row.restoreOnStart === 1,
    autoReconnect: row.autoReconnect === 1,
    allowNonLoopback: row.allowNonLoopback === 1
  };
}

export class ForwardRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): ForwardProfile[] {
    const rows = this.db.prepare('SELECT * FROM forwardProfiles ORDER BY name COLLATE NOCASE').all();
    return (rows as unknown as ForwardRow[]).map(toForward);
  }

  get(id: string): ForwardProfile {
    const row = this.db.prepare('SELECT * FROM forwardProfiles WHERE id = ?').get(id) as ForwardRow | undefined;
    if (!row) throw new NotFoundError('Port-Weiterleitung');
    return toForward(row);
  }

  create(input: ForwardInput): ForwardProfile {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO forwardProfiles (id, name, hostId, type, bindAddress, bindPort, destHost, destPort,
           restoreOnStart, autoReconnect, allowNonLoopback, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.hostId,
        input.type,
        input.bindAddress,
        input.bindPort,
        input.destHost,
        input.destPort,
        input.restoreOnStart ? 1 : 0,
        input.autoReconnect ? 1 : 0,
        input.allowNonLoopback ? 1 : 0,
        now,
        now
      );
    return this.get(id);
  }

  update(id: string, input: ForwardInput): ForwardProfile {
    const result = this.db
      .prepare(
        `UPDATE forwardProfiles SET name = ?, hostId = ?, type = ?, bindAddress = ?, bindPort = ?, destHost = ?,
           destPort = ?, restoreOnStart = ?, autoReconnect = ?, allowNonLoopback = ?, updatedAt = ? WHERE id = ?`
      )
      .run(
        input.name,
        input.hostId,
        input.type,
        input.bindAddress,
        input.bindPort,
        input.destHost,
        input.destPort,
        input.restoreOnStart ? 1 : 0,
        input.autoReconnect ? 1 : 0,
        input.allowNonLoopback ? 1 : 0,
        new Date().toISOString(),
        id
      );
    if (result.changes === 0) throw new NotFoundError('Port-Weiterleitung');
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM forwardProfiles WHERE id = ?').run(id);
  }

  countForHost(hostId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM forwardProfiles WHERE hostId = ?').get(hostId) as {
      count: number;
    };
    return row.count;
  }
}
