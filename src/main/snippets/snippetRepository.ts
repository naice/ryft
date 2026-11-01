import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Snippet, SnippetInput } from '@shared/features/snippets';
import { NotFoundError } from '../storage/repositories';

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
    updatedAt: row.updatedAt
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
        `INSERT INTO snippets (id, name, description, command, category, tags, shells, params, favorite, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now
      );
    return this.get(id);
  }

  update(id: string, input: SnippetInput): Snippet {
    const result = this.db
      .prepare(
        `UPDATE snippets SET name = ?, description = ?, command = ?, category = ?, tags = ?, shells = ?, params = ?,
         favorite = ?, updatedAt = ? WHERE id = ?`
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
    const result = this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
    if (result.changes === 0) throw new NotFoundError('Snippet');
  }
}
