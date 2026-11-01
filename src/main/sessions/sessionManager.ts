import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { PromptResponse, SessionError, SessionLaunch, SessionTarget } from '@shared/contracts';
import { SessionStateMachine, type SessionState } from '@shared/sessionState';
import { log } from '../logger';
import type { AdapterEnd, PromptRequest, Prompter, SessionAdapter, SessionEventSink } from './types';
import { SessionFailure } from './types';

const FLUSH_INTERVAL_MS = 8;
/** Unacknowledged characters at which the source is paused, and at which it may continue. */
export const HIGH_WATER_MARK = 512 * 1024;
export const LOW_WATER_MARK = 128 * 1024;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 8_000];

export class SessionAccessError extends Error {
  constructor() {
    super('Unbekannte Sitzung');
    this.name = 'SessionAccessError';
  }
}

export interface SessionManagerDeps {
  sink: SessionEventSink;
  createAdapter(
    target: SessionTarget,
    prompt: Prompter,
    onDetail: (detail: string) => void,
    launch: SessionLaunch | null
  ): SessionAdapter;
  /** Asked at the moment they would run, not when the session was requested. */
  startupCommandsAllowed?(): boolean;
  autoReconnectEnabled(target: SessionTarget): boolean;
  /** How the bytes of a session map to characters; UTF-8 unless a host says otherwise. */
  encodingOf?(target: SessionTarget): 'utf8' | 'latin1';
  reconnectDelaysMs?: readonly number[];
  /** Sees what a session displays and how it changes state, never what is typed into it. */
  observer?: {
    connected(sessionId: string, target: SessionTarget): void;
    output(sessionId: string, text: string): void;
    state(sessionId: string, state: SessionState): void;
    ended(sessionId: string): void;
  };
  history?: {
    start(target: SessionTarget): string | null;
    outcome(id: string, outcome: 'connected' | 'failed'): void;
    finish(id: string): void;
  };
}

interface ManagedSession {
  id: string;
  ownerId: number;
  target: SessionTarget;
  machine: SessionStateMachine;
  adapter: SessionAdapter | null;
  /** Bumped on each connection attempt so that events of a superseded adapter are ignored. */
  generation: number;
  cols: number;
  rows: number;
  buffer: string;
  flushTimer: NodeJS.Timeout | null;
  unacked: number;
  paused: boolean;
  decoder: StringDecoder;
  reconnectTimer: NodeJS.Timeout | null;
  attempt: number;
  promptIds: Set<string>;
  historyId: string | null;
  launch: SessionLaunch | null;
  /** Startup commands belong to the first connection. A reconnect must not repeat them. */
  startupDone: boolean;
}

interface PendingPrompt {
  sessionId: string;
  ownerId: number;
  resolve(response: PromptResponse): void;
}

