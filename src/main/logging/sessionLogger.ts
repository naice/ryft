import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import {
  stripTerminalControls,
  type SessionLogEvent,
  type SessionLogMatch,
  type SessionLogStateEvent,
  type SessionLogSummary
} from '@shared/features/sessionLogs';
import { NotFoundError } from '../storage/repositories';

const FLUSH_INTERVAL_MS = 250;
/** Output that outruns the disk is dropped and marked, so that a log can never grow the memory of the app. */
const MAX_PENDING_CHARS = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 4096;
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class SessionLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLogError';
  }
}

export interface SessionLogEventSink {
  sessionLogState(event: SessionLogStateEvent): void;
}

export interface SessionLogSettings {
  sessionLogDefault: boolean;
  sessionLogMaxMb: number;
  sessionLogRetentionDays: number;
}

interface ActiveLog {
  id: string;
  sessionId: string;
  fd: number;
  pending: string[];
  pendingChars: number;
  size: number;
  truncated: boolean;
  timer: NodeJS.Timeout | null;
}

interface LogRow {
  id: string;
  sessionId: string;
  label: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  sizeBytes: number;
  truncated: number;
}

export interface SessionLoggerOptions {
  db: DatabaseSync;
  directory: string;
  settings(): SessionLogSettings;
  sink: SessionLogEventSink;
  now?(): number;
}

/**
 * Writes what a session displays to one JSONL file per session. The only way in is `output`, which
 * sees what came back from the session; nothing in here ever receives what the user typed.
 */
