# RYFT – Benutzerhandbuch

Dieses Handbuch erklärt die Funktionen von RYFT ab Version 1.0. Installation und Tastaturkürzel stehen in der [README](../README.md).

## Hosts und Anmeldung

Lege Hosts über **Hosts → Host hinzufügen** an. Die Anmeldung läuft per Agent, Schlüsseldatei oder Passwort. Wenn mehrere Hosts dieselben Zugangsdaten nutzen, lege unter **Einstellungen** ein Anmeldeprofil an und wähle es im Host aus.

Die erweiterten Optionen im Host-Editor enthalten Timeouts, Keepalive, Verhalten beim Wiederverbinden, Standardordner, Terminaltyp, Kodierung, Umgebungsvariablen, Startbefehle, Proxy und Sprunghosts.

Trage keine Geheimnisse in Umgebungsvariablen ein. Sie stehen unverschlüsselt in der Datenbank.

## Sprunghosts

Wähle im Host-Editor unter den erweiterten Optionen die Hosts aus, über die die Verbindung laufen soll. Die Reihenfolge entspricht dem Weg von deinem Rechner zum Ziel.

- Jeder Host der Kette wird einzeln geprüft. Du bestätigst also für jeden Host seinen eigenen Schlüssel.
- Lehnst du einen Schlüssel ab, bricht RYFT ab und kontaktiert keinen weiteren Host.
- Eine Fehlermeldung nennt den Host, an dem die Kette gescheitert ist.
- Kreise in der Kette werden abgewiesen, bevor eine Verbindung entsteht.
- Terminal, SFTP und Port Forwarding nutzen dieselbe Kette.

## SFTP

Öffne **SFTP** und wähle einen Host. Links steht dein Rechner, rechts der Server. Ziehe Dateien zwischen den Seiten oder nutze die Schaltflächen. Die Warteschlange zeigt den Fortschritt und lässt dich Übertragungen abbrechen und wiederholen. Existiert das Ziel schon, fragt RYFT nach.

Übertragungen landen zuerst in einer `.ryftpart`-Datei und erhalten erst am Ende ihren Namen. Reißt die Verbindung ab, kann auf dem Server eine solche Datei übrig bleiben.

## Port Forwarding

Unter **Port Forwarding** legst du Tunnel als Profile an:

| Typ | Entspricht | Zweck |
| --- | --- | --- |
| Lokal | `ssh -L` | Ein Dienst des Servers erscheint auf deinem Rechner |
| Remote | `ssh -R` | Ein Dienst deines Rechners erscheint auf dem Server |
| Dynamisch | `ssh -D` | SOCKS-Proxy über den Server |

Ein Tunnel, der von außen erreichbar wäre, braucht deine ausdrückliche Zustimmung im Profil. Mit der Option zum Wiederherstellen startet ein Tunnel automatisch mit der App.

## Workspaces

Unter **Workspaces → Aktuelles Layout speichern** sicherst du Tabs, Teilungen, Bereichsgrößen, Hosts und Ordner unter einem Namen. Du kannst Workspaces umbenennen, duplizieren, löschen, überschreiben und einen als Standard festlegen.

Beim Öffnen baut RYFT die Sitzungen neu auf. Ist ein Host nicht erreichbar oder gelöscht, zeigt der betroffene Bereich den Fehler, die übrigen Bereiche laufen weiter.

**Startbefehle** laufen nur, wenn du das in den Einstellungen erlaubst. Ab Werk ist das aus, weil ein gespeicherter Befehl sonst ohne Rückfrage auf einem Server laufen würde.

Der **Export** ist eine JSON-Datei ohne Passwörter und Schlüssel. Den Import prüft RYFT gegen das Format und ersetzt dabei keine vorhandenen Workspaces.

## Snippets

Unter **Snippets** speicherst du Befehle mit Name, Kategorie und Favorit. Parameter schreibst du so:

```
docker logs --tail {{lines:50}} {{container}}
```

`lines` hat den Standardwert 50, `container` musst du ausfüllen. Die Vorschau zeigt den fertigen Befehl.

- **Einfügen** schreibt den Befehl ins aktive Terminal und führt ihn nicht aus.
- **Ausführen** sendet ihn an die Sitzungen, die du auswählst. Bei mehreren Sitzungen zeigt RYFT vorher alle Ziele und den fertigen Befehl.

## Befehlsverlauf und Vorschläge

RYFT merkt sich Befehle, die dir die Shell-Integration meldet. Du findest sie unter **Snippets → Verlauf**, kannst sie dort durchsuchen und einzeln löschen. **Ctrl+Shift+Space** öffnet im Terminal Vorschläge aus Verlauf und Snippets. Die normale Tab-Vervollständigung deiner Shell bleibt unberührt.

| Shell | Stand |
| --- | --- |
| PowerShell, bash (lokal) | Unterstützt und getestet |
| zsh (lokal und per SSH) | Implementiert, aber **nicht getestet**, weil keine zsh zur Verfügung stand |
| bash per SSH | Unterstützt und getestet; pro Host in den erweiterten Optionen einschalten |
| Andere Shells | Kein Verlauf; alles andere funktioniert normal |

Nicht im Verlauf landen:

