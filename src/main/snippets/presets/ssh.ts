import { ALL_SHELLS, EVERYWHERE, host, int, path, port, POSIX, presetsOf, text, UNIX, user, type Preset } from './define';

const preset = presetsOf('SSH', { shells: ALL_SHELLS, platforms: EVERYWHERE, requiredTools: ['ssh'] });
const sshPort = port('port', 22, 'SSH-Port');

export const SSH_PRESETS: Preset[] = [
  preset('ssh.connect', 'Verbinden', 'Öffnet eine SSH-Sitzung mit Benutzer und Port.', 'ssh -p {{port}} {{user}}@{{host}}', {
    risk: 'caution',
    params: [sshPort, user(), host()]
  }),
  preset('ssh.keygen', 'Schlüssel erzeugen', 'Erzeugt ein neues Ed25519-Schlüsselpaar. Fragt nach Datei und Passphrase.', 'ssh-keygen -t ed25519 -C {{comment}}', {
    requiredTools: ['ssh-keygen'],
    risk: 'caution',
    params: [text('comment', 'Kommentar im Schlüssel, zum Beispiel deine Adresse')],
    tags: ['schlüssel']
  }),
  preset('ssh.fingerprint', 'Fingerabdruck', 'Zeigt den Fingerabdruck einer Schlüsseldatei.', 'ssh-keygen -lf {{path}}', {
    shells: POSIX,
    requiredTools: ['ssh-keygen'],
    params: [path('path', '~/.ssh/id_ed25519.pub', 'Schlüsseldatei')],
    tags: ['schlüssel']
  }),
  preset('ssh.agent-list', 'Geladene Schlüssel', 'Listet die Schlüssel im SSH-Agent auf.', 'ssh-add -l', { requiredTools: ['ssh-add'], tags: ['agent'] }),
  preset('ssh.agent-add', 'Schlüssel laden', 'Lädt einen Schlüssel in den SSH-Agent.', 'ssh-add {{path}}', {
    shells: POSIX,
    requiredTools: ['ssh-add'],
    risk: 'caution',
    params: [path('path', '~/.ssh/id_ed25519', 'Private Schlüsseldatei')],
    tags: ['agent']
  }),
  preset('ssh.copy-id', 'Schlüssel installieren', 'Trägt einen öffentlichen Schlüssel auf dem Zielrechner ein.', 'ssh-copy-id -i {{path}} -p {{port}} {{user}}@{{host}}', {
    shells: POSIX,
    platforms: UNIX,
    requiredTools: ['ssh-copy-id'],
    risk: 'caution',
    params: [path('path', '~/.ssh/id_ed25519.pub', 'Öffentliche Schlüsseldatei'), sshPort, user(), host()],
    tags: ['schlüssel']
  }),
  preset('ssh.forget-host', 'Hostschlüssel vergessen', 'Entfernt einen Rechner aus known_hosts. Nur nutzen, wenn der neue Schlüssel bestätigt ist.', 'ssh-keygen -R {{host}}', {
    requiredTools: ['ssh-keygen'],
    risk: 'caution',
    params: [host()],
    tags: ['known_hosts']
  }),
  preset('ssh.scan-host', 'Hostschlüssel prüfen', 'Holt die Schlüssel eines Rechners und zeigt ihre Fingerabdrücke, ohne etwas zu speichern.', 'ssh-keyscan -p {{port}} {{host}} | ssh-keygen -lf -', {
    shells: POSIX,
    requiredTools: ['ssh-keyscan', 'ssh-keygen'],
    params: [sshPort, host()],
    tags: ['known_hosts']
  }),
  preset(
    'ssh.tunnel-local',
    'Lokaler Tunnel',
    'Leitet einen lokalen Port über den SSH-Rechner an ein Ziel weiter, bis du ihn beendest.',
    'ssh -N -L {{localPort}}:{{destHost}}:{{destPort}} -p {{port}} {{user}}@{{host}}',
    {
      risk: 'caution',
      params: [port('localPort', null, 'Lokaler Port'), host('destHost', 'Ziel, vom SSH-Rechner aus gesehen'), port('destPort', null, 'Port am Ziel'), sshPort, user(), host()],
      tags: ['tunnel']
    }
  ),
  preset('ssh.tunnel-socks', 'SOCKS-Proxy', 'Öffnet einen SOCKS-Proxy auf 127.0.0.1, bis du ihn beendest.', 'ssh -N -D 127.0.0.1:{{localPort}} -p {{port}} {{user}}@{{host}}', {
    risk: 'caution',
    params: [port('localPort', 1080, 'Lokaler Port'), sshPort, user(), host()],
    tags: ['tunnel']
  }),
  preset('ssh.jump', 'Über Sprungrechner', 'Verbindet über einen Zwischenrechner.', 'ssh -J {{jumpUser}}@{{jumpHost}} {{user}}@{{host}}', {
    risk: 'caution',
    params: [user('jumpUser', 'Benutzer auf dem Sprungrechner'), host('jumpHost', 'Sprungrechner'), user(), host()],
    tags: ['tunnel']
  }),
  preset('ssh.effective-config', 'Wirksame Konfiguration', 'Zeigt, welche Einstellungen für einen Rechner gelten, ohne zu verbinden.', 'ssh -G {{host}}', {
    params: [host()],
    tags: ['konfiguration']
  }),
  preset('ssh.list-dir', 'SSH-Verzeichnis', 'Dateien und Rechte in ~/.ssh.', 'ls -la ~/.ssh', { shells: POSIX, requiredTools: ['ls'] }),
  preset(
    'ssh.fix-permissions',
    'Rechte korrigieren',
    'Setzt die Rechte, die der SSH-Server für ~/.ssh und authorized_keys verlangt.',
    'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
    { shells: POSIX, platforms: UNIX, requiredTools: ['chmod'], risk: 'caution' }
  ),
  preset('ssh.check-server-config', 'Serverkonfiguration prüfen', 'Prüft die sshd-Konfiguration auf Fehler, ohne den Dienst anzufassen.', 'sudo sshd -t', {
    shells: POSIX,
    platforms: ['linux'],
    requiredTools: ['sudo', 'sshd'],
    risk: 'caution'
  }),
  preset('ssh.server-logs', 'Serverprotokoll', 'Die letzten Protokollzeilen des SSH-Servers.', 'journalctl -u ssh -u sshd -n {{lines}} --no-pager', {
    shells: POSIX,
    platforms: ['linux'],
    requiredTools: ['journalctl'],
    params: [int('lines', 100, 'Anzahl der Zeilen')],
    tags: ['logs']
  }),
  preset(
    'ssh.failed-logins',
    'Fehlgeschlagene Anmeldungen',
    'Abgewiesene Passwortversuche im Protokoll des SSH-Servers.',
    "journalctl -u ssh -u sshd --grep 'Failed password' -n {{lines}} --no-pager",
    { shells: POSIX, platforms: ['linux'], requiredTools: ['journalctl'], params: [int('lines', 100, 'Anzahl der Zeilen')], tags: ['logs'] }
  )
];
