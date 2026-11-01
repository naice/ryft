import { z } from 'zod';
import type { RiskLevel } from './snippetRisk';

// Matching control characters is the point: a parameter value must not smuggle in a second command.
// Line separators and bidi overrides count too: they make the preview show something else than what runs.
// eslint-disable-next-line no-control-regex
const VALUE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const COMMAND_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The families of quoting rules a snippet can be expanded for. */
export const SNIPPET_SHELLS = ['posix', 'powershell', 'cmd'] as const;
export type SnippetShell = (typeof SNIPPET_SHELLS)[number];

export const SNIPPET_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const SNIPPET_PLATFORMS = ['linux', 'macos', 'windows'] as const;
export type SnippetPlatform = (typeof SNIPPET_PLATFORMS)[number];

/** What a value may look like. A parameter without a type is plain text, as in snippets from before 1.3. */
export const SNIPPET_PARAM_TYPES = ['text', 'integer', 'port', 'host', 'user', 'path', 'identifier', 'enum', 'url'] as const;
export type SnippetParamType = (typeof SNIPPET_PARAM_TYPES)[number];

export const SNIPPET_TOOL_NAME = /^[A-Za-z0-9._+-]{1,64}$/;

export const snippetParamSchema = z.strictObject({
  name: z.string().regex(SNIPPET_PARAM_NAME),
  defaultValue: z.string().max(1024).refine((value) => !VALUE_CONTROL_CHARS.test(value)).nullable(),
  description: z.string().trim().max(256),
  type: z.enum(SNIPPET_PARAM_TYPES).optional(),
  /** Absent means required, which is what a placeholder has always been. */
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(64)).max(32).optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  /** The value may start with a dash, because it follows an option and cannot be read as one. */
  allowDash: z.boolean().optional()
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
  favorite: z.boolean(),
  /** Empty or absent means the author did not restrict it. */
  platforms: z.array(z.enum(SNIPPET_PLATFORMS)).max(3).optional(),
  requiredTools: z.array(z.string().regex(SNIPPET_TOOL_NAME)).max(16).optional()
});
export type SnippetInput = z.infer<typeof snippetInputSchema>;

export type SnippetSource = 'user' | 'builtin';

export interface Snippet extends Omit<SnippetInput, 'platforms' | 'requiredTools'> {
  id: string;
  createdAt: string;
  updatedAt: string;
  platforms: SnippetPlatform[];
  requiredTools: string[];
  /** Set by the main process only: the input schema has no such field, so nothing can claim to be built in. */
  source: SnippetSource;
  presetId: string | null;
  presetVersion: number | null;
  risk: RiskLevel;
}

const UNICODE_DASH = /^[‐-―−]/;
const INTEGER = /^\d{1,15}$/;
const HOST = /^[A-Za-z0-9._:-]{1,253}$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z0-9._@:/+~^-]{1,255}$/;

