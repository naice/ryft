# RYFT – Release Notes

Dieser Stand ist noch nicht veröffentlicht. Die Details stehen im [Changelog](CHANGELOG.md), die Bedienung im [Benutzerhandbuch](USER_GUIDE.md).

## v1.2 – Developer Edition

- **Docker:** Container ansehen, starten, stoppen und neu starten, Logs live verfolgen und eine Shell im Terminal öffnen.
- **WSL:** Distributionen erkennen und beliebig viele Terminals darin öffnen.
- **KI-Assistent:** Befehle erzeugen, Fehler erklären und Logs analysieren, mit einem lokalen Ollama. Ab Werk aus, und nichts läuft ohne deine Bestätigung.
- **Sitzungsprotokolle:** Pro Sitzung aufzeichnen, durchsuchen und exportieren. Ab Werk aus.
- **Broadcast:** Eingaben an ausgewählte Sitzungen senden, mit dauerhafter Warnung und sofortigem Abschalten.

## v1.1 – Productivity

- **Workspaces:** Tabs, Teilungen und Hosts speichern und wiederherstellen, auch als Export ohne Geheimnisse.
- **Snippets:** Befehle mit Parametern speichern, einfügen oder auf ausgewählten Sitzungen ausführen.
- **Befehlsverlauf und Vorschläge:** Durchsuchbar und abschaltbar, ohne Passwortabfragen.
- **SSH Keys:** ED25519-Schlüssel erzeugen, importieren, Hosts zuweisen und auf Servern eintragen.
- **Sprunghosts:** Verbindungen über mehrere Stationen, mit eigener Host-Key-Prüfung für jede.

## v1.0 – Connectivity & Security

- **SFTP:** Zwei Dateibereiche, Warteschlange, Abbrechen und Wiederholen, auch für große Dateien.
- **Port Forwarding:** Lokal, remote und dynamisch, als Profile.
- **Anmeldeprofile und erweiterte Host-Optionen**, darunter Proxy und Keepalive.
- **Geänderte Host-Keys** lassen sich bewusst ersetzen.

## Bekannte Einschränkungen

- Getestet wurde unter Windows 11. Linux und macOS wurden lokal nicht ausgeführt.
- Der Befehlsverlauf für zsh ist implementiert, aber nicht getestet.
- Sitzungsprotokolle und Befehlsverlauf liegen unverschlüsselt auf der Festplatte. Protokolle können Geheimnisse aus der Ausgabe enthalten.
- Die Programme sind nicht signiert, und automatische Updates gibt es nicht.
- Nach einem Verbindungsabbruch kann auf dem Server eine `.ryftpart`-Datei übrig bleiben.

## Hinweis zum Update

Die Datenbank wird beim ersten Start automatisch erweitert. Vorher legt RYFT eine Kopie als `<Datenbank>.bak-v<Version>` an. Ein Zurück auf eine ältere RYFT-Version ist nur mit dieser Kopie möglich, weil ältere Versionen eine neuere Datenbank ablehnen.
