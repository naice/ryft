import { z } from 'zod';

// Matching control characters is the point: a parameter value must not smuggle in a second command.
// eslint-disable-next-line no-control-regex
const VALUE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const COMMAND_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The families of quoting rules a snippet can be expanded for. */
export const SNIPPET_SHELLS = ['posix', 'powershell', 'cmd'] as const;
export type SnippetShell = (typeof SNIPPET_SHELLS)[number];

export const SNIPPET_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const snippetParamSchema = z.strictObject({
  name: z.string().regex(SNIPPET_PARAM_NAME),
  defaultValue: z.string().max(1024).refine((value) => !VALUE_CONTROL_CHARS.test(value)).nullable(),
  description: z.string().trim().max(256)
});
export type SnippetParam = z.infer<typeof snippetParamSchema>;

export const snippetInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1024),
  command: z
    .string()
    .min(1)
    .max(16 * 1024)
    .refine((value) => value.trim().length > 0 && !COMMAND_CONTROL_CHARS.test(value)),
  category: z.string().trim().max(64),
  tags: z.array(z.string().trim().min(1).max(32)).max(16),
  /** Empty means the author did not restrict it. */
  shells: z.array(z.enum(SNIPPET_SHELLS)).max(3),
  params: z.array(snippetParamSchema).max(32),
  favorite: z.boolean()
});
export type SnippetInput = z.infer<typeof snippetInputSchema>;

export interface Snippet extends SnippetInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*(?::([^{}\r\n]*))?\}\}/g;

export interface PlaceholderInfo {
  name: string;
  /** The default written inside the template, `{{name:default}}`. */
  inlineDefault: string | null;
}

/**
 * The parameters a template mentions, in order of first use. `{{.Names}}` in a Docker format string
 * does not match the name rule and stays literal text.
 */
export function placeholdersOf(command: string): PlaceholderInfo[] {
  const seen = new Map<string, PlaceholderInfo>();
  for (const match of command.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!seen.has(name)) seen.set(name, { name, inlineDefault: match[2] ?? null });
  }
  return [...seen.values()];
}

type QuoteContext = 'none' | 'single' | 'double';

export class SnippetExpansionError extends Error {
  constructor(
    message: string,
    readonly parameter: string | null = null
  ) {
    super(message);
    this.name = 'SnippetExpansionError';
  }
}

const POSIX_SAFE = /^[A-Za-z0-9_./:=@%+,-]+$/;
const POWERSHELL_SAFE = /^[A-Za-z0-9_./:=+-]+$/;
const CMD_SAFE = /^[A-Za-z0-9_./:=+\\-]+$/;

/** Quotes one value so that the shell reads it as exactly that value, wherever the placeholder stands. */
function quoteValue(value: string, shell: SnippetShell, context: QuoteContext, parameter: string): string {
  if (shell === 'posix') {
    if (context === 'single') return value.replace(/'/g, `'\\''`);
    if (context === 'double') return value.replace(/[\\"$`]/g, '\\$&');
    if (POSIX_SAFE.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  if (shell === 'powershell') {
    if (context === 'single') return value.replace(/'/g, "''");
    if (context === 'double') return value.replace(/[`"$]/g, '`$&');
    if (POWERSHELL_SAFE.test(value)) return value;
    return `'${value.replace(/'/g, "''")}'`;
  }
  // cmd.exe has no quoting which is safe for every character, so such values are refused instead of guessed.
  if (/["%!^&|<>]/.test(value)) {
    throw new SnippetExpansionError(`„${parameter}“ enthält Zeichen, die in der Eingabeaufforderung nicht sicher sind.`, parameter);
  }
  if (context === 'single') {
    throw new SnippetExpansionError('Die Eingabeaufforderung kennt keine einfachen Anführungszeichen.', parameter);
  }
  if (context === 'double' || CMD_SAFE.test(value)) return value;
  return `"${value}"`;
}

function advanceQuote(context: QuoteContext, text: string, shell: SnippetShell): QuoteContext {
  let current = context;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (current === 'single') {
      if (char === "'") current = 'none';
    } else if (current === 'double') {
      if (char === '"') current = 'none';
      else if ((char === '\\' && shell === 'posix') || (char === '`' && shell === 'powershell')) index += 1;
    } else if (char === '"') {
      current = 'double';
    } else if (char === "'" && shell !== 'cmd') {
      current = 'single';
    } else if ((char === '\\' && shell === 'posix') || (char === '`' && shell === 'powershell')) {
      index += 1;
    }
  }
  return current;
}

export interface SnippetExpansion {
  command: string;
  /** Parameters whose value can still change the meaning of the command, for the user to judge. */
  warnings: string[];
}

/**
 * Replaces the placeholders. A value can never leave its argument: it is quoted for the shell and for
 * the quotes the template put around the placeholder, and control characters are refused outright.
 */
export function expandSnippet(
  command: string,
  values: Record<string, string>,
  shell: SnippetShell,
  params: readonly SnippetParam[] = []
): SnippetExpansion {
  const warnings: string[] = [];
  let result = '';
  let context: QuoteContext = 'none';
  let last = 0;
  for (const match of command.matchAll(PLACEHOLDER)) {
    const literal = command.slice(last, match.index);
    result += literal;
    context = advanceQuote(context, literal, shell);
    last = match.index + match[0].length;
    const name = match[1] as string;
    const declared = params.find((param) => param.name === name);
    const value = values[name] ?? declared?.defaultValue ?? match[2] ?? null;
    if (value === null || value === '') throw new SnippetExpansionError(`Wert für „${name}“ fehlt.`, name);
    if (VALUE_CONTROL_CHARS.test(value)) {
      throw new SnippetExpansionError(`„${name}“ darf keine Steuerzeichen oder Zeilenumbrüche enthalten.`, name);
    }
    if (value.startsWith('-') && context === 'none') {
      warnings.push(`„${name}“ beginnt mit „-“ und kann als Option gelesen werden.`);
    }
    result += quoteValue(value, shell, context, name);
  }
  result += command.slice(last);
  return { command: result, warnings };
}

export function isMultiline(command: string): boolean {
  return /[\r\n]/.test(command.trim());
}
