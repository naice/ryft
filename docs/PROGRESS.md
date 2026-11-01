# Fortschrittslog

Stand: 2026-11-01, MVP abgeschlossen auf Windows 11 x64.

## Abgeschlossen

1. **Grundgerüst:** Electron, electron-vite, React, Tailwind, Tokens, CSP.
2. **Speicher und Sicherheit:** SQLite (`node:sqlite`), Secret-Vault über `safeStorage`, Host-Key-Store, `known_hosts` nur lesend, IPC-Validierung.
3. **Sitzungen:** SSH (Agent, Schlüssel, Passwort, Keyboard-Interactive, Reconnect), lokale PTYs, Zustandsmodell.
4. **Oberfläche:** Navigation, Hostliste, Editor, Tabs, Splits, Palette, Einstellungen, Dialoge.
5. **Visueller Abgleich:** Screenshots in `screenshots/`. `screenshots/comparison-1440x900.png` ist eine einmalige Gegenüberstellung mit der Referenz und wird von `npm run screenshots` nicht aktualisiert.
6. **Tests:** Unit, Integration gegen die SSH-Fixture, E2E gegen die echte App, Test des gepackten Programms.
7. **Packaging:** Windows-Installer (NSIS, unsigniert).

## Entscheidungen

- **`node:sqlite` statt better-sqlite3:** Auf dem Entwicklungsrechner gibt es keinen C++-Compiler.
- **Farben:** Flächenfarben sind aus dem Referenzbild gemessen und weichen von den Kit-Tokens ab, weil diese sichtbar zu hell wirkten. Werte, die die Spezifikation ausdrücklich nennt, bleiben unverändert: Terminal `#030911`, ANSI-Farben, Akzente und Maße. Der Override-Block in `src/renderer/src/styles/themes.css` lässt sich löschen, um zu den Kit-Werten zurückzukehren.
- **Sortierung:** Favoriten stehen innerhalb einer Gruppe oben, wie in der Referenz. Sonst gilt die Namensreihenfolge.
- **Fonts:** `assetsInlineLimit: 0`, weil die CSP eingebettete `data:`-Fonts absichtlich blockiert.

## Bewusst nicht umgesetzt

- SFTP, Port Forwarding und KI (Coming Soon)
- Kontozeile unten in der Navigation: Es gibt keine Konten, sie wäre also erfunden.

## Offen

- macOS und Linux werden nur vom automatischen Starttest im Release-Workflow abgedeckt.
- Gegen einen echten OpenSSH-Server und einen echten System-Agenten wurde nicht getestet.
- Code-Signing für die Verteilung fehlt.
- Der E2E-Test „after a restart ...“ schlägt sporadisch fehl (lokal 6 von 88 Läufen, danach 0 von 60, gehäuft in Schüben): `safeStorage.decryptString` wirft nach dem Neustart. `Local State` mit dem Betriebssystem-Schlüssel entsteht erst beim Beenden der ersten Sitzung, ein verlorener Schreibvorgang ist also der wahrscheinlichste, aber unbewiesene Grund. Die App fragt dann erneut nach dem Passwort. Scheitert deshalb der Verify-Job, lässt sich der Lauf neu starten.
