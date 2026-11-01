import { z } from 'zod';
import { Channels, SendChannels, type InvokeChannel } from './channels';
import { aiEndpointSchema, aiModelNameSchema, aiSchemas, DEFAULT_AI_ENDPOINT, type AiChunkEvent, type AiModel } from './features/ai';
import { authProfileInputSchema, type AuthProfile } from './features/authProfiles';
import {
  containerIdSchema,
  dockerEndpointSchema,
  dockerSchemas,
  type DockerContainer,
  type DockerContainerDetails,
  type DockerEndpointInfo,
  type DockerLogEndEvent,
  type DockerLogEvent,
  type DockerStatus
} from './features/docker';
import { forwardInputSchema, type ForwardProfile, type ForwardRuntime } from './features/forwards';
import { commandHistoryQuerySchema, exclusionPatternSchema, type CommandHistoryEntry } from './features/commandHistory';
import { hostOptionsSchema } from './features/hostOptions';
import { keySchemas, type ManagedKey } from './features/keys';
import {
  sftpSchemas,
  type DirectoryListing,
  type SftpSessionInfo,
  type TransferJob
} from './features/sftp';
import { sessionLogSchemas, type SessionLogMatch, type SessionLogStateEvent, type SessionLogSummary } from './features/sessionLogs';
import { snippetInputSchema, type Snippet } from './features/snippets';
import { createWorkspaceSchemas, workspaceNameSchema, type WorkspaceSummary } from './features/workspaces';
import { distroNameSchema, wslDirectorySchema, type WslStatus } from './features/wsl';
import type { SessionState } from './sessionState';

export type { AiChunkEvent, AiModel, AiTask } from './features/ai';
export type { AuthProfile, AuthProfileInput } from './features/authProfiles';
export type {
  DockerAction,
  DockerContainer,
  DockerContainerDetails,
  DockerEndpoint,
  DockerEndpointInfo,
  DockerLogEndEvent,
  DockerLogEvent,
  DockerStatus
} from './features/docker';
export type { SessionLogMatch, SessionLogStateEvent, SessionLogSummary } from './features/sessionLogs';
export type { WslDistro, WslStatus } from './features/wsl';
export type { CommandHistoryEntry } from './features/commandHistory';
export type { ManagedKey } from './features/keys';
export type { Snippet, SnippetInput, SnippetParam, SnippetShell } from './features/snippets';
export type { WorkspaceSummary } from './features/workspaces';
export type { ForwardInput, ForwardProfile, ForwardRuntime, ForwardStatus } from './features/forwards';
export { DEFAULT_HOST_OPTIONS, type HostOptions, type ProxyConfig } from './features/hostOptions';
export type {
  ConflictAction,
  ConflictPolicy,
  DirectoryListing,
  FileEntry,
  FileEntryType,
  SftpSessionInfo,
  TransferDirection,
  TransferJob,
  TransferState
} from './features/sftp';

// Matching control characters is the whole point: they must not reach names shown in the UI or written to logs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const noControlChars = (value: string): boolean => !CONTROL_CHARS.test(value);

export const idSchema = z.uuid();

export const authMethodSchema = z.enum(['agent', 'key', 'password']);
export type AuthMethod = z.infer<typeof authMethodSchema>;

const hostFields = {
  name: z.string().trim().min(1).max(128).refine(noControlChars),
  // A hostname is handed to the socket layer only, but must never look like an option or contain whitespace.
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\s-][^\s]*$/, 'Ungültiger Hostname'),
  port: z.number().int().min(1).max(65535),
  username: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[^\s]+$/, 'Ungültiger Benutzername')
    .refine(noControlChars),
  authMethod: authMethodSchema,
  keyReference: z.string().trim().min(1).max(4096).refine(noControlChars).nullable(),
  groupId: idSchema.nullable(),
  tags: z.array(z.string().trim().min(1).max(32).refine(noControlChars)).max(16),
  favorite: z.boolean(),
  /** When set, the profile decides how to authenticate instead of `authMethod` and `keyReference`. */
  authProfileId: idSchema.nullable().default(null),
  options: hostOptionsSchema.prefault({})
};

