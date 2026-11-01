import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { SecretKind, VaultStatus } from '@shared/contracts';

/** A reference is safe to store and log: it identifies a secret but contains none of it. */
export function secretReference(hostId: string, kind: SecretKind): string {
  return `ryft-secret://host/${hostId}/${kind}`;
}

export interface SecretStore {
  status(): VaultStatus;
  get(reference: string): string | null;
  set(reference: string, value: string): void;
  delete(reference: string): void;
  has(reference: string): boolean;
}

/** The subset of Electron's safeStorage we use: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux. */
export interface OsEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export class VaultUnavailableError extends Error {
  constructor() {
    super('Der Schlüsselbund des Betriebssystems ist nicht verfügbar. Secrets können nicht gespeichert werden.');
    this.name = 'VaultUnavailableError';
  }
}

const vaultFileSchema = z.strictObject({ version: z.literal(1), entries: z.record(z.string(), z.string()) });

/**
 * Stores secrets only as ciphertext protected by an OS-held key. Refuses to store when the OS
 * offers no real keychain (Electron's Linux `basic_text` fallback would be hardcoded-key obfuscation).
 */
export class OsSecretVault implements SecretStore {
  private entries: Record<string, string> = {};

  constructor(
    private readonly filePath: string,
    private readonly encryption: OsEncryption
  ) {
    if (existsSync(filePath)) {
      const parsed = vaultFileSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
      if (parsed.success) this.entries = parsed.data.entries;
    }
  }

  status(): VaultStatus {
    const backend = this.encryption.getSelectedStorageBackend?.() ?? 'os';
    return { available: this.encryption.isEncryptionAvailable() && backend !== 'basic_text', backend };
  }

  has(reference: string): boolean {
    return reference in this.entries;
  }

  get(reference: string): string | null {
    const encrypted = this.entries[reference];
    if (!encrypted || !this.status().available) return null;
    try {
      return this.encryption.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      // The OS key changed (e.g. profile restored elsewhere). The user simply gets prompted again.
      return null;
    }
  }

  set(reference: string, value: string): void {
    if (!this.status().available) throw new VaultUnavailableError();
    this.entries[reference] = this.encryption.encryptString(value).toString('base64');
    this.persist();
  }

  delete(reference: string): void {
    if (!(reference in this.entries)) return;
    delete this.entries[reference];
    this.persist();
  }

  private persist(): void {
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, entries: this.entries }), { mode: 0o600 });
    renameSync(temp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Not meaningful on every filesystem; the content is ciphertext regardless.
    }
  }
}

/** Convenience wrapper binding vault references to hosts. */
export class HostSecrets {
  constructor(private readonly store: SecretStore) {}

  status(): VaultStatus {
    return this.store.status();
  }

  get(hostId: string, kind: SecretKind): string | null {
    return this.store.get(secretReference(hostId, kind));
  }

  set(hostId: string, kind: SecretKind, value: string): void {
    this.store.set(secretReference(hostId, kind), value);
  }

  hasAny(hostId: string): boolean {
    return (
      this.store.has(secretReference(hostId, 'password')) || this.store.has(secretReference(hostId, 'passphrase'))
    );
  }

  clear(hostId: string): void {
    this.store.delete(secretReference(hostId, 'password'));
    this.store.delete(secretReference(hostId, 'passphrase'));
  }
}
