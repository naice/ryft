import type {
  HostKeyChange,
  SessionError,
  SessionPrompt,
  PromptResponse,
  SessionStateEvent,
  SessionDataEvent
} from '@shared/contracts';

export class SessionFailure extends Error {
  constructor(
    readonly code: SessionError['code'],
    message: string,
    readonly hostKeyChange?: HostKeyChange
  ) {
    super(message);
    this.name = 'SessionFailure';
  }

  toSessionError(): SessionError {
    const error: SessionError = { code: this.code, message: this.message };
    if (this.hostKeyChange) error.hostKeyChange = this.hostKeyChange;
    return error;
  }
}

export type AdapterEnd =
  | { kind: 'exit'; code: number | null }
  | { kind: 'lost'; error: SessionError };

export interface AdapterHooks {
  onAuthenticating(): void;
  onData(data: string | Buffer): void;
  onEnd(end: AdapterEnd): void;
}

/** One live connection for one pane: a local PTY or an SSH shell channel. */
export interface SessionAdapter {
  /** Resolves once the terminal is usable. Rejects with a SessionFailure otherwise. */
  start(hooks: AdapterHooks, size: { cols: number; rows: number }): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  dispose(): void;
  /** Sees decoded output before anything else does, and may remove what is not meant for the terminal. */
  filterOutput?(text: string): string;
}

export type PromptRequest = SessionPrompt extends infer P
  ? P extends SessionPrompt
    ? Omit<P, 'promptId' | 'sessionId'>
    : never
  : never;

export type Prompter = (request: PromptRequest) => Promise<PromptResponse>;

/** Where the session layer delivers events; implemented over IPC in the app and in-memory in tests. */
export interface SessionEventSink {
  data(event: SessionDataEvent): void;
  state(event: SessionStateEvent): void;
  prompt(event: SessionPrompt): void;
}
