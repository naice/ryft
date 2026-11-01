import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseAgent } from 'ssh2';
import {
  DEFAULT_HOST_OPTIONS,
  type AiChunkEvent,
  type DockerLogEndEvent,
  type DockerLogEvent,
  type ForwardRuntime,
  type HostInput,
  type PromptResponse,
  type SessionLogStateEvent,
  type SessionPrompt,
  type SessionStateEvent,
  type TransferJob,
  type VaultStatus
} from '@shared/contracts';
import type { SessionState } from '@shared/sessionState';
import type { DockerBinary } from '../../src/main/docker/dockerService';
import { detectShells } from '../../src/main/pty/shells';
import type { SecretStore } from '../../src/main/security/secretVault';
import { createServices } from '../../src/main/services';
import { openDatabase } from '../../src/main/storage/database';

export const OWNER = 1;

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  available = true;
  status(): VaultStatus {
    return { available: this.available, backend: 'test', keyLost: false };
  }
  get(reference: string): string | null {
    return this.values.get(reference) ?? null;
  }
  set(reference: string, value: string): void {
    this.values.set(reference, value);
  }
  delete(reference: string): void {
    this.values.delete(reference);
  }
  has(reference: string): boolean {
    return this.values.has(reference);
  }
}

export function hostInput(overrides: Partial<HostInput> = {}): HostInput {
  return {
    name: 'fixture',
    hostname: '127.0.0.1',
    port: 22,
    username: 'tester',
    authMethod: 'password',
    keyReference: null,
    groupId: null,
    tags: [],
    favorite: false,
    authProfileId: null,
    options: DEFAULT_HOST_OPTIONS,
    ...overrides
  };
}

export function createHarness(
  options: {
    agent?: string | BaseAgent;
    reconnectDelaysMs?: readonly number[];
    localRoots?: string[];
    dockerBinary?: DockerBinary | null;
    wslBinary?: string | null;
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'ryft-test-'));
  const db: DatabaseSync = openDatabase(join(directory, 'test.sqlite'));
  const secretStore = new MemorySecretStore();
  const states: SessionStateEvent[] = [];
  const prompts: SessionPrompt[] = [];
  const output = new Map<string, string>();
  const stateWaiters: (() => void)[] = [];
  const promptWaiters: ((prompt: SessionPrompt) => void)[] = [];
  const dataWaiters: (() => void)[] = [];
  let responder: ((prompt: SessionPrompt) => PromptResponse) | null = null;
  const sftpClosed: { sftpId: string; message: string }[] = [];
  const transfers = new Map<string, TransferJob>();
  const forwardStates: ForwardRuntime[] = [];
  const dockerLogs: DockerLogEvent[] = [];
  const dockerLogEnds: DockerLogEndEvent[] = [];
  const aiChunks: AiChunkEvent[] = [];
  const sessionLogStates: SessionLogStateEvent[] = [];

  const services = createServices({
    db,
    dataDirectory: directory,
    secretStore,
    shells: detectShells(),
    // An empty directory: tests must never see the developer's real known_hosts.
    sshDirectory: directory,
    agent: options.agent,
    reconnectDelaysMs: options.reconnectDelaysMs ?? [10, 10, 10],
    connectTimeoutMs: 8_000,
    sink: {
      data: (event) => {
        output.set(event.sessionId, (output.get(event.sessionId) ?? '') + event.data);
        for (const waiter of dataWaiters.splice(0)) waiter();
      },
      state: (event) => {
        states.push(event);
        for (const waiter of stateWaiters.splice(0)) waiter();
      },
      prompt: (event) => {
        if (responder) {
          const respond = responder;
          setImmediate(() => services.sessions.respondToPrompt(OWNER, event.promptId, respond(event)));
          return;
        }
        const waiter = promptWaiters.shift();
        if (waiter) waiter(event);
        else prompts.push(event);
      },
      sftpClosed: (event) => sftpClosed.push(event),
      transferUpdate: (jobs) => {
        for (const job of jobs) transfers.set(job.id, job);
      },
      transferRemoved: (ids) => {
        for (const id of ids) transfers.delete(id);
      },
      forwardState: (runtime) => {
        forwardStates.push(runtime);
      },
      dockerLog: (event) => {
        dockerLogs.push(event);
      },
      dockerLogEnd: (event) => {
        dockerLogEnds.push(event);
      },
      aiChunk: (event) => {
        aiChunks.push(event);
      },
      sessionLogState: (event) => {
        sessionLogStates.push(event);
      }
    },
    localRoots: [directory, ...(options.localRoots ?? [])],
    forwardBackoffMs: [10, 20, 40],
    dockerBinary: options.dockerBinary,
    wslBinary: options.wslBinary
  });

  return {
    directory,
    db,
    secretStore,
    services,
    states,
    output,
    sftpClosed,
    transfers,
    forwardStates,
    dockerLogs,
    dockerLogEnds,
    aiChunks,
    sessionLogStates,
    sessionId: () => randomUUID(),
    nextPrompt(): Promise<SessionPrompt> {
      const queued = prompts.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => promptWaiters.push(resolve));
    },
    /** Answers all prompts until stopped, for flows where only the outcome matters. */
    answerPrompts(next: (prompt: SessionPrompt) => PromptResponse): () => void {
      responder = next;
      return () => {
        responder = null;
      };
    },
    async waitForState(sessionId: string, state: SessionState, timeoutMs = 15_000): Promise<SessionStateEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = states.find((event) => event.sessionId === sessionId && event.state === state);
        if (match) return match;
        if (Date.now() > deadline) {
          const seen = states.filter((event) => event.sessionId === sessionId).map((event) => event.state);
          throw new Error(`Timed out waiting for ${state}; saw ${seen.join(', ')}`);
        }
        await new Promise<void>((resolve) => {
          stateWaiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
    async waitForOutput(sessionId: string, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = output.get(sessionId) ?? '';
        if (pattern.test(text)) return text;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}; got ${JSON.stringify(text)}`);
        await new Promise<void>((resolve) => {
          dataWaiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
    },
    dispose(): void {
      services.disposeAll();
      db.close();
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Windows may hold a file briefly; the OS temp directory is cleaned eventually.
      }
    }
  };
}

export type Harness = ReturnType<typeof createHarness>;
