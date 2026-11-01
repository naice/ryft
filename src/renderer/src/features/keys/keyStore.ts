import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { ManagedKey } from '@shared/contracts';
import { api } from '../../lib/api';

interface KeyState {
  keys: ManagedKey[];
  load(): Promise<void>;
}

export const useKeys = create<KeyState>((set) => ({
  keys: [],
  async load() {
    set({ keys: await api.invoke(Channels.keysList) });
  }
}));
