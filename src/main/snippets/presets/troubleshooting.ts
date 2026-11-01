import { identifier, int, port, POSIX, presetsOf, UNIX, url, type Preset } from './define';

const preset = presetsOf('Fehlersuche', { shells: POSIX, platforms: ['linux'] });
const lines = int('lines', 50, 'Anzahl der Zeilen');
const pid = int('pid', null, 'Prozess-ID', 4_194_304);

export const TROUBLESHOOTING_PRESETS: Preset[] = [
  preset('debug.errors-since-boot', 'Fehler seit Systemstart', 'Protokollmeldungen ab Priorität „err“ seit dem letzten Start.', 'journalctl -p err -b -n {{lines}} --no-pager', {
    requiredTools: ['journalctl'],
    params: [lines],
    tags: ['logs']
  }),
  preset('debug.kernel-errors', 'Kernel-Fehler', 'Fehler und Warnungen aus dem Kernel-Puffer, lesbar mit Uhrzeit.', 'sudo dmesg -T --level=err,warn | tail -n {{lines}}', {
    requiredTools: ['sudo', 'dmesg', 'tail'],
    risk: 'caution',
    params: [lines],
    tags: ['kernel']
  }),
  preset(
    'debug.oom',
    'Speichermangel',
    'Ob der Kernel seit dem Start Prozesse wegen Speichermangels beendet hat.',
    "journalctl -k -b --grep 'out of memory|oom-killer' --no-pager -n {{lines}}",
    { requiredTools: ['journalctl'], params: [lines], tags: ['kernel', 'ram'] }
  ),
  preset('debug.who-listens-linux', 'Wer belegt den Port?', 'Welcher Prozess auf einem TCP-Port lauscht.', 'ss -ltnp sport = :{{port}}', {
    requiredTools: ['ss'],
    params: [port('port', null, 'TCP-Port')],
    tags: ['ports']
  }),
  preset('debug.who-listens-macos', 'Wer belegt den Port?', 'Welcher Prozess auf einem TCP-Port lauscht.', 'lsof -nP -iTCP:{{port}} -sTCP:LISTEN', {
    platforms: ['macos'],
    requiredTools: ['lsof'],
    params: [port('port', null, 'TCP-Port')],
    tags: ['ports']
  }),
  preset('debug.find-process', 'Prozess suchen', 'Sucht Prozesse nach einem Teil ihrer Befehlszeile.', 'pgrep -af {{name}}', {
    requiredTools: ['pgrep'],
    params: [identifier('name', 'Teil des Namens oder der Befehlszeile')]
  }),
  preset('debug.open-files', 'Offene Dateien', 'Alle Dateien und Sockets, die ein Prozess geöffnet hat.', 'lsof -p {{pid}}', {
    platforms: UNIX,
    requiredTools: ['lsof'],
    params: [pid]
  }),
  preset('debug.deleted-open', 'Gelöscht, aber offen', 'Gelöschte Dateien, die noch Platz belegen, weil ein Prozess sie offen hält.', 'lsof +L1', {
    platforms: UNIX,
    requiredTools: ['lsof'],
    tags: ['disk']
  }),
  preset('debug.dns-status', 'DNS-Einstellungen', 'Welche DNS-Server systemd-resolved je Schnittstelle nutzt.', 'resolvectl status', { requiredTools: ['resolvectl'], tags: ['dns'] }),
  preset('debug.time-status', 'Uhrzeit und Synchronisation', 'Systemzeit, Zeitzone und ob die Uhr synchronisiert ist.', 'timedatectl status', { requiredTools: ['timedatectl'] }),
  preset('debug.path', 'Suchpfad', 'Die Verzeichnisse in PATH, eines pro Zeile.', 'echo "$PATH" | tr \':\' \'\\n\'', { platforms: ['linux', 'macos', 'windows'], requiredTools: ['tr'] }),
  preset('debug.which', 'Befehl finden', 'Was die Shell für einen Namen ausführen würde.', 'command -v {{name}}', {
    platforms: ['linux', 'macos', 'windows'],
    params: [identifier('name', 'Name des Befehls')]
  }),
  preset('debug.kill', 'Prozess beenden', 'Bittet einen Prozess mit SIGTERM, sich zu beenden.', 'kill {{pid}}', {
    platforms: UNIX,
    risk: 'caution',
    params: [pid]
  }),
  preset('debug.zombies', 'Zombie-Prozesse', 'Beendete Prozesse, die ihr Elternprozess noch nicht abgeholt hat.', "ps -eo pid,ppid,stat,comm | awk '$3 ~ /^Z/'", {
    requiredTools: ['ps', 'awk']
  }),
  preset(
    'debug.http-timing',
    'HTTP-Antwortzeit',
    'Wie lange DNS, Verbindung, TLS und die erste Antwort dauern.',
    'curl -sS -o /dev/null --max-time 30 -w "dns %{time_namelookup}s  connect %{time_connect}s  tls %{time_appconnect}s  first byte %{time_starttransfer}s  total %{time_total}s\\n" {{url}}',
    { platforms: UNIX, requiredTools: ['curl'], params: [url()], tags: ['http'] }
  ),
  preset('debug.disk-io', 'Datenträgerlast', 'Auslastung und Wartezeiten der Datenträger im Sekundentakt.', 'iostat -xz 1 {{count}}', {
    requiredTools: ['iostat'],
    params: [int('count', 5, 'Anzahl der Messungen', 3600)],
    tags: ['disk']
  }),
  preset('debug.reboots', 'Letzte Neustarts', 'Wann das System zuletzt gestartet wurde.', 'last reboot -n {{count}}', {
    requiredTools: ['last'],
    params: [int('count', 10, 'Anzahl der Einträge')]
  })
];
