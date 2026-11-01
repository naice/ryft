import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Level = 'info' | 'warn' | 'error';

let logFile: string | null = null;

/**
 * Field names that must never reach the log, whatever a caller passes in.
 * Terminal input/output is deliberately not logged at all.
 */
const SECRET_FIELD = /pass(word|phrase)?|secret|private|answers?|^key$|^value$|^data$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: value.message };
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        SECRET_FIELD.test(field) ? '[redacted]' : redact(item, depth + 1)
      ])
    );
  }
  return value;
}

export function configureLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

function write(level: Level, message: string, details?: unknown): void {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(redact(details))}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
    } catch {
      logFile = null;
    }
  }
}

export const log = {
  info: (message: string, details?: unknown) => write('info', message, details),
  warn: (message: string, details?: unknown) => write('warn', message, details),
  error: (message: string, details?: unknown) => write('error', message, details)
};
