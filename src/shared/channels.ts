/** IPC channel names. Kept dependency-free because the sandboxed preload bundles this file. */
export const Channels = {
  hostsList: 'hosts:list',
  hostsCreate: 'hosts:create',
  hostsUpdate: 'hosts:update',
  hostsDelete: 'hosts:delete',
  hostsDuplicate: 'hosts:duplicate',
  hostsSetFavorite: 'hosts:setFavorite',
  groupsList: 'groups:list',
  groupsCreate: 'groups:create',
  groupsUpdate: 'groups:update',
  groupsDelete: 'groups:delete',
  historyList: 'history:list',
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  secretsStatus: 'secrets:status',
  secretsSet: 'secrets:set',
  secretsClear: 'secrets:clear',
  dialogPickKeyFile: 'dialog:pickKeyFile',
  knownHostsList: 'knownHosts:list',
  knownHostsRemove: 'knownHosts:remove',
  shellsList: 'shells:list',
  sessionsOpen: 'sessions:open',
  sessionsClose: 'sessions:close',
  sessionsRespondPrompt: 'sessions:respondPrompt',
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  appInfo: 'app:info'
} as const;

export type InvokeChannel = (typeof Channels)[keyof typeof Channels];

/** Fire-and-forget renderer -> main channels used for high frequency terminal traffic. */
export const SendChannels = {
  sessionWrite: 'sessions:write',
  sessionResize: 'sessions:resize',
  sessionAck: 'sessions:ack'
} as const;

/** main -> renderer events. */
export const EventChannels = {
  sessionData: 'session:data',
  sessionState: 'session:state',
  sessionPrompt: 'session:prompt',
  windowMaximized: 'window:maximized'
} as const;
