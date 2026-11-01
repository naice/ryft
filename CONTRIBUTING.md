# Mitarbeit

## Einrichtung

```sh
npm install
npm run dev
```

`npm install` richtet auch den Pre-Push-Hook ein (`core.hooksPath` zeigt auf `.githooks`).

## README und Screenshots vor jedem Push

Die README beschreibt immer den Stand, der gepusht wird. Der Hook `scripts/check-docs.mjs` setzt das durch:

1. Ändert ein Push `src/`, `resources/` oder `package.json`, muss er auch `README.md` und `docs/screenshots/` ändern, und zwar im selben oder einem neueren Commit.
2. Fehlen die Screenshots, erzeugt der Hook sie mit `npm run screenshots` neu. Sind neue Bilder entstanden, bricht er den Push ab, damit du sie prüfen und committen kannst. Bleiben sie unverändert, sind sie aktuell.
3. Bilder, auf die die README verweist, müssen existieren.

Der Ablauf bei einer Änderung an der App:

```sh
npm run screenshots
# README.md anpassen: neue Funktionen beschreiben, Screenshots einbinden
git add README.md docs/screenshots
git commit -m "docs: README und Screenshots aktualisieren"
git push
```

Die Prüfung erkennt, ob die Dateien geändert wurden, nicht ob der Text stimmt. Dafür bleibst du selbst verantwortlich.

## Vor dem Commit

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

Tests verwenden nie echte Hosts, Zugangsdaten oder deine `known_hosts`.

## Release

Jeder Push auf `main` veröffentlicht ein Release, wenn alle Tests bestehen. Die Version setzt sich aus Major und Minor in `package.json` und der Laufnummer des Workflows zusammen, zum Beispiel `v0.1.42`. Für einen neuen Versionssprung änderst du `package.json`. Mit `[skip ci]` in der Commit-Nachricht entfällt der Lauf.
