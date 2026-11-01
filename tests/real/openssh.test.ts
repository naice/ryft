import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_HOST_OPTIONS, type PromptResponse, type SessionPrompt } from '@shared/contracts';
import { defineConnectivitySuite } from '../fixtures/connectivitySuite';
import { createHarness, hostInput, OWNER, type Harness } from '../fixtures/harness';

/**
 * Runs against a real OpenSSH server, started with tests/fixtures/wsl-openssh.sh or any other disposable one.
 * RYFT_TEST_OPENSSH=<host>:<port>:<user>:<private key path>:<writable remote folder>
 * Everything happens below the given folder. Never point this at a server that matters.
 */
const config = process.env.RYFT_TEST_OPENSSH;

if (!config) {
  describe('real OpenSSH', () => {
    it.skip('needs RYFT_TEST_OPENSSH', () => undefined);
  });
} else {
  const match = /^([^:]+):(\d+):([^:]+):(.+):(\/[^:]*)$/.exec(config);
  if (!match) throw new Error('RYFT_TEST_OPENSSH has the wrong format');
  const [, hostname, port, username, keyPath, remoteRoot] = match as unknown as [string, string, string, string, string, string];

  defineConnectivitySuite('against a real OpenSSH server', () => ({
    host: (harness) =>
      harness.services.toPublicHost(
        harness.services.hosts.create(
          hostInput({ hostname, port: Number(port), username, authMethod: 'key', keyReference: keyPath })
        )
      ),
    remoteRoot,
    // sshd itself greets first, so no further service has to run on the server.
    banner: { host: '127.0.0.1', port: Number(port), pattern: /^SSH-2\.0-OpenSSH/ },
    largeFileBytes: 512 * 1024 * 1024
  }));

  // The test server logs in as a real account, and what is typed there must not end up in that account's ~/.bash_history.
  const keepOutOfShellHistory = (harness: Harness, id: string) => harness.services.sessions.write(OWNER, id, ' unset HISTFILE\r');

  describe('command history on a real OpenSSH server', () => {
    let harness: Harness;
    beforeEach(() => {
      harness = createHarness();
    });
    afterEach(() => harness.dispose());

    it('records a command through the bash hook and shows nothing of the hook', async () => {
      const host = harness.services.hosts.create(
        hostInput({
          hostname,
          port: Number(port),
          username,
          authMethod: 'key',
          keyReference: keyPath,
          options: { ...DEFAULT_HOST_OPTIONS, shellIntegration: true }
        })
      );
      harness.answerPrompts((prompt) => (prompt.kind === 'hostKey' ? { kind: 'hostKey', trust: 'once' } : { kind: 'cancel' }));
      const id = harness.sessionId();
      await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 200, 40);
      await harness.waitForState(id, 'connected');
      keepOutOfShellHistory(harness, id);
      harness.services.sessions.write(OWNER, id, 'echo ryft-real-history-$((40+2))\r');
      const output = await harness.waitForOutput(id, /ryft-real-history-42/);
      await expect.poll(() => harness.services.commandHistory.list({ query: 'ryft-real-history', hostId: host.id, limit: 5 }).length).toBe(1);
      const [entry] = harness.services.commandHistory.list({ query: 'ryft-real-history', hostId: host.id, limit: 5 });
      expect(entry?.exitCode).toBe(0);
      expect(harness.services.commandHistory.list({ query: 'HISTFILE', hostId: host.id, limit: 5 })).toHaveLength(0);
      expect(output).not.toContain('\u001b]7777;');
    });
  });

  // One server plays both roles: reached directly as the jump host, and through it under another name as the target.
  describe('through a jump host on a real OpenSSH server', () => {
    let harness: Harness;
    beforeEach(() => {
      harness = createHarness();
    });
    afterEach(() => harness.dispose());

    const chain = () => {
      const auth = { port: Number(port), username, authMethod: 'key', keyReference: keyPath } as const;
      const bastion = harness.services.hosts.create(hostInput({ ...auth, name: 'bastion', hostname }));
      return harness.services.hosts.create(
        hostInput({ ...auth, name: 'inner', hostname: 'localhost', options: { ...DEFAULT_HOST_OPTIONS, jumpHostIds: [bastion.id] } })
      );
    };
    const accept = (prompt: SessionPrompt): PromptResponse =>
      prompt.kind === 'hostKey' ? { kind: 'hostKey', trust: 'once' } : { kind: 'cancel' };

    it('verifies each hop on its own and opens a shell at the end of the route', async () => {
      const host = chain();
      const asked: string[] = [];
      harness.answerPrompts((prompt) => {
        if (prompt.kind === 'hostKey') asked.push(prompt.host);
        return accept(prompt);
      });
      const id = harness.sessionId();
      await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
      await harness.waitForState(id, 'connected');
      expect(asked).toEqual([hostname, 'localhost']);
      keepOutOfShellHistory(harness, id);
      harness.services.sessions.write(OWNER, id, 'echo jump-$((40+2))\r');
      await harness.waitForOutput(id, /jump-42/);
    });

    it('stops when the key of the second hop is declined', async () => {
      const host = chain();
      harness.answerPrompts((prompt) =>
        prompt.kind === 'hostKey' && prompt.host === 'localhost' ? { kind: 'cancel' } : accept(prompt)
      );
      const id = harness.sessionId();
      await harness.services.sessions.open(OWNER, id, { kind: 'ssh', hostId: host.id }, 80, 24);
      const failed = await harness.waitForState(id, 'failed');
      expect(failed.error?.code).toBe('HOST_KEY_REJECTED');
    });

    it('lists a remote folder over SFTP through the route', async () => {
      const host = chain();
      harness.answerPrompts(accept);
      const sftpId = randomUUID();
      await harness.services.sftp.open(OWNER, sftpId, host.id);
      const listing = await harness.services.sftp.list(OWNER, sftpId, remoteRoot);
      expect(listing.path).toBe(remoteRoot);
    });
  });
}
