import { AiError } from '../ai/aiProvider';
import { DockerError } from '../docker/dockerService';
import { SessionLogError } from '../logging/sessionLogger';
import { ReadOnlySnippetError } from '../snippets/snippetRepository';
import { z } from 'zod';
import type { InvokeChannel } from '@shared/channels';
import { invokeInputSchemas, sendInputSchemas, type InvokeResult } from '@shared/contracts';
import { ForwardConfigError } from '../forward/forwardManager';
import { KeyManagerError } from '../keys/keyManager';
import { WorkspaceFormatError } from '../workspaces/workspaceRepository';
import { SessionAccessError } from '../sessions/sessionManager';
import { SessionFailure } from '../sessions/types';
import { FileAccessError } from '../sftp/localFs';
import { NotFoundError } from '../storage/repositories';
import { HostKeyChangeExpiredError } from '../security/hostKeyChanges';
import { VaultUnavailableError } from '../security/secretVault';
import { log } from '../logger';

export interface IpcCaller {
  /** webContents id of the sender. */
  ownerId: number;
  /** Origin frame URL; used to reject anything but the app's own document. */
  frameUrl: string | undefined;
}

export class IpcValidationError extends Error {
  constructor(channel: string) {
    super(`Ungültige Anfrage an ${channel}`);
    this.name = 'IpcValidationError';
  }
}

export class IpcSenderError extends Error {
  constructor() {
    super('Anfrage von nicht vertrauenswürdigem Absender');
    this.name = 'IpcSenderError';
  }
}

export type InvokeHandlers = {
  [C in InvokeChannel]: (
    input: z.output<(typeof invokeInputSchemas)[C]>,
    caller: IpcCaller
  ) => InvokeResult<C> | Promise<InvokeResult<C>>;
};

export type SendHandlers = {
  [C in keyof typeof sendInputSchemas]: (input: z.output<(typeof sendInputSchemas)[C]>, caller: IpcCaller) => void;
};

/** Messages safe to pass to the renderer unchanged. Everything else is logged and generalized. */
const PUBLIC_ERRORS = [
  IpcValidationError,
  IpcSenderError,
  NotFoundError,
  SessionAccessError,
  VaultUnavailableError,
  FileAccessError,
  ForwardConfigError,
  HostKeyChangeExpiredError,
  SessionFailure,
  KeyManagerError,
  WorkspaceFormatError,
  DockerError,
  AiError,
  SessionLogError,
  ReadOnlySnippetError
];

/** The renderer's document is either the packaged file or, in development, the Vite server. */
export function createSenderCheck(isTrustedUrl: (url: string) => boolean) {
  return (caller: IpcCaller): void => {
    if (!caller.frameUrl || !isTrustedUrl(caller.frameUrl)) throw new IpcSenderError();
  };
}

export function createDispatcher(
  handlers: InvokeHandlers,
  sendHandlers: SendHandlers,
  checkSender: (caller: IpcCaller) => void
) {
  return {
    /** Sender check, schema validation, handler, in this order. No handler sees unvalidated input. */
    async invoke(channel: string, rawInput: unknown, caller: IpcCaller): Promise<unknown> {
      checkSender(caller);
      if (!Object.hasOwn(invokeInputSchemas, channel)) throw new IpcValidationError(channel);
      const key = channel as InvokeChannel;
      const parsed = invokeInputSchemas[key].safeParse(rawInput);
      if (!parsed.success) throw new IpcValidationError(channel);
      const handler = handlers[key] as (input: unknown, caller: IpcCaller) => unknown;
      try {
        return await handler(parsed.data, caller);
      } catch (error) {
        if (PUBLIC_ERRORS.some((type) => error instanceof type)) throw error;
        // Error text may include paths or SQL; the sanitized version is what the renderer gets.
        log.error(`IPC handler failed: ${channel}`, { error });
        throw new Error('Interner Fehler', { cause: error });
      }
    },

    /** Terminal traffic. Failures are dropped: a late keystroke for a closed session is not an error. */
    send(channel: string, rawInput: unknown, caller: IpcCaller): void {
      try {
        checkSender(caller);
        if (!Object.hasOwn(sendInputSchemas, channel)) return;
        const key = channel as keyof typeof sendInputSchemas;
        const parsed = sendInputSchemas[key].safeParse(rawInput);
        if (!parsed.success) return;
        (sendHandlers[key] as (input: unknown, caller: IpcCaller) => void)(parsed.data, caller);
      } catch (error) {
        if (!(error instanceof SessionAccessError)) log.warn(`IPC send failed: ${channel}`, { error });
      }
    }
  };
}
