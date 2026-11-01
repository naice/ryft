import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { SessionLogStateEvent, SessionLogSummary } from '@shared/contracts';
import { api } from '../../lib/api';
import { useApp } from '../../state/appStore';

interface LogState {
  logs: SessionLogSummary[];
  /** The sessions being recorded right now. Main says so, because the default can start one on its own. */
  recording: Record<string, boolean>;
  load(): Promise<void>;
  setRecording(sessionId: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  onState(event: SessionLogStateEvent): void;
}

export const useSessionLogs = create<LogState>((set, get) => ({
  logs: [],
  recording: {},

  async load() {
    set({ logs: await api.invoke(Channels.sessionLogsList) });
  },

  async setRecording(sessionId, enabled) {
    await api.invoke(Channels.sessionLogsSetRecording, { sessionId, enabled });
  },

  async remove(id) {
    await api.invoke(Channels.sessionLogsDelete, { id });
    await get().load();
  },

  async clear() {
    await api.invoke(Channels.sessionLogsClear);
    await get().load();
  },

  onState(event) {
    set({ recording: { ...get().recording, [event.sessionId]: event.recording } });
    if (event.error) useApp.getState().toast('error', event.error);
    if (useApp.getState().nav === 'logs') void get().load().catch(() => undefined);
  }
}));
