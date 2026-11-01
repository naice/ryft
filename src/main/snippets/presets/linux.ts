import { identifier, int, POSIX, presetsOf, type Preset } from './define';

const preset = presetsOf('Linux-System', { shells: POSIX, platforms: ['linux'] });
const service = identifier('service', 'Name des Dienstes, zum Beispiel ssh oder nginx');

export const LINUX_PRESETS: Preset[] = [
  preset('linux.uptime', 'Laufzeit und Last', 'Zeigt, wie lange das System läuft, und die durchschnittliche Last.', 'uptime', {
    platforms: ['linux', 'macos'],
    requiredTools: ['uptime'],
    tags: ['last']
  }),
  preset('linux.memory', 'Arbeitsspeicher', 'Belegter und freier Arbeitsspeicher und Swap.', 'free -h', { requiredTools: ['free'], tags: ['ram'] }),
  preset('linux.disk-usage', 'Speicherplatz', 'Belegung aller eingehängten Dateisysteme.', 'df -h', {
    platforms: ['linux', 'macos'],
    requiredTools: ['df'],
    tags: ['disk']
  }),
  preset('linux.disk-inodes', 'Inodes', 'Belegte Inodes je Dateisystem, wenn trotz freiem Platz nichts mehr geschrieben werden kann.', 'df -i', {
    platforms: ['linux', 'macos'],
    requiredTools: ['df'],
    tags: ['disk']
  }),
  preset(
    'linux.top-cpu',
    'Prozesse nach CPU',
    'Die Prozesse mit der höchsten CPU-Last.',
    'ps -eo pid,ppid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -n {{count}}',
    { requiredTools: ['ps', 'head'], params: [int('count', 15, 'Anzahl der Zeilen')], tags: ['prozesse'] }
  ),
  preset(
    'linux.top-memory',
    'Prozesse nach Speicher',
    'Die Prozesse mit dem höchsten Speicherverbrauch.',
    'ps -eo pid,ppid,user,%cpu,%mem,etime,comm --sort=-%mem | head -n {{count}}',
    { requiredTools: ['ps', 'head'], params: [int('count', 15, 'Anzahl der Zeilen')], tags: ['prozesse', 'ram'] }
  ),
  preset('linux.os-release', 'Distribution', 'Name und Version der Linux-Distribution.', 'cat /etc/os-release', { requiredTools: ['cat'] }),
  preset('linux.kernel', 'Kernel', 'Kernel-Version und Architektur.', 'uname -a', { platforms: ['linux', 'macos'], requiredTools: ['uname'] }),
  preset('linux.cpu', 'Prozessor', 'Modell, Kerne und Architektur der CPU.', 'lscpu', { requiredTools: ['lscpu'] }),
  preset('linux.block-devices', 'Datenträger', 'Datenträger und Partitionen mit Größe und Einhängepunkt.', 'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT', {
    requiredTools: ['lsblk'],
    tags: ['disk']
  }),
  preset('linux.failed-services', 'Fehlgeschlagene Dienste', 'Alle systemd-Dienste im Fehlerzustand.', 'systemctl --failed --no-pager', {
    requiredTools: ['systemctl'],
    tags: ['systemd']
  }),
  preset('linux.service-status', 'Dienststatus', 'Zustand und letzte Meldungen eines Dienstes.', 'systemctl status --no-pager {{service}}', {
    requiredTools: ['systemctl'],
    params: [service],
    tags: ['systemd']
  }),
  preset('linux.service-restart', 'Dienst neu starten', 'Startet einen Dienst mit sudo neu. Laufende Verbindungen können abbrechen.', 'sudo systemctl restart {{service}}', {
    requiredTools: ['sudo', 'systemctl'],
    risk: 'caution',
    params: [service],
    tags: ['systemd']
  }),
  preset('linux.service-logs', 'Dienstprotokoll', 'Die letzten Protokollzeilen eines Dienstes.', 'journalctl -u {{service}} -n {{lines}} --no-pager', {
    requiredTools: ['journalctl'],
    params: [service, int('lines', 100, 'Anzahl der Zeilen')],
    tags: ['systemd', 'logs']
  }),
  preset('linux.logged-in', 'Angemeldete Benutzer', 'Wer gerade am System angemeldet ist.', 'who', { platforms: ['linux', 'macos'], requiredTools: ['who'] }),
  preset('linux.last-logins', 'Letzte Anmeldungen', 'Die letzten Anmeldungen am System.', 'last -n {{count}}', {
    platforms: ['linux', 'macos'],
    requiredTools: ['last'],
    params: [int('count', 20, 'Anzahl der Zeilen')]
  }),
  preset('linux.vmstat', 'Systemaktivität', 'Speicher, Swap, Ein-/Ausgabe und CPU im Sekundentakt.', 'vmstat 1 {{count}}', {
    requiredTools: ['vmstat'],
    params: [int('count', 5, 'Anzahl der Messungen', 3600)]
  })
];
