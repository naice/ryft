import type { AuthMethod, SecretKind } from '@shared/contracts';
import type { StoredAuthProfile, StoredHost } from '../storage/repositories';
import { scopedSecretReference, type SecretScope, type SecretStore } from './secretVault';

export interface ResolvedCredentials {
  username: string;
  authMethod: AuthMethod;
  keyReference: string | null;
  getSecret(kind: SecretKind): string | null;
  setSecret(kind: SecretKind, value: string): void;
}

const SECRET_KINDS: readonly SecretKind[] = ['password', 'passphrase'];

/** Decides which credentials a host really uses. Secrets stay here in the main process. */
export class CredentialResolver {
  constructor(
    private readonly store: SecretStore,
    private readonly profileOf: (id: string) => StoredAuthProfile | null,
    /** The passphrase stored with a managed key, for hosts that have none of their own. */
    private readonly managedKeyPassphrase: (keyReference: string) => string | null = () => null
  ) {}

  getKeyPassphrase(keyId: string): string | null {
    return this.store.get(scopedSecretReference('key', keyId, 'passphrase'));
  }

  private scopeOf(host: StoredHost, profile: StoredAuthProfile | null): { scope: SecretScope; id: string } {
    return profile ? { scope: 'profile', id: profile.id } : { scope: 'host', id: host.id };
  }

  resolve(host: StoredHost): ResolvedCredentials {
    const profile = host.authProfileId ? this.profileOf(host.authProfileId) : null;
    const { scope, id } = this.scopeOf(host, profile);
    const keyReference = profile ? profile.keyReference : host.keyReference;
    return {
      username: profile?.username ?? host.username,
      authMethod: profile?.method ?? host.authMethod,
      keyReference,
      getSecret: (kind) => {
        const own = this.store.get(scopedSecretReference(scope, id, kind));
        if (own !== null || kind !== 'passphrase' || !keyReference) return own;
        return this.managedKeyPassphrase(keyReference);
      },
      setSecret: (kind, value) => this.store.set(scopedSecretReference(scope, id, kind), value)
    };
  }

  hasStoredSecret(host: StoredHost): boolean {
    const profile = host.authProfileId ? this.profileOf(host.authProfileId) : null;
    const { scope, id } = this.scopeOf(host, profile);
    return this.hasAny(scope, id);
  }

  hasAny(scope: SecretScope, id: string): boolean {
    return SECRET_KINDS.some((kind) => this.store.has(scopedSecretReference(scope, id, kind)));
  }

  set(scope: SecretScope, id: string, kind: SecretKind, value: string): void {
    this.store.set(scopedSecretReference(scope, id, kind), value);
  }

  clear(scope: SecretScope, id: string): void {
    for (const kind of SECRET_KINDS) this.store.delete(scopedSecretReference(scope, id, kind));
  }
}
