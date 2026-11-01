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
  `
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
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
