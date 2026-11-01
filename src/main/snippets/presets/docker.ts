import { ALL_SHELLS, EVERYWHERE, identifier, int, presetsOf, type Preset } from './define';

const preset = presetsOf('Docker', { shells: ALL_SHELLS, platforms: EVERYWHERE, requiredTools: ['docker'] });
const container = identifier('container', 'Name oder ID des Containers');
const lines = int('lines', 100, 'Anzahl der Zeilen');
const TABLE = 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}';

export const DOCKER_PRESETS: Preset[] = [
  preset('docker.ps', 'Laufende Container', 'Laufende Container mit Image, Status und Ports.', `docker ps --format "${TABLE}"`),
  preset('docker.ps-all', 'Alle Container', 'Auch die gestoppten Container.', `docker ps -a --format "${TABLE}"`),
  preset('docker.logs', 'Containerprotokoll', 'Die letzten Protokollzeilen eines Containers.', 'docker logs --tail {{lines}} {{container}}', {
    params: [lines, container],
    tags: ['logs']
  }),
  preset('docker.logs-follow', 'Protokoll verfolgen', 'Zeigt neue Protokollzeilen fortlaufend, bis du abbrichst.', 'docker logs -f --tail {{lines}} {{container}}', {
    params: [lines, container],
    tags: ['logs']
  }),
  preset('docker.stats', 'Ressourcen', 'CPU, Speicher und Ein-/Ausgabe aller laufenden Container, einmalig.', 'docker stats --no-stream'),
  preset('docker.images', 'Images', 'Alle lokalen Images.', 'docker images'),
  preset('docker.disk', 'Speicherbelegung', 'Wie viel Platz Images, Container und Volumes belegen.', 'docker system df'),
  preset('docker.inspect', 'Container untersuchen', 'Die vollständige Konfiguration eines Containers als JSON.', 'docker inspect {{container}}', { params: [container] }),
  preset(
    'docker.networks-of',
    'Netzwerke eines Containers',
    'Netzwerke und Adressen eines Containers als JSON.',
    'docker inspect -f "{{json .NetworkSettings.Networks}}" {{container}}',
    { params: [container], tags: ['netzwerk'] }
  ),
  preset('docker.top', 'Prozesse im Container', 'Die Prozesse in einem laufenden Container.', 'docker top {{container}}', { params: [container] }),
  preset('docker.networks', 'Netzwerke', 'Alle Docker-Netzwerke.', 'docker network ls', { tags: ['netzwerk'] }),
  preset('docker.volumes', 'Volumes', 'Alle Docker-Volumes.', 'docker volume ls'),
  preset('docker.shell', 'Shell im Container', 'Öffnet eine interaktive Shell in einem laufenden Container.', 'docker exec -it {{container}} sh', {
    risk: 'caution',
    params: [container]
  }),
  preset('docker.restart', 'Container neu starten', 'Startet einen Container neu. Laufende Verbindungen brechen ab.', 'docker restart {{container}}', {
    risk: 'caution',
    params: [container]
  }),
  preset('docker.stop', 'Container stoppen', 'Stoppt einen laufenden Container.', 'docker stop {{container}}', { risk: 'caution', params: [container] }),
  preset('docker.start', 'Container starten', 'Startet einen gestoppten Container.', 'docker start {{container}}', { risk: 'caution', params: [container] }),
  preset('docker.rm', 'Container löschen', 'Löscht einen gestoppten Container. Daten außerhalb von Volumes gehen verloren.', 'docker rm {{container}}', {
    risk: 'danger',
    params: [container]
  }),
  preset('docker.prune-containers', 'Gestoppte Container löschen', 'Löscht alle gestoppten Container, nach Rückfrage von Docker.', 'docker container prune', { risk: 'danger' }),
  preset('docker.prune-images', 'Ungenutzte Images löschen', 'Löscht Images ohne Namen, nach Rückfrage von Docker.', 'docker image prune', { risk: 'danger' }),
  preset(
    'docker.prune-system',
    'Docker aufräumen',
    'Löscht gestoppte Container, ungenutzte Netzwerke, Images ohne Namen und den Build-Cache, nach Rückfrage von Docker.',
    'docker system prune',
    { risk: 'danger' }
  ),
  preset('docker.compose-ps', 'Compose: Status', 'Die Container des Compose-Projekts im aktuellen Verzeichnis.', 'docker compose ps', { tags: ['compose'] }),
  preset('docker.compose-logs', 'Compose: Protokoll', 'Die letzten Protokollzeilen aller Dienste des Projekts.', 'docker compose logs --tail {{lines}}', {
    params: [lines],
    tags: ['compose', 'logs']
  }),
  preset('docker.compose-up', 'Compose: Starten', 'Startet das Projekt im Hintergrund.', 'docker compose up -d', { risk: 'caution', tags: ['compose'] }),
  preset('docker.compose-pull', 'Compose: Images holen', 'Holt die neuesten Images des Projekts, ohne Container anzufassen.', 'docker compose pull', { risk: 'caution', tags: ['compose'] }),
  preset('docker.compose-down', 'Compose: Beenden', 'Stoppt das Projekt und entfernt seine Container und Netzwerke. Volumes bleiben.', 'docker compose down', {
    risk: 'danger',
    tags: ['compose']
  })
];
