<p align="center">
  <img src="build/icon.png" alt="RYFT-Logo" width="96" />
</p>

<h1 align="center">RYFT</h1>

<p align="center"><strong>One Terminal. Every System.</strong><br />Desktop-App für SSH-Sitzungen und lokale Terminals.</p>

<p align="center">
  <a href="https://github.com/naice/ryft/actions/workflows/release.yml"><img src="https://github.com/naice/ryft/actions/workflows/release.yml/badge.svg" alt="Release-Status" /></a>
  <img src="https://img.shields.io/badge/Plattform-Windows%20%7C%20macOS%20%7C%20Linux-0b1420" alt="Plattformen: Windows, macOS, Linux" />
  <img src="https://img.shields.io/badge/Electron-45-0b1420?logo=electron" alt="Electron 45" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-0b1420?logo=typescript" alt="TypeScript 5.9" />
  <img src="https://img.shields.io/badge/Lizenz-keine-0b1420" alt="Keine Lizenz" />
</p>

![RYFT-Arbeitsbereich mit Hostliste, Tabs und geteilten Terminal-Bereichen](docs/screenshots/workspace-1440x900.png)

## Inhalt

- [Funktionen](#funktionen)
- [Screenshots](#screenshots)
- [Installation](#installation)
- [Entwicklung](#entwicklung)
- [Tastaturkürzel](#tastaturkürzel)
- [Sicherheitsmodell](#sicherheitsmodell)
- [Fehlerbehebung](#fehlerbehebung)
- [Plattformen](#plattformen)
- [Aufbau](#aufbau)
- [Mitarbeit und Lizenz](#mitarbeit-und-lizenz)

## Funktionen

**Hosts**

- Hosts anlegen, bearbeiten und durchsuchen, mit Gruppen, Tags und Favoriten
- Ansichten für zuletzt verwendete Hosts, Favoriten und Gruppen

**SSH**

- Anmeldung per Agent, Schlüsseldatei (auch mit Passphrase), Passwort und Keyboard-Interactive
- Host-Key-Prüfung mit Fingerprint; ein geänderter Schlüssel blockiert die Verbindung
- Klare Zustände für jede Sitzung, verständliche Fehlermeldungen und erneutes Verbinden

**Lokale Terminals**

- Installierte Shells werden erkannt, auf Windows zum Beispiel PowerShell, Eingabeaufforderung, Git Bash und WSL

**Arbeitsbereich**

- Tabs und frei teilbare Bereiche, deren Layout einen Neustart übersteht
- Befehlspalette und Tastaturkürzel
- Themes und Terminal-Einstellungen, darunter Schrift und Renderer (WebGL oder DOM)

**Noch nicht enthalten:** SFTP, Port Forwarding und KI-Funktionen. Die Einträge sind deaktiviert und als „Coming Soon" markiert.

## Screenshots

| | |
| --- | --- |
| ![Host-Editor mit Anmeldung per Schlüsseldatei](docs/screenshots/host-editor.png) | ![Befehlspalette](docs/screenshots/command-palette.png) |
| **Host-Editor** | **Befehlspalette** |
| ![Terminal-Einstellungen](docs/screenshots/settings.png) | ![Fehlermeldung nach einem abgelehnten Verbindungsversuch](docs/screenshots/connection-error.png) |
| **Einstellungen** | **Verbindungsfehler** |
| ![Leerer Zustand ohne Hosts](docs/screenshots/empty-state.png) | ![Schmales Fenster mit eingeklappter Navigation](docs/screenshots/workspace-1000x680-rail.png) |
| **Erster Start** | **Schmales Fenster** |

Die Bilder stammen aus der echten App und werden mit `npm run screenshots` erzeugt. Die Hostnamen sind Beispiele aus den Dokumentations-Adressbereichen. Der Verbindungsfehler entsteht durch einen echten abgelehnten Verbindungsversuch auf 127.0.0.1.

## Installation

Installer stehen unter [Releases](https://github.com/naice/ryft/releases/latest). Jeder Push auf `main` erzeugt ein neues Release.

| Plattform | Datei |
| --- | --- |
| Windows x64 | `RYFT.Setup.<Version>.exe` |
| macOS Apple Silicon | `RYFT-<Version>-arm64.dmg` |
| Linux x64 | `RYFT-<Version>.AppImage` oder `ryft_<Version>_amd64.deb` |

Die Programme sind nicht signiert, Windows SmartScreen und macOS Gatekeeper warnen also beim ersten Start. Automatische Updates gibt es nicht.

## Entwicklung

Voraussetzung ist Node.js 24 oder neuer. Auf Windows und macOS ist kein C++-Compiler nötig, weil node-pty vorkompiliert mitkommt. Auf Linux kompiliert `npm install` node-pty und braucht dafür Compiler und Python.

```sh
git clone https://github.com/naice/ryft.git
cd ryft
npm install
npm run dev
```

| Befehl | Zweck |
| --- | --- |
| `npm run dev` | Entwicklung mit Hot Reload |
| `npm run build` | Produktions-Build nach `out/` |
| `npm run typecheck` | TypeScript prüfen |
| `npm run lint` | ESLint |
| `npm test` | Unit- und Integrationstests |
| `npm run test:e2e` | Build und E2E-Tests der echten App |
| `npm run screenshots` | Build und Screenshots nach `docs/screenshots/` |
| `npm run check:docs` | Bildverweise der README prüfen |
| `npm run package:dir` | Ungepacktes Programm nach `release/` |
| `npm run package` | Installer für die aktuelle Plattform nach `release/` |

Den Test des gepackten Programms startest du nach `npm run package:dir` mit `npx playwright test --project=packaged`.

Die Tests verwenden nie echte Hosts. `tests/fixtures/sshServer.ts` ist ein SSH-Server im Testprozess auf 127.0.0.1 mit echten Handshakes. Die E2E-Tests laufen mit einem temporären Profil und eigenem `HOME`, damit deine Schlüssel und `known_hosts` außen vor bleiben.

## Tastaturkürzel

Auf macOS steht Cmd anstelle von Ctrl. Ausnahme: Der Tab-Wechsel nutzt überall Ctrl+Tab.

| Kürzel | Aktion |
| --- | --- |
| Ctrl+K oder Ctrl+Shift+P | Befehlspalette |
| Ctrl+T oder Ctrl+Shift+T | Lokales Terminal |
| Ctrl+W oder Ctrl+Shift+W | Tab schließen |
| Ctrl+Shift+D / Ctrl+Shift+E | Rechts / unten teilen |
| Ctrl+Tab / Ctrl+Shift+Tab | Nächster / vorheriger Tab |
| Ctrl+Alt+Pfeiltasten | Bereich wechseln |

**Konflikt mit der Shell:** Ctrl+K, Ctrl+T und Ctrl+W haben in vielen Shells eine eigene Bedeutung. Wenn du sie dort brauchst, schalte unter Einstellungen → Terminal „App-Kürzel im Terminal abfangen" aus. Die Shift-Varianten funktionieren immer.

**Zwischenablage im Terminal:**

- Windows: Ctrl+C kopiert nur bei aktiver Auswahl und sendet sonst SIGINT; Ctrl+V fügt ein.
- Linux: Ctrl+Shift+C und Ctrl+Shift+V.
- macOS: Cmd+C und Cmd+V.

## Sicherheitsmodell

- **Renderer gilt als nicht vertrauenswürdig:** `contextIsolation` an, `nodeIntegration` aus, schmale typisierte Preload-Brücke, Validierung aller IPC-Eingaben mit zod im Hauptprozess und eine strikte CSP.
- **Secrets:** Passwörter und Passphrasen werden nur auf Wunsch gespeichert und mit Electron `safeStorage` verschlüsselt (DPAPI, Keychain, libsecret/kwallet). Bietet Linux keinen echten Schlüsselbund (`basic_text`), speichert RYFT nichts und fragt stattdessen bei jeder Verbindung nach.
- **Schlüssel:** In SQLite steht nur der Pfad zur Schlüsseldatei, nie ihr Inhalt.
- **Host-Keys:** Die Prüfung lässt sich nicht abschalten. `~/.ssh/known_hosts` wird nur gelesen, eigene Vertrauensentscheidungen liegen in der App-Datenbank.
- **Sitzungen:** Sie laufen im Hauptprozess und enden, wenn der Renderer neu lädt oder abstürzt. Beim Start wird nichts automatisch verbunden.

Schwachstellen meldest du wie in [SECURITY.md](SECURITY.md) beschrieben.

## Fehlerbehebung

**`MODULE_NOT_FOUND 'electron'` oder die App startet als reines Node:** Die Umgebungsvariable `ELECTRON_RUN_AS_NODE=1` ist gesetzt, was in VS-Code-Terminals vorkommt. Abhilfe: `unset ELECTRON_RUN_AS_NODE` (PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`).

**„Kein SSH-Agent gefunden":** RYFT nutzt `SSH_AUTH_SOCK`, auf Windows sonst die Pipe von OpenSSH oder Pageant. Der Windows-Dienst `ssh-agent` ist ab Werk oft deaktiviert und muss erst aktiviert und gestartet werden.

**Terminal bleibt leer oder flackert:** Stelle unter Einstellungen → Terminal den Renderer von WebGL auf DOM um.

**`AttachConsole failed` in der Testausgabe:** Diese Meldung stammt von einem Hilfsprozess von node-pty unter Windows, wenn eine Test-Shell beendet wird. Sie beeinflusst das Testergebnis nicht.

## Plattformen

| Plattform | Stand |
| --- | --- |
| Windows 11 x64 | Entwickelt und getestet: Unit-, Integrations- und E2E-Tests, gepacktes Programm |
| macOS Apple Silicon | Nur automatischer Starttest des gepackten Programms in GitHub Actions |
| Linux x64 | Nur automatischer Starttest des gepackten Programms in GitHub Actions |

Auf allen Plattformen läuft SSH bisher nur gegen den Testserver im Testprozess. Gegen einen echten OpenSSH-Server und einen echten System-Agenten wurde RYFT noch nicht getestet.

## Aufbau

```
src/main       Hauptprozess: SQLite, Secrets, SSH, PTY, Sitzungen, IPC
src/preload    Typisierte Brücke zum Renderer
src/renderer   React-Oberfläche
src/shared     Verträge und Zustandsmodell für beide Seiten
tests          Unit-, Integrationstests und SSH-Fixture
e2e            Playwright gegen die echte App
scripts        Pre-Push-Prüfung der Dokumentation
reference      Designkit und visuelle Referenz
docs           Screenshots und Fortschrittslog
```

Designwerte stehen als Tokens in `src/renderer/src/styles/themes.css`. Komponenten enthalten keine Farbwerte, das prüft ein Unit-Test. Einzige Ausnahme ist die Datei `terminalTheme.ts`, weil xterm konkrete Farben braucht.

Gebaut mit Electron, React, TypeScript, Tailwind, xterm.js, ssh2 und node-pty.

## Mitarbeit und Lizenz

Wie du mitarbeitest und warum vor jedem Push README und Screenshots aktuell sein müssen, steht in [CONTRIBUTING.md](CONTRIBUTING.md).

Das Projekt hat keine Lizenz, alle Rechte bleiben vorbehalten. „RYFT" ist ein Arbeitstitel und nicht markenrechtlich geprüft.