export class SessionLogger {
  private readonly active = new Map<string, ActiveLog>();
  /** A person's "off" outlasts reconnects of that session. */
  private readonly declined = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: SessionLoggerOptions) {
    this.now = options.now ?? Date.now;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    // A crash can leave logs which claim to still be running.
    options.db.prepare('UPDATE sessionLogs SET endedAt = startedAt WHERE endedAt IS NULL').run();
    this.enforceRetention();
  }

  /** Called on every connect. Follows the default unless the person decided otherwise for this session. */
  sessionConnected(sessionId: string, label: string, kind: string): void {
    const log = this.active.get(sessionId);
    if (log) {
      this.append(log, { t: this.now(), type: 'state', state: 'connected' });
      return;
    }
    if (this.options.settings().sessionLogDefault && !this.declined.has(sessionId)) this.start(sessionId, label, kind);
  }

  setRecording(sessionId: string, enabled: boolean, label: string, kind: string): void {
    if (enabled) {
      this.declined.delete(sessionId);
      if (!this.active.has(sessionId)) this.start(sessionId, label, kind);
      return;
    }
    this.declined.add(sessionId);
    this.stop(sessionId);
  }

  output(sessionId: string, text: string): void {
    const log = this.active.get(sessionId);
    if (log) this.append(log, { t: this.now(), type: 'output', data: text });
  }

  sessionState(sessionId: string, state: string): void {
    const log = this.active.get(sessionId);
    if (log) this.append(log, { t: this.now(), type: 'state', state });
  }

  sessionEnded(sessionId: string): void {
    this.declined.delete(sessionId);
    this.stop(sessionId);
  }

  list(): SessionLogSummary[] {
    const rows = this.options.db.prepare('SELECT * FROM sessionLogs ORDER BY startedAt DESC').all() as unknown as LogRow[];
    return rows.map((row) => this.summary(row));
  }

  remove(id: string): void {
    const row = this.row(id);
    if ([...this.active.values()].some((log) => log.id === id)) {
      throw new SessionLogError('Dieses Protokoll wird noch geschrieben. Beende zuerst die Aufzeichnung.');
    }
    this.deleteRow(row.id);
  }

  removeAllFinished(): void {
    for (const row of this.list()) {
      if (!row.active) this.deleteRow(row.id);
    }
  }

  /** Reads file by file and line by line, so that large logs cost time rather than memory. */
  async search(query: string, limit: number): Promise<SessionLogMatch[]> {
    this.flushAll();
    const needle = query.toLocaleLowerCase();
    const matches: SessionLogMatch[] = [];
    for (const log of this.list()) {
      if (matches.length >= limit) break;
      let partial = '';
      const check = (line: string, at: number) => {
        if (matches.length < limit && line.toLocaleLowerCase().includes(needle)) {
          matches.push({ logId: log.id, label: log.label, at, line: line.slice(0, MAX_LINE_CHARS) });
        }
      };
      await this.readEvents(log.id, (event) => {
        if (event.type !== 'output') return matches.length < limit;
        const lines = (partial + stripTerminalControls(event.data)).split('\n');
        partial = lines.pop() ?? '';
        // A line without an end would otherwise grow with every chunk of a program that never prints one.
        if (partial.length > MAX_LINE_CHARS) {
          lines.push(partial);
          partial = '';
        }
        for (const line of lines) check(line, event.t);
        return matches.length < limit;
      });
      check(partial, log.endedAt ?? log.startedAt);
    }
    return matches;
  }

  /** The content of a log, for saving outside of RYFT. */
  read(id: string, format: 'text' | 'jsonl'): string {
    this.row(id);
    this.flushAll();
    const path = this.pathOf(id);
    if (statSync(path).size > MAX_EXPORT_BYTES) throw new SessionLogError('Dieses Protokoll ist zu groß für den Export.');
    const raw = readFileSync(path, 'utf8');
    if (format === 'jsonl') return raw;
    const chunks: string[] = [];
    for (const line of raw.split('\n')) {
      const event = parseEvent(line);
      if (event?.type === 'output') chunks.push(event.data);
    }
    return stripTerminalControls(chunks.join(''));
  }

  enforceRetention(): void {
    const { sessionLogMaxMb, sessionLogRetentionDays } = this.options.settings();
    const finished = this.list().filter((log) => !log.active);
    const cutoff = this.now() - sessionLogRetentionDays * DAY_MS;
    let total = this.list().reduce((sum, log) => sum + log.sizeBytes, 0);
    // Oldest first, since `list` sorts the other way around.
    for (const log of [...finished].reverse()) {
      if (log.startedAt >= cutoff && total <= sessionLogMaxMb * 1024 * 1024) continue;
      total -= log.sizeBytes;
      this.deleteRow(log.id);
    }
  }

  /** Flushes and closes everything, as the last step of shutting down. */
  disposeAll(): void {
    for (const sessionId of [...this.active.keys()]) this.stop(sessionId);
    this.declined.clear();
  }

  private start(sessionId: string, label: string, kind: string): void {
    const id = randomUUID();
    let fd: number;
    try {
      fd = openSync(this.pathOf(id), 'a', 0o600);
    } catch {
      this.options.sink.sessionLogState({ sessionId, recording: false, logId: null, error: 'Das Protokoll konnte nicht angelegt werden.' });
      return;
    }
    this.options.db
      .prepare('INSERT INTO sessionLogs (id, sessionId, label, kind, startedAt, endedAt, sizeBytes, truncated) VALUES (?, ?, ?, ?, ?, NULL, 0, 0)')
      .run(id, sessionId, label, kind, this.now());
    const log: ActiveLog = { id, sessionId, fd, pending: [], pendingChars: 0, size: 0, truncated: false, timer: null };
    this.active.set(sessionId, log);
    this.append(log, { t: this.now(), type: 'meta', label, kind });
    this.options.sink.sessionLogState({ sessionId, recording: true, logId: id, error: null });
  }

  private stop(sessionId: string): void {
    const log = this.active.get(sessionId);
    if (!log) return;
    this.flush(log);
    this.active.delete(sessionId);
    if (log.timer) clearTimeout(log.timer);
    closeSync(log.fd);
    this.options.db
      .prepare('UPDATE sessionLogs SET endedAt = ?, sizeBytes = ?, truncated = ? WHERE id = ?')
      .run(this.now(), log.size, log.truncated ? 1 : 0, log.id);
    this.options.sink.sessionLogState({ sessionId, recording: false, logId: log.id, error: null });
    this.enforceRetention();
  }

  private append(log: ActiveLog, event: SessionLogEvent): void {
    if (log.pendingChars > MAX_PENDING_CHARS) {
      if (!log.truncated) {
        log.truncated = true;
        log.pending.push(`${JSON.stringify({ t: this.now(), type: 'truncated' } satisfies SessionLogEvent)}\n`);
      }
      return;
    }
    const line = `${JSON.stringify(event)}\n`;
    log.pending.push(line);
    log.pendingChars += line.length;
    log.timer ??= setTimeout(() => {
      log.timer = null;
      this.flush(log);
    }, FLUSH_INTERVAL_MS);
  }

  private flushAll(): void {
    for (const log of this.active.values()) this.flush(log);
  }

  private flush(log: ActiveLog): void {
    if (log.pending.length === 0) return;
    const data = Buffer.from(log.pending.join(''), 'utf8');
    log.pending = [];
    log.pendingChars = 0;
    try {
      writeSync(log.fd, data);
      log.size += data.length;
      this.options.db.prepare('UPDATE sessionLogs SET sizeBytes = ? WHERE id = ?').run(log.size, log.id);
    } catch {
      // A full disk must not take the session down with it. The person gets told that recording stopped.
      const { sessionId } = log;
      this.active.delete(sessionId);
      if (log.timer) clearTimeout(log.timer);
      closeSync(log.fd);
      this.options.db.prepare('UPDATE sessionLogs SET endedAt = ?, truncated = 1 WHERE id = ?').run(this.now(), log.id);
      this.options.sink.sessionLogState({ sessionId, recording: false, logId: log.id, error: 'Das Protokoll konnte nicht weitergeschrieben werden.' });
    }
  }

  private summary(row: LogRow): SessionLogSummary {
    const active = [...this.active.values()].find((log) => log.id === row.id);
    return {
      id: row.id,
      sessionId: row.sessionId,
      label: row.label,
      kind: row.kind,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      sizeBytes: active ? active.size : row.sizeBytes,
      truncated: active ? active.truncated : row.truncated === 1,
      active: active !== undefined
    };
  }

  private row(id: string): LogRow {
    const row = this.options.db.prepare('SELECT * FROM sessionLogs WHERE id = ?').get(id) as unknown as LogRow | undefined;
    if (!row) throw new NotFoundError('Protokoll');
    return row;
  }

  private deleteRow(id: string): void {
    rmSync(this.pathOf(id), { force: true });
    this.options.db.prepare('DELETE FROM sessionLogs WHERE id = ?').run(id);
  }

  private pathOf(id: string): string {
    return join(this.options.directory, `${id}.jsonl`);
  }

  private async readEvents(id: string, visit: (event: SessionLogEvent) => boolean): Promise<void> {
    const stream = createReadStream(this.pathOf(id), { encoding: 'utf8' });
    stream.on('error', () => undefined);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const event = parseEvent(line);
        if (event && !visit(event)) break;
      }
    } catch {
      // A log deleted by hand simply has nothing to search.
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}

function parseEvent(line: string): SessionLogEvent | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as SessionLogEvent;
  } catch {
    return null;
  }
}
