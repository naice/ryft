import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { classifyCommand, type RiskLevel } from '@shared/features/snippetRisk';
import type { Snippet, SnippetInput } from '@shared/features/snippets';
import { NotFoundError } from '../storage/repositories';
import type { Preset, PresetLibrary } from './presets';

interface SnippetRow {
  id: string;
  name: string;
  description: string;
  command: string;
  category: string;
  tags: string;
  shells: string;
  params: string;
  favorite: number;
  createdAt: string;
  updatedAt: string;
  source: string;
  presetId: string | null;
  presetVersion: number | null;
  platforms: string;
  requiredTools: string;
  risk: string | null;
}

/** Built-in snippets belong to RYFT: they can be favorited and copied, not changed. */
export class ReadOnlySnippetError extends Error {
  constructor() {
    super('Eingebaute Snippets lassen sich nicht ändern. Bearbeite stattdessen eine Kopie.');
    this.name = 'ReadOnlySnippetError';
  }
}

function toSnippet(row: SnippetRow): Snippet {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    command: row.command,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    shells: JSON.parse(row.shells) as Snippet['shells'],
    params: JSON.parse(row.params) as Snippet['params'],
    favorite: row.favorite === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source === 'builtin' ? 'builtin' : 'user',
    presetId: row.presetId,
    presetVersion: row.presetVersion,
    platforms: JSON.parse(row.platforms) as Snippet['platforms'],
    requiredTools: JSON.parse(row.requiredTools) as string[],
    // Only the library declares a risk. For anything else it follows from the command itself.
    risk: (row.risk as RiskLevel | null) ?? classifyCommand(row.command).level
  };
}

