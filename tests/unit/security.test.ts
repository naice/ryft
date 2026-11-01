import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeHostKey,
  matchesHostPatterns,
  parseKnownHosts,
  readOpenSshKnownHosts,
  sha256Fingerprint,
  verifyHostKey,
  type HostKeyTrustSource
} from '../../src/main/security/knownHosts';
import {
  HostSecrets,
  isOsKeyOnDisk,
  OsSecretVault,
  secretReference,
  VaultUnavailableError,
  type OsEncryption
} from '../../src/main/security/secretVault';
import { log, redact, configureLogFile } from '../../src/main/logger';

function keyBlob(type: string, seed: string): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, Buffer.from(seed)]);
}

const ED_A = keyBlob('ssh-ed25519', 'key-a');
const ED_B = keyBlob('ssh-ed25519', 'key-b');
const RSA = keyBlob('ssh-rsa', 'key-c');

function source(lines: string, ryft: ReturnType<HostKeyTrustSource['ryftEntries']> = []): HostKeyTrustSource {
  return { ryftEntries: () => ryft, openSshLines: () => parseKnownHosts(lines) };
}

describe('host key parsing', () => {
  it('reads key type and computes the OpenSSH fingerprint format', () => {
    const presented = describeHostKey(ED_A);
    expect(presented.keyType).toBe('ssh-ed25519');
    const digest = createHash('sha256').update(ED_A).digest('base64').replace(/=+$/, '');
    expect(presented.fingerprint).toBe(`SHA256:${digest}`);
  });

  it('skips comments, blanks and malformed lines', () => {
    const lines = parseKnownHosts('# comment\n\nincomplete line\nhost ssh-rsa AAAA comment\r\n@revoked h ssh-rsa BBBB\n');
    expect(lines).toEqual([
      { marker: null, hostPatterns: 'host', keyType: 'ssh-rsa', keyBase64: 'AAAA' },
      { marker: '@revoked', hostPatterns: 'h', keyType: 'ssh-rsa', keyBase64: 'BBBB' }
    ]);
  });
});

describe('host matching', () => {
  it('matches plain names, lists and non-default ports like OpenSSH', () => {
    expect(matchesHostPatterns('a.example,b.example', 'B.EXAMPLE', 22)).toBe(true);
    expect(matchesHostPatterns('a.example', 'a.example', 2222)).toBe(false);
    expect(matchesHostPatterns('[a.example]:2222', 'a.example', 2222)).toBe(true);
  });

  it('supports wildcards and negation without treating regex characters as patterns', () => {
    expect(matchesHostPatterns('*.example', 'x.example', 22)).toBe(true);
    expect(matchesHostPatterns('h?st', 'host', 22)).toBe(true);
    expect(matchesHostPatterns('*.example,!bad.example', 'bad.example', 22)).toBe(false);
    expect(matchesHostPatterns('a.example', 'aXexample', 22)).toBe(false);
  });

  it('supports hashed entries', () => {
    const salt = randomBytes(20);
    const hash = createHmac('sha1', salt).update('secret.example').digest('base64');
    const pattern = `|1|${salt.toString('base64')}|${hash}`;
    expect(matchesHostPatterns(pattern, 'secret.example', 22)).toBe(true);
    expect(matchesHostPatterns(pattern, 'other.example', 22)).toBe(false);
  });
});

describe('host key verification', () => {
  const presented = describeHostKey(ED_A);
  const line = (blob: Buffer, host = 'h.example'): string =>
    `${host} ${describeHostKey(blob).keyType} ${blob.toString('base64')}`;

  it('trusts an exact known_hosts match', () => {
    expect(verifyHostKey(source(line(ED_A)), 'h.example', 22, presented)).toEqual({
      status: 'trusted',
      source: 'known_hosts'
    });
  });

  it('reports unknown hosts instead of trusting them', () => {
    expect(verifyHostKey(source(''), 'h.example', 22, presented)).toEqual({ status: 'unknown', otherTypesKnown: false });
  });

  it('flags when another key type is already known', () => {
    expect(verifyHostKey(source(line(RSA)), 'h.example', 22, presented)).toEqual({
      status: 'unknown',
      otherTypesKnown: true
    });
  });

  it('reports a changed key as mismatch', () => {
    expect(verifyHostKey(source(line(ED_B)), 'h.example', 22, presented)).toEqual({
      status: 'mismatch',
      expectedFingerprint: sha256Fingerprint(ED_B),
      source: 'known_hosts'
    });
  });

  it('applies the same rules to keys trusted inside RYFT', () => {
    const ryft = [{ keyType: 'ssh-ed25519', keyBase64: ED_B.toString('base64'), fingerprint: 'SHA256:b' }];
    expect(verifyHostKey(source('', ryft), 'h.example', 22, presented)).toEqual({
      status: 'mismatch',
      expectedFingerprint: 'SHA256:b',
      source: 'ryft'
    });
    ryft[0]!.keyBase64 = ED_A.toString('base64');
    expect(verifyHostKey(source('', ryft), 'h.example', 22, presented)).toEqual({ status: 'trusted', source: 'ryft' });
  });

  it('prefers revocation over everything', () => {
    const lines = `${line(ED_A)}\n@revoked ${line(ED_A)}`;
    expect(verifyHostKey(source(lines), 'h.example', 22, presented)).toEqual({ status: 'revoked' });
  });

  it('does not mix up entries of other hosts or ports', () => {
    expect(verifyHostKey(source(line(ED_B, 'other.example')), 'h.example', 22, presented).status).toBe('unknown');
    expect(verifyHostKey(source(line(ED_B)), 'h.example', 2222, presented).status).toBe('unknown');
  });

  it('reads a missing known_hosts as empty and never creates one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ryft-kh-'));
    expect(readOpenSshKnownHosts(directory)).toEqual([]);
    expect(existsSync(join(directory, 'known_hosts'))).toBe(false);
    rmSync(directory, { recursive: true });
  });
});

