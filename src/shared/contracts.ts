import { z } from 'zod';
import { Channels, SendChannels, type InvokeChannel } from './channels';
import type { SessionState } from './sessionState';

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
  favorite: z.boolean()
};

export const hostInputSchema = z.strictObject(hostFields).superRefine((value, ctx) => {
  if (value.authMethod === 'key' && !value.keyReference) {
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
  z.strictObject({ kind: z.literal('ssh'), hostId: idSchema })
]);
export type SessionTarget = z.infer<typeof sessionTargetSchema>;

export type LayoutNode =
  | { type: 'pane'; id: string; target: SessionTarget }
  | { type: 'split'; direction: 'row' | 'column'; ratio: number; first: LayoutNode; second: LayoutNode };

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('pane'), id: idSchema, target: sessionTargetSchema }),
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
  workspaceLayout: workspaceLayoutSchema.nullable()
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
  workspaceLayout: null
};

export const preferencesPatchSchema = preferencesSchema.partial();

/* ---------- Secrets ---------- */

export const secretKindSchema = z.enum(['password', 'passphrase']);
export type SecretKind = z.infer<typeof secretKindSchema>;

const secretValue = z.string().min(1).max(4096);

export interface VaultStatus {
  available: boolean;
  backend: string;
}

/* ---------- Sessions ---------- */

export interface SessionError {
  code: SessionErrorCode;
  message: string;
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
  | 'UNKNOWN';

export interface SessionStateEvent {
  sessionId: string;
  state: SessionState;
  error: SessionError | null;
  exitCode: number | null;
  /** Upcoming automatic retry, 1-based. */
  attempt: number | null;
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
  [Channels.shellsList]: none,
  [Channels.sessionsOpen]: z.strictObject({
    sessionId: idSchema,
    target: sessionTargetSchema,
    cols: dimension(1000),
    rows: dimension(1000)
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
}
