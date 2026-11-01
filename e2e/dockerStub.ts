import type { ElectronApplication } from '@playwright/test';
import type { DockerContainer, DockerContainerDetails, DockerStatus } from '../src/shared/contracts';
import { Channels, EventChannels } from '../src/shared/channels';

export const DEMO_RUNNING = 'a'.repeat(64);
export const DEMO_STOPPED = 'b'.repeat(64);

const DEMO_LOG = [
  'demo log line',
  '192.0.2.31 - - "GET / HTTP/1.1" 200 615',
  '192.0.2.31 - - "GET /assets/app.css HTTP/1.1" 200 4312',
  '192.0.2.77 - - "GET /health HTTP/1.1" 200 2',
  ''
].join('\n');

const STATUS: DockerStatus = {
  available: true,
  endpoints: [
    { endpoint: { distro: null, context: 'default' }, label: 'default', url: 'unix:///var/run/docker.sock', isCurrent: true, insecure: false },
    { endpoint: { distro: null, context: 'lab' }, label: 'lab', url: 'tcp://192.0.2.50:2375', isCurrent: false, insecure: true }
  ],
  stoppedDistros: [],
  error: null
};

const CONTAINERS: DockerContainer[] = [
  { id: DEMO_RUNNING, name: 'demo-web', image: 'nginx:1.27', state: 'running', status: 'Up 2 hours', ports: '0.0.0.0:8080->80/tcp', runningFor: '2 hours ago' },
  { id: 'c'.repeat(64), name: 'demo-api', image: 'demo/api:3.1', state: 'running', status: 'Up 2 hours', ports: '0.0.0.0:3000->3000/tcp', runningFor: '2 hours ago' },
  { id: 'd'.repeat(64), name: 'demo-db', image: 'postgres:17-alpine', state: 'running', status: 'Up 3 days (healthy)', ports: '5432/tcp', runningFor: '3 days ago' },
  { id: DEMO_STOPPED, name: 'demo-job', image: 'busybox:1.36', state: 'exited', status: 'Exited (0) 5 hours ago', ports: '', runningFor: '6 hours ago' }
];

const DETAILS: DockerContainerDetails = {
  id: DEMO_RUNNING,
  name: 'demo-web',
  image: 'nginx:1.27',
  created: '2026-01-01T08:00:00Z',
  state: 'running',
  startedAt: '2026-01-01T08:00:01Z',
  restartCount: 0,
  command: 'nginx -g daemon off;',
  workingDir: '/',
  environmentCount: 3,
  mounts: [],
  networks: [{ name: 'bridge', ipAddress: '192.0.2.2' }],
  ports: ['0.0.0.0:8080 → 80/tcp'],
  labels: []
};

/**
 * Replaces the Docker channels in the running app with demo data. A developer's machine may have real
 * containers, and neither a test nor a published screenshot should touch or show those. The real
 * adapter is tested in tests/integration/developer.test.ts. Returns the actions the UI asked for.
 */
export async function stubDocker(app: ElectronApplication): Promise<() => Promise<{ containerId: string; action: string }[]>> {
  await app.evaluate(
    ({ ipcMain }, { channels, events, status, containers, details, log }) => {
      const actions: unknown[] = [];
      (globalThis as unknown as { ryftDockerActions: unknown[] }).ryftDockerActions = actions;
      const answers: Record<string, (event: Electron.IpcMainInvokeEvent, input: { containerId: string; action: string; streamId: string }) => unknown> = {
        [channels.dockerStatus]: () => status,
        [channels.dockerList]: () => containers,
        [channels.dockerInspect]: () => details,
        [channels.dockerAction]: (_event, input) => {
          actions.push({ containerId: input.containerId, action: input.action });
        },
        [channels.dockerLogsStart]: (event, input) => {
          event.sender.send(events.dockerLog, { streamId: input.streamId, data: log });
        },
        [channels.dockerLogsStop]: () => undefined
      };
      for (const [channel, answer] of Object.entries(answers)) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, answer);
      }
    },
    { channels: Channels, events: EventChannels, status: STATUS, containers: CONTAINERS, details: DETAILS, log: DEMO_LOG }
  );
  return () => app.evaluate(() => (globalThis as unknown as { ryftDockerActions: { containerId: string; action: string }[] }).ryftDockerActions);
}