class FakeEncryption implements OsEncryption {
  available = true;
  backend = 'gnome_libsecret';
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plain: string): Buffer {
    return Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a) as Buffer;
  }
  decryptString(encrypted: Buffer): string {
    return Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString('utf8');
  }
  getSelectedStorageBackend(): string {
    return this.backend;
  }
}

describe('secret vault', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ryft-vault-'));
    file = join(directory, 'vault.json');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('round-trips through a restart and stores only ciphertext', () => {
    const vault = new OsSecretVault(file, new FakeEncryption());
    vault.set('r', 'plaintext-secret');
    expect(readFileSync(file, 'utf8')).not.toContain('plaintext-secret');
    expect(new OsSecretVault(file, new FakeEncryption()).get('r')).toBe('plaintext-secret');
  });

  it('refuses to store when no OS encryption exists', () => {
    const encryption = new FakeEncryption();
    encryption.available = false;
    const vault = new OsSecretVault(file, encryption);
    expect(vault.status().available).toBe(false);
    expect(() => vault.set('r', 'x')).toThrow(VaultUnavailableError);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses the Linux basic_text fallback', () => {
    const encryption = new FakeEncryption();
    encryption.backend = 'basic_text';
    expect(new OsSecretVault(file, encryption).status().available).toBe(false);
  });

  it('returns null when decryption fails instead of throwing', () => {
    const encryption = new FakeEncryption();
    const vault = new OsSecretVault(file, encryption);
    vault.set('r', 'x');
    encryption.decryptString = () => {
      throw new Error('key changed');
    };
    expect(vault.get('r')).toBeNull();
  });

  it('removes entries and scopes references per host', () => {
    const secrets = new HostSecrets(new OsSecretVault(file, new FakeEncryption()));
    secrets.set('h1', 'password', 'a');
    secrets.set('h1', 'passphrase', 'b');
    secrets.set('h2', 'password', 'c');
    secrets.clear('h1');
    expect(secrets.hasAny('h1')).toBe(false);
    expect(secrets.get('h2', 'password')).toBe('c');
    expect(secretReference('h1', 'password')).not.toContain('a-secret-value');
  });
});

describe('logger', () => {
  it('redacts secret fields at any depth', () => {
    expect(
      redact({ password: 'x', nested: { passphrase: 'y', list: [{ privateKey: 'z' }], ok: 1 }, data: 'terminal output' })
    ).toEqual({
      password: '[redacted]',
      nested: { passphrase: '[redacted]', list: [{ privateKey: '[redacted]' }], ok: 1 },
      data: '[redacted]'
    });
  });

  it('writes redacted lines to the log file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ryft-log-'));
    const file = join(directory, 'logs', 'ryft.log');
    configureLogFile(file);
    log.info('connect', { password: 'hunter2', host: 'example' });
    const content = writeAndRead(file);
    expect(content).toContain('example');
    expect(content).not.toContain('hunter2');
    configureLogFile(join(directory, 'other.log'));
  });
});

function writeAndRead(file: string): string {
  writeFileSync(file, '', { flag: 'a' });
  return readFileSync(file, 'utf8');
}

describe('OS key persistence', () => {
  it('only counts a Local State which really holds the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryft-key-'));
    const file = join(dir, 'Local State');
    try {
      expect(isOsKeyOnDisk(file)).toBe(false);
      writeFileSync(file, '{"os_crypt":{}}');
      expect(isOsKeyOnDisk(file)).toBe(false);
      writeFileSync(file, 'not json');
      expect(isOsKeyOnDisk(file)).toBe(false);
      writeFileSync(file, '{"os_crypt":{"encrypted_key":"abc"}}');
      expect(isOsKeyOnDisk(file)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
