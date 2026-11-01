import { choice, int, path, POSIX, presetsOf, text, UNIX, type Preset } from './define';

const preset = presetsOf('Dateien', { shells: POSIX, platforms: UNIX });
const directory = path('path', '.', 'Verzeichnis');
const file = path('path', null, 'Datei');
const lines = int('lines', 100, 'Anzahl der Zeilen');
const anyPath = path('path', null, 'Datei oder Verzeichnis');

export const FILE_PRESETS: Preset[] = [
  preset('files.list', 'Verzeichnis anzeigen', 'Alle Dateien mit Rechten und lesbaren Größen.', 'ls -lah -- {{path}}', { requiredTools: ['ls'], params: [directory] }),
  preset('files.find-name', 'Dateien nach Namen', 'Sucht Dateien nach einem Muster, ohne Groß- und Kleinschreibung zu beachten.', 'find {{path}} -type f -iname {{pattern}}', {
    requiredTools: ['find'],
    params: [directory, text('pattern', 'Muster, zum Beispiel *.log')]
  }),
  preset('files.find-large', 'Große Dateien', 'Dateien ab einer Größe, nur auf diesem Dateisystem.', 'find {{path}} -xdev -type f -size +{{sizeMb}}M -ls', {
    requiredTools: ['find'],
    params: [directory, int('sizeMb', 100, 'Mindestgröße in MB', 10_000_000)],
    tags: ['disk']
  }),
  preset('files.find-recent', 'Kürzlich geändert', 'Dateien, die sich in den letzten Minuten geändert haben.', 'find {{path}} -xdev -type f -mmin -{{minutes}}', {
    requiredTools: ['find'],
    params: [directory, int('minutes', 60, 'Zeitraum in Minuten', 10_000_000)]
  }),
  preset('files.grep', 'Text suchen', 'Sucht rekursiv nach Text, ohne Binärdateien und .git.', 'grep -rnI --exclude-dir=.git -e {{pattern}} -- {{path}}', {
    requiredTools: ['grep'],
    params: [text('pattern', 'Der gesuchte Text als regulärer Ausdruck'), directory]
  }),
  preset('files.tail', 'Dateiende', 'Die letzten Zeilen einer Datei.', 'tail -n {{lines}} -- {{path}}', { requiredTools: ['tail'], params: [lines, file], tags: ['logs'] }),
  preset('files.follow', 'Datei verfolgen', 'Zeigt neue Zeilen fortlaufend, bis du abbrichst.', 'tail -n {{lines}} -f -- {{path}}', { requiredTools: ['tail'], params: [lines, file], tags: ['logs'] }),
  preset('files.biggest-dirs', 'Größte Verzeichnisse', 'Die größten Unterverzeichnisse, nur auf diesem Dateisystem.', 'du -xh -d 1 {{path}} | sort -rh | head -n {{count}}', {
    requiredTools: ['du', 'sort', 'head'],
    params: [directory, int('count', 20, 'Anzahl der Zeilen')],
    tags: ['disk']
  }),
  preset('files.tar-list', 'Archiv ansehen', 'Listet den Inhalt eines .tar.gz, ohne etwas zu entpacken.', 'tar -tzf {{archive}}', {
    requiredTools: ['tar'],
    params: [path('archive', null, 'Archivdatei')],
    tags: ['archiv']
  }),
  preset('files.tar-create', 'Archiv erstellen', 'Packt eine Datei oder ein Verzeichnis in ein .tar.gz. Ein vorhandenes Archiv wird ersetzt.', 'tar -czf {{archive}} {{path}}', {
    requiredTools: ['tar'],
    risk: 'caution',
    params: [path('archive', null, 'Neue Archivdatei'), anyPath],
    tags: ['archiv']
  }),
  preset('files.tar-extract', 'Archiv entpacken', 'Entpackt ein .tar.gz in ein Verzeichnis. Vorhandene Dateien werden überschrieben.', 'tar -xzf {{archive}} -C {{dest}}', {
    requiredTools: ['tar'],
    risk: 'caution',
    params: [path('archive', null, 'Archivdatei'), path('dest', '.', 'Zielverzeichnis')],
    tags: ['archiv']
  }),
  preset('files.rsync-preview', 'Synchronisieren (Vorschau)', 'Zeigt, was rsync übertragen würde, ohne etwas zu ändern.', 'rsync -avhn {{source}} {{dest}}', {
    requiredTools: ['rsync'],
    params: [path('source', null, 'Quelle'), path('dest', null, 'Ziel')]
  }),
  preset('files.rsync', 'Synchronisieren', 'Überträgt Dateien und überschreibt ältere am Ziel. Nichts wird am Ziel gelöscht.', 'rsync -avh --progress {{source}} {{dest}}', {
    requiredTools: ['rsync'],
    risk: 'caution',
    params: [path('source', null, 'Quelle'), path('dest', null, 'Ziel')]
  }),
  preset('files.copy', 'Kopieren', 'Kopiert mit Rechten und Zeitstempeln und fragt vor dem Überschreiben.', 'cp -aiv -- {{source}} {{dest}}', {
    requiredTools: ['cp'],
    risk: 'caution',
    params: [path('source', null, 'Quelle'), path('dest', null, 'Ziel')]
  }),
  preset('files.move', 'Verschieben', 'Verschiebt oder benennt um und fragt vor dem Überschreiben.', 'mv -iv -- {{source}} {{dest}}', {
    requiredTools: ['mv'],
    risk: 'caution',
    params: [path('source', null, 'Quelle'), path('dest', null, 'Ziel')]
  }),
  preset('files.remove', 'Löschen', 'Löscht rekursiv und fragt bei jeder Datei nach. Das lässt sich nicht rückgängig machen.', 'rm -ri -- {{path}}', {
    requiredTools: ['rm'],
    risk: 'danger',
    params: [anyPath]
  }),
  preset('files.chmod', 'Rechte setzen', 'Setzt die Zugriffsrechte einer Datei.', 'chmod -- {{mode}} {{path}}', {
    requiredTools: ['chmod'],
    risk: 'caution',
    params: [choice('mode', '644', 'Neue Rechte', ['600', '640', '644', '700', '750', '755']), anyPath]
  }),
  preset('files.sha256-linux', 'SHA-256-Prüfsumme', 'Berechnet die Prüfsumme einer Datei.', 'sha256sum -- {{path}}', {
    platforms: ['linux'],
    requiredTools: ['sha256sum'],
    params: [file]
  }),
  preset('files.sha256-macos', 'SHA-256-Prüfsumme', 'Berechnet die Prüfsumme einer Datei.', 'shasum -a 256 -- {{path}}', {
    platforms: ['macos'],
    requiredTools: ['shasum'],
    params: [file]
  }),
  preset('files.stat', 'Dateidetails', 'Größe, Rechte, Eigentümer und Zeitstempel.', 'stat -- {{path}}', { requiredTools: ['stat'], params: [anyPath] }),
  preset('files.type', 'Dateityp', 'Erkennt den Typ einer Datei an ihrem Inhalt.', 'file -- {{path}}', { requiredTools: ['file'], params: [file] }),
  preset('files.count-lines', 'Zeilen zählen', 'Anzahl der Zeilen einer Datei.', 'wc -l -- {{path}}', { requiredTools: ['wc'], params: [file] }),
  preset('files.mkdir', 'Verzeichnis anlegen', 'Legt ein Verzeichnis samt fehlender Elternverzeichnisse an.', 'mkdir -p -- {{path}}', {
    requiredTools: ['mkdir'],
    risk: 'caution',
    params: [path('path', null, 'Neues Verzeichnis')]
  }),
  preset('files.broken-links', 'Defekte Links', 'Symbolische Links, deren Ziel nicht mehr existiert.', 'find {{path}} -xtype l', {
    platforms: ['linux'],
    requiredTools: ['find'],
    params: [directory]
  })
];
