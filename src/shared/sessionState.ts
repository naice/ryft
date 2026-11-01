export const SESSION_STATES = [
  'disconnected',
  'connecting',
  'authenticating',
  'connected',
  'reconnecting',
  'failed',
  'closed'
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  disconnected: ['connecting', 'closed'],
  connecting: ['authenticating', 'connected', 'reconnecting', 'failed', 'closed'],
  authenticating: ['connected', 'reconnecting', 'failed', 'closed'],
  connected: ['reconnecting', 'failed', 'closed'],
  reconnecting: ['connecting', 'failed', 'closed'],
  failed: ['connecting', 'reconnecting', 'closed'],
  closed: []
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalSessionTransition extends Error {
  constructor(from: SessionState, to: SessionState) {
    super(`Illegal session transition: ${from} -> ${to}`);
    this.name = 'IllegalSessionTransition';
  }
}

/** Enforces the documented lifecycle so that adapters cannot report impossible states. */
export class SessionStateMachine {
  private current: SessionState = 'disconnected';

  get state(): SessionState {
    return this.current;
  }

  transition(to: SessionState): void {
    if (!canTransition(this.current, to)) {
      throw new IllegalSessionTransition(this.current, to);
    }
    this.current = to;
  }
}

/** States in which the pane owns a live or in-flight connection. */
export function isSessionActive(state: SessionState): boolean {
  return state === 'connecting' || state === 'authenticating' || state === 'connected' || state === 'reconnecting';
}
