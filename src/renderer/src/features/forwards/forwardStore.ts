import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { ForwardInput, ForwardProfile, ForwardRuntime } from '@shared/contracts';
import { api } from '../../lib/api';
import { registerPromptContext, unregisterPromptContext } from '../../state/workspaceStore';

interface ForwardState {
  profiles: ForwardProfile[];
  runtime: Record<string, ForwardRuntime>;
  load(): Promise<void>;
  save(id: string | null, input: ForwardInput): Promise<ForwardProfile>;
  remove(id: string): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  onState(runtime: ForwardRuntime): void;
}

export const useForwards = create<ForwardState>((set, get) => ({
  profiles: [],
  runtime: {},

  async load() {
    const [profiles, runtime] = await Promise.all([api.invoke(Channels.forwardsList), api.invoke(Channels.forwardsRuntime)]);
    for (const profile of profiles) registerPromptContext(profile.id);
    set({ profiles, runtime: Object.fromEntries(runtime.map((item) => [item.id, item])) });
  },

  async save(id, input) {
    const saved = id
      ? await api.invoke(Channels.forwardsUpdate, { id, input })
      : await api.invoke(Channels.forwardsCreate, input);
    registerPromptContext(saved.id);
    set({
      profiles: [...get().profiles.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      )
    });
    return saved;
  },

  async remove(id) {
    await api.invoke(Channels.forwardsDelete, { id });
    unregisterPromptContext(id);
    const { [id]: _removed, ...runtime } = get().runtime;
    set({ profiles: get().profiles.filter((item) => item.id !== id), runtime });
  },

  async start(id) {
    get().onState(await api.invoke(Channels.forwardsStart, { id }));
  },

  async stop(id) {
    await api.invoke(Channels.forwardsStop, { id });
  },

  onState(runtime) {
    set({ runtime: { ...get().runtime, [runtime.id]: runtime } });
  }
}));
