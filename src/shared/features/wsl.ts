import { z } from 'zod';

const noControlChars = (value: string): boolean => !/[\p{Cc}]/u.test(value);

/** What `wsl --import` itself allows. Keeps a name from ever reading as an option or a second argument. */
export const distroNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const wslDirectorySchema = z
  .string()
  .max(4096)
  .refine(noControlChars)
  .refine((value) => value === '~' || value.startsWith('~/') || value.startsWith('/'), 'Absoluter Linux-Pfad oder ~ erwartet');

export interface WslDistro {
  name: string;
  running: boolean;
  version: number | null;
  isDefault: boolean;
}

export interface WslStatus {
  available: boolean;
  distros: WslDistro[];
  error: string | null;
}

/** `wsl.exe` writes UTF-16 unless told otherwise, and older versions ignore being told. */
export function decodeWslOutput(output: Buffer): string {
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

/**
 * Reads `wsl -l -v`. The state column is translated, so whether a distribution runs comes from the
 * language-independent `wsl -l --running -q` instead.
 */
export function parseWslList(verbose: string, runningNames: string): WslDistro[] {
  const running = new Set(runningNames.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const distros: WslDistro[] = [];
  for (const line of verbose.split(/\r?\n/).slice(1)) {
    const match = /^\s*(\*)?\s*(\S+)\s+.*?(\d+)\s*$/.exec(line);
    if (!match) continue;
    const name = match[2] as string;
    if (!distroNameSchema.safeParse(name).success) continue;
    distros.push({ name, running: running.has(name), version: Number(match[3]), isDefault: match[1] === '*' });
  }
  return distros;
}
