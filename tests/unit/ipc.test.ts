import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Channels, SendChannels } from '@shared/channels';
import { invokeInputSchemas, hostInputSchema, preferencesSchema } from '@shared/contracts';
import {
  createDispatcher,
  createSenderCheck,
  IpcSenderError,
  IpcValidationError,
  type InvokeHandlers,
  type SendHandlers
} from '../../src/main/ipc/registry';
import { hostInput } from '../fixtures/harness';

const trusted = { ownerId: 1, frameUrl: 'file:///app/index.html' };

function setup() {
  const handler = vi.fn(() => []);
  const write = vi.fn();
  const handlers = new Proxy({} as InvokeHandlers, { get: () => handler });
  const sendHandlers = new Proxy({} as SendHandlers, { get: () => write });
  const dispatcher = createDispatcher(
    handlers,
    sendHandlers,
    createSenderCheck((url) => url === trusted.frameUrl)
  );
  return { dispatcher, handler, write };
}

describe('IPC dispatcher', () => {
  it('has a schema for every channel', () => {
    for (const channel of Object.values(Channels)) expect(invokeInputSchemas).toHaveProperty([channel]);
  });

  it('passes valid input to the handler', async () => {
    const { dispatcher, handler } = setup();
    await dispatcher.invoke(Channels.hostsCreate, hostInput(), trusted);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ['foreign origin', { ownerId: 1, frameUrl: 'https://evil.example/' }],
    ['missing frame', { ownerId: 1, frameUrl: undefined }]
  ])('rejects senders with %s', async (_name, caller) => {
    const { dispatcher, handler } = setup();
    await expect(dispatcher.invoke(Channels.hostsList, undefined, caller)).rejects.toBeInstanceOf(IpcSenderError);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown channel', 'shell:exec', {}],
    ['prototype key', '__proto__', {}],
    ['unexpected input', Channels.hostsList, { evil: true }],
    ['extra host field', Channels.hostsCreate, { ...hostInput(), privateKey: 'x' }],
    ['port out of range', Channels.hostsCreate, hostInput({ port: 70000 })],
    ['hostname as option', Channels.hostsCreate, hostInput({ hostname: '-oProxyCommand=calc' })],
    ['hostname with space', Channels.hostsCreate, hostInput({ hostname: 'a b' })],
    ['non-uuid id', Channels.hostsDelete, { id: '../../etc' }],
    ['ssh session by address', Channels.sessionsOpen, {
      sessionId: randomUUID(),
      target: { kind: 'ssh', hostname: 'evil.example' },
      cols: 80,
      rows: 24
    }],
    ['shell by path', Channels.sessionsOpen, {
      sessionId: randomUUID(),
      target: { kind: 'local', shell: 'C:/evil.exe' },
      cols: 80,
      rows: 24
    }],
    ['zero size', Channels.sessionsOpen, {
      sessionId: randomUUID(),
      target: { kind: 'local', shellId: null },
      cols: 0,
      rows: 24
    }]
  ])('rejects %s', async (_name, channel, input) => {
    const { dispatcher, handler } = setup();
    await expect(dispatcher.invoke(channel, input, trusted)).rejects.toBeInstanceOf(IpcValidationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('hides internal error details from the renderer', async () => {
    const handler = vi.fn(() => {
      throw new Error('SQLITE_ERROR at C:/Users/name/secret/path');
    });
    const dispatcher = createDispatcher(
      new Proxy({} as InvokeHandlers, { get: () => handler }),
      {} as SendHandlers,
      () => undefined
    );
    await expect(dispatcher.invoke(Channels.hostsList, undefined, trusted)).rejects.toThrow(/^Interner Fehler$/);
  });

  it('drops invalid terminal traffic silently', () => {
    const { dispatcher, write } = setup();
    dispatcher.send(SendChannels.sessionWrite, { sessionId: 'nope', data: 'x' }, trusted);
    dispatcher.send(SendChannels.sessionWrite, { sessionId: randomUUID(), data: 'x' }, { ownerId: 1, frameUrl: 'https://evil.example' });
    dispatcher.send('other', {}, trusted);
    expect(write).not.toHaveBeenCalled();
    dispatcher.send(SendChannels.sessionWrite, { sessionId: randomUUID(), data: 'x' }, trusted);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe('contracts', () => {
  it('requires a key file for key authentication', () => {
    expect(hostInputSchema.safeParse(hostInput({ authMethod: 'key', keyReference: null })).success).toBe(false);
    expect(hostInputSchema.safeParse(hostInput({ authMethod: 'key', keyReference: '~/.ssh/id' })).success).toBe(true);
  });

  it('has no field that could hold a secret on hosts or preferences', () => {
    const fields = [...Object.keys(hostInputSchema.shape), ...Object.keys(preferencesSchema.shape)];
    expect(fields.filter((field) => /pass|secret|private/i.test(field))).toEqual([]);
  });
});
