import { Channels, SendChannels } from '@shared/channels';
import type { AppInfo, AuthProfile } from '@shared/contracts';
import type { ShellDefinition } from '../pty/shells';
import type { Services } from '../services';
import type { StoredAuthProfile } from '../storage/repositories';
import type { InvokeHandlers, SendHandlers } from './registry';

export interface PlatformBridge {
  pickKeyFile(): Promise<string | null>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  appInfo(): AppInfo;
  pickFolder(): Promise<string | null>;
  /** Asks in a native dialog, because the renderer could name any path as "dropped". */
  confirmDroppedPaths(paths: string[]): Promise<boolean>;
  /** The native dialog asks before replacing a file. Returns false when the user cancelled. */
  saveTextFile(options: { title: string; defaultName: string; extension: string; content: string }): Promise<boolean>;
  /** Returns null when the user cancelled. */
  openTextFile(options: { title: string; extension: string; maxBytes: number }): Promise<string | null>;
}

export function createHandlers(services: Services, shells: ShellDefinition[], platform: PlatformBridge): InvokeHandlers {
  const {
    hosts,
    groups,
    preferences,
    history,
    trustedKeys,
    secrets,
    sessions,
    toPublicHost,
    authProfiles,
    credentials,
    hostKeyChanges,
    localFs,
    sftp,
    transfers,
    forwards,
    forwarding,
    workspaces,
    snippets,
    commandHistory,
    docker,
    wsl,
    ai,
    sessionLogs,
    keys
  } = services;
  const hostRefs = () =>
    hosts.list().map(({ id, name, hostname, port, username }) => ({ id, name, hostname, port, username }));
  const toPublicProfile = (profile: StoredAuthProfile): AuthProfile => ({
    ...profile,
    hasStoredSecret: credentials.hasAny('profile', profile.id),
    usedByHosts: authProfiles.usedByHosts(profile.id)
  });
  return {
    [Channels.knownHostsAcceptChange]: ({ changeId }) => hostKeyChanges.accept(changeId),
    [Channels.authProfilesList]: () => authProfiles.list().map(toPublicProfile),
    [Channels.authProfilesCreate]: (input) => toPublicProfile(authProfiles.create(input)),
    [Channels.authProfilesUpdate]: ({ id, input }) => toPublicProfile(authProfiles.update(id, input)),
    [Channels.authProfilesDelete]: ({ id }) => {
      authProfiles.delete(id);
      credentials.clear('profile', id);
    },
    [Channels.authProfilesSetSecret]: ({ id, kind, value }) => {
      authProfiles.get(id);
      credentials.set('profile', id, kind, value);
    },
    [Channels.authProfilesClearSecret]: ({ id }) => credentials.clear('profile', id),
    [Channels.secretsDiscardUnreadable]: () => services.discardUnreadableSecrets(),
    [Channels.sftpOpen]: ({ sftpId, hostId }, caller) => sftp.open(caller.ownerId, sftpId, hostId),
    [Channels.sftpClose]: ({ sftpId }, caller) => sftp.close(caller.ownerId, sftpId),
    [Channels.sftpList]: ({ sftpId, path }, caller) => sftp.list(caller.ownerId, sftpId, path),
    [Channels.sftpMkdir]: ({ sftpId, parent, name }, caller) => sftp.mkdir(caller.ownerId, sftpId, parent, name),
    [Channels.sftpRename]: ({ sftpId, path, name }, caller) => sftp.rename(caller.ownerId, sftpId, path, name),
    [Channels.sftpRemove]: ({ sftpId, path, recursive }, caller) => sftp.remove(caller.ownerId, sftpId, path, recursive),
    [Channels.sftpChmod]: ({ sftpId, path, mode }, caller) => sftp.chmod(caller.ownerId, sftpId, path, mode),
    [Channels.localFsList]: ({ path }) => localFs.list(path),
    [Channels.localFsMkdir]: ({ parent, name }) => localFs.mkdir(parent, name),
    [Channels.localFsRename]: ({ path, name }) => localFs.rename(path, name),
    [Channels.localFsRemove]: ({ path, recursive }) => localFs.remove(path, recursive),
    [Channels.localFsPickFolder]: async () => {
      const folder = await platform.pickFolder();
      if (folder) localFs.grant(folder);
      return folder;
    },
    [Channels.localFsGrantDropped]: async ({ paths }) => {
      const missing = await localFs.outsideScope(paths);
      if (missing.length === 0) return true;
      if (!(await platform.confirmDroppedPaths(missing))) return false;
      for (const path of missing) localFs.grant(path);
      return true;
    },
    [Channels.transfersList]: (_input, caller) => transfers.list(caller.ownerId),
    [Channels.transfersEnqueue]: (input, caller) => transfers.enqueue(caller.ownerId, input),
    [Channels.transfersCancel]: (input, caller) => transfers.cancel(caller.ownerId, input),
    [Channels.transfersRetry]: ({ jobId, sftpId }, caller) => transfers.retry(caller.ownerId, jobId, sftpId),
    [Channels.transfersResolveConflict]: (input, caller) => transfers.resolveConflict(caller.ownerId, input),
    [Channels.transfersClearFinished]: (_input, caller) => transfers.clearFinished(caller.ownerId),
    [Channels.forwardsList]: () => forwards.list(),
    [Channels.forwardsCreate]: (input) => {
      hosts.get(input.hostId);
      return forwards.create(input);
    },
    [Channels.forwardsUpdate]: ({ id, input }) => {
      hosts.get(input.hostId);
      return forwards.update(id, input);
    },
    [Channels.forwardsDelete]: ({ id }, caller) => {
      forwarding.stop(caller.ownerId, id);
      forwards.delete(id);
    },
    [Channels.forwardsStart]: ({ id }, caller) => forwarding.start(caller.ownerId, id),
    [Channels.forwardsStop]: ({ id }, caller) => forwarding.stop(caller.ownerId, id),
    [Channels.forwardsRuntime]: (_input, caller) => forwarding.list(caller.ownerId),
    [Channels.forwardsRestore]: (_input, caller) => {
      // Failures surface as state events of the single forward, not as a failed restore.
      for (const profile of forwards.list()) {
        if (profile.restoreOnStart) void forwarding.start(caller.ownerId, profile.id).catch(() => undefined);
      }
    },
    [Channels.hostsList]: () => hosts.list().map(toPublicHost),
    [Channels.hostsCreate]: (input) => toPublicHost(hosts.create(input)),
    [Channels.hostsUpdate]: ({ id, input }) => toPublicHost(hosts.update(id, input)),
    [Channels.hostsDelete]: ({ id }, caller) => {
      // Their profiles go with the host, so nothing could stop these tunnels afterwards.
      for (const profile of forwards.list()) {
        if (profile.hostId === id) forwarding.stop(caller.ownerId, profile.id);
      }
      hosts.delete(id);
      secrets.clear(id);
    },
    [Channels.hostsDuplicate]: ({ id }) => toPublicHost(hosts.duplicate(id)),
    [Channels.hostsSetFavorite]: ({ id, favorite }) => toPublicHost(hosts.setFavorite(id, favorite)),
    [Channels.groupsList]: () => groups.list(),
    [Channels.groupsCreate]: ({ name }) => groups.create(name),
    [Channels.groupsUpdate]: ({ id, input }) => groups.rename(id, input.name),
    [Channels.groupsDelete]: ({ id }) => groups.delete(id),
    [Channels.historyList]: ({ limit }) => history.list(limit),
    [Channels.prefsGet]: () => preferences.getAll(),
    [Channels.prefsSet]: (patch) => preferences.setMany(patch),
    [Channels.secretsStatus]: () => secrets.status(),
    [Channels.secretsSet]: ({ hostId, kind, value }) => {
      hosts.get(hostId);
      secrets.set(hostId, kind, value);
    },
    [Channels.secretsClear]: ({ hostId }) => secrets.clear(hostId),
    [Channels.dialogPickKeyFile]: () => platform.pickKeyFile(),
    [Channels.knownHostsList]: () => trustedKeys.list(),
    [Channels.knownHostsRemove]: ({ id }) => trustedKeys.remove(id),
    [Channels.workspacesList]: () => workspaces.list(),
    [Channels.workspacesGet]: ({ id }) => workspaces.get(id),
    [Channels.workspacesCreate]: ({ name, definition }) => workspaces.create(name, definition),
    [Channels.workspacesUpdate]: ({ id, name, definition }) => workspaces.update(id, { name, definition }),
    [Channels.workspacesDuplicate]: ({ id }) => workspaces.duplicate(id),
    [Channels.workspacesDelete]: ({ id }) => workspaces.delete(id),
    [Channels.workspacesSetDefault]: ({ id }) => workspaces.setDefault(id),
    [Channels.workspacesExport]: ({ id }) => {
      const { name, content } = workspaces.exportFile(id, hostRefs());
      return platform.saveTextFile({ title: 'Workspace exportieren', defaultName: `${name}.ryft-workspace.json`, extension: 'json', content });
    },
    [Channels.workspacesImport]: async () => {
      const content = await platform.openTextFile({ title: 'Workspace importieren', extension: 'json', maxBytes: 4 * 1024 * 1024 });
      return content === null ? null : workspaces.importFile(content, hostRefs());
    },
    [Channels.snippetsList]: () => snippets.list(),
    [Channels.snippetsCreate]: (input) => snippets.create(input),
    [Channels.snippetsUpdate]: ({ id, input }) => snippets.update(id, input),
    [Channels.snippetsDelete]: ({ id }) => snippets.delete(id),
    [Channels.snippetsSetFavorite]: ({ id, favorite }) => snippets.setFavorite(id, favorite),
    [Channels.commandHistoryList]: (input) => commandHistory.list(input),
    [Channels.commandHistoryDelete]: ({ id }) => commandHistory.delete(id),
    [Channels.commandHistoryClear]: () => commandHistory.clear(),
    [Channels.keysList]: () => keys.list(),
    [Channels.keysGenerate]: (input) => keys.generate(input),
    [Channels.keysPickImport]: async () => {
      const path = await platform.pickKeyFile();
      return path ? keys.inspectImport(path) : null;
    },
    [Channels.keysImport]: (input) => keys.import(input),
    [Channels.keysRename]: ({ id, name }) => keys.rename(id, name),
    [Channels.keysRemove]: ({ id, deleteFile }) => keys.remove(id, deleteFile),
    [Channels.keysAssign]: ({ id, hostIds }) => {
      const key = keys.get(id);
      for (const hostId of hostIds) {
        const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = hosts.get(hostId);
        hosts.update(hostId, { ...input, authProfileId: null, authMethod: 'key', keyReference: key.privateKeyPath });
      }
      return keys.get(id);
    },
    [Channels.keysExportPublic]: ({ id }) => {
      const key = keys.get(id);
      return platform.saveTextFile({
        title: 'Öffentlichen Schlüssel exportieren',
        defaultName: `${key.name.replace(/[^\w.-]+/g, '_')}.pub`,
        extension: 'pub',
        content: `${key.publicKey}\n`
      });
    },
    [Channels.keysInstall]: ({ id, hostId, contextId }, caller) => services.installKey(caller.ownerId, id, hostId, contextId),
    [Channels.dockerStatus]: () => docker.status(),
    [Channels.dockerProbeDistro]: ({ distro }) => docker.probeDistro(distro),
    [Channels.dockerList]: ({ endpoint }) => docker.list(endpoint),
    [Channels.dockerInspect]: ({ endpoint, containerId }) => docker.inspect(endpoint, containerId),
    [Channels.dockerAction]: ({ endpoint, containerId, action }) => docker.act(endpoint, containerId, action),
    [Channels.dockerLogsStart]: ({ streamId, endpoint, containerId, tail }, caller) =>
      docker.startLogs(caller.ownerId, streamId, endpoint, containerId, tail),
    [Channels.dockerLogsStop]: ({ streamId }, caller) => docker.stopLogs(caller.ownerId, streamId),
    [Channels.wslStatus]: () => wsl.status(),
    [Channels.aiModels]: () => ai.models(),
    [Channels.aiRun]: (input, caller) => ai.run(caller.ownerId, input),
    [Channels.aiCancel]: ({ requestId }, caller) => ai.cancel(caller.ownerId, requestId),
    [Channels.sessionLogsList]: () => sessionLogs.list(),
    [Channels.sessionLogsSearch]: ({ query, limit }) => sessionLogs.search(query, limit),
    [Channels.sessionLogsDelete]: ({ id }) => sessionLogs.remove(id),
    [Channels.sessionLogsClear]: () => sessionLogs.removeAllFinished(),
    [Channels.sessionLogsExport]: ({ id, format }) => {
      const summary = sessionLogs.list().find((log) => log.id === id);
      const base = (summary?.label ?? 'session').replace(/[^\w.-]+/g, '_');
      return platform.saveTextFile({
        title: 'Sitzungsprotokoll exportieren',
        defaultName: `${base}.${format === 'text' ? 'txt' : 'jsonl'}`,
        extension: format === 'text' ? 'txt' : 'jsonl',
        content: sessionLogs.read(id, format)
      });
    },
    [Channels.sessionLogsSetRecording]: ({ sessionId, enabled }, caller) => {
      const target = sessions.targetOf(caller.ownerId, sessionId);
      sessionLogs.setRecording(sessionId, enabled, services.labelOf(target), target.kind);
    },
    [Channels.shellsList]: () => shells.map(({ id, label }) => ({ id, label })),
    [Channels.sessionsOpen]: ({ sessionId, target, cols, rows, launch }, caller) =>
      sessions.open(caller.ownerId, sessionId, target, cols, rows, launch ?? null),
    [Channels.sessionsClose]: ({ sessionId }, caller) => sessions.close(caller.ownerId, sessionId),
    [Channels.sessionsRespondPrompt]: ({ promptId, response }, caller) =>
      sessions.respondToPrompt(caller.ownerId, promptId, response),
    [Channels.clipboardRead]: () => platform.readClipboard(),
    [Channels.clipboardWrite]: ({ text }) => platform.writeClipboard(text),
    [Channels.windowMinimize]: () => platform.minimizeWindow(),
    [Channels.windowToggleMaximize]: () => platform.toggleMaximizeWindow(),
    [Channels.windowClose]: () => platform.closeWindow(),
    [Channels.appInfo]: () => platform.appInfo()
  };
}

export function createSendHandlers(services: Services): SendHandlers {
  const { sessions } = services;
  return {
    [SendChannels.sessionWrite]: ({ sessionId, data }, caller) => sessions.write(caller.ownerId, sessionId, data),
    [SendChannels.sessionResize]: ({ sessionId, cols, rows }, caller) =>
      sessions.resize(caller.ownerId, sessionId, cols, rows),
    [SendChannels.sessionAck]: ({ sessionId, chars }, caller) => sessions.ack(caller.ownerId, sessionId, chars)
  };
}
