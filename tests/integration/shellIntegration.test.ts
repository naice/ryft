import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalPtyAdapter } from '../../src/main/pty/localPtyAdapter';
import { detectShells } from '../../src/main/pty/shells';
import {
  prepareLocalIntegration,
  ShellIntegrationParser,
  type ShellCommandEvent
} from '../../src/main/history/shellIntegration';

const directory = mkdtempSync(join(tmpdir(), 'ryft-si-'));
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));

const OSC = (nonce: string, body: string): string => `\u001b]7777;${nonce};cmd;${body}\u0007`;

describe('shell integration parser', () => {
  const collect = () => {
    const events: ShellCommandEvent[] = [];
    return { events, parser: new ShellIntegrationParser('n1', (event) => events.push(event)) };
  };

  it('strips its sequence and reports the command', () => {
    const { events, parser } = collect();
    expect(parser.filter(`before${OSC('n1', '3;/tmp;ls -la')}after`)).toBe('beforeafter');
    expect(events).toEqual([{ command: 'ls -la', exitCode: 3, cwd: '/tmp' }]);
  });

  it('handles a sequence split at every position', () => {
    const whole = `a${OSC('n1', '0;/x;echo hi')}b`;
    for (let split = 1; split < whole.length; split += 1) {
      const { events, parser } = collect();
      const output = parser.filter(whole.slice(0, split)) + parser.filter(whole.slice(split));
      expect(output).toBe('ab');
      expect(events).toHaveLength(1);
    }
  });

  it('decodes escaped fields', () => {
    const { events, parser } = collect();
    parser.filter(OSC('n1', '0;C:\\\\Users;a\\x3bb\\x0ac \\\\ d'));
    expect(events[0]).toEqual({ command: 'a;b\nc \\ d', exitCode: 0, cwd: 'C:\\Users' });
  });

  it('ignores what a program printed without the nonce, and leaves it in the output', () => {
    const { events, parser } = collect();
    const forged = OSC('wrong', '0;/;rm -rf /');
    expect(parser.filter(forged)).toBe(forged);
    expect(events).toHaveLength(0);
  });

  it('gives an unterminated sequence back instead of swallowing output forever', () => {
    const { parser } = collect();
    const long = `\u001b]7777;${'x'.repeat(20_000)}`;
    expect(parser.filter(long).length).toBeGreaterThan(19_000);
  });

  it('leaves other escape sequences untouched', () => {
    const { parser } = collect();
    const text = '\u001b[31mred\u001b[0m \u001b]0;title\u0007';
    expect(parser.filter(text)).toBe(text);
  });
});

/** Runs a real shell through the real PTY layer and types into it like a user. */
async function runShell(shellId: string, lines: string[], ready: RegExp): Promise<{ events: ShellCommandEvent[]; output: string }> {
  const shell = detectShells().find((item) => item.id === shellId);
  if (!shell) throw new Error(`no ${shellId}`);
  const events: ShellCommandEvent[] = [];
  const nonce = randomUUID();
  const integration = prepareLocalIntegration(shell, directory, nonce, (event) => events.push(event));
  expect(integration).not.toBeNull();
  const adapter = new LocalPtyAdapter(integration!.shell, { env: integration!.env });
  let output = '';
  await adapter.start(
    {
      onAuthenticating: () => undefined,
      onData: (data) => {
        output += integration!.parser.filter(data.toString());
      },
      onEnd: () => undefined
    },
    { cols: 120, rows: 30 }
  );
  const waitFor = async (test: () => boolean, label: string) => {
    const deadline = Date.now() + 20_000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}; output ${JSON.stringify(output)}; events ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await waitFor(() => ready.test(output), 'first prompt');
    for (const line of lines) {
      const before = events.length;
      adapter.write(`${line}\r`);
      await waitFor(() => events.length > before, line);
    }
    return { events, output };
  } finally {
    adapter.dispose();
  }
}

const shells = detectShells().map((shell) => shell.id);

describe.runIf(shells.includes('powershell'))('Windows PowerShell through ConPTY', () => {
  it('reports commands with exit code and folder, and shows nothing of it', async () => {
    const { events, output } = await runShell(
      'powershell',
      ['echo ryft-marker', 'cmd /c exit 7', 'echo "semi;colon"'],
      /PS .*>/
    );
    expect(events.map((event) => event.command)).toEqual(['echo ryft-marker', 'cmd /c exit 7', 'echo "semi;colon"']);
    expect(events[0]?.exitCode).toBe(0);
    expect(events[1]?.exitCode).toBe(7);
    expect(events[0]?.cwd).toMatch(/.+/);
    expect(output).toContain('ryft-marker');
    expect(output).not.toContain('7777');
  }, 60_000);
});

describe.runIf(shells.includes('git-bash') || shells.includes('bash'))('bash', () => {
  it('reports commands, skips empty lines, and never sees what `read -s` reads', async () => {
    const id = shells.includes('git-bash') ? 'git-bash' : 'bash';
    const shell = detectShells().find((item) => item.id === id)!;
    const events: ShellCommandEvent[] = [];
    const integration = prepareLocalIntegration(shell, directory, randomUUID(), (event) => events.push(event))!;
    const adapter = new LocalPtyAdapter(integration.shell, { env: integration.env });
    let output = '';
    await adapter.start(
      {
        onAuthenticating: () => undefined,
        onData: (data) => {
          output += integration.parser.filter(data.toString());
        },
        onEnd: () => undefined
      },
      { cols: 120, rows: 30 }
    );
    const wait = async (test: () => boolean, label: string) => {
      const deadline = Date.now() + 20_000;
      while (!test()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}: ${JSON.stringify(output)} ${JSON.stringify(events)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      adapter.write('echo ready-$((40+2))\r');
      await wait(() => output.includes('ready-42') && events.length === 1, 'first command');
      adapter.write('\r');
      adapter.write('(exit 5)\r');
      await wait(() => events.length === 2, 'exit code');
      adapter.write('read -s value\r');
      await new Promise((resolve) => setTimeout(resolve, 300));
      adapter.write('hunter2-secret\r');
      await wait(() => events.length === 3, 'read -s');
      adapter.write('echo a;echo b\r');
      await wait(() => events.length === 4, 'semicolon');
    } finally {
      adapter.dispose();
    }
    expect(events.map((event) => event.command)).toEqual(['echo ready-$((40+2))', '(exit 5)', 'read -s value', 'echo a;echo b']);
    expect(events[1]?.exitCode).toBe(5);
    expect(JSON.stringify(events)).not.toContain('hunter2');
  }, 60_000);
});
