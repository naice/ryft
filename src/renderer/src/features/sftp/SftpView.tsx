import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, FolderOpen, FolderSearch, Loader2, Plug, Unplug } from 'lucide-react';
import { Channels } from '@shared/channels';
import { api } from '../../lib/api';
import { attempt, useApp } from '../../state/appStore';
import { Button, EmptyState, IconButton, Select } from '../../components/ui/primitives';
import { ToolView } from '../../components/ui/ToolView';
import { FilePane, type FileOperations } from './FilePane';
import { isFinishedJob, useSftp } from './sftpStore';
import { TransferQueue } from './TransferQueue';

const LOCAL_OPERATIONS: FileOperations = {
  mkdir: (parent, name) => api.invoke(Channels.localFsMkdir, { parent, name }),
  rename: (path, name) => api.invoke(Channels.localFsRename, { path, name }),
  remove: (path, recursive) => api.invoke(Channels.localFsRemove, { path, recursive })
};

export function SftpView() {
  const hosts = useApp((state) => state.hosts);
  const selectedHostId = useApp((state) => state.selectedHostId);
  const askConfirm = useApp((state) => state.askConfirm);
  const toast = useApp((state) => state.toast);
  const connection = useSftp((state) => state.connection);
  const connect = useSftp((state) => state.connect);
  const disconnect = useSftp((state) => state.disconnect);
  const navigate = useSftp((state) => state.navigate);
  const enqueue = useSftp((state) => state.enqueue);
  const localPath = useSftp((state) => state.panes.local.listing?.path ?? null);
  const remotePath = useSftp((state) => state.panes.remote.listing?.path ?? null);
  const [hostId, setHostId] = useState(selectedHostId ?? '');

  useEffect(() => {
    if (localPath === null) void navigate('local', null);
    // Only the first visit needs a starting folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if ('hostId' in connection) setHostId(connection.hostId);
  }, [connection]);

  const connected = connection.status === 'connected';
  const connecting = connection.status === 'connecting';
  const sftpId = connected ? connection.sftpId : null;

  const whenTransfersIdle = (proceed: () => void) => {
    const active = Object.values(useSftp.getState().jobs).filter((job) => !isFinishedJob(job)).length;
    if (active === 0) {
      proceed();
      return;
    }
    askConfirm({
      title: 'SFTP-Verbindung trennen?',
      message: `${active} Übertragungen laufen noch. Sie werden abgebrochen und lassen sich nach dem erneuten Verbinden wiederholen. Auf dem Server kann eine unvollständige .ryftpart-Datei zurückbleiben.`,
      confirmLabel: 'Trennen',
      danger: true,
      onConfirm: proceed
    });
  };

  const remoteOperations: FileOperations = {
    mkdir: (parent, name) => api.invoke(Channels.sftpMkdir, { sftpId: sftpId!, parent, name }),
    rename: (path, name) => api.invoke(Channels.sftpRename, { sftpId: sftpId!, path, name }),
    remove: (path, recursive) => api.invoke(Channels.sftpRemove, { sftpId: sftpId!, path, recursive }),
    chmod: (path, mode) => api.invoke(Channels.sftpChmod, { sftpId: sftpId!, path, mode })
  };

  const upload = (paths: string[]) => {
    if (remotePath) void attempt(() => enqueue('upload', paths, remotePath));
  };
  const download = (paths: string[]) => {
    if (localPath) void attempt(() => enqueue('download', paths, localPath));
  };

  const uploadDropped = (files: File[]) => {
    const paths = files.map((file) => api.pathForDroppedFile(file)).filter(Boolean);
    if (paths.length === 0) return;
    void attempt(async () => {
      // Main asks natively for anything outside of the granted folders: a path from here proves nothing.
      if (await api.invoke(Channels.localFsGrantDropped, { paths })) upload(paths);
    });
  };

  const pickLocalFolder = () =>
    void attempt(async () => {
      const folder = await api.invoke(Channels.localFsPickFolder);
      if (folder) await navigate('local', folder);
    });

  const connectSelected = () => {
    if (hostId) void connect(hostId);
    else toast('info', 'Wähle zuerst einen Host aus.');
  };

  const problem = connection.status === 'failed' || connection.status === 'lost' ? connection.message : null;

  return (
    <ToolView
      testId="sftp-view"
      title="SFTP"
      description="Dateien zwischen diesem Rechner und einem Server übertragen"
      actions={
        <>
          <div className="w-56">
            <Select
              ariaLabel="SFTP-Host"
              value={hostId}
              onChange={(value) => {
                if (connected || connecting) {
                  whenTransfersIdle(() => {
                    disconnect();
                    setHostId(value);
                  });
                } else {
                  setHostId(value);
                }
              }}
              options={[
                { value: '', label: hosts.length ? 'Host wählen…' : 'Keine Hosts vorhanden' },
                ...hosts.map((host) => ({ value: host.id, label: host.name }))
              ]}
            />
          </div>
          {connected || connecting ? (
            <Button onClick={() => whenTransfersIdle(disconnect)}>
              {connecting ? <Loader2 size={14} className="ryft-spin" /> : <Unplug size={14} />}
              {connecting ? 'Abbrechen' : 'Trennen'}
            </Button>
          ) : (
            <Button variant="primary" disabled={!hostId} onClick={connectSelected}>
              <Plug size={14} /> Verbinden
            </Button>
          )}
        </>
      }
    >
      {problem && (
        <div role="alert" className="mx-3 mt-3 flex flex-none items-start gap-2 rounded-card border border-error p-2.5">
          <AlertTriangle size={15} className="mt-px flex-none text-error" />
          <div className="min-w-0 text-xs">
            <p className="font-semibold text-text">
              {connection.status === 'lost' ? 'Die SFTP-Verbindung wurde getrennt' : 'Verbindung fehlgeschlagen'}
            </p>
            <p className="mt-0.5 break-words text-secondary select-text">{problem}</p>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2 p-3">
        <FilePane
          side="local"
          title="Dieser Rechner"
          operations={LOCAL_OPERATIONS}
          transferLabel={connected && remotePath ? 'Hochladen' : null}
          onTransfer={upload}
          onDropPaths={download}
          toolbar={
            <IconButton label="Anderen Ordner freigeben und öffnen" onClick={pickLocalFolder}>
              <FolderSearch size={14} />
            </IconButton>
          }
        />
        <div className="flex flex-none flex-col items-center justify-center gap-2 text-subtle" aria-hidden>
          <ArrowRight size={14} />
          <ArrowLeft size={14} />
        </div>
        <FilePane
          side="remote"
          title={connected ? (hosts.find((host) => host.id === connection.hostId)?.name ?? 'Server') : 'Server'}
          operations={remoteOperations}
          transferLabel={localPath ? 'Herunterladen' : null}
          onTransfer={download}
          onDropPaths={upload}
          onDropFiles={uploadDropped}
          empty={
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={connecting ? <Loader2 size={24} className="ryft-spin" /> : <FolderOpen size={24} />}
                title={connecting ? 'Verbinde…' : 'Nicht verbunden'}
                description={
                  connecting
                    ? 'Der Server wird geprüft. Unbekannte Host-Schlüssel musst du bestätigen.'
                    : 'Wähle oben einen Host und verbinde dich, um seine Dateien zu sehen.'
                }
              />
            </div>
          }
        />
      </div>
      <div className="flex-none px-3 pb-3">
        <TransferQueue />
      </div>
    </ToolView>
  );
}
