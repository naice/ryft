import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type {
  AppInfo,
  Group,
  HistoryEntry,
  Host,
  HostInput,
  Preferences,
  ShellInfo,
  VaultStatus
} from '@shared/contracts';
import type { HostSegment } from '../lib/hostFilter';
import { api, errorMessage } from '../lib/api';

export type NavItem = 'hosts' | 'recent' | 'starred' | 'groups' | 'local';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error';
  message: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
}

interface AppState {
  ready: boolean;
  loadError: string | null;
  info: AppInfo | null;
  hosts: Host[];
  groups: Group[];
  history: HistoryEntry[];
  shells: ShellInfo[];
  vault: VaultStatus;
  preferences: Preferences | null;

  nav: NavItem;
  query: string;
  segment: HostSegment;
  groupFilter: string | null;
  selectedHostId: string | null;

  editor: { host: Host | null } | null;
  settingsOpen: boolean;
  paletteOpen: boolean;
  confirm: ConfirmRequest | null;
  toasts: Toast[];

  load(): Promise<void>;
  refreshHistory(): Promise<void>;
  setNav(nav: NavItem): void;
  setQuery(query: string): void;
  setSegment(segment: HostSegment): void;
  setGroupFilter(groupId: string | null): void;
  selectHost(id: string | null): void;
  openEditor(host: Host | null): void;
  closeEditor(): void;
  setSettingsOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;
  askConfirm(request: ConfirmRequest): void;
  closeConfirm(): void;
  toast(tone: Toast['tone'], message: string): void;
  dismissToast(id: number): void;

  saveHost(id: string | null, input: HostInput): Promise<Host>;
  deleteHost(id: string): Promise<void>;
  duplicateHost(id: string): Promise<void>;
  toggleFavorite(host: Host): Promise<void>;
  createGroup(name: string): Promise<Group>;
  renameGroup(id: string, name: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  refreshHost(id: string): Promise<void>;
  setPreferences(patch: Partial<Preferences>): Promise<void>;
}

let nextToastId = 1;
const TOAST_MS = 5_000;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  loadError: null,
  info: null,
  hosts: [],
  groups: [],
  history: [],
  shells: [],
  vault: { available: false, backend: '' },
  preferences: null,

  nav: 'hosts',
  query: '',
  segment: 'all',
  groupFilter: null,
  selectedHostId: null,

  editor: null,
  settingsOpen: false,
  paletteOpen: false,
  confirm: null,
  toasts: [],

  async load() {
    try {
      const [info, hosts, groups, history, shells, vault, preferences] = await Promise.all([
        api.invoke(Channels.appInfo),
        api.invoke(Channels.hostsList),
        api.invoke(Channels.groupsList),
        api.invoke(Channels.historyList, { limit: 30 }),
        api.invoke(Channels.shellsList),
        api.invoke(Channels.secretsStatus),
        api.invoke(Channels.prefsGet)
      ]);
      set({ info, hosts, groups, history, shells, vault, preferences, ready: true });
    } catch (error) {
      set({ loadError: errorMessage(error) });
    }
  },

  async refreshHistory() {
    set({ history: await api.invoke(Channels.historyList, { limit: 30 }) });
  },

  setNav: (nav) => set({ nav, segment: nav === 'starred' ? 'favorites' : nav === 'groups' ? 'groups' : 'all', groupFilter: null }),
  setQuery: (query) => set({ query }),
  setSegment: (segment) =>
    set({ segment, groupFilter: null, nav: segment === 'favorites' ? 'starred' : segment === 'groups' ? 'groups' : 'hosts' }),
  setGroupFilter: (groupFilter) => set({ groupFilter, nav: 'hosts', segment: 'all' }),
  selectHost: (selectedHostId) => set({ selectedHostId }),
  openEditor: (host) => set({ editor: { host } }),
  closeEditor: () => set({ editor: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),

  toast(tone, message) {
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { id, tone, message }] });
    setTimeout(() => get().dismissToast(id), TOAST_MS);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

  async saveHost(id, input) {
    const saved = id
      ? await api.invoke(Channels.hostsUpdate, { id, input })
      : await api.invoke(Channels.hostsCreate, input);
    const others = get().hosts.filter((host) => host.id !== saved.id);
    set({
      hosts: [...others, saved].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      selectedHostId: saved.id
    });
    return saved;
  },

  async deleteHost(id) {
    await api.invoke(Channels.hostsDelete, { id });
    set({
      hosts: get().hosts.filter((host) => host.id !== id),
      selectedHostId: get().selectedHostId === id ? null : get().selectedHostId
    });
  },

  async duplicateHost(id) {
    const copy = await api.invoke(Channels.hostsDuplicate, { id });
    set({
      hosts: [...get().hosts, copy].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      selectedHostId: copy.id
    });
  },

  async toggleFavorite(host) {
    const updated = await api.invoke(Channels.hostsSetFavorite, { id: host.id, favorite: !host.favorite });
    set({ hosts: get().hosts.map((item) => (item.id === updated.id ? updated : item)) });
  },

  async createGroup(name) {
    const group = await api.invoke(Channels.groupsCreate, { name });
    set({ groups: [...get().groups, group] });
    return group;
  },

  async renameGroup(id, name) {
    const group = await api.invoke(Channels.groupsUpdate, { id, input: { name } });
    set({ groups: get().groups.map((item) => (item.id === id ? group : item)) });
  },

  async deleteGroup(id) {
    await api.invoke(Channels.groupsDelete, { id });
    set({
      groups: get().groups.filter((group) => group.id !== id),
      hosts: get().hosts.map((host) => (host.groupId === id ? { ...host, groupId: null } : host)),
      groupFilter: get().groupFilter === id ? null : get().groupFilter
    });
  },

  /** Secret status can change while connecting, when the user chooses to remember a credential. */
  async refreshHost(id) {
    const hosts = await api.invoke(Channels.hostsList);
    if (hosts.some((host) => host.id === id)) set({ hosts });
  },

  async setPreferences(patch) {
    set({ preferences: await api.invoke(Channels.prefsSet, patch) });
  }
}));

/** Reports a failed user action as a toast instead of failing silently. */
export async function attempt(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    useApp.getState().toast('error', errorMessage(error));
    return false;
  }
}
