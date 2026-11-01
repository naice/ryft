import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  workspaceDefinitionSchema,
  workspaceExportSchema,
  type LayoutNode,
  type WorkspaceDefinition,
  type WorkspaceExportFile
} from '@shared/contracts';
import {
  matchWorkspaceHost,
  WORKSPACE_VERSION,
  type WorkspaceHostRef,
  type WorkspaceSummary
} from '@shared/features/workspaces';
import { NotFoundError } from '../storage/repositories';

export class WorkspaceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFormatError';
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  data: string;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
}

function countPanes(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);
}

function hostIdsOf(node: LayoutNode, into: Set<string>): void {
  if (node.type === 'split') {
    hostIdsOf(node.first, into);
    hostIdsOf(node.second, into);
  } else if (node.target.kind === 'ssh') {
    into.add(node.target.hostId);
  }
}

function remapHosts(node: LayoutNode, mapping: ReadonlyMap<string, string>): LayoutNode {
  if (node.type === 'split') {
    return { ...node, first: remapHosts(node.first, mapping), second: remapHosts(node.second, mapping) };
  }
  if (node.target.kind !== 'ssh') return node;
  return { ...node, target: { kind: 'ssh', hostId: mapping.get(node.target.hostId) ?? node.target.hostId } };
}

/** Stored JSON that no longer parses is reported, and the row stays, so that nothing is lost by reading it. */
function parseDefinition(data: string): WorkspaceDefinition | null {
  try {
    const parsed = workspaceDefinitionSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class WorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  private toSummary(row: WorkspaceRow): WorkspaceSummary {
    const definition = parseDefinition(row.data);
    const tabs = definition?.layout.tabs ?? [];
    return {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault === 1,
      tabCount: tabs.length,
      paneCount: tabs.reduce((sum, tab) => sum + countPanes(tab.root), 0),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private row(id: string): WorkspaceRow {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    if (!row) throw new NotFoundError('Workspace');
    return row;
  }

  list(): WorkspaceSummary[] {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY name COLLATE NOCASE').all() as unknown as WorkspaceRow[];
    return rows.map((row) => this.toSummary(row));
  }

  get(id: string): WorkspaceDefinition {
    const definition = parseDefinition(this.row(id).data);
    if (!definition) throw new WorkspaceFormatError('Dieser Workspace hat ein unbekanntes Format und kann nicht geöffnet werden.');
    return definition;
  }

  defaultId(): string | null {
    const row = this.db.prepare('SELECT id FROM workspaces WHERE isDefault = 1').get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  create(name: string, definition: WorkspaceDefinition): WorkspaceSummary {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO workspaces (id, name, data, isDefault, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, name, JSON.stringify(definition), now, now);
    return this.toSummary(this.row(id));
  }

  update(id: string, changes: { name?: string; definition?: WorkspaceDefinition }): WorkspaceSummary {
    const row = this.row(id);
    this.db
      .prepare('UPDATE workspaces SET name = ?, data = ?, updatedAt = ? WHERE id = ?')
      .run(
        changes.name ?? row.name,
        changes.definition ? JSON.stringify(changes.definition) : row.data,
        new Date().toISOString(),
        id
      );
    return this.toSummary(this.row(id));
  }

  duplicate(id: string): WorkspaceSummary {
    const row = this.row(id);
    const definition = parseDefinition(row.data);
    if (!definition) throw new WorkspaceFormatError('Dieser Workspace hat ein unbekanntes Format.');
    return this.create(`${row.name} (Kopie)`, definition);
  }

  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    if (result.changes === 0) throw new NotFoundError('Workspace');
  }

  /** At most one workspace is the default; a partial unique index enforces that in the schema, too. */
  setDefault(id: string | null): void {
    if (id) this.row(id);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE workspaces SET isDefault = 0 WHERE isDefault = 1').run();
      if (id) this.db.prepare('UPDATE workspaces SET isDefault = 1 WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The file holds addresses to find hosts by. Credentials and environment values are not part of a workspace. */
  exportFile(id: string, hosts: readonly WorkspaceHostRef[]): { name: string; content: string } {
    const row = this.row(id);
    const definition = this.get(id);
    const used = new Set<string>();
    for (const tab of definition.layout.tabs) hostIdsOf(tab.root, used);
    const file: WorkspaceExportFile = {
      format: 'ryft-workspace',
      version: WORKSPACE_VERSION,
      name: row.name,
      definition,
      hosts: hosts
        .filter((host) => used.has(host.id))
        .map(({ id: hostId, name, hostname, port, username }) => ({ id: hostId, name, hostname, port, username }))
    };
    return { name: row.name, content: `${JSON.stringify(file, null, 2)}\n` };
  }

  /** Always creates a new workspace, and its startup commands stay off until the user has read them. */
  importFile(content: string, hosts: readonly WorkspaceHostRef[]): { workspace: WorkspaceSummary; unresolvedHosts: string[] } {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new WorkspaceFormatError('Die Datei ist kein gültiges JSON.');
    }
    const parsed = workspaceExportSchema.safeParse(raw);
    if (!parsed.success) throw new WorkspaceFormatError('Die Datei ist keine unterstützte RYFT-Workspace-Datei.');
    const file = parsed.data;
    const mapping = new Map<string, string>();
    const unresolvedHosts: string[] = [];
    for (const ref of file.hosts) {
      const match = matchWorkspaceHost(ref, hosts);
      if (match) mapping.set(ref.id, match);
      else unresolvedHosts.push(ref.name || ref.hostname);
    }
    const definition: WorkspaceDefinition = {
      ...file.definition,
      startupApproved: false,
      layout: {
        ...file.definition.layout,
        tabs: file.definition.layout.tabs.map((tab) => ({ ...tab, root: remapHosts(tab.root, mapping) }))
      }
    };
    return { workspace: this.create(file.name, definition), unresolvedHosts };
  }
}
