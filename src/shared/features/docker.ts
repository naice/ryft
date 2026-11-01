import { z } from 'zod';
import { distroNameSchema } from './wsl';

/** Where a Docker CLI runs: here, or inside a WSL distribution, and with which of its contexts. */
export const dockerEndpointSchema = z.strictObject({
  distro: distroNameSchema.nullable(),
  context: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/)
});
export type DockerEndpoint = z.infer<typeof dockerEndpointSchema>;

export const containerIdSchema = z.string().regex(/^[a-f0-9]{12,64}$/);
export const DOCKER_ACTIONS = ['start', 'stop', 'restart'] as const;
export type DockerAction = (typeof DOCKER_ACTIONS)[number];

export const dockerSchemas = {
  probe: z.strictObject({ distro: distroNameSchema }),
  list: z.strictObject({ endpoint: dockerEndpointSchema }),
  inspect: z.strictObject({ endpoint: dockerEndpointSchema, containerId: containerIdSchema }),
  action: z.strictObject({ endpoint: dockerEndpointSchema, containerId: containerIdSchema, action: z.enum(DOCKER_ACTIONS) }),
  logsStart: z.strictObject({
    streamId: z.uuid(),
    endpoint: dockerEndpointSchema,
    containerId: containerIdSchema,
    tail: z.number().int().min(0).max(10_000)
  }),
  logsStop: z.strictObject({ streamId: z.uuid() })
};

export interface DockerEndpointInfo {
  endpoint: DockerEndpoint;
  label: string;
  /** Where the context points, as Docker reports it. */
  url: string;
  isCurrent: boolean;
  /** A plain TCP connection to another machine. RYFT does not use it. */
  insecure: boolean;
}

export interface DockerStatus {
  /** Whether a CLI was found here or in a running distribution. */
  available: boolean;
  endpoints: DockerEndpointInfo[];
  /** Asking these would boot them, along with whatever starts inside, so that takes a click. */
  stoppedDistros: string[];
  error: string | null;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  runningFor: string;
}

/** Deliberately without the environment, which is where containers keep their secrets. */
export interface DockerContainerDetails {
  id: string;
  name: string;
  image: string;
  created: string;
  state: string;
  startedAt: string | null;
  restartCount: number;
  command: string;
  workingDir: string;
  environmentCount: number;
  mounts: { source: string; destination: string; readOnly: boolean }[];
  networks: { name: string; ipAddress: string }[];
  ports: string[];
  labels: { key: string; value: string }[];
}

export interface DockerLogEvent {
  streamId: string;
  data: string;
}

export interface DockerLogEndEvent {
  streamId: string;
  error: string | null;
}

/** Whether a context would talk to another machine without encryption or authentication. */
export function isInsecureDockerUrl(url: string, hasTls: boolean): boolean {
  const match = /^(tcp|http):\/\/\[?([^\]/:]+)/i.exec(url);
  if (!match || hasTls) return false;
  const host = (match[2] as string).toLowerCase();
  return !(host === 'localhost' || host === '::1' || host.startsWith('127.'));
}
