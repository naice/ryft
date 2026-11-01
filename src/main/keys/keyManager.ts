import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { utils, type Client } from 'ssh2';
import { buildInstallCommand, isValidPublicKeyLine, type ManagedKey, type ManagedKeyOrigin } from '@shared/features/keys';
import { sha256Fingerprint } from '../security/knownHosts';
import type { CredentialResolver } from '../security/credentials';
import { NotFoundError } from '../storage/repositories';

const MAX_KEY_FILE_BYTES = 64 * 1024;
const INSTALL_TIMEOUT_MS = 30_000;

export class KeyManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyManagerError';
  }
}

interface KeyRow {
  id: string;
  name: string;
  type: string;
  fingerprint: string;
  publicKey: string;
  privateKeyPath: string;
  origin: ManagedKeyOrigin;
  encrypted: number;
  createdAt: string;
}

export interface KeyImportCandidate {
  token: string;
  path: string;
  suggestedName: string;
  /** The public part cannot be read without the passphrase. */
  needsPassphrase: boolean;
}

export interface KeyManagerDeps {
  db: DatabaseSync;
  directory: string;
  credentials: CredentialResolver;
  /** Names of hosts and profiles using a key file. */
  usersOf(path: string): string[];
}

function isParseError(value: unknown): value is Error {
  return value instanceof Error;
}

function parsePrivate(content: Buffer, passphrase?: string | null) {
  const parsed = utils.parseKey(content, passphrase ?? undefined);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) return new Error('Keine Schlüssel gefunden');
  return key;
}

/** About 3 in 1000 keys from ssh2's generator cannot be parsed again, so each one is proven before it is kept. */
function generatePair(comment: string, passphrase: string | null): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519', {
      comment,
      ...(passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 16 } : {})
    });
    if (!isParseError(parsePrivate(Buffer.from(pair.private), passphrase))) return pair;
  }
  throw new KeyManagerError('Der Schlüssel konnte nicht erzeugt werden.');
}

/** Mode bits mean little on Windows, where a file inherits its folder's ACL and OpenSSH refuses what others may read. */
function restrictToOwner(path: string): void {
  chmodSync(path, 0o600);
  if (process.platform !== 'win32') return;
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const domain = process.env.USERDOMAIN;
  const account = domain ? `${domain}\\${userInfo().username}` : userInfo().username;
  execFileSync(icacls, [path, '/inheritance:r', '/grant:r', `${account}:F`], { stdio: 'ignore', windowsHide: true });
}

function isPassphraseError(error: Error): boolean {
  return /encrypted|passphrase/i.test(error.message);
}

function describePublic(line: string): { type: string; fingerprint: string } {
  const [type, base64] = line.split(' ') as [string, string];
  return { type, fingerprint: sha256Fingerprint(Buffer.from(base64, 'base64')) };
}

/**
 * Manages keys by reference: the private part stays in its file, is only ever read to derive the
 * public part, and is not returned through any interface.
 */
export class KeyManager {
  private readonly candidates = new Map<string, string>();

  constructor(private readonly deps: KeyManagerDeps) {}

