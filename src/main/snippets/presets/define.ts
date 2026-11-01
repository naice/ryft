import type { SnippetParam, SnippetPlatform, SnippetShell } from '@shared/features/snippets';
import type { RiskLevel } from '@shared/features/snippetRisk';

/** One entry of the built-in library. Its id is the identity across upgrades and never changes. */
export interface Preset {
  id: string;
  /** Raised whenever the content changes, which is what makes an upgrade replace the stored copy. */
  version: number;
  title: string;
  description: string;
  category: string;
  command: string;
  shells: SnippetShell[];
  platforms: SnippetPlatform[];
  requiredTools: string[];
  risk: RiskLevel;
  tags: string[];
  params: SnippetParam[];
}

type Options = Partial<Pick<Preset, 'version' | 'shells' | 'platforms' | 'requiredTools' | 'risk' | 'tags' | 'params'>>;

export function presetsOf(category: string, defaults: Options) {
  return (id: string, title: string, description: string, command: string, options: Options = {}): Preset => ({
    id,
    version: 1,
    title,
    description,
    category,
    command,
    shells: [],
    platforms: [],
    requiredTools: [],
    risk: 'safe',
    tags: [],
    params: [],
    ...defaults,
    ...options
  });
}

const typed = (type: SnippetParam['type'], name: string, defaultValue: string | null, description: string): SnippetParam => ({
  name,
  defaultValue,
  description,
  type
});

export const ALL_SHELLS: SnippetShell[] = ['posix', 'powershell', 'cmd'];
export const POSIX: SnippetShell[] = ['posix'];
export const UNIX: SnippetPlatform[] = ['linux', 'macos'];
export const EVERYWHERE: SnippetPlatform[] = ['linux', 'macos', 'windows'];

export const int = (name: string, defaultValue: number | null, description: string, max = 100_000): SnippetParam => ({
  ...typed('integer', name, defaultValue === null ? null : String(defaultValue), description),
  min: 1,
  max
});
export const port = (name: string, defaultValue: number | null, description: string) =>
  typed('port', name, defaultValue === null ? null : String(defaultValue), description);
export const host = (name = 'host', description = 'Hostname oder IP-Adresse') => typed('host', name, null, description);
export const user = (name = 'user', description = 'Benutzername auf dem Zielrechner') => typed('user', name, null, description);
export const path = (name: string, defaultValue: string | null, description: string) => typed('path', name, defaultValue, description);
export const identifier = (name: string, description: string, defaultValue: string | null = null) =>
  typed('identifier', name, defaultValue, description);
export const text = (name: string, description: string, defaultValue: string | null = null): SnippetParam => ({
  ...typed('text', name, defaultValue, description),
  // These follow an option or are data, so a leading dash cannot turn them into one.
  allowDash: true
});
export const url = (name = 'url', description = 'http- oder https-Adresse') => typed('url', name, null, description);
export const choice = (name: string, defaultValue: string, description: string, options: string[]): SnippetParam => ({
  ...typed('enum', name, defaultValue, description),
  options
});
