import { randomUUID } from 'node:crypto';
import type { RememberedHostKey } from '../ssh/connection';
import type { TrustedHostKeyRepository } from '../storage/repositories';

const CHANGE_TTL_MS = 10 * 60_000;

export class HostKeyChangeExpiredError extends Error {
  constructor() {
    super('Diese Schlüsseländerung ist abgelaufen. Verbinde dich erneut und prüfe den Fingerabdruck noch einmal.');
    this.name = 'HostKeyChangeExpiredError';
  }
}

/**
 * Remembers keys presented during a blocked connection. The renderer can only refer to one by id and
 * so can never supply key material: what gets trusted is exactly what the server presented.
 */
export class HostKeyChanges {
  private readonly pending = new Map<string, { entry: RememberedHostKey; expires: number }>();

  constructor(
    private readonly repository: TrustedHostKeyRepository,
    private readonly now: () => number = Date.now
  ) {}

  register(entry: RememberedHostKey): string {
    this.prune();
    const id = randomUUID();
    this.pending.set(id, { entry, expires: this.now() + CHANGE_TTL_MS });
    return id;
  }

  accept(changeId: string): void {
    this.prune();
    const change = this.pending.get(changeId);
    if (!change) throw new HostKeyChangeExpiredError();
    this.pending.delete(changeId);
    this.repository.replace(change.entry);
  }

  private prune(): void {
    for (const [id, change] of this.pending) {
      if (change.expires <= this.now()) this.pending.delete(id);
    }
  }
}