export const hostInputSchema = z.strictObject(hostFields).superRefine((value, ctx) => {
  if (value.authMethod === 'key' && !value.keyReference && !value.authProfileId) {
    ctx.addIssue({ code: 'custom', path: ['keyReference'], message: 'Schlüsseldatei erforderlich' });
  }
});
export type HostInput = z.infer<typeof hostInputSchema>;

export interface Host extends HostInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** True when a password or passphrase is held in the OS-backed vault. The secret itself never leaves main. */
  hasStoredSecret: boolean;
}

export const groupInputSchema = z.strictObject({ name: z.string().trim().min(1).max(64).refine(noControlChars) });
export interface Group {
  id: string;
  name: string;
  sortOrder: number;
}

export interface HistoryEntry {
  id: string;
  hostId: string | null;
  label: string;
  kind: 'ssh' | 'local';
  startedAt: string;
  endedAt: string | null;
  outcome: 'connected' | 'failed' | null;
}

export interface KnownHostEntry {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  addedAt: string;
}

export interface ShellInfo {
  id: string;
  label: string;
}

/* ---------- Workspace layout (persisted, contains no secrets) ---------- */

export const sessionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local'), shellId: z.string().min(1).max(64).nullable() }),
  z.strictObject({ kind: z.literal('ssh'), hostId: idSchema }),
  z.strictObject({ kind: z.literal('wsl'), distro: distroNameSchema.nullable() }),
  z.strictObject({
    kind: z.literal('docker'),
    endpoint: dockerEndpointSchema,
    containerId: containerIdSchema,
    containerName: z.string().min(1).max(256)
  })
]);
export type SessionTarget = z.infer<typeof sessionTargetSchema>;

const paneDirectorySchema = z.string().min(1).max(4096).refine(noControlChars);
const paneCommandsSchema = z.array(z.string().min(1).max(4096).refine(noControlChars)).max(32);

/** How one pane of a workspace starts. Startup commands run only when the user allowed that in the settings. */
export const sessionLaunchSchema = z.strictObject({
  cwd: paneDirectorySchema.nullable(),
  startupCommands: paneCommandsSchema
});
export type SessionLaunch = z.infer<typeof sessionLaunchSchema>;

export type LayoutNode =
  | {
      type: 'pane';
      id: string;
      target: SessionTarget;
      /** Only set in saved workspaces. */
      cwd?: string | null;
      startupCommands?: string[];
    }
  | { type: 'split'; direction: 'row' | 'column'; ratio: number; first: LayoutNode; second: LayoutNode };

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.strictObject({
      type: z.literal('pane'),
      id: idSchema,
      target: sessionTargetSchema,
      cwd: paneDirectorySchema.nullable().optional(),
      startupCommands: paneCommandsSchema.optional()
    }),
    z.strictObject({
      type: z.literal('split'),
      direction: z.enum(['row', 'column']),
      ratio: z.number().min(0.05).max(0.95),
      first: layoutNodeSchema,
      second: layoutNodeSchema
    })
  ])
);

export const workspaceLayoutSchema = z.strictObject({
  tabs: z
    .array(z.strictObject({ id: idSchema, root: layoutNodeSchema, activePaneId: idSchema }))
    .max(64),
  activeTabId: idSchema.nullable()
});
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;

const workspaceSchemas = createWorkspaceSchemas(workspaceLayoutSchema);
export const workspaceDefinitionSchema = workspaceSchemas.definition;
export const workspaceExportSchema = workspaceSchemas.exportFile;
export type WorkspaceDefinition = z.infer<typeof workspaceDefinitionSchema>;
export type WorkspaceExportFile = z.infer<typeof workspaceExportSchema>;

/* ---------- Preferences ---------- */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;
export type AnsiColorKey = (typeof ANSI_COLOR_KEYS)[number];