- Passwortabfragen und Vollbildprogramme wie `vim`
- Befehle mit einem Leerzeichen am Anfang
- Befehle, die wie ein Geheimnis aussehen, zum Beispiel `export API_TOKEN=…`
- alles, was auf deine eigenen Ausschlussregeln passt

Regeln und den Hauptschalter findest du unter **Einstellungen**. Der Verlauf liegt unverschlüsselt in der Datenbank.

## SSH Keys

Unter **SSH Keys** erzeugst du ED25519-Schlüssel oder importierst vorhandene. Für jeden Schlüssel kannst du den öffentlichen Teil kopieren oder exportieren und ihn einem Host zuweisen. Eine Passphrase ist möglich und wird empfohlen.

Der private Schlüssel wird nie angezeigt. Beim Löschen eines importierten Schlüssels entfernt RYFT nur den Verweis, deine Datei bleibt erhalten. Bei einem in RYFT erzeugten Schlüssel kannst du auch die Datei löschen.

**Auf Server installieren** hängt den öffentlichen Schlüssel an `authorized_keys` des gewählten Hosts an, nachdem du das bestätigt hast. Steht er dort schon, ändert sich nichts.

## Lokale Terminals und WSL

**Neue Sitzung** bietet die gefundenen Shells an. Unter Windows zeigt RYFT zusätzlich die WSL-Distributionen mit ihrem Zustand. Standard-Distribution und Startordner stellst du in den Einstellungen ein. Ohne WSL erscheint dieser Bereich nicht.

Eine gestoppte Distribution startet, sobald du ein Terminal in ihr öffnest. Dabei starten auch deren Dienste, zum Beispiel Docker und seine Container mit Neustart-Richtlinie.

## Docker

**Docker** findet die lokale Docker-CLI und, unter Windows, Docker in laufenden WSL-Distributionen. Eine gestoppte Distribution startet RYFT erst, wenn du **Starten und prüfen** bestätigst.

Die Liste zeigt Name, Image, Status, Ports und Laufzeit. Pro Container gibt es Start, Stopp, Neustart, Live-Logs, Details und eine interaktive Shell. Stopp und Neustart fragen vorher nach.

Kontexte mit unverschlüsseltem TCP zu einem anderen Rechner nutzt RYFT nicht und warnt stattdessen. Ein solcher Zugang gibt jedem im Netz die Kontrolle über den Docker-Host.

## KI-Assistent

Der Assistent ist ausgeschaltet, bis du ihn unter **AI Assistant** aktivierst. Er braucht einen lokalen [Ollama](https://ollama.com)-Server mit mindestens einem Modell. Adresse und Modell stehen sichtbar im Panel.

- Erlaubt sind nur Adressen auf diesem Rechner oder im privaten Netz. Bei einer Adresse im privaten Netz verlässt dein Text diesen Rechner.
- Das Modell sieht nur, was du schreibst oder ausdrücklich anhängst, etwa eine Markierung aus dem Terminal. Verlauf, Zugangsdaten und Schlüssel liest es nie.
- Vorschläge laufen nie von selbst. **Einfügen** und **Ausführen** zeigen immer erst den genauen Befehl.
- Text aus dem Terminal kann Anweisungen enthalten, die das Modell täuschen. Prüfe deshalb jeden Vorschlag, bevor du ihn bestätigst.

In den Einstellungen schaltest du den Assistenten vollständig ab.

## Sitzungsprotokolle

Ab Werk zeichnet RYFT nichts auf. Du startest die Aufzeichnung pro Sitzung im Kopf des Terminals; solange sie läuft, ist das dort sichtbar. In den Einstellungen kannst du sie zum Standard machen und festlegen, wie lange und bis zu welcher Größe Protokolle bleiben.

Unter **Sitzungsprotokolle** suchst, exportierst (Text oder JSONL) und löschst du Protokolle.

Bitte beachte diese Grenzen:

- Protokolle enthalten, was die Sitzung ausgibt. RYFT zeichnet keine Tastatureingaben auf, aber was die Gegenseite als Echo anzeigt, steht trotzdem darin. Das kann auch Geheimnisse betreffen.
- Protokolle liegen unverschlüsselt in deinem Datenordner.
- Shells mit Zeileneditor wie PowerShell zeichnen Eingaben beim Tippen neu. Das steht auch im Protokoll, und eine Zeile kann deshalb wie `echo deploy finecho deploy finished` aussehen.

## Broadcast

**Ctrl+Shift+B** öffnet die Auswahl. Wähle mindestens zwei verbundene Sitzungen und starte den Broadcast.

- Eine Warnleiste zeigt Anzahl und Namen der Ziele, die betroffenen Bereiche sind hervorgehoben.
- Tastatureingaben aus einer der gewählten Sitzungen gehen an alle Ziele.
- Das Befehlsfeld in der Leiste sendet erst nach einer Bestätigung.
- **Ctrl+Shift+B** beendet den Broadcast sofort.
- Getrennte Sitzungen fallen heraus, neue kommen nie von selbst dazu.
- Schlägt das Senden an ein Ziel fehl, nennt RYFT es, die übrigen Ziele erhalten den Befehl trotzdem.
