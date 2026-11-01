// Stands in for the Docker CLI. Writes every call to FAKE_DOCKER_LOG, so tests can see what RYFT asked for.
const { appendFileSync } = require('node:fs');

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`);

const RUNNING = 'a'.repeat(64);
const STOPPED = 'b'.repeat(64);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (argv[0] === 'context' && argv[1] === 'ls') {
  const rows = [
    { Name: 'default', DockerEndpoint: 'unix:///var/run/docker.sock', Current: true },
    { Name: 'plain', DockerEndpoint: 'tcp://10.0.0.5:2375', Current: false },
    { Name: 'secured', DockerEndpoint: 'tcp://10.0.0.6:2376', Current: false }
  ];
  process.stdout.write(`WARNING: between the rows\n${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  process.exit(0);
}
if (argv[0] === 'context' && argv[1] === 'inspect') {
  process.stdout.write(argv[2] === 'secured' ? '{"docker":{"ca.pem":"x"}}\n' : '{}\n');
  process.exit(0);
}

const [, , command, ...rest] = argv;
const id = rest[rest.length - 1];

switch (command) {
  case 'ps':
    process.stdout.write(
      [
        { ID: RUNNING, Names: 'web', Image: 'nginx:1', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:80->80/tcp', RunningFor: '2 hours ago' },
        { ID: STOPPED, Names: 'job', Image: 'busybox', State: 'exited', Status: 'Exited (0)', Ports: '', RunningFor: '3 days ago' }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    );
    break;
  case 'inspect':
    if (rest.includes('--format')) process.stdout.write(id === RUNNING ? 'true\n' : 'false\n');
    else {
      process.stdout.write(
        JSON.stringify([
          {
            Id: id,
            Name: '/web',
            Created: '2026-01-01T00:00:00Z',
            RestartCount: 1,
            Path: 'nginx',
            Args: ['-g', 'daemon off;'],
            State: { Status: 'running', StartedAt: '2026-01-01T00:00:01Z' },
            Config: { Image: 'nginx:1', WorkingDir: '/', Env: ['DB_PASSWORD=fake-env-secret', 'PATH=/bin'], Labels: { app: 'web' } },
            Mounts: [{ Source: '/data', Destination: '/srv', RW: false }],
            NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' } }, Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }], '443/tcp': null } }
          }
        ])
      );
    }
    break;
  case 'start':
  case 'stop':
  case 'restart':
    if (id !== RUNNING && id !== STOPPED) fail('Error: No such container: ' + id);
    process.stdout.write(`${id}\n`);
    break;
  case 'logs':
    process.stdout.write(`pid=${process.pid}\nfirst line\n`);
    process.stderr.write('from stderr\n');
    setInterval(() => process.stdout.write('tick\n'), 50);
    break;
  case 'exec':
    process.stdout.write('in-container$ ');
    process.stdin.on('data', (data) => process.stdout.write(`seen:${data}`));
    break;
  default:
    fail(`unknown command ${command}`);
}