export const preferencesSchema = z.strictObject({
  theme: z.enum(['ryft-dark', 'ryft-midnight', 'ryft-light']),
  highContrast: z.boolean(),
  terminalFontFamily: z.string().min(1).max(200).regex(/^[\w\s,'"-]+$/),
  terminalFontSize: z.number().int().min(9).max(28),
  terminalLineHeight: z.number().min(1).max(2),
  terminalCursorStyle: z.enum(['block', 'bar', 'underline']),
  terminalCursorBlink: z.boolean(),
  terminalScrollback: z.number().int().min(100).max(100_000),
  terminalRenderer: z.enum(['webgl', 'dom']),
  ansiOverrides: z.partialRecord(z.enum(ANSI_COLOR_KEYS), hexColor),
  defaultShellId: z.string().min(1).max(64).nullable(),
  autoReconnect: z.boolean(),
  confirmCloseRunning: z.boolean(),
  restoreLayout: z.boolean(),
  captureTerminalShortcuts: z.boolean(),
  hostPanelWidth: z.number().int().min(220).max(380),
  collapsedGroups: z.array(z.string().max(64)).max(512),
  workspaceLayout: workspaceLayoutSchema.nullable(),
  commandHistoryEnabled: z.boolean(),
  historyExclusions: z.array(exclusionPatternSchema).max(64),
  workspaceStartupCommands: z.boolean(),
  wslDefaultDistro: distroNameSchema.nullable(),
  wslStartDirectory: wslDirectorySchema.nullable(),
  aiEnabled: z.boolean(),
  aiEndpoint: aiEndpointSchema,
  aiModel: aiModelNameSchema.nullable(),
  sessionLogDefault: z.boolean(),
  sessionLogMaxMb: z.number().int().min(10).max(100_000),
  sessionLogRetentionDays: z.number().int().min(1).max(3650)
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'ryft-dark',
  highContrast: false,
  terminalFontFamily: "'JetBrains Mono', Consolas, monospace",
  terminalFontSize: 13,
  terminalLineHeight: 1.3,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: 10_000,
  terminalRenderer: 'webgl',
  ansiOverrides: {},
  defaultShellId: null,
  autoReconnect: true,
  confirmCloseRunning: true,
  restoreLayout: true,
  captureTerminalShortcuts: true,
  hostPanelWidth: 260,
  collapsedGroups: [],
  workspaceLayout: null,
  commandHistoryEnabled: true,
  historyExclusions: [],
  workspaceStartupCommands: false,
  wslDefaultDistro: null,
  wslStartDirectory: null,
  aiEnabled: false,
  aiEndpoint: DEFAULT_AI_ENDPOINT,
  aiModel: null,
  sessionLogDefault: false,
  sessionLogMaxMb: 500,
  sessionLogRetentionDays: 30
};

export const preferencesPatchSchema = preferencesSchema.partial();

/* ---------- Secrets ---------- */

export const secretKindSchema = z.enum(['password', 'passphrase']);
export type SecretKind = z.infer<typeof secretKindSchema>;

const secretValue = z.string().min(1).max(4096);

export interface VaultStatus {
  available: boolean;
  backend: string;
  /**
   * The OS key that protected the existing secrets can no longer decrypt them (e.g. a restored profile).
   * The ciphertext is kept; affected credentials are asked for again.
   */
  keyLost: boolean;
}

/* ---------- Sessions ---------- */

/** What the user needs to judge a changed host key. Key material can only be accepted through `changeId`. */
export interface HostKeyChange {
  host: string;
  port: number;
  keyType: string;
  expectedFingerprint: string;
  presentedFingerprint: string;
  source: 'ryft' | 'openssh';
  /** Only for entries RYFT owns; `~/.ssh/known_hosts` is never written. */
  changeId: string | null;
}

export interface SessionError {
  code: SessionErrorCode;
  message: string;
  hostKeyChange?: HostKeyChange;
}

export type SessionErrorCode =
  | 'HOST_NOT_FOUND'
  | 'DNS_FAILED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'CONNECTION_LOST'
  | 'HOST_KEY_MISMATCH'
  | 'HOST_KEY_REVOKED'
  | 'HOST_KEY_REJECTED'
  | 'AUTH_FAILED'
  | 'AUTH_CANCELLED'
  | 'AGENT_UNAVAILABLE'
  | 'KEY_UNREADABLE'
  | 'SHELL_FAILED'
  | 'SPAWN_FAILED'
  | 'JUMP_CHAIN_INVALID'
  | 'UNKNOWN';

export interface SessionStateEvent {
  sessionId: string;
  state: SessionState;
  error: SessionError | null;
  exitCode: number | null;
  /** Upcoming automatic retry, 1-based. */
  attempt: number | null;
  /** The hop of a jump chain being connected, when there is more than one. */
  detail?: string | null;
}

export interface SessionDataEvent {
  sessionId: string;
  data: string;
}

export type SessionPrompt =
  | {
      promptId: string;
      sessionId: string;
      kind: 'hostKey';
      host: string;
      port: number;
      keyType: string;
      fingerprint: string;
      otherTypesKnown: boolean;
    }
  | {
      promptId: string;
      sessionId: string;
      kind: 'password' | 'passphrase';
      label: string;
      retry: boolean;
      canRemember: boolean;
    }
  | {
      promptId: string;
      sessionId: string;
      kind: 'keyboardInteractive';
      label: string;
      instructions: string;
      prompts: { prompt: string; echo: boolean }[];
    };

export const promptResponseSchema = z.strictObject({
  promptId: idSchema,
  response: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('cancel') }),
    z.strictObject({ kind: z.literal('hostKey'), trust: z.enum(['once', 'always']) }),
    z.strictObject({ kind: z.literal('secret'), value: secretValue, remember: z.boolean() }),
    z.strictObject({ kind: z.literal('answers'), answers: z.array(z.string().max(4096)).max(32) })
  ])
});
export type PromptResponse = z.infer<typeof promptResponseSchema>['response'];

