import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sortOrder INTEGER NOT NULL
  );
  CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    authMethod TEXT NOT NULL CHECK (authMethod IN ('agent','key','password')),
    keyReference TEXT,
    groupId TEXT REFERENCES groups(id) ON DELETE SET NULL,
    tags TEXT NOT NULL,
    favorite INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX hosts_group ON hosts(groupId);
  CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE sessionHistory (
    id TEXT PRIMARY KEY,
    hostId TEXT,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ssh','local')),
    startedAt TEXT NOT NULL,
    endedAt TEXT,
    outcome TEXT
  );
  CREATE INDEX history_started ON sessionHistory(startedAt DESC);
  CREATE TABLE trustedHostKeys (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    keyType TEXT NOT NULL,
    keyBase64 TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    addedAt TEXT NOT NULL,
    UNIQUE (host, port, keyType)
  );
  `,
  // v1.0: reusable auth profiles, advanced host options, port forwarding profiles.
  `
  CREATE TABLE authProfiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('agent','key','password')),
    username TEXT,
    keyReference TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  ALTER TABLE hosts ADD COLUMN authProfileId TEXT REFERENCES authProfiles(id) ON DELETE SET NULL;
  ALTER TABLE hosts ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX hosts_auth_profile ON hosts(authProfileId);
  CREATE TABLE forwardProfiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostId TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('local','remote','dynamic')),
    bindAddress TEXT NOT NULL,
    bindPort INTEGER NOT NULL,
    destHost TEXT,
    destPort INTEGER,
    restoreOnStart INTEGER NOT NULL,
    autoReconnect INTEGER NOT NULL,
    allowNonLoopback INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX forwards_host ON forwardProfiles(hostId);
  `,
  // v1.1: saved workspaces, snippets, recorded commands, managed SSH keys.
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX workspaces_one_default ON workspaces(isDefault) WHERE isDefault = 1;
  CREATE TABLE snippets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    command TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT NOT NULL,
    shells TEXT NOT NULL,
    params TEXT NOT NULL,
    favorite INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE commandHistory (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    sessionLabel TEXT NOT NULL,
    hostId TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    cwd TEXT,
    exitCode INTEGER,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX command_history_created ON commandHistory(createdAt DESC);
  CREATE TABLE managedKeys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    publicKey TEXT NOT NULL,
    privateKeyPath TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('generated','imported')),
    encrypted INTEGER NOT NULL,
    createdAt TEXT NOT NULL
  );
  `,
  // v1.2: the session log index. The logs themselves are files, written only when someone turned them on.
  `
  CREATE TABLE sessionLogs (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    sizeBytes INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idxSessionLogsStarted ON sessionLogs (startedAt);
  `
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class DatabaseTooNewError extends Error {
  constructor(found: number) {
    super(
      `Die Datenbank stammt von einer neueren RYFT-Version (Schema ${found}, unterstützt bis ${SCHEMA_VERSION}). ` +
        'Bitte installiere die neuere Version; die Daten bleiben unverändert.'
    );
    this.name = 'DatabaseTooNewError';
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    migrate(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Keeps a copy of the data as it was, so that a migration can never be the end of it. */
function backupBeforeMigration(db: DatabaseSync, path: string, version: number): void {
  if (path === ':memory:') return;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const backup = `${path}.bak-v${version}`;
  // An earlier attempt may have left a backup; that one is the original and stays.
  if (!existsSync(backup)) copyFileSync(path, backup);
}

function migrate(db: DatabaseSync, path: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) throw new DatabaseTooNewError(row.user_version);
  if (row.user_version > 0 && row.user_version < MIGRATIONS.length) {
    backupBeforeMigration(db, path, row.user_version);
  }
  for (let version = row.user_version; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
