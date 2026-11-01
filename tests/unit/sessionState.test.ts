import { describe, expect, it } from 'vitest';
import {
  canTransition,
  IllegalSessionTransition,
  isSessionActive,
  SESSION_STATES,
  SessionStateMachine
} from '@shared/sessionState';

describe('session state machine', () => {
  it('walks the regular lifecycle', () => {
    const machine = new SessionStateMachine();
    for (const state of ['connecting', 'authenticating', 'connected', 'reconnecting', 'connecting', 'connected', 'closed'] as const) {
      machine.transition(state);
      expect(machine.state).toBe(state);
    }
  });

  it('rejects impossible transitions', () => {
    const machine = new SessionStateMachine();
    expect(() => machine.transition('connected')).toThrow(IllegalSessionTransition);
    expect(machine.state).toBe('disconnected');
  });

  it('treats closed as terminal', () => {
    for (const state of SESSION_STATES) expect(canTransition('closed', state)).toBe(false);
  });

  it('can retry after failure', () => {
    expect(canTransition('failed', 'connecting')).toBe(true);
  });

  it('knows which states hold a connection', () => {
    expect(SESSION_STATES.filter(isSessionActive)).toEqual(['connecting', 'authenticating', 'connected', 'reconnecting']);
  });
});
