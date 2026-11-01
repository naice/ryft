import { z } from 'zod';

export const sessionLogSchemas = {
  search: z.strictObject({ query: z.string().min(1).max(512), limit: z.number().int().min(1).max(1000) }),
  byId: z.strictObject({ id: z.uuid() }),
  export: z.strictObject({ id: z.uuid(), format: z.enum(['text', 'jsonl']) }),
  setRecording: z.strictObject({ sessionId: z.uuid(), enabled: z.boolean() })
};

export interface SessionLogSummary {
  id: string;
  sessionId: string;
  label: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  sizeBytes: number;
  truncated: boolean;
  /** Still being written. */
  active: boolean;
}

export interface SessionLogMatch {
  logId: string;
  label: string;
  at: number;
  line: string;
}

export interface SessionLogStateEvent {
  sessionId: string;
  recording: boolean;
  logId: string | null;
  error: string | null;
}

/** One line of a log file. Input is not part of this format: it can contain what a prompt asked for. */
export type SessionLogEvent =
  | { t: number; type: 'meta'; label: string; kind: string }
  | { t: number; type: 'state'; state: string }
  | { t: number; type: 'output'; data: string }
  | { t: number; type: 'truncated' };

/** Removes terminal control sequences, so that text can be searched and read outside of a terminal. */
export function stripTerminalControls(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b(\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(\u0007|\u001b\\)?|[()][0-9A-Za-z]|[@-Z\\^_=>])/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