/** Why a value does not fit its parameter, or null when it does. */
export function validateParamValue(param: SnippetParam, value: string): string | null {
  const { name } = param;
  if (VALUE_CONTROL_CHARS.test(value)) return `„${name}“ darf keine Steuerzeichen oder Zeilenumbrüche enthalten.`;
  if (value === '') return param.required === false ? null : `Wert für „${name}“ fehlt.`;
  if (!param.type) return null;
  if ((value.startsWith('-') || UNICODE_DASH.test(value)) && !param.allowDash) {
    return `„${name}“ darf nicht mit einem Bindestrich beginnen, sonst wird der Wert als Option gelesen.`;
  }
  switch (param.type) {
    case 'text':
    case 'path':
      return null;
    case 'integer':
    case 'port': {
      if (!INTEGER.test(value)) return `„${name}“ muss eine ganze Zahl sein.`;
      const number = Number(value);
      const min = param.type === 'port' ? 1 : param.min;
      const max = param.type === 'port' ? 65535 : param.max;
      if (min !== undefined && number < min) return `„${name}“ muss mindestens ${min} sein.`;
      if (max !== undefined && number > max) return `„${name}“ darf höchstens ${max} sein.`;
      return null;
    }
    case 'host':
      return HOST.test(value) ? null : `„${name}“ ist kein gültiger Hostname und keine gültige IP-Adresse.`;
    case 'user':
      return USER.test(value) ? null : `„${name}“ ist kein gültiger Benutzername.`;
    case 'identifier':
      return IDENTIFIER.test(value) ? null : `„${name}“ darf nur Buchstaben, Ziffern und . _ @ : / + ~ ^ - enthalten.`;
    case 'enum':
      return param.options?.includes(value) ? null : `„${name}“ muss einer dieser Werte sein: ${(param.options ?? []).join(', ')}.`;
    case 'url':
      return /^https?:\/\/\S+$/i.test(value) && URL.canParse(value) ? null : `„${name}“ muss eine http- oder https-Adresse sein.`;
  }
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
// A bare word which starts with a digit is a number to PowerShell: 1gb arrives as 1073741824.
const POWERSHELL_SAFE = /^(?:[A-Za-z/][A-Za-z0-9_./:=+-]*|\d+)$/;
const CMD_SAFE = /^[A-Za-z0-9_./:=+\\-]+$/;

const POWERSHELL_SINGLE_QUOTES = /['‘’‚‛]/g;
const POWERSHELL_DOUBLE_QUOTES = /["“”„]/;
const isPowerShellSingle = (char: string | undefined) => char !== undefined && "'‘’‚‛".includes(char);
const isPowerShellDouble = (char: string | undefined) => char !== undefined && POWERSHELL_DOUBLE_QUOTES.test(char);

/** Quotes one value so that the shell reads it as exactly that value, wherever the placeholder stands. */
function quoteValue(value: string, shell: SnippetShell, context: QuoteContext, parameter: string): string {
  if (shell === 'posix') {
    if (context === 'single') return value.replace(/'/g, `'\\''`);
    if (context === 'double') return value.replace(/[\\"$`]/g, '\\$&');
    // zsh expands a word which starts with = into the path of a command.
    if (POSIX_SAFE.test(value) && !value.startsWith('=')) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  if (shell === 'powershell') {
    // PowerShell also ends a string at typographic quotes, so they need the same treatment as the plain ones.
    if (context === 'single') return value.replace(POWERSHELL_SINGLE_QUOTES, '$&$&');
    if (context === 'double') return value.replace(/[`$"“”„]/g, '`$&');
    if (POWERSHELL_SAFE.test(value)) return value;
    return `'${value.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'`;
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
  const single = (char: string | undefined) => (shell === 'powershell' ? isPowerShellSingle(char) : char === "'");
  const double = (char: string | undefined) => (shell === 'powershell' ? isPowerShellDouble(char) : char === '"');
  let current = context;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (current === 'single') {
      if (single(char)) current = 'none';
    } else if (current === 'double') {
      if (double(char)) current = 'none';
      else if ((char === '\\' && shell === 'posix') || (char === '`' && shell === 'powershell')) index += 1;
    } else if (double(char)) {
      current = 'double';
    } else if (single(char) && shell !== 'cmd') {
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

/** The template hands its text to another shell, which parses a quoted value all over again. */
const REPARSED_BY_SHELL =
  /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh\s+-\w*c\b|eval\s|ssh\s|su\s.*-c\b|watch\s|iex\b|invoke-expression\b|cmd(?:\.exe)?\s+\/[ck]\b|(?:powershell|pwsh)(?:\.exe)?\s|docker\s+(?:compose\s+)?exec\s|wsl(?:\.exe)?\s)/i;

// echo is PowerShell's alias of Write-Output.
const CMDLET_SEGMENT = /^(?:[A-Za-z]+-[A-Za-z]+|echo)(?:\s|$)/;

/**
 * Windows PowerShell hands `'a"b'` to a program as a"b, without escaping, and `'c:\a b\'` with a closing
 * quote the program reads as escaped. Either way one value becomes several arguments. Only cmdlets are
 * immune, so everything which is not plainly a cmdlet counts as a program.
 */
function runsNativeProgram(command: string): boolean {
  if (command.includes('(')) return true;
  return command.split(/[|;]|&&/).some((segment) => !CMDLET_SEGMENT.test(segment.trim()));
}

/** Where the double quotes the placeholder stands in were opened. */
function openingQuote(text: string, shell: SnippetShell): number {
  let position = 0;
  let context: QuoteContext = 'none';
  for (let index = 0; index < text.length; index += 1) {
    const next = advanceQuote(context, text.slice(index, index + 1), shell);
    if (context === 'none' && next === 'double') position = index;
    context = next;
  }
  return position;
}

function refuseUnsafeValue(command: string, before: string, value: string, shell: SnippetShell, context: QuoteContext, name: string): void {
  if (REPARSED_BY_SHELL.test(command) && !POSIX_SAFE.test(value)) {
    throw new SnippetExpansionError(`„${name}“ wird von einer weiteren Shell gelesen und darf nur Buchstaben, Ziffern und . _ / : = @ % + , - enthalten.`, name);
  }
  if (context === 'double' && shell !== 'cmd') {
    // The quotes around the placeholder belong to the outer command; inside a substitution none of them apply.
    const quoted = before.slice(openingQuote(before, shell));
    if (quoted.includes('$(') || (shell === 'posix' && quoted.includes('`'))) {
      throw new SnippetExpansionError(`„${name}“ steht in einer Befehlsersetzung in Anführungszeichen und lässt sich dort nicht sicher maskieren.`, name);
    }
    if (shell === 'posix' && value.includes('!')) {
      throw new SnippetExpansionError(`„${name}“ darf in doppelten Anführungszeichen kein „!“ enthalten, die Shell liest es als Verlaufszugriff.`, name);
    }
  }
  if (shell === 'powershell' && runsNativeProgram(command) && (POWERSHELL_DOUBLE_QUOTES.test(value) || (value.endsWith('\\') && /\s/.test(value)))) {
    throw new SnippetExpansionError(`„${name}“ enthält Zeichen, die PowerShell nicht sicher an ein externes Programm übergibt.`, name);
  }
}

/** A leading ~/ only means the home directory while it stands outside quotes, so it stays outside. */
function quotePath(value: string, shell: SnippetShell, parameter: string): string {
  if (shell === 'posix' && (value === '~' || value.startsWith('~/'))) {
    const rest = value.slice(2);
    return rest ? `~/${quoteValue(rest, shell, 'none', parameter)}` : value;
  }
  return quoteValue(value, shell, 'none', parameter);
}

/**
 * Replaces the placeholders. A value can never leave its argument: it is checked against its declared
 * type, quoted for the shell and for the quotes the template put around the placeholder, and control
 * characters are refused outright.
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
    const value = values[name] ?? declared?.defaultValue ?? match[2] ?? '';
    const problem = validateParamValue(declared ?? { name, defaultValue: null, description: '' }, value);
    if (problem) throw new SnippetExpansionError(problem, name);
    if (value === '') {
      // An optional argument leaves no trace, not even an empty one.
      if (context === 'none') result = result.replace(/ $/, '');
      continue;
    }
    refuseUnsafeValue(command, command.slice(0, match.index), value, shell, context, name);
    if (value.startsWith('-') && context === 'none' && !declared?.type) {
      warnings.push(`„${name}“ beginnt mit „-“ und kann als Option gelesen werden.`);
    }
    result += declared?.type === 'path' && context === 'none' ? quotePath(value, shell, name) : quoteValue(value, shell, context, name);
  }
  result += command.slice(last);
  return { command: result, warnings };
}

export function isMultiline(command: string): boolean {
  return /[\r\n]/.test(command.trim());
}
