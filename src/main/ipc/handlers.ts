import { Channels, SendChannels } from '@shared/channels';
import type { AppInfo } from '@shared/contracts';
import type { ShellDefinition } from '../pty/shells';
import type { Services } from '../services';
import type { InvokeHandlers, SendHandlers } from './registry';

export interface PlatformBridge {
  pickKeyFile(): Promise<string | null>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  appInfo(): AppInfo;
}

export function createHandlers(services: Services, shells: ShellDefinition[], platform: PlatformBridge): InvokeHandlers {
  const { hosts, groups, preferences, history, trustedKeys, secrets, sessions, toPublicHost } = services;
  return {
    [Channels.hostsList]: () => hosts.list().map(toPublicHost),
    [Channels.hostsCreate]: (input) => toPublicHost(hosts.create(input)),
    [Channels.hostsUpdate]: ({ id, input }) => toPublicHost(hosts.update(id, input)),
    [Channels.hostsDelete]: ({ id }) => {
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
    [Channels.shellsList]: () => shells.map(({ id, label }) => ({ id, label })),
    [Channels.sessionsOpen]: ({ sessionId, target, cols, rows }, caller) =>
      sessions.open(caller.ownerId, sessionId, target, cols, rows),
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
