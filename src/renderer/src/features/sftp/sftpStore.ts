import { create } from 'zustand';
import { Channels } from '@shared/channels';
import type { ConflictAction, DirectoryListing, TransferDirection, TransferJob } from '@shared/contracts';
import { api, errorMessage } from '../../lib/api';
import { registerPromptContext, unregisterPromptContext } from '../../state/workspaceStore';

export type PaneSide = 'local' | 'remote';

export interface PaneState {
  listing: DirectoryListing | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_PANE: PaneState = { listing: null, loading: false, error: null };
const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled', 'skipped']);

export function isFinishedJob(job: TransferJob): boolean {
  return TERMINAL_STATES.has(job.state);
}

type Connection =
  | { status: 'idle' }
  | { status: 'connecting'; sftpId: string; hostId: string }
  | { status: 'connected'; sftpId: string; hostId: string }
  | { status: 'lost' | 'failed'; hostId: string; message: string };

interface SftpState {
  connection: Connection;
  panes: Record<PaneSide, PaneState>;
  jobs: Record<string, TransferJob>;
  showHidden: boolean;

  connect(hostId: string): Promise<void>;
  disconnect(): void;
  navigate(side: PaneSide, path: string | null): Promise<void>;
  refresh(side: PaneSide): Promise<void>;
  setShowHidden(show: boolean): void;
  enqueue(direction: TransferDirection, sources: string[], destinationDir: string): Promise<void>;
  retry(jobId: string): Promise<void>;
  resolveConflict(jobId: string, action: ConflictAction, applyToBatch: boolean): Promise<void>;
  loadJobs(): Promise<void>;
  onSftpClosed(event: { sftpId: string; message: string }): void;
  onJobs(jobs: TransferJob[]): void;
  onJobsRemoved(ids: string[]): void;
}

const refreshTimers: Partial<Record<PaneSide, ReturnType<typeof setTimeout>>> = {};
/** Only the newest listing of a pane counts, however the answers arrive. */
const listRequests: Record<PaneSide, number> = { local: 0, remote: 0 };

export const useSftp = create<SftpState>((set, get) => {
  const setPane = (side: PaneSide, patch: Partial<PaneState>): void =>
    set({ panes: { ...get().panes, [side]: { ...get().panes[side], ...patch } } });

  const scheduleRefresh = (side: PaneSide): void => {
    if (refreshTimers[side]) return;
    refreshTimers[side] = setTimeout(() => {
      refreshTimers[side] = undefined;
      void get().refresh(side);
    }, 300);
  };

  return {
    connection: { status: 'idle' },
    panes: { local: EMPTY_PANE, remote: EMPTY_PANE },
    jobs: {},
    showHidden: false,

    async connect(hostId) {
      get().disconnect();
      const sftpId = crypto.randomUUID();
      registerPromptContext(sftpId);
      set({ connection: { status: 'connecting', sftpId, hostId } });
      const stale = (): boolean => {
        const current = get().connection;
        return current.status !== 'connecting' || current.sftpId !== sftpId;
      };
      try {
        const info = await api.invoke(Channels.sftpOpen, { sftpId, hostId });
        if (stale()) {
          // Given up on while still connecting: nothing else would ever close it.
          void api.invoke(Channels.sftpClose, { sftpId }).catch(() => undefined);
          return;
        }
        set({ connection: { status: 'connected', sftpId, hostId } });
        await get().navigate('remote', info.startPath);
      } catch (error) {
        unregisterPromptContext(sftpId);
        if (!stale()) set({ connection: { status: 'failed', hostId, message: errorMessage(error) } });
      }
    },

    disconnect() {
      const current = get().connection;
      if (current.status === 'connecting' || current.status === 'connected') {
        unregisterPromptContext(current.sftpId);
        void api.invoke(Channels.sftpClose, { sftpId: current.sftpId }).catch(() => undefined);
      }
      listRequests.remote += 1;
      set({ connection: { status: 'idle' }, panes: { ...get().panes, remote: EMPTY_PANE } });
    },

    async navigate(side, path) {
      const request = ++listRequests[side];
      setPane(side, { loading: true, error: null });
      try {
        let listing: DirectoryListing;
        if (side === 'local') {
          listing = await api.invoke(Channels.localFsList, { path });
        } else {
          const { connection } = get();
          if (connection.status !== 'connected' || path === null) return;
          listing = await api.invoke(Channels.sftpList, { sftpId: connection.sftpId, path });
        }
        if (request === listRequests[side]) setPane(side, { listing, loading: false });
      } catch (error) {
        // The previous listing stays, so a mistyped path does not throw the pane away.
        if (request === listRequests[side]) setPane(side, { loading: false, error: errorMessage(error) });
      }
    },

    async refresh(side) {
      const path = get().panes[side].listing?.path ?? null;
      if (side === 'remote' && path === null) return;
      await get().navigate(side, path);
    },

    setShowHidden: (showHidden) => set({ showHidden }),

    async enqueue(direction, sources, destinationDir) {
      const { connection } = get();
      if (connection.status !== 'connected' || sources.length === 0) return;
      await api.invoke(Channels.transfersEnqueue, {
        sftpId: connection.sftpId,
        direction,
        sources,
        destinationDir,
        conflictPolicy: 'ask'
      });
    },

    async retry(jobId) {
      const { connection } = get();
      // Connected again by now? Main checks that this is still the same host.
      const sftpId = connection.status === 'connected' ? connection.sftpId : undefined;
      await api.invoke(Channels.transfersRetry, { jobId, sftpId });
    },

    async resolveConflict(jobId, action, applyToBatch) {
      await api.invoke(Channels.transfersResolveConflict, { jobId, action, applyToBatch });
    },

    async loadJobs() {
      const list = await api.invoke(Channels.transfersList);
      set({ jobs: Object.fromEntries(list.map((job) => [job.id, job])) });
    },

    onSftpClosed({ sftpId, message }) {
      const current = get().connection;
      if ((current.status === 'connected' || current.status === 'connecting') && current.sftpId === sftpId) {
        unregisterPromptContext(sftpId);
        set({ connection: { status: 'lost', hostId: current.hostId, message } });
      }
    },

    onJobs(updates) {
      const jobs = { ...get().jobs };
      for (const job of updates) {
        const previous = jobs[job.id];
        jobs[job.id] = job;
        // What landed should show up without the user having to refresh.
        if (job.state === 'done' && previous?.state !== 'done') {
          scheduleRefresh(job.direction === 'upload' ? 'remote' : 'local');
        }
      }
      set({ jobs });
    },

    onJobsRemoved(ids) {
      const jobs = { ...get().jobs };
      for (const id of ids) delete jobs[id];
      set({ jobs });
    }
  };
});
