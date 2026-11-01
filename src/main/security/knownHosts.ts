import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PresentedHostKey {
  keyType: string;
  keyBase64: string;
  fingerprint: string;
}

/** Parses an SSH public key blob: the leading length-prefixed string names the key type. */
export function describeHostKey(blob: Buffer): PresentedHostKey {
  const typeLength = blob.readUInt32BE(0);
  const keyType = blob.subarray(4, 4 + typeLength).toString('ascii');
  return { keyType, keyBase64: blob.toString('base64'), fingerprint: sha256Fingerprint(blob) };
}

export function sha256Fingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export interface KnownHostLine {
  marker: '@revoked' | '@cert-authority' | null;
  hostPatterns: string;
  keyType: string;
  keyBase64: string;
}

export function parseKnownHosts(content: string): KnownHostLine[] {
  const lines: KnownHostLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: KnownHostLine['marker'] = null;
    if (fields[0] === '@revoked' || fields[0] === '@cert-authority') {
      marker = fields.shift() as KnownHostLine['marker'];
    }
    const [hostPatterns, keyType, keyBase64] = fields;
    if (hostPatterns && keyType && keyBase64) lines.push({ marker, hostPatterns, keyType, keyBase64 });
  }
  return lines;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesHashed(pattern: string, candidate: string): boolean {
  const [, magic, salt, hash] = pattern.split('|');
  if (magic !== '1' || !salt || !hash) return false;
  const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(candidate).digest();
  const expected = Buffer.from(hash, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Implements OpenSSH host matching: `[host]:port` for non-default ports, wildcards, negation and hashed names. */
export function matchesHostPatterns(patterns: string, host: string, port: number): boolean {
  const candidate = port === 22 ? host : `[${host}]:${port}`;
  if (patterns.startsWith('|')) return matchesHashed(patterns, candidate);
  let matched = false;
  for (const entry of patterns.split(',')) {
    const negated = entry.startsWith('!');
    const pattern = negated ? entry.slice(1) : entry;
    if (wildcardToRegExp(pattern).test(candidate)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

export type HostKeyVerdict =
  | { status: 'trusted'; source: 'known_hosts' | 'ryft' }
  | { status: 'unknown'; otherTypesKnown: boolean }
  | { status: 'mismatch'; expectedFingerprint: string; source: 'known_hosts' | 'ryft' }
  | { status: 'revoked' };

export interface HostKeyTrustSource {
  /** Keys trusted for this endpoint in RYFT's own store. */
  ryftEntries(host: string, port: number): { keyType: string; keyBase64: string; fingerprint: string }[];
  /** Lines of the user's OpenSSH known_hosts, used read-only. */
  openSshLines(): KnownHostLine[];
}

/**
 * Decides whether a presented host key is acceptable. A key that differs from a known key of the
 * same type is a mismatch and is never offered for acceptance. Unknown keys always need an explicit
 * user decision; nothing in here trusts automatically.
 */
export function verifyHostKey(
  source: HostKeyTrustSource,
  host: string,
  port: number,
  presented: PresentedHostKey
): HostKeyVerdict {
  const endpointLines = source.openSshLines().filter((line) => matchesHostPatterns(line.hostPatterns, host, port));

  if (endpointLines.some((line) => line.marker === '@revoked' && line.keyBase64 === presented.keyBase64)) {
    return { status: 'revoked' };
  }

  const opensshKeys = endpointLines.filter((line) => line.marker === null);
  if (opensshKeys.some((line) => line.keyType === presented.keyType && line.keyBase64 === presented.keyBase64)) {
    return { status: 'trusted', source: 'known_hosts' };
  }
  const ryftKeys = source.ryftEntries(host, port);
  if (ryftKeys.some((entry) => entry.keyType === presented.keyType && entry.keyBase64 === presented.keyBase64)) {
    return { status: 'trusted', source: 'ryft' };
  }

  const opensshConflict = opensshKeys.find((line) => line.keyType === presented.keyType);
  if (opensshConflict) {
    return {
      status: 'mismatch',
      expectedFingerprint: sha256Fingerprint(Buffer.from(opensshConflict.keyBase64, 'base64')),
      source: 'known_hosts'
    };
  }
  const ryftConflict = ryftKeys.find((entry) => entry.keyType === presented.keyType);
  if (ryftConflict) {
    return { status: 'mismatch', expectedFingerprint: ryftConflict.fingerprint, source: 'ryft' };
  }

  return { status: 'unknown', otherTypesKnown: opensshKeys.length > 0 || ryftKeys.length > 0 };
}

export function defaultSshDirectory(): string {
  return join(homedir(), '.ssh');
}

export function readOpenSshKnownHosts(directory = defaultSshDirectory()): KnownHostLine[] {
  const path = join(directory, 'known_hosts');
  if (!existsSync(path)) return [];
  try {
    return parseKnownHosts(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}