const dimension = (max: number): z.ZodNumber => z.number().int().min(1).max(max);

export const sessionWriteSchema = z.strictObject({
  sessionId: idSchema,
  data: z.string().min(1).max(1024 * 1024)
});
export const sessionResizeSchema = z.strictObject({
  sessionId: idSchema,
  cols: dimension(1000),
  rows: dimension(1000)
});
export const sessionAckSchema = z.strictObject({
  sessionId: idSchema,
  chars: z.number().int().min(1).max(64 * 1024 * 1024)
});

export interface AppInfo {
  platform: NodeJS.Platform;
  version: string;
  homeSshDir: string;
}

const none = z.undefined();

/**
 * Input validation for every invoke channel. Anything that does not parse is rejected
 * before a handler runs, so handlers only ever see well-formed data.
 */
export const invokeInputSchemas = {
  [Channels.hostsList]: none,
  [Channels.hostsCreate]: hostInputSchema,
  [Channels.hostsUpdate]: z.strictObject({ id: idSchema, input: hostInputSchema }),
  [Channels.hostsDelete]: z.strictObject({ id: idSchema }),
  [Channels.hostsDuplicate]: z.strictObject({ id: idSchema }),
  [Channels.hostsSetFavorite]: z.strictObject({ id: idSchema, favorite: z.boolean() }),
  [Channels.groupsList]: none,
  [Channels.groupsCreate]: groupInputSchema,
  [Channels.groupsUpdate]: z.strictObject({ id: idSchema, input: groupInputSchema }),
  [Channels.groupsDelete]: z.strictObject({ id: idSchema }),
  [Channels.historyList]: z.strictObject({ limit: z.number().int().min(1).max(200) }),
  [Channels.prefsGet]: none,
  [Channels.prefsSet]: preferencesPatchSchema,
  [Channels.secretsStatus]: none,
  [Channels.secretsSet]: z.strictObject({ hostId: idSchema, kind: secretKindSchema, value: secretValue }),
  [Channels.secretsClear]: z.strictObject({ hostId: idSchema }),
  [Channels.dialogPickKeyFile]: none,
  [Channels.knownHostsList]: none,
  [Channels.knownHostsRemove]: z.strictObject({ id: idSchema }),
  [Channels.knownHostsAcceptChange]: z.strictObject({ changeId: idSchema }),
  [Channels.authProfilesList]: none,
  [Channels.authProfilesCreate]: authProfileInputSchema,
  [Channels.authProfilesUpdate]: z.strictObject({ id: idSchema, input: authProfileInputSchema }),
  [Channels.authProfilesDelete]: z.strictObject({ id: idSchema }),
  [Channels.authProfilesSetSecret]: z.strictObject({ id: idSchema, kind: secretKindSchema, value: secretValue }),
  [Channels.authProfilesClearSecret]: z.strictObject({ id: idSchema }),
  [Channels.secretsDiscardUnreadable]: none,
  [Channels.sftpOpen]: sftpSchemas.open,
  [Channels.sftpClose]: sftpSchemas.close,
  [Channels.sftpList]: sftpSchemas.list,
  [Channels.sftpMkdir]: sftpSchemas.mkdir,
  [Channels.sftpRename]: sftpSchemas.rename,
  [Channels.sftpRemove]: sftpSchemas.remove,
  [Channels.sftpChmod]: sftpSchemas.chmod,
  [Channels.localFsList]: sftpSchemas.localList,
  [Channels.localFsMkdir]: sftpSchemas.localMkdir,
  [Channels.localFsRename]: sftpSchemas.localRename,
  [Channels.localFsRemove]: sftpSchemas.localRemove,
  [Channels.localFsPickFolder]: none,
  [Channels.localFsGrantDropped]: sftpSchemas.grantDropped,
  [Channels.transfersList]: none,
  [Channels.transfersEnqueue]: sftpSchemas.enqueue,
  [Channels.transfersCancel]: sftpSchemas.cancel,
  [Channels.transfersRetry]: sftpSchemas.retry,
  [Channels.transfersResolveConflict]: sftpSchemas.resolveConflict,
  [Channels.transfersClearFinished]: none,
  [Channels.forwardsList]: none,
  [Channels.forwardsCreate]: forwardInputSchema,
  [Channels.forwardsUpdate]: z.strictObject({ id: idSchema, input: forwardInputSchema }),
  [Channels.forwardsDelete]: z.strictObject({ id: idSchema }),
  [Channels.forwardsStart]: z.strictObject({ id: idSchema }),
  [Channels.forwardsStop]: z.strictObject({ id: idSchema }),
  [Channels.forwardsRuntime]: none,
  [Channels.forwardsRestore]: none,
  [Channels.workspacesList]: none,
  [Channels.workspacesGet]: z.strictObject({ id: idSchema }),
  [Channels.workspacesCreate]: z.strictObject({ name: workspaceNameSchema, definition: workspaceDefinitionSchema }),
  [Channels.workspacesUpdate]: z.strictObject({
    id: idSchema,
    name: workspaceNameSchema.optional(),
    definition: workspaceDefinitionSchema.optional()
  }),
  [Channels.workspacesDuplicate]: z.strictObject({ id: idSchema }),
  [Channels.workspacesDelete]: z.strictObject({ id: idSchema }),
  [Channels.workspacesSetDefault]: z.strictObject({ id: idSchema.nullable() }),
  [Channels.workspacesExport]: z.strictObject({ id: idSchema }),
  [Channels.workspacesImport]: none,
  [Channels.snippetsList]: none,
  [Channels.snippetsCreate]: snippetInputSchema,
  [Channels.snippetsUpdate]: z.strictObject({ id: idSchema, input: snippetInputSchema }),
  [Channels.snippetsDelete]: z.strictObject({ id: idSchema }),
  [Channels.snippetsSetFavorite]: z.strictObject({ id: idSchema, favorite: z.boolean() }),
  [Channels.commandHistoryList]: commandHistoryQuerySchema,
  [Channels.commandHistoryDelete]: z.strictObject({ id: idSchema }),
  [Channels.commandHistoryClear]: none,
  [Channels.keysList]: none,
  [Channels.keysGenerate]: keySchemas.generate,
  [Channels.keysPickImport]: none,
  [Channels.keysImport]: keySchemas.import,
  [Channels.keysRename]: keySchemas.rename,
  [Channels.keysRemove]: keySchemas.remove,
  [Channels.keysAssign]: keySchemas.assign,
  [Channels.keysExportPublic]: z.strictObject({ id: idSchema }),
  [Channels.keysInstall]: keySchemas.install,
  [Channels.dockerStatus]: none,
  [Channels.dockerProbeDistro]: dockerSchemas.probe,
  [Channels.dockerList]: dockerSchemas.list,
  [Channels.dockerInspect]: dockerSchemas.inspect,
  [Channels.dockerAction]: dockerSchemas.action,
  [Channels.dockerLogsStart]: dockerSchemas.logsStart,
  [Channels.dockerLogsStop]: dockerSchemas.logsStop,
  [Channels.wslStatus]: none,
  [Channels.aiModels]: none,
  [Channels.aiRun]: aiSchemas.run,
  [Channels.aiCancel]: aiSchemas.cancel,
  [Channels.sessionLogsList]: none,
  [Channels.sessionLogsSearch]: sessionLogSchemas.search,
  [Channels.sessionLogsDelete]: sessionLogSchemas.byId,
  [Channels.sessionLogsClear]: none,
  [Channels.sessionLogsExport]: sessionLogSchemas.export,
  [Channels.sessionLogsSetRecording]: sessionLogSchemas.setRecording,
  [Channels.shellsList]: none,
  [Channels.sessionsOpen]: z.strictObject({
    sessionId: idSchema,
    target: sessionTargetSchema,
    cols: dimension(1000),
    rows: dimension(1000),
    launch: sessionLaunchSchema.optional()
  }),
  [Channels.sessionsClose]: z.strictObject({ sessionId: idSchema }),
  [Channels.sessionsRespondPrompt]: promptResponseSchema,
  [Channels.clipboardRead]: none,
  [Channels.clipboardWrite]: z.strictObject({ text: z.string().max(16 * 1024 * 1024) }),
  [Channels.windowMinimize]: none,
  [Channels.windowToggleMaximize]: none,
  [Channels.windowClose]: none,
  [Channels.appInfo]: none
} satisfies Record<InvokeChannel, z.ZodType>;