/** The row id of a preset, in the form every snippet channel expects. Stable, so favorites outlive upgrades. */
export function builtinSnippetId(presetId: string): string {
  const hash = createHash('sha256').update(`ryft-preset:${presetId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface PresetImportResult {
  inserted: number;
  updated: number;
  removed: number;
  /** The database was written by a newer library, which this version leaves as it is. */
  skippedNewer: boolean;
}

function presetContent(preset: Preset) {
  return {
    name: preset.title,
    description: preset.description,
    command: preset.command,
    category: preset.category,
    tags: JSON.stringify(preset.tags),
    shells: JSON.stringify(preset.shells),
    params: JSON.stringify(preset.params),
    platforms: JSON.stringify(preset.platforms),
    requiredTools: JSON.stringify(preset.requiredTools),
    risk: preset.risk
  };
}

export class SnippetRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Snippet[] {
    const rows = this.db.prepare('SELECT * FROM snippets ORDER BY favorite DESC, name COLLATE NOCASE').all();
    return (rows as unknown as SnippetRow[]).map(toSnippet);
  }

  get(id: string): Snippet {
    const row = this.db.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as SnippetRow | undefined;
    if (!row) throw new NotFoundError('Snippet');
    return toSnippet(row);
  }

  create(input: SnippetInput): Snippet {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO snippets (id, name, description, command, category, tags, shells, params, favorite, createdAt, updatedAt, platforms, requiredTools)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description,
        input.command,
        input.category,
        JSON.stringify(input.tags),
        JSON.stringify(input.shells),
        JSON.stringify(input.params),
        input.favorite ? 1 : 0,
        now,
        now,
        JSON.stringify(input.platforms ?? []),
        JSON.stringify(input.requiredTools ?? [])
      );
    return this.get(id);
  }

  update(id: string, input: SnippetInput): Snippet {
    this.assertEditable(id);
    const current = this.get(id);
    const result = this.db
      .prepare(
        `UPDATE snippets SET name = ?, description = ?, command = ?, category = ?, tags = ?, shells = ?, params = ?,
         favorite = ?, updatedAt = ?, platforms = ?, requiredTools = ? WHERE id = ? AND source = 'user'`
      )
      .run(
        input.name,
        input.description,
        input.command,
        input.category,
        JSON.stringify(input.tags),
        JSON.stringify(input.shells),
        JSON.stringify(input.params),
        input.favorite ? 1 : 0,
        new Date().toISOString(),
        JSON.stringify(input.platforms ?? current.platforms),
        JSON.stringify(input.requiredTools ?? current.requiredTools),
        id
      );
    if (result.changes === 0) throw new NotFoundError('Snippet');
    return this.get(id);
  }

  setFavorite(id: string, favorite: boolean): Snippet {
    const result = this.db
      .prepare('UPDATE snippets SET favorite = ?, updatedAt = ? WHERE id = ?')
      .run(favorite ? 1 : 0, new Date().toISOString(), id);
    if (result.changes === 0) throw new NotFoundError('Snippet');
    return this.get(id);
  }

  delete(id: string): void {
    this.assertEditable(id);
    const result = this.db.prepare("DELETE FROM snippets WHERE id = ? AND source = 'user'").run(id);
    if (result.changes === 0) throw new NotFoundError('Snippet');
  }

  /** A personal copy of any snippet. It keeps everything but its identity and is then the user's to change. */
  duplicate(id: string): Snippet {
    const original = this.get(id);
    const taken = new Set((this.db.prepare('SELECT name FROM snippets').all() as unknown as { name: string }[]).map((row) => row.name.toLowerCase()));
    let name = `${original.name} (Kopie)`.slice(0, 128);
    for (let number = 2; taken.has(name.toLowerCase()); number += 1) {
      name = `${original.name.slice(0, 110)} (Kopie ${number})`;
    }
    return this.create({
      name,
      description: original.description,
      command: original.command,
      category: original.category,
      tags: original.tags,
      shells: original.shells,
      params: original.params,
      favorite: false,
      platforms: original.platforms,
      requiredTools: original.requiredTools
    });
  }

  /** Every tool some snippet asks for, which is all a detection ever looks for. */
  requiredToolNames(): string[] {
    const names = new Set<string>();
    for (const { requiredTools } of this.db.prepare('SELECT requiredTools FROM snippets').all() as unknown as { requiredTools: string }[]) {
      for (const tool of JSON.parse(requiredTools) as string[]) names.add(tool);
    }
    return [...names].sort();
  }

  /**
   * Brings the built-in rows in line with the library. Safe to run on every start: it only ever touches rows
   * with source = 'builtin', keeps their favorite flag and creation date, and a second run changes nothing.
   */
  importPresets(library: PresetLibrary): PresetImportResult {
    const stored = this.db.prepare('SELECT version FROM presetLibrary WHERE id = 1').get() as { version: number } | undefined;
    if (stored && stored.version > library.version) return { inserted: 0, updated: 0, removed: 0, skippedNewer: true };

    const rows = this.db.prepare("SELECT * FROM snippets WHERE source = 'builtin'").all() as unknown as SnippetRow[];
    const existing = new Map(rows.map((row) => [row.presetId as string, row]));
    const result: PresetImportResult = { inserted: 0, updated: 0, removed: 0, skippedNewer: false };
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO snippets (id, name, description, command, category, tags, shells, params, favorite, createdAt, updatedAt,
         source, presetId, presetVersion, platforms, requiredTools, risk)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'builtin', ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    );
    const update = this.db.prepare(
      `UPDATE snippets SET name = ?, description = ?, command = ?, category = ?, tags = ?, shells = ?, params = ?,
         updatedAt = ?, presetVersion = ?, platforms = ?, requiredTools = ?, risk = ?
       WHERE source = 'builtin' AND presetId = ?`
    );

    this.db.exec('BEGIN');
    try {
      for (const preset of library.presets) {
        const content = presetContent(preset);
        const row = existing.get(preset.id);
        existing.delete(preset.id);
        if (!row) {
          const changes = insert.run(
            builtinSnippetId(preset.id),
            content.name,
            content.description,
            content.command,
            content.category,
            content.tags,
            content.shells,
            content.params,
            now,
            now,
            preset.id,
            preset.version,
            content.platforms,
            content.requiredTools,
            content.risk
          ).changes;
          result.inserted += Number(changes);
          continue;
        }
        // Comparing the content as well repairs a row which was edited behind RYFT's back.
        const unchanged =
          row.presetVersion === preset.version && (Object.keys(content) as (keyof typeof content)[]).every((key) => row[key] === content[key]);
        if (unchanged) continue;
        update.run(
          content.name,
          content.description,
          content.command,
          content.category,
          content.tags,
          content.shells,
          content.params,
          now,
          preset.version,
          content.platforms,
          content.requiredTools,
          content.risk,
          preset.id
        );
        result.updated += 1;
      }
      // Whatever is left was retired from the library. Copies the user made are their own rows and stay.
      const remove = this.db.prepare("DELETE FROM snippets WHERE source = 'builtin' AND presetId = ?");
      for (const presetId of existing.keys()) result.removed += Number(remove.run(presetId).changes);
      this.db
        .prepare(
          `INSERT INTO presetLibrary (id, version, importedAt) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET version = excluded.version, importedAt = excluded.importedAt`
        )
        .run(library.version, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return result;
  }

  private assertEditable(id: string): void {
    if (this.get(id).source === 'builtin') throw new ReadOnlySnippetError();
  }
}
