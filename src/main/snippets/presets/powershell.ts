import { choice, EVERYWHERE, host, identifier, int, path, port, presetsOf, text, url, type Preset } from './define';

const preset = presetsOf('PowerShell', { shells: ['powershell'], platforms: ['windows'] });
const count = int('count', 15, 'Anzahl der Zeilen');
const service = identifier('service', 'Name des Dienstes, zum Beispiel Spooler');
const directory = path('path', '.', 'Verzeichnis');
const file = path('path', null, 'Datei');
const anyPath = path('path', null, 'Datei oder Verzeichnis');
const lines = int('lines', 100, 'Anzahl der Zeilen');
const events = int('count', 20, 'Anzahl der Ereignisse');

const GIGABYTES = (property: string, label: string) => `@{n='${label}';e={[math]::Round($_.${property}/1GB,1)}}`;
// The operating system reports memory in KB, so a division by 1MB gives GB.
const MEMORY_GB = (property: string, label: string) => `@{n='${label}';e={[math]::Round($_.${property}/1MB,1)}}`;

export const POWERSHELL_PRESETS: Preset[] = [
  preset('ps.uptime', 'Laufzeit', 'Wie lange Windows seit dem letzten Start läuft.', '(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime'),
  preset(
    'ps.os',
    'Windows-Version',
    'Name, Version und Architektur des Systems.',
    'Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime'
  ),
  preset(
    'ps.top-cpu',
    'Prozesse nach CPU',
    'Die Prozesse mit der meisten bisher verbrauchten CPU-Zeit.',
    'Get-Process | Sort-Object CPU -Descending | Select-Object -First {{count}} Id, ProcessName, CPU, WS',
    { platforms: EVERYWHERE, params: [count], tags: ['prozesse'] }
  ),
  preset(
    'ps.top-memory',
    'Prozesse nach Speicher',
    'Die Prozesse mit dem größten Arbeitsspeicher.',
    'Get-Process | Sort-Object WS -Descending | Select-Object -First {{count}} Id, ProcessName, CPU, WS',
    { platforms: EVERYWHERE, params: [count], tags: ['prozesse', 'ram'] }
  ),
  preset(
    'ps.disks',
    'Speicherplatz',
    'Größe und freier Platz aller lokalen Laufwerke in GB.',
    `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, ${GIGABYTES('Size', 'SizeGB')}, ${GIGABYTES('FreeSpace', 'FreeGB')}`,
    { tags: ['disk'] }
  ),
  preset(
    'ps.memory',
    'Arbeitsspeicher',
    'Gesamter und freier Arbeitsspeicher in GB.',
    `Get-CimInstance Win32_OperatingSystem | Select-Object ${MEMORY_GB('TotalVisibleMemorySize', 'TotalGB')}, ${MEMORY_GB('FreePhysicalMemory', 'FreeGB')}`,
    { tags: ['ram'] }
  ),
  preset('ps.services-running', 'Laufende Dienste', 'Alle gestarteten Dienste.', 'Get-Service | Where-Object Status -eq Running | Sort-Object DisplayName', { tags: ['dienste'] }),
  preset('ps.service-status', 'Dienststatus', 'Zustand eines Dienstes.', 'Get-Service -Name {{service}} | Select-Object Name, DisplayName, Status, StartType', {
    params: [service],
    tags: ['dienste']
  }),
  preset('ps.service-restart', 'Dienst neu starten', 'Startet einen Dienst neu, nach Rückfrage von PowerShell. Braucht meist Administratorrechte.', 'Restart-Service -Name {{service}} -Confirm', {
    risk: 'caution',
    params: [service],
    tags: ['dienste']
  }),
  preset(
    'ps.listening',
    'Offene Ports',
    'Alle lauschenden TCP-Ports mit Prozess-ID.',
    'Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalAddress, LocalPort, OwningProcess',
    { tags: ['ports', 'netzwerk'] }
  ),
  preset(
    'ps.who-listens',
    'Wer belegt den Port?',
    'Welcher Prozess einen lokalen Port benutzt.',
    'Get-NetTCPConnection -LocalPort {{port}} | Select-Object LocalAddress, LocalPort, RemoteAddress, State, OwningProcess',
    { params: [port('port', null, 'Lokaler Port')], tags: ['ports', 'netzwerk'] }
  ),
  preset('ps.port-check', 'Port prüfen', 'Prüft, ob ein TCP-Port erreichbar ist.', 'Test-NetConnection -ComputerName {{host}} -Port {{port}}', {
    params: [host(), port('port', null, 'TCP-Port')],
    tags: ['ports', 'netzwerk']
  }),
  preset('ps.ping', 'Ping', 'Prüft mit einer festen Anzahl Pakete, ob ein Rechner antwortet.', 'Test-Connection -ComputerName {{host}} -Count {{count}}', {
    params: [host(), int('count', 4, 'Anzahl der Pakete', 1000)],
    tags: ['netzwerk']
  }),
  preset('ps.dns', 'DNS-Abfrage', 'Fragt einen DNS-Eintrag ab.', 'Resolve-DnsName -Name {{name}} -Type {{type}}', {
    params: [host('name', 'Der gesuchte Name'), choice('type', 'A', 'Art des Eintrags', ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA'])],
    tags: ['dns', 'netzwerk']
  }),
  preset('ps.ip-config', 'IP-Konfiguration', 'Schnittstellen mit Adressen, Gateway und DNS-Servern.', 'Get-NetIPConfiguration', { tags: ['netzwerk'] }),
  preset('ps.routes', 'Routing-Tabelle', 'Die aktuellen IPv4-Routen.', 'Get-NetRoute -AddressFamily IPv4 | Sort-Object RouteMetric | Select-Object DestinationPrefix, NextHop, RouteMetric, InterfaceAlias', {
    tags: ['netzwerk']
  }),
  preset(
    'ps.http-headers',
    'HTTP-Header',
    'Ruft nur Status und Header einer Adresse ab, mit Zeitlimit.',
    'Invoke-WebRequest -Uri {{url}} -Method Head -UseBasicParsing -TimeoutSec 10 | Select-Object StatusCode, Headers',
    { params: [url()], tags: ['http', 'netzwerk'] }
  ),
  preset(
    'ps.events-system',
    'Systemfehler',
    'Die letzten Fehler aus dem System-Ereignisprotokoll.',
    "Get-WinEvent -FilterHashtable @{LogName='System';Level=2} -MaxEvents {{count}} | Select-Object TimeCreated, Id, ProviderName, Message | Format-List",
    { params: [events], tags: ['logs'] }
  ),
  preset(
    'ps.events-application',
    'Anwendungsfehler',
    'Die letzten Fehler aus dem Anwendungs-Ereignisprotokoll.',
    "Get-WinEvent -FilterHashtable @{LogName='Application';Level=2} -MaxEvents {{count}} | Select-Object TimeCreated, Id, ProviderName, Message | Format-List",
    { params: [events], tags: ['logs'] }
  ),
  preset('ps.hotfixes', 'Installierte Updates', 'Die zuletzt installierten Windows-Updates.', 'Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First {{count}} HotFixID, Description, InstalledOn', {
    params: [count]
  }),
  preset(
    'ps.large-files',
    'Große Dateien',
    'Die größten Dateien unterhalb eines Verzeichnisses in MB.',
    "Get-ChildItem -LiteralPath {{path}} -Recurse -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First {{count}} FullName, @{n='SizeMB';e={[math]::Round($_.Length/1MB,1)}}",
    { platforms: EVERYWHERE, params: [directory, count], tags: ['disk', 'dateien'] }
  ),
  preset(
    'ps.find-name',
    'Dateien nach Namen',
    'Sucht Dateien nach einem Muster unterhalb eines Verzeichnisses.',
    'Get-ChildItem -LiteralPath {{path}} -Recurse -File -Filter {{pattern}} -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime',
    { platforms: EVERYWHERE, params: [directory, text('pattern', 'Muster, zum Beispiel *.log')], tags: ['dateien'] }
  ),
  preset(
    'ps.grep',
    'Text suchen',
    'Sucht wörtlichen Text in allen Dateien unterhalb eines Verzeichnisses.',
    'Get-ChildItem -LiteralPath {{path}} -Recurse -File -ErrorAction SilentlyContinue | Select-String -SimpleMatch -Pattern {{text}}',
    { platforms: EVERYWHERE, params: [directory, text('text', 'Der gesuchte Text')], tags: ['dateien'] }
  ),
  preset('ps.tail', 'Dateiende', 'Die letzten Zeilen einer Datei.', 'Get-Content -LiteralPath {{path}} -Tail {{lines}}', {
    platforms: EVERYWHERE,
    params: [file, lines],
    tags: ['dateien', 'logs']
  }),
  preset('ps.follow', 'Datei verfolgen', 'Zeigt neue Zeilen fortlaufend, bis du abbrichst.', 'Get-Content -LiteralPath {{path}} -Tail {{lines}} -Wait', {
    platforms: EVERYWHERE,
    params: [file, lines],
    tags: ['dateien', 'logs']
  }),
  preset('ps.hash', 'SHA-256-Prüfsumme', 'Berechnet die Prüfsumme einer Datei.', 'Get-FileHash -LiteralPath {{path}} -Algorithm SHA256', {
    platforms: EVERYWHERE,
    params: [file],
    tags: ['dateien']
  }),
  preset('ps.copy', 'Kopieren', 'Kopiert Dateien oder Verzeichnisse, nach Rückfrage von PowerShell.', 'Copy-Item -LiteralPath {{source}} -Destination {{dest}} -Recurse -Confirm', {
    platforms: EVERYWHERE,
    risk: 'caution',
    params: [path('source', null, 'Quelle'), path('dest', null, 'Ziel')],
    tags: ['dateien']
  }),
  preset('ps.move', 'Verschieben', 'Verschiebt oder benennt um, nach Rückfrage von PowerShell.', 'Move-Item -LiteralPath {{source}} -Destination {{dest}} -Confirm', {
    platforms: EVERYWHERE,
    risk: 'caution',
    params: [path('source', null, 'Quelle'), path('dest', null, 'Ziel')],
    tags: ['dateien']
  }),
  preset('ps.remove', 'Löschen', 'Löscht rekursiv, nach Rückfrage von PowerShell. Das lässt sich nicht rückgängig machen.', 'Remove-Item -LiteralPath {{path}} -Recurse -Confirm', {
    platforms: EVERYWHERE,
    risk: 'danger',
    params: [anyPath],
    tags: ['dateien']
  }),
  preset('ps.zip', 'Archiv erstellen', 'Packt Dateien in ein ZIP-Archiv, nach Rückfrage von PowerShell.', 'Compress-Archive -LiteralPath {{path}} -DestinationPath {{archive}} -Confirm', {
    platforms: EVERYWHERE,
    risk: 'caution',
    params: [anyPath, path('archive', null, 'Neue ZIP-Datei')],
    tags: ['dateien', 'archiv']
  }),
  preset('ps.unzip', 'Archiv entpacken', 'Entpackt ein ZIP-Archiv in ein Verzeichnis, nach Rückfrage von PowerShell.', 'Expand-Archive -LiteralPath {{archive}} -DestinationPath {{dest}} -Confirm', {
    platforms: EVERYWHERE,
    risk: 'caution',
    params: [path('archive', null, 'ZIP-Datei'), path('dest', null, 'Zielverzeichnis')],
    tags: ['dateien', 'archiv']
  }),
  preset('ps.which', 'Befehl finden', 'Was PowerShell für einen Namen ausführen würde.', 'Get-Command -Name {{name}} | Select-Object Name, CommandType, Source', {
    platforms: EVERYWHERE,
    params: [identifier('name', 'Name des Befehls')]
  }),
  preset('ps.path', 'Suchpfad', 'Die Verzeichnisse in PATH, eines pro Zeile.', "$env:Path -split ';'"),
  preset('ps.execution-policy', 'Ausführungsrichtlinien', 'Welche Richtlinie in welchem Bereich gilt.', 'Get-ExecutionPolicy -List'),
  preset('ps.version', 'PowerShell-Version', 'Version und Edition dieser PowerShell.', '$PSVersionTable', { platforms: EVERYWHERE }),
  preset('ps.kill', 'Prozess beenden', 'Beendet einen Prozess, nach Rückfrage von PowerShell. Nicht gespeicherte Daten gehen verloren.', 'Stop-Process -Id {{pid}} -Confirm', {
    platforms: EVERYWHERE,
    risk: 'caution',
    params: [int('pid', null, 'Prozess-ID', 4_294_967_295)],
    tags: ['prozesse']
  }),
  preset('ps.scheduled-tasks', 'Geplante Aufgaben', 'Die aktiven geplanten Aufgaben.', 'Get-ScheduledTask | Where-Object State -eq Ready | Select-Object TaskPath, TaskName, State'),
  preset('ps.firewall', 'Firewall-Profile', 'Welche Firewall-Profile aktiv sind.', 'Get-NetFirewallProfile | Select-Object Name, Enabled', { tags: ['netzwerk'] }),
  preset('ps.sshd', 'SSH-Server', 'Ob der OpenSSH-Server installiert ist und läuft.', 'Get-Service -Name sshd | Select-Object Name, Status, StartType', { tags: ['ssh', 'dienste'] }),
  preset('ps.ssh-fingerprint', 'SSH-Fingerabdruck', 'Fingerabdruck des eigenen öffentlichen Ed25519-Schlüssels.', 'ssh-keygen -lf "$HOME\\.ssh\\id_ed25519.pub"', {
    requiredTools: ['ssh-keygen'],
    tags: ['ssh', 'schlüssel']
  })
];
