import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { Channels, EventChannels, SendChannels, type InvokeChannel } from '@shared/channels';
import type { RyftApi } from '@shared/contracts';

const invokeChannels = new Set<string>(Object.values(Channels));

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: RyftApi = {
  invoke: ((channel: InvokeChannel, input?: unknown) => {
    if (!invokeChannels.has(channel)) return Promise.reject(new Error('Unbekannter Kanal'));
    return ipcRenderer.invoke(channel, input);
  }) as RyftApi['invoke'],
  writeSession: (sessionId, data) => ipcRenderer.send(SendChannels.sessionWrite, { sessionId, data }),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.send(SendChannels.sessionResize, { sessionId, cols, rows }),
  ackSession: (sessionId, chars) => ipcRenderer.send(SendChannels.sessionAck, { sessionId, chars }),
  onSessionData: (listener) => subscribe(EventChannels.sessionData, listener),
  onSessionState: (listener) => subscribe(EventChannels.sessionState, listener),
  onSessionPrompt: (listener) => subscribe(EventChannels.sessionPrompt, listener),
  onWindowMaximized: (listener) => subscribe(EventChannels.windowMaximized, listener),
  onSftpClosed: (listener) => subscribe(EventChannels.sftpClosed, listener),
  onTransferUpdate: (listener) => subscribe(EventChannels.transferUpdate, listener),
  onTransferRemoved: (listener) => subscribe(EventChannels.transferRemoved, listener),
  onForwardState: (listener) => subscribe(EventChannels.forwardState, listener),
  onDockerLog: (listener) => subscribe(EventChannels.dockerLog, listener),
  onDockerLogEnd: (listener) => subscribe(EventChannels.dockerLogEnd, listener),
  onAiChunk: (listener) => subscribe(EventChannels.aiChunk, listener),
  onSessionLogState: (listener) => subscribe(EventChannels.sessionLogState, listener),
  pathForDroppedFile: (file) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld('ryft', api);
