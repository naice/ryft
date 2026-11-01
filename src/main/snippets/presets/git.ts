import { ALL_SHELLS, EVERYWHERE, identifier, int, path, presetsOf, text, type Preset } from './define';

const preset = presetsOf('Git', { shells: ALL_SHELLS, platforms: EVERYWHERE, requiredTools: ['git'] });
const count = int('count', 20, 'Anzahl der Einträge');
const file = path('path', null, 'Datei oder Verzeichnis');
const branch = identifier('branch', 'Name des Branches');
const rev = identifier('rev', 'Commit, Tag oder Branch', 'HEAD');

export const GIT_PRESETS: Preset[] = [
  preset('git.status', 'Status', 'Kurzer Stand des Arbeitsverzeichnisses mit Branch.', 'git status --short --branch'),
  preset('git.log', 'Verlauf', 'Die letzten Commits als Graph.', 'git log --oneline --graph --decorate -n {{count}}', { params: [count] }),
  preset('git.branches', 'Branches', 'Lokale Branches mit Upstream und letztem Commit.', 'git branch -vv'),
  preset('git.remotes', 'Remotes', 'Die eingetragenen Remotes mit Adressen.', 'git remote -v'),
  preset('git.diff-stat', 'Änderungen (Übersicht)', 'Geänderte Dateien mit Anzahl der Zeilen.', 'git diff --stat'),
  preset('git.diff-staged', 'Vorgemerkte Änderungen', 'Was der nächste Commit enthalten würde.', 'git diff --staged'),
  preset('git.show', 'Commit ansehen', 'Metadaten und geänderte Dateien eines Commits.', 'git show --stat {{rev}}', { params: [rev] }),
  preset('git.blame', 'Zeilenherkunft', 'Wer welche Zeile einer Datei zuletzt geändert hat.', 'git blame -- {{path}}', { params: [file] }),
  preset('git.file-history', 'Dateiverlauf', 'Alle Commits einer Datei, auch über Umbenennungen hinweg.', 'git log --follow --oneline -- {{path}}', { params: [file] }),
  preset('git.stash-list', 'Stash-Liste', 'Alle zurückgelegten Änderungen.', 'git stash list'),
  preset('git.tags', 'Tags', 'Alle Tags des Repositorys.', 'git tag'),
  preset('git.authors', 'Autoren', 'Commits je Autor über alle Branches.', 'git shortlog -sn --all'),
  preset('git.reflog', 'Reflog', 'Wo HEAD zuletzt stand. Hilft, Verlorenes wiederzufinden.', 'git reflog -n {{count}}', { params: [count] }),
  preset('git.clean-preview', 'Aufräumen (Vorschau)', 'Zeigt, was „git clean“ löschen würde, ohne etwas zu löschen.', 'git clean -nd'),
  preset('git.fetch', 'Holen', 'Holt alle Remotes und entfernt gelöschte Remote-Branches lokal.', 'git fetch --all --prune', { risk: 'caution' }),
  preset('git.pull-ff', 'Aktualisieren', 'Zieht Änderungen nur, wenn kein Merge nötig ist.', 'git pull --ff-only', { risk: 'caution' }),
  preset('git.switch', 'Branch wechseln', 'Wechselt zu einem vorhandenen Branch.', 'git switch {{branch}}', { risk: 'caution', params: [branch] }),
  preset('git.switch-create', 'Branch anlegen', 'Legt einen neuen Branch an und wechselt zu ihm.', 'git switch -c {{branch}}', { risk: 'caution', params: [branch] }),
  preset('git.stash-push', 'Änderungen zurücklegen', 'Legt die Änderungen mit einer Notiz in den Stash.', 'git stash push -m {{message}}', {
    risk: 'caution',
    params: [text('message', 'Notiz zum Stash')]
  }),
  preset('git.undo-commit', 'Letzten Commit zurücknehmen', 'Nimmt den letzten Commit zurück, die Änderungen bleiben vorgemerkt.', 'git reset --soft HEAD~1', { risk: 'caution' }),
  preset('git.unstage', 'Vormerkung aufheben', 'Nimmt eine Datei aus dem nächsten Commit, die Änderung bleibt.', 'git restore --staged -- {{path}}', { risk: 'caution', params: [file] }),
  preset('git.push-upstream', 'Branch hochladen', 'Lädt den aktuellen Branch hoch und setzt den Upstream.', 'git push -u origin HEAD', { risk: 'caution' }),
  preset('git.branch-delete', 'Branch löschen', 'Löscht einen lokalen Branch, aber nur, wenn er zusammengeführt ist.', 'git branch -d {{branch}}', { risk: 'caution', params: [branch] }),
  preset('git.discard-file', 'Änderungen verwerfen', 'Verwirft nicht vorgemerkte Änderungen einer Datei. Das lässt sich nicht rückgängig machen.', 'git restore -- {{path}}', {
    risk: 'danger',
    params: [file]
  }),
  preset('git.clean', 'Unversioniertes löschen', 'Löscht unversionierte Dateien und Verzeichnisse endgültig. Zuerst die Vorschau ansehen.', 'git clean -fd', { risk: 'danger' }),
  preset('git.reset-hard', 'Hart zurücksetzen', 'Setzt Branch und Arbeitsverzeichnis zurück. Nicht committete Änderungen gehen verloren.', 'git reset --hard {{rev}}', {
    risk: 'danger',
    params: [rev]
  })
];