/**
 * Owns every live connection. Sessions are bound to the webContents that opened them, and a request
 * for someone else's session is treated like a request for an unknown one.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly prompts = new Map<string, PendingPrompt>();

  constructor(private readonly deps: SessionManagerDeps) {}

  async open(
    ownerId: number,
    sessionId: string,
    target: SessionTarget,
    cols: number,
    rows: number,
    launch: SessionLaunch | null = null
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.ownerId !== ownerId) throw new SessionAccessError();
      // Re-opening a pane is how retry works; whatever it still holds is torn down first.
      this.teardown(existing);
      this.sessions.delete(sessionId);
    }
    const session: ManagedSession = {
      id: sessionId,
      ownerId,
      target,
      machine: new SessionStateMachine(),
      adapter: null,
      generation: 0,
      cols,
      rows,
      buffer: '',
      flushTimer: null,
      unacked: 0,
      paused: false,
      decoder: new StringDecoder('utf8'),
      reconnectTimer: null,
      attempt: 0,
      promptIds: new Set(),
      historyId: null,
      launch,
      startupDone: false
    };
    this.sessions.set(sessionId, session);
    await this.connect(session);
  }

  close(ownerId: number, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.ownerId !== ownerId) throw new SessionAccessError();
    this.flush(session);
    this.teardown(session);
    this.transition(session, 'closed', {});
    this.deps.observer?.ended(sessionId);
    this.sessions.delete(sessionId);
  }

  write(ownerId: number, sessionId: string, data: string): void {
    this.authorized(ownerId, sessionId).adapter?.write(data);
  }

  resize(ownerId: number, sessionId: string, cols: number, rows: number): void {
    const session = this.authorized(ownerId, sessionId);
    session.cols = cols;
    session.rows = rows;
    session.adapter?.resize(cols, rows);
  }

  /** Flow control: the renderer reports what xterm has actually processed. */
  ack(ownerId: number, sessionId: string, chars: number): void {
    const session = this.authorized(ownerId, sessionId);
    session.unacked = Math.max(0, session.unacked - chars);
    if (session.paused && session.unacked <= LOW_WATER_MARK) {
      session.paused = false;
      session.adapter?.resume();
    }
  }

  respondToPrompt(ownerId: number, promptId: string, response: PromptResponse): void {
    const pending = this.prompts.get(promptId);
    if (!pending || pending.ownerId !== ownerId) throw new SessionAccessError();
    this.prompts.delete(promptId);
    this.sessions.get(pending.sessionId)?.promptIds.delete(promptId);
    pending.resolve(response);
  }

  /** Prompts for connections that belong to no pane, such as SFTP or a tunnel. */
  createPrompter(ownerId: number, contextId: string): Prompter {
    return (request: PromptRequest) =>
      new Promise<PromptResponse>((resolve) => {
        const promptId = randomUUID();
        this.prompts.set(promptId, { sessionId: contextId, ownerId, resolve });
        this.deps.sink.prompt({ ...request, promptId, sessionId: contextId } as Parameters<SessionEventSink['prompt']>[0]);
      });
  }

  cancelContext(contextId: string): void {
    for (const [promptId, pending] of [...this.prompts]) {
      if (pending.sessionId !== contextId) continue;
      this.prompts.delete(promptId);
      pending.resolve({ kind: 'cancel' });
    }
  }

  /** The target of a session of this owner, for features acting on a running session. */
  targetOf(ownerId: number, sessionId: string): SessionTarget {
    return this.authorized(ownerId, sessionId).target;
  }

  stateOf(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId)?.machine.state ?? null;
  }

  count(): number {
    return this.sessions.size;
  }

  disposeOwner(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.close(ownerId, session.id);
    }
  }

  disposeAll(): void {
    for (const session of [...this.sessions.values()]) this.close(session.ownerId, session.id);
  }

  private authorized(ownerId: number, sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) throw new SessionAccessError();
    return session;
  }

  private prompterFor(session: ManagedSession): Prompter {
    return (request: PromptRequest) =>
      new Promise<PromptResponse>((resolve) => {
        const promptId = randomUUID();
        this.prompts.set(promptId, { sessionId: session.id, ownerId: session.ownerId, resolve });
        session.promptIds.add(promptId);
        this.deps.sink.prompt({ ...request, promptId, sessionId: session.id } as Parameters<SessionEventSink['prompt']>[0]);
      });
  }

  private async connect(session: ManagedSession): Promise<void> {
    const generation = ++session.generation;
    this.transition(session, 'connecting', {});
    session.historyId ??= this.deps.history?.start(session.target) ?? null;

    let adapter: SessionAdapter;
    try {
      adapter = this.deps.createAdapter(
        session.target,
        this.prompterFor(session),
        (detail) => {
          if (session.generation !== generation) return;
          this.deps.sink.state({
            sessionId: session.id,
            state: session.machine.state,
            error: null,
            exitCode: null,
            attempt: null,
            detail
          });
        },
        session.launch
      );
    } catch (error) {
      this.failed(session, toSessionError(error));
      return;
    }
    session.adapter = adapter;
    session.decoder = new StringDecoder(this.deps.encodingOf?.(session.target) ?? 'utf8');
    session.unacked = 0;
    session.paused = false;
    const current = (): boolean => session.generation === generation && this.sessions.get(session.id) === session;

    try {
      await adapter.start(
        {
          onAuthenticating: () => {
            if (current() && session.machine.state === 'connecting') this.transition(session, 'authenticating', {});
          },
          onData: (data) => {
            if (current()) this.enqueue(session, data);
          },
          onEnd: (end) => {
            if (current()) this.handleEnd(session, end);
          }
        },
        { cols: session.cols, rows: session.rows }
      );
    } catch (error) {
      if (current()) {
        this.releaseAdapter(session);
        this.cancelPrompts(session);
        if (session.attempt > 0 && isTransient(toSessionError(error))) {
          this.scheduleReconnect(session, toSessionError(error));
        } else {
          this.failed(session, toSessionError(error));
        }
      }
      return;
    }
    if (!current()) return;
    session.attempt = 0;
    this.transition(session, 'connected', {});
    this.deps.observer?.connected(session.id, session.target);
    if (session.historyId) this.deps.history?.outcome(session.historyId, 'connected');
    // The window may have changed while connecting.
    adapter.resize(session.cols, session.rows);
    if (!session.startupDone) {
      session.startupDone = true;
      if (this.deps.startupCommandsAllowed?.()) {
        for (const command of session.launch?.startupCommands ?? []) adapter.write(`${command}\r`);
      }
    }
  }

  private handleEnd(session: ManagedSession, end: AdapterEnd): void {
    this.flush(session);
    this.releaseAdapter(session);
    this.cancelPrompts(session);
    if (end.kind === 'exit') {
      this.finishHistory(session);
      this.transition(session, 'closed', { exitCode: end.code });
      this.deps.observer?.ended(session.id);
      this.sessions.delete(session.id);
      return;
    }
    if (session.target.kind === 'ssh' && this.deps.autoReconnectEnabled(session.target)) {
      this.scheduleReconnect(session, end.error);
    } else {
      this.failed(session, end.error);
    }
  }

  private scheduleReconnect(session: ManagedSession, error: SessionError): void {
    const delays = this.deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    const delay = delays[session.attempt];
    if (delay === undefined) {
      this.failed(session, error);
      return;
    }
    session.attempt += 1;
    this.transition(session, 'reconnecting', { error, attempt: session.attempt });
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.connect(session);
    }, delay);
  }

  private failed(session: ManagedSession, error: SessionError): void {
    if (session.historyId) this.deps.history?.outcome(session.historyId, 'failed');
    this.finishHistory(session);
    session.attempt = 0;
    this.transition(session, 'failed', { error });
  }

  private finishHistory(session: ManagedSession): void {
    if (session.historyId) this.deps.history?.finish(session.historyId);
    session.historyId = null;
  }

  private transition(
    session: ManagedSession,
    state: SessionState,
    extras: { error?: SessionError; exitCode?: number | null; attempt?: number }
  ): void {
    session.machine.transition(state);
    this.deps.observer?.state(session.id, state);
    this.deps.sink.state({
      sessionId: session.id,
      state,
      error: extras.error ?? null,
      exitCode: extras.exitCode ?? null,
      attempt: extras.attempt ?? null
    });
  }

  private enqueue(session: ManagedSession, data: string | Buffer): void {
    const decoded = typeof data === 'string' ? data : session.decoder.write(data);
    const text = session.adapter?.filterOutput ? session.adapter.filterOutput(decoded) : decoded;
    if (!text) return;
    this.deps.observer?.output(session.id, text);
    session.buffer += text;
    session.unacked += text.length;
    if (!session.paused && session.unacked >= HIGH_WATER_MARK) {
      session.paused = true;
      session.adapter?.pause();
    }
    session.flushTimer ??= setTimeout(() => {
      session.flushTimer = null;
      this.flush(session);
    }, FLUSH_INTERVAL_MS);
  }

  private flush(session: ManagedSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (!session.buffer) return;
    const data = session.buffer;
    session.buffer = '';
    this.deps.sink.data({ sessionId: session.id, data });
  }

  private releaseAdapter(session: ManagedSession): void {
    const adapter = session.adapter;
    session.adapter = null;
    try {
      adapter?.dispose();
    } catch (error) {
      log.warn('Adapter dispose failed', { error });
    }
  }

  private cancelPrompts(session: ManagedSession): void {
    for (const promptId of session.promptIds) {
      const pending = this.prompts.get(promptId);
      this.prompts.delete(promptId);
      pending?.resolve({ kind: 'cancel' });
    }
    session.promptIds.clear();
  }

  private teardown(session: ManagedSession): void {
    // Invalidate first so that adapter callbacks caused by the teardown are ignored.
    session.generation += 1;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    this.cancelPrompts(session);
    this.releaseAdapter(session);
    this.finishHistory(session);
  }
}

function toSessionError(error: unknown): SessionError {
  if (error instanceof SessionFailure) return error.toSessionError();
  log.error('Unexpected session error', { error });
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : 'Unbekannter Fehler' };
}

/** Only network conditions are retried. Trust and credential problems need a person. */
function isTransient(error: SessionError): boolean {
  return ['CONNECTION_LOST', 'CONNECTION_REFUSED', 'CONNECTION_TIMEOUT', 'DNS_FAILED'].includes(error.code);
}