  private toPublic(row: KeyRow): ManagedKey {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      fingerprint: row.fingerprint,
      publicKey: row.publicKey,
      privateKeyPath: row.privateKeyPath,
      origin: row.origin,
      encrypted: row.encrypted === 1,
      hasStoredPassphrase: this.deps.credentials.hasAny('key', row.id),
      usedBy: this.deps.usersOf(row.privateKeyPath),
      createdAt: row.createdAt
    };
  }

  private row(id: string): KeyRow {
    const row = this.deps.db.prepare('SELECT * FROM managedKeys WHERE id = ?').get(id) as KeyRow | undefined;
    if (!row) throw new NotFoundError('Schlüssel');
    return row;
  }

  private insert(row: KeyRow): void {
    this.deps.db
      .prepare(
        `INSERT INTO managedKeys (id, name, type, fingerprint, publicKey, privateKeyPath, origin, encrypted, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.name, row.type, row.fingerprint, row.publicKey, row.privateKeyPath, row.origin, row.encrypted, row.createdAt);
  }

  list(): ManagedKey[] {
    const rows = this.deps.db.prepare('SELECT * FROM managedKeys ORDER BY name COLLATE NOCASE').all();
    return (rows as unknown as KeyRow[]).map((row) => this.toPublic(row));
  }

  get(id: string): ManagedKey {
    return this.toPublic(this.row(id));
  }

  /** A stored passphrase for a host that names a managed key file. */
  passphraseForPath(path: string): string | null {
    const row = this.deps.db.prepare('SELECT id FROM managedKeys WHERE privateKeyPath = ?').get(path) as { id: string } | undefined;
    return row ? this.deps.credentials.getKeyPassphrase(row.id) : null;
  }

  generate(input: { name: string; comment: string; passphrase: string | null; rememberPassphrase: boolean }): ManagedKey {
    const id = randomUUID();
    const pair = generatePair(input.comment, input.passphrase);
    mkdirSync(this.deps.directory, { recursive: true, mode: 0o700 });
    const path = join(this.deps.directory, id);
    // `wx`: a key is never written over an existing file, even if an id should ever repeat.
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    try {
      // The rights are in place before the file holds anything worth reading.
      restrictToOwner(path);
    } catch {
      rmSync(path, { force: true });
      throw new KeyManagerError('Die Rechte der Schlüsseldatei konnten nicht eingeschränkt werden. Es wurde kein Schlüssel angelegt.');
    }
    appendFileSync(path, pair.private);
    const publicKey = pair.public.trim();
    writeFileSync(`${path}.pub`, `${publicKey}\n`, { mode: 0o644, flag: 'wx' });
    this.insert({
      id,
      name: input.name,
      ...describePublic(publicKey),
      publicKey,
      privateKeyPath: path,
      origin: 'generated',
      encrypted: input.passphrase ? 1 : 0,
      createdAt: new Date().toISOString()
    });
    if (input.passphrase && input.rememberPassphrase) {
      this.deps.credentials.set('key', id, 'passphrase', input.passphrase);
    }
    return this.get(id);
  }

  /** Looks at a file the user picked in the native dialog. The renderer only gets a token for that path. */
  inspectImport(path: string): KeyImportCandidate {
    const token = randomUUID();
    this.candidates.set(token, path);
    const hasPublicFile = existsSync(`${path}.pub`);
    const parsed = parsePrivate(this.readKeyFile(path));
    if (isParseError(parsed) && !isPassphraseError(parsed)) {
      this.candidates.delete(token);
      throw new KeyManagerError('Diese Datei ist kein unterstützter privater SSH-Schlüssel.');
    }
    if (!isParseError(parsed) && !parsed.isPrivateKey()) {
      this.candidates.delete(token);
      throw new KeyManagerError('Das ist ein öffentlicher Schlüssel. Bitte wähle den privaten Schlüssel.');
    }
    return { token, path, suggestedName: basename(path), needsPassphrase: isParseError(parsed) && !hasPublicFile };
  }

  import(input: { name: string; passphrase: string | null; rememberPassphrase: boolean; pickToken: string }): ManagedKey {
    const path = this.candidates.get(input.pickToken);
    if (!path) throw new KeyManagerError('Die Auswahl ist nicht mehr gültig. Bitte wähle die Datei erneut.');
    const existing = this.deps.db.prepare('SELECT id FROM managedKeys WHERE privateKeyPath = ?').get(path);
    if (existing) throw new KeyManagerError('Dieser Schlüssel ist bereits eingetragen.');
    const content = this.readKeyFile(path);
    const unlocked = parsePrivate(content);
    if (isParseError(unlocked) && !isPassphraseError(unlocked)) {
      throw new KeyManagerError('Diese Datei ist kein unterstützter privater SSH-Schlüssel.');
    }
    const encrypted = isParseError(unlocked);
    let publicKey: string | null = null;
    if (existsSync(`${path}.pub`)) {
      const line = readFileSync(`${path}.pub`, 'utf8').trim();
      if (isValidPublicKeyLine(line)) publicKey = line;
    }
    const opened = encrypted && input.passphrase ? parsePrivate(content, input.passphrase) : unlocked;
    if (isParseError(opened)) {
      if (input.passphrase) throw new KeyManagerError('Die Passphrase passt nicht zu diesem Schlüssel.');
      if (publicKey === null) throw new KeyManagerError('Für diesen Schlüssel wird die Passphrase benötigt.');
    } else {
      const derived = `${opened.type} ${opened.getPublicSSH().toString('base64')}${opened.comment ? ` ${opened.comment}` : ''}`;
      if (publicKey !== null && publicKey.split(' ')[1] !== derived.split(' ')[1]) {
        throw new KeyManagerError('Die .pub-Datei gehört nicht zu diesem privaten Schlüssel.');
      }
      publicKey ??= isValidPublicKeyLine(derived) ? derived : derived.split(' ').slice(0, 2).join(' ');
    }
    const id = randomUUID();
    this.insert({
      id,
      name: input.name,
      ...describePublic(publicKey),
      publicKey,
      privateKeyPath: path,
      origin: 'imported',
      encrypted: encrypted ? 1 : 0,
      createdAt: new Date().toISOString()
    });
    this.candidates.delete(input.pickToken);
    if (encrypted && input.passphrase && input.rememberPassphrase) {
      this.deps.credentials.set('key', id, 'passphrase', input.passphrase);
    }
    return this.get(id);
  }

  rename(id: string, name: string): ManagedKey {
    this.row(id);
    this.deps.db.prepare('UPDATE managedKeys SET name = ? WHERE id = ?').run(name, id);
    return this.get(id);
  }

  /**
   * Removes the entry. The file goes only when RYFT generated it and the user said so:
   * a key that was imported belongs to the user and stays where it is.
   */
  remove(id: string, deleteFile: boolean): void {
    const row = this.row(id);
    if (deleteFile && row.origin !== 'generated') {
      throw new KeyManagerError('Importierte Schlüsseldateien werden nicht gelöscht, nur der Eintrag.');
    }
    this.deps.db.prepare('DELETE FROM managedKeys WHERE id = ?').run(id);
    this.deps.credentials.clear('key', id);
    if (deleteFile) {
      rmSync(row.privateKeyPath, { force: true });
      rmSync(`${row.privateKeyPath}.pub`, { force: true });
    }
  }

  /** Appends the public key on the server. Authorization is the confirmation dialog in the UI. */
  async installOn(client: Client, id: string): Promise<'added' | 'present'> {
    const command = buildInstallCommand(this.row(id).publicKey);
    const output = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new KeyManagerError('Zeitüberschreitung beim Eintragen des Schlüssels.')), INSTALL_TIMEOUT_MS);
      client.exec(command, (error, channel) => {
        if (error) {
          clearTimeout(timer);
          reject(new KeyManagerError(`Der Server hat den Befehl abgelehnt: ${error.message}`));
          return;
        }
        let stdout = '';
        let stderr = '';
        channel.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        channel.on('close', (code: number | null) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout);
          else reject(new KeyManagerError(`Der Schlüssel konnte nicht eingetragen werden: ${stderr.trim().slice(0, 300) || `Exit-Code ${code}`}`));
        });
      });
    });
    if (output.includes('RYFT_KEY_ADDED')) return 'added';
    if (output.includes('RYFT_KEY_PRESENT')) return 'present';
    throw new KeyManagerError('Der Server hat eine unerwartete Antwort geliefert. Ist die Login-Shell POSIX-kompatibel?');
  }

  private readKeyFile(path: string): Buffer {
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      throw new KeyManagerError('Die Schlüsseldatei kann nicht gelesen werden.');
    }
    if (content.length > MAX_KEY_FILE_BYTES) throw new KeyManagerError('Diese Datei ist zu groß für einen SSH-Schlüssel.');
    return content;
  }
}
