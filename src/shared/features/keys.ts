import { z } from 'zod';

export type ManagedKeyOrigin = 'generated' | 'imported';

/** Never contains the private key: that stays in its file and is not read for display at all. */
export interface ManagedKey {
  id: string;
  name: string;
  type: string;
  fingerprint: string;
  publicKey: string;
  privateKeyPath: string;
  origin: ManagedKeyOrigin;
  encrypted: boolean;
  hasStoredPassphrase: boolean;
  /** Names of the hosts and auth profiles using this key. */
  usedBy: string[];
  createdAt: string;
}

const nameSchema = z.string().trim().min(1).max(128);
const passphraseSchema = z.string().min(1).max(1024);

export const keySchemas = {
  generate: z.strictObject({
    name: nameSchema,
    comment: z.string().trim().max(128).regex(/^[^\r\n]*$/),
    passphrase: passphraseSchema.nullable(),
    rememberPassphrase: z.boolean()
  }),
  import: z.strictObject({
    name: nameSchema,
    /** Needed when the file has no `.pub` next to it and is protected. The token stands for the file picked in main. */
    passphrase: passphraseSchema.nullable(),
    rememberPassphrase: z.boolean(),
    pickToken: z.uuid()
  }),
  rename: z.strictObject({ id: z.uuid(), name: nameSchema }),
  remove: z.strictObject({ id: z.uuid(), deleteFile: z.boolean() }),
  assign: z.strictObject({ id: z.uuid(), hostIds: z.array(z.uuid()).max(512) }),
  install: z.strictObject({ id: z.uuid(), hostId: z.uuid(), contextId: z.uuid() })
};

/** One authorized_keys line without options. Everything else is refused before it reaches a remote shell. */
const PUBLIC_KEY_LINE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9 ._@:+-]{0,128})?$/;

export function isValidPublicKeyLine(line: string): boolean {
  return PUBLIC_KEY_LINE.test(line);
}

/**
 * The remote side of "install on server". It only appends a line that is not there yet, and it
 * never replaces or reorders what the user has in `authorized_keys`.
 */
export function buildInstallCommand(publicKeyLine: string): string {
  if (!isValidPublicKeyLine(publicKeyLine)) throw new Error('Ungültiger öffentlicher Schlüssel');
  // The pattern guarantees there is no single quote in the line.
  const line = `'${publicKeyLine}'`;
  return [
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    `if grep -qxF ${line} "$HOME/.ssh/authorized_keys"; then echo RYFT_KEY_PRESENT; else printf '%s\\n' ${line} >> "$HOME/.ssh/authorized_keys" && echo RYFT_KEY_ADDED; fi`
  ].join(' && ');
}