export const sendInputSchemas = {
  [SendChannels.sessionWrite]: sessionWriteSchema,
  [SendChannels.sessionResize]: sessionResizeSchema,
  [SendChannels.sessionAck]: sessionAckSchema
};

/** Result types per channel, shared by the handlers and the preload bridge. */
export interface InvokeResults {
  [Channels.hostsList]: Host[];
  [Channels.hostsCreate]: Host;
  [Channels.hostsUpdate]: Host;
  [Channels.hostsDelete]: void;
  [Channels.hostsDuplicate]: Host;
  [Channels.hostsSetFavorite]: Host;
  [Channels.groupsList]: Group[];
  [Channels.groupsCreate]: Group;
  [Channels.groupsUpdate]: Group;
  [Channels.groupsDelete]: void;
  [Channels.historyList]: HistoryEntry[];
  [Channels.prefsGet]: Preferences;
  [Channels.prefsSet]: Preferences;
  [Channels.secretsStatus]: VaultStatus;
  [Channels.secretsSet]: void;
  [Channels.secretsClear]: void;
  [Channels.dialogPickKeyFile]: string | null;
  [Channels.knownHostsList]: KnownHostEntry[];
  [Channels.knownHostsRemove]: void;
  [Channels.knownHostsAcceptChange]: void;
  [Channels.authProfilesList]: AuthProfile[];
  [Channels.authProfilesCreate]: AuthProfile;
  [Channels.authProfilesUpdate]: AuthProfile;
  [Channels.authProfilesDelete]: void;
  [Channels.authProfilesSetSecret]: void;
  [Channels.authProfilesClearSecret]: void;
  [Channels.secretsDiscardUnreadable]: number;
  [Channels.sftpOpen]: SftpSessionInfo;
  [Channels.sftpClose]: void;
  [Channels.sftpList]: DirectoryListing;
  [Channels.sftpMkdir]: void;
  [Channels.sftpRename]: void;
  [Channels.sftpRemove]: void;
  [Channels.sftpChmod]: void;
  [Channels.localFsList]: DirectoryListing;
  [Channels.localFsMkdir]: void;
  [Channels.localFsRename]: void;
  [Channels.localFsRemove]: void;
  [Channels.localFsPickFolder]: string | null;
  [Channels.localFsGrantDropped]: boolean;
  [Channels.transfersList]: TransferJob[];
  [Channels.transfersEnqueue]: string;
  [Channels.transfersCancel]: void;
  [Channels.transfersRetry]: void;
  [Channels.transfersResolveConflict]: void;
  [Channels.transfersClearFinished]: void;
  [Channels.forwardsList]: ForwardProfile[];
  [Channels.forwardsCreate]: ForwardProfile;
  [Channels.forwardsUpdate]: ForwardProfile;
  [Channels.forwardsDelete]: void;
  [Channels.forwardsStart]: ForwardRuntime;
  [Channels.forwardsStop]: void;
  [Channels.forwardsRuntime]: ForwardRuntime[];
  [Channels.forwardsRestore]: void;
  [Channels.workspacesList]: WorkspaceSummary[];
  [Channels.workspacesGet]: WorkspaceDefinition;
  [Channels.workspacesCreate]: WorkspaceSummary;
  [Channels.workspacesUpdate]: WorkspaceSummary;
  [Channels.workspacesDuplicate]: WorkspaceSummary;
  [Channels.workspacesDelete]: void;
  [Channels.workspacesSetDefault]: void;
  [Channels.workspacesExport]: boolean;
  [Channels.workspacesImport]: { workspace: WorkspaceSummary; unresolvedHosts: string[] } | null;
  [Channels.snippetsList]: Snippet[];
  [Channels.snippetsCreate]: Snippet;
  [Channels.snippetsUpdate]: Snippet;
  [Channels.snippetsDelete]: void;
  [Channels.snippetsSetFavorite]: Snippet;
  [Channels.commandHistoryList]: CommandHistoryEntry[];
  [Channels.commandHistoryDelete]: void;
  [Channels.commandHistoryClear]: void;
  [Channels.keysList]: ManagedKey[];
  [Channels.keysGenerate]: ManagedKey;
  [Channels.keysPickImport]: { token: string; path: string; suggestedName: string; needsPassphrase: boolean } | null;
  [Channels.keysImport]: ManagedKey;
  [Channels.keysRename]: ManagedKey;
  [Channels.keysRemove]: void;
  [Channels.keysAssign]: ManagedKey;
  [Channels.keysExportPublic]: boolean;
  [Channels.keysInstall]: 'added' | 'present';
  [Channels.dockerStatus]: DockerStatus;
  [Channels.dockerProbeDistro]: DockerEndpointInfo[];
  [Channels.dockerList]: DockerContainer[];
  [Channels.dockerInspect]: DockerContainerDetails;
  [Channels.dockerAction]: void;
  [Channels.dockerLogsStart]: void;
  [Channels.dockerLogsStop]: void;
  [Channels.wslStatus]: WslStatus;
  [Channels.aiModels]: AiModel[];
  [Channels.aiRun]: 'done' | 'cancelled';
  [Channels.aiCancel]: void;
  [Channels.sessionLogsList]: SessionLogSummary[];
  [Channels.sessionLogsSearch]: SessionLogMatch[];
  [Channels.sessionLogsDelete]: void;
  [Channels.sessionLogsClear]: void;
  [Channels.sessionLogsExport]: boolean;
  [Channels.sessionLogsSetRecording]: void;
  [Channels.shellsList]: ShellInfo[];
  [Channels.sessionsOpen]: void;
  [Channels.sessionsClose]: void;
  [Channels.sessionsRespondPrompt]: void;
  [Channels.clipboardRead]: string;
  [Channels.clipboardWrite]: void;
  [Channels.windowMinimize]: void;
  [Channels.windowToggleMaximize]: void;
  [Channels.windowClose]: void;
  [Channels.appInfo]: AppInfo;
}

