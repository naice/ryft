import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectShells, resolveShell } from '../../src/main/pty/shells';
import { HIGH_WATER_MARK, SessionManager } from '../../src/main/sessions/sessionManager';
import type { AdapterHooks, SessionAdapter } from '../../src/main/sessions/types';
import { createHarness, OWNER, type Harness } from '../fixtures/harness';

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.dispose());

describe('shell allowlist', () => {
  it('finds at least one shell and falls back to the first one', () => {
    const shells = detectShells();
    expect(shells.length).toBeGreaterThan(0);
    expect(resolveShell(shells, 'does-not-exist')).toBe(shells[0]);
    expect(resolveShell([], null)).toBeNull();
  });
});

describe('local PTY', () => {
  const EXIT = process.platform === 'win32' ? 'exit\r' : 'exit\n';

  it('runs a real shell, echoes a command and reports the exit', async () => {
    const sessionId = harness.sessionId();
    await harness.services.sessions.open(OWNER, sessionId, { kind: 'local', shellId: null }, 100, 30);
    await harness.waitForState(sessionId, 'connected');

    harness.services.sessions.write(OWNER, sessionId, process.platform === 'win32' ? 'echo ryft-%OS%-marker\r' : 'echo ryft-marker\n');
    await harness.waitForOutput(sessionId, /ryft-/);

    harness.services.sessions.resize(OWNER, sessionId, 120, 40);
    harness.services.sessions.write(OWNER, sessionId, EXIT);
    await harness.waitForState(sessionId, 'closed', 20_000);
    expect(harness.services.sessions.count()).toBe(0);
    expect(harness.services.history.list(1)[0]).toMatchObject({ kind: 'local', outcome: 'connected' });
  });

  it('kills the process when the session is closed', async () => {
    const sessionId = harness.sessionId();
    await harness.services.sessions.open(OWNER, sessionId, { kind: 'local', shellId: null }, 80, 24);
    harness.services.sessions.close(OWNER, sessionId);
    expect(harness.services.sessions.stateOf(sessionId)).toBeNull();
    await harness.waitForState(sessionId, 'closed');
  });
});

describe('flow control', () => {
  class ScriptedAdapter implements SessionAdapter {
    hooks: AdapterHooks | null = null;
    paused = 0;
    resumed = 0;
    async start(hooks: AdapterHooks): Promise<void> {
      this.hooks = hooks;
    }
    write(): void {}
    resize(): void {}
    pause(): void {
      this.paused += 1;
    }
    resume(): void {
      this.resumed += 1;
    }
    dispose(): void {}
  }

  function setup() {
    const adapter = new ScriptedAdapter();
    const received: string[] = [];
    const manager = new SessionManager({
      sink: { data: (event) => received.push(event.data), state: () => undefined, prompt: () => undefined },
      createAdapter: () => adapter,
      autoReconnectEnabled: () => false
    });
    return { adapter, manager, received };
  }
  const ID = '6f9a7f4e-4f6d-4f5a-9f3a-000000000001';

  it('pauses at the high water mark and resumes after acknowledgements', async () => {
    const { adapter, manager } = setup();
    await manager.open(OWNER, ID, { kind: 'local', shellId: null }, 80, 24);
    adapter.hooks!.onData('x'.repeat(HIGH_WATER_MARK));
    expect(adapter.paused).toBe(1);
    manager.ack(OWNER, ID, 100);
    expect(adapter.resumed).toBe(0);
    manager.ack(OWNER, ID, HIGH_WATER_MARK);
    expect(adapter.resumed).toBe(1);
    manager.disposeAll();
  });

  it('batches chunks and does not split multi-byte characters', async () => {
    const { adapter, manager, received } = setup();
    await manager.open(OWNER, ID, { kind: 'local', shellId: null }, 80, 24);
    const euro = Buffer.from('€');
    adapter.hooks!.onData(euro.subarray(0, 1));
    adapter.hooks!.onData(euro.subarray(1));
    adapter.hooks!.onData(Buffer.from('!'));
    await expect.poll(() => received.join('')).toBe('€!');
    expect(received).toHaveLength(1);
    manager.disposeAll();
  });

  it('ignores events of a replaced adapter', async () => {
    const { adapter, manager, received } = setup();
    await manager.open(OWNER, ID, { kind: 'local', shellId: null }, 80, 24);
    const stale = adapter.hooks!;
    await manager.open(OWNER, ID, { kind: 'local', shellId: null }, 80, 24);
    stale.onData('late');
    stale.onEnd({ kind: 'exit', code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toEqual([]);
    expect(manager.stateOf(ID)).toBe('connected');
    manager.disposeAll();
  });
});
