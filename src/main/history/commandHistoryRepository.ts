import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CommandHistoryEntry } from '@shared/features/commandHistory';

/** Oldest entries go first once the history is this long; it never grows without bound. */
export const MAX_COMMAND_HISTORY = 5_000;
const PRUNE_EVERY = 100;

export class CommandHistoryRepository {
  private addsSincePrune = 0;

  constructor(private readonly db: DatabaseSync) {}

  add(entry: Omit<CommandHistoryEntry, 'id' | 'createdAt'>): void {
    this.db
      .prepare(
        'INSERT INTO commandHistory (id, command, sessionLabel, hostId, cwd, exitCode, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), entry.command, entry.sessionLabel, entry.hostId, entry.cwd, entry.exitCode, new Date().toISOString());
    this.addsSincePrune += 1;
    if (this.addsSincePrune >= PRUNE_EVERY) this.prune();
  }

  prune(limit = MAX_COMMAND_HISTORY): void {
    this.addsSincePrune = 0;
    this.db
      .prepare(
        'DELETE FROM commandHistory WHERE rowid NOT IN (SELECT rowid FROM commandHistory ORDER BY createdAt DESC, rowid DESC LIMIT ?)'
      )
      .run(limit);
  }

  /** Newest first. Fuzzy ranking happens on top of this; this only narrows by plain text and host. */
  list(options: { query: string; hostId: string | null; limit: number }): CommandHistoryEntry[] {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (options.query.trim()) {
      conditions.push("command LIKE ? ESCAPE '\\'");
      values.push(`%${options.query.trim().replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (options.hostId) {
      conditions.push('hostId = ?');
      values.push(options.hostId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM commandHistory ${where} ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
      .all(...values, options.limit);
    return rows as unknown as CommandHistoryEntry[];
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM commandHistory WHERE id = ?').run(id);
  }

  clear(): void {
    this.db.prepare('DELETE FROM commandHistory').run();
  }
}