export type InvokeInput<C extends InvokeChannel> = z.input<(typeof invokeInputSchemas)[C]>;
export type InvokeResult<C extends InvokeChannel> = InvokeResults[C];

/** The API the preload bridge publishes as `window.ryft`. */
export interface RyftApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeInput<C> extends undefined ? [] : [InvokeInput<C>]
  ): Promise<InvokeResult<C>>;
  writeSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, cols: number, rows: number): void;
  ackSession(sessionId: string, chars: number): void;
  onSessionData(listener: (event: SessionDataEvent) => void): () => void;
  onSessionState(listener: (event: SessionStateEvent) => void): () => void;
  onSessionPrompt(listener: (event: SessionPrompt) => void): () => void;
  onWindowMaximized(listener: (maximized: boolean) => void): () => void;
  onSftpClosed(listener: (event: { sftpId: string; message: string }) => void): () => void;
  onTransferUpdate(listener: (jobs: TransferJob[]) => void): () => void;
  onTransferRemoved(listener: (ids: string[]) => void): () => void;
  onForwardState(listener: (runtime: ForwardRuntime) => void): () => void;
  onDockerLog(listener: (event: DockerLogEvent) => void): () => void;
  onDockerLogEnd(listener: (event: DockerLogEndEvent) => void): () => void;
  onAiChunk(listener: (event: AiChunkEvent) => void): () => void;
  onSessionLogState(listener: (event: SessionLogStateEvent) => void): () => void;
  /** The real path of a dropped OS file; only the preload may ask for this. */
  pathForDroppedFile(file: File): string;
}
