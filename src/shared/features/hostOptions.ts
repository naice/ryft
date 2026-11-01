import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const proxySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({
    type: z.enum(['socks5', 'http']),
    // Handed to the socket layer only, but must never look like an option or contain whitespace.
    host: z.string().trim().min(1).max(255).regex(/^[^\s-][^\s]*$/),
    port: z.number().int().min(1).max(65535)
  })
]);
export type ProxyConfig = z.infer<typeof proxySchema>;

/**
 * Advanced connection settings of a host. Every field has a default, so hosts saved
 * before these options existed parse to the behaviour they always had.
 */
export const hostOptionsSchema = z.strictObject({
  connectTimeoutSec: z.number().int().min(1).max(600).default(20),
  /** 0 turns keepalives off. */
  keepaliveIntervalSec: z.number().int().min(0).max(3600).default(15),
  /** `inherit` follows the application setting. */
  reconnectPolicy: z.enum(['inherit', 'never', 'auto']).default('inherit'),
  /** Start folder of the SFTP pane. Terminals keep starting where the server puts them. */
  defaultRemoteDir: z
    .string()
    .trim()
    .max(4096)
    .refine((value) => !CONTROL_CHARS.test(value))
    .default(''),
  terminalType: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._+-]+$/)
    .default('xterm-256color'),
  encoding: z.enum(['utf8', 'latin1']).default('utf8'),
  /** Sent with the shell request. OpenSSH only accepts names listed in the server's AcceptEnv. */
  env: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
        value: z
          .string()
          .max(4096)
          .refine((value) => !CONTROL_CHARS.test(value))
      })
    )
    .max(32)
    .default([]),
  startupCommands: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !CONTROL_CHARS.test(value))
    )
    .max(32)
    .default([]),
  /** Stored commands stay inert until this is switched on for the host. */
  runStartupCommands: z.boolean().default(false),
  proxy: proxySchema.default({ type: 'none' }),
  /** Hops in connection order, nearest first. */
  jumpHostIds: z.array(z.uuid()).max(8).default([]),
  /** Lets RYFT send a one-line shell bootstrap so that command boundaries can be recorded. */
  shellIntegration: z.boolean().default(false)
});

export type HostOptions = z.infer<typeof hostOptionsSchema>;

export const DEFAULT_HOST_OPTIONS: HostOptions = hostOptionsSchema.parse({});
