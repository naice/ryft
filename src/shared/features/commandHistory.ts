import { z } from 'zod';

export interface CommandHistoryEntry {
  id: string;
  command: string;
  sessionLabel: string;
  hostId: string | null;
  cwd: string | null;
  exitCode: number | null;
  createdAt: string;
}

export const commandHistoryQuerySchema = z.strictObject({
  query: z.string().max(512),
  hostId: z.uuid().nullable(),
  limit: z.number().int().min(1).max(500)
});

export const exclusionPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => compileExclusion(value) !== null, 'Ungültiger regulärer Ausdruck');

/** Never recorded, whatever the user configured: these commands tend to carry a secret on the line. */
const BUILTIN_EXCLUSIONS: readonly RegExp[] = [
  /(^|[\s;&|$:])[-_a-z0-9]*(pass(word|wd|phrase)?|pwd|secret|token|api[-_]?key|auth|credential)s?[-_a-z0-9]*\s*=/i,
  /--?(pass(word|wd|phrase)?|secret|token|api[-_]?key|auth[-_]?token|credentials?)([=\s]|$)/i,
  /\b(authorization|x-api-key)\s*:/i,
  /\bmysql\b.*\s-p\S+/i,
  /\bsshpass\b/i,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /\b(ghp|gho|github_pat|glpat|xox[abp]|sk|AKIA)[-_A-Za-z0-9]{12,}/
];

const MAX_COMMAND_LENGTH = 4096;

function compileExclusion(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Decides whether a finished command may be stored. User patterns that do not compile are ignored. */
export function isCommandRecordable(command: string, userPatterns: readonly string[]): boolean {
  // The shell convention for "do not remember this one".
  if (command.startsWith(' ')) return false;
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_COMMAND_LENGTH) return false;
  if (BUILTIN_EXCLUSIONS.some((pattern) => pattern.test(trimmed))) return false;
  return !userPatterns.some((pattern) => compileExclusion(pattern)?.test(trimmed));
}

/**
 * A subsequence match with a bonus for contiguous runs and word starts. Returns null when `query` does
 * not match, so the same function filters and ranks.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const haystack = text.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 1_000 - direct + (direct === 0 ? 200 : 0);
  let score = 0;
  let position = 0;
  let run = 0;
  for (const char of needle) {
    if (char === ' ') continue;
    const found = haystack.indexOf(char, position);
    if (found < 0) return null;
    run = found === position ? run + 1 : 0;
    const atWordStart = found === 0 || /[\s/_.:-]/.test(haystack[found - 1] as string);
    score += 1 + run * 2 + (atWordStart ? 3 : 0);
    position = found + 1;
  }
  return score;
}

export interface Suggestion {
  kind: 'history' | 'snippet';
  id: string;
  /** What gets inserted. For a snippet with parameters, the template. */
  text: string;
  label: string;
  detail: string;
  score: number;
}

/** Ranks history and snippets together; the newest use of a command wins, each command appears once. */
export function rankSuggestions(
  query: string,
  history: readonly CommandHistoryEntry[],
  snippets: readonly { id: string; name: string; command: string; description: string; favorite: boolean }[],
  limit = 50
): Suggestion[] {
  const results: Suggestion[] = [];
  const seen = new Set<string>();
  history.forEach((entry, index) => {
    if (seen.has(entry.command)) return;
    seen.add(entry.command);
    const score = fuzzyScore(query, entry.command);
    if (score === null) return;
    results.push({
      kind: 'history',
      id: entry.id,
      text: entry.command,
      label: entry.command,
      detail: entry.sessionLabel,
      // Recent commands first among similarly good matches.
      score: score - Math.min(index, 200) / 20
    });
  });
  for (const snippet of snippets) {
    const score = Math.max(fuzzyScore(query, snippet.name) ?? -1, fuzzyScore(query, snippet.command) ?? -1);
    if (score < 0) continue;
    results.push({
      kind: 'snippet',
      id: snippet.id,
      text: snippet.command,
      label: snippet.name,
      detail: snippet.command,
      score: score + (snippet.favorite ? 5 : 0)
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
