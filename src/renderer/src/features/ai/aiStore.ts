import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { AiModel, AiTask } from '@shared/contracts';
import { api, errorMessage } from '../../lib/api';

export type AiExchangeStatus = 'streaming' | 'done' | 'cancelled' | 'failed';

export interface AiExchange {
  id: string;
  task: AiTask;
  prompt: string;
  /** How much selected text went along. The text itself is not kept around after sending. */
  contextChars: number;
  answer: string;
  status: AiExchangeStatus;
  error: string | null;
}

interface AiState {
  open: boolean;
  models: AiModel[];
  modelsError: string | null;
  loadingModels: boolean;
  exchanges: AiExchange[];
  setOpen(open: boolean): void;
  loadModels(): Promise<void>;
  ask(task: AiTask, prompt: string, context: string | null): Promise<void>;
  cancel(id: string): void;
  clear(): void;
  onChunk(requestId: string, text: string): void;
}

const update = (exchanges: AiExchange[], id: string, patch: (item: AiExchange) => Partial<AiExchange>) =>
  exchanges.map((item) => (item.id === id ? { ...item, ...patch(item) } : item));

export const useAi = create<AiState>((set, get) => ({
  open: false,
  models: [],
  modelsError: null,
  loadingModels: false,
  exchanges: [],

  setOpen: (open) => set({ open }),

  async loadModels() {
    set({ loadingModels: true });
    try {
      set({ models: await api.invoke(Channels.aiModels), modelsError: null });
    } catch (error) {
      set({ models: [], modelsError: errorMessage(error) });
    } finally {
      set({ loadingModels: false });
    }
  },

  async ask(task, prompt, context) {
    const id = crypto.randomUUID();
    set({
      exchanges: [...get().exchanges, { id, task, prompt, contextChars: context?.length ?? 0, answer: '', status: 'streaming', error: null }]
    });
    try {
      const status = await api.invoke(Channels.aiRun, { requestId: id, task, prompt, context });
      set({ exchanges: update(get().exchanges, id, () => ({ status })) });
    } catch (error) {
      set({ exchanges: update(get().exchanges, id, () => ({ status: 'failed', error: errorMessage(error) })) });
    }
  },

  cancel(id) {
    void api.invoke(Channels.aiCancel, { requestId: id }).catch(() => undefined);
  },

  clear() {
    for (const item of get().exchanges) {
      if (item.status === 'streaming') get().cancel(item.id);
    }
    set({ exchanges: [] });
  },

  onChunk(requestId, text) {
    set({ exchanges: update(get().exchanges, requestId, (item) => ({ answer: item.answer + text })) });
  }
}));
