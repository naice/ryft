import type { DockerContainer, DockerContainerDetails } from '@shared/features/docker';

function jsonLines(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Warnings of the CLI can end up between the rows.
    }
  }
  return rows;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface DockerContextRow {
  name: string;
  url: string;
  isCurrent: boolean;
}

export function parseContexts(output: string): DockerContextRow[] {
  return jsonLines(output)
    .map((row) => ({ name: text(row.Name), url: text(row.DockerEndpoint), isCurrent: row.Current === true || row.Current === 'true' }))
    .filter((row) => row.name !== '');
}

export function parseContainers(output: string): DockerContainer[] {
  return jsonLines(output)
    .map((row) => ({
      id: text(row.ID),
      name: text(row.Names),
      image: text(row.Image),
      state: text(row.State),
      status: text(row.Status),
      ports: text(row.Ports),
      runningFor: text(row.RunningFor)
    }))
    .filter((row) => /^[a-f0-9]{12,64}$/.test(row.id));
}

interface InspectResult {
  Id?: string;
  Name?: string;
  Created?: string;
  RestartCount?: number;
  Path?: string;
  Args?: string[];
  State?: { Status?: string; StartedAt?: string };
  Config?: { Image?: string; WorkingDir?: string; Env?: unknown[]; Labels?: Record<string, string> | null };
  Mounts?: { Source?: string; Name?: string; Destination?: string; RW?: boolean }[];
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }> | null;
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  };
}

/** Picks what the details view shows. Anything else, above all the environment, never leaves main. */
export function summarizeInspect(output: string): DockerContainerDetails | null {
  let parsed: InspectResult | undefined;
  try {
    parsed = (JSON.parse(output) as InspectResult[])[0];
  } catch {
    return null;
  }
  if (!parsed?.Id) return null;
  const startedAt = parsed.State?.StartedAt;
  const ports: string[] = [];
  for (const [port, bindings] of Object.entries(parsed.NetworkSettings?.Ports ?? {})) {
    if (!bindings?.length) ports.push(port);
    for (const binding of bindings ?? []) ports.push(`${binding.HostIp ?? ''}:${binding.HostPort ?? ''} → ${port}`);
  }
  return {
    id: parsed.Id,
    name: (parsed.Name ?? '').replace(/^\//, ''),
    image: parsed.Config?.Image ?? '',
    created: parsed.Created ?? '',
    state: parsed.State?.Status ?? '',
    startedAt: startedAt && !startedAt.startsWith('0001-') ? startedAt : null,
    restartCount: parsed.RestartCount ?? 0,
    command: [parsed.Path ?? '', ...(parsed.Args ?? [])].join(' ').trim(),
    workingDir: parsed.Config?.WorkingDir ?? '',
    environmentCount: parsed.Config?.Env?.length ?? 0,
    mounts: (parsed.Mounts ?? []).map((mount) => ({
      source: mount.Source || mount.Name || '',
      destination: mount.Destination ?? '',
      readOnly: mount.RW === false
    })),
    networks: Object.entries(parsed.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({
      name,
      ipAddress: network.IPAddress ?? ''
    })),
    ports,
    labels: Object.entries(parsed.Config?.Labels ?? {}).map(([key, value]) => ({ key, value }))
  };
}

/** The one line of a CLI failure that helps, in words a person can act on. */
export function explainDockerFailure(stderr: string): string {
  if (/cannot connect to the docker daemon|docker daemon is not running|error during connect/i.test(stderr)) {
    return 'Der Docker-Daemon ist nicht erreichbar. Läuft Docker?';
  }
  if (/permission denied/i.test(stderr)) return 'Keine Berechtigung für den Docker-Daemon.';
  if (/no such container/i.test(stderr)) return 'Diesen Container gibt es nicht mehr.';
  if (/context .* (not found|does not exist)/i.test(stderr)) return 'Diesen Docker-Kontext gibt es nicht mehr.';
  const line = stderr.split(/\r?\n/).find((item) => item.trim() !== '')?.trim();
  return line ? `Docker meldet: ${line.slice(0, 300)}` : 'Der Docker-Befehl ist fehlgeschlagen.';
}
