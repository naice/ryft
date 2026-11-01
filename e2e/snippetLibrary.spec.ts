import { expect, test, type Locator, type Page } from '@playwright/test';
import { enableDomRenderer, launchApp, removeProfile, type LaunchedApp } from './launch';

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;

const windows = process.platform === 'win32';
// What the default local shell of each platform offers: one that only reads, one that takes a value, one that destroys.
const READS = windows ? 'ps.service-status' : 'files.tail';
const READS_PARAM = windows ? 'service' : 'path';
const DESTROYS = windows ? 'ps.remove' : 'files.remove';
const FOREIGN = windows ? 'linux.' : 'ps.';

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true });
const tab = (name: string): Locator => page.getByRole('tab', { name, exact: true });
const rows = (): Locator => page.getByTestId('preset-row');
const row = (presetId: string): Locator => page.locator(`[data-testid="preset-row"][data-preset="${presetId}"]`);

function terminalText(): Promise<string> {
  return page.evaluate(() => {
    const lines = document.querySelectorAll('[data-active="true"] .xterm-rows > div');
    return [...lines].map((line) => line.textContent ?? '').join('\n');
  });
}

async function openLibrary(): Promise<void> {
  await nav('Snippets').click();
  await tab('Bibliothek').click();
  await expect(page.getByTestId('preset-browser')).toBeVisible();
}

async function select(presetId: string): Promise<Locator> {
  await page.getByLabel('Bibliothek durchsuchen').fill('');
  const target = row(presetId);
  await target.getByRole('button').nth(1).click();
  await expect(target.getByRole('button').nth(1)).toHaveAttribute('aria-current', 'true');
  return page.getByTestId('preset-detail');
}

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
  await enableDomRenderer(page);
});

test.afterAll(async () => {
  await launched?.close().catch(() => undefined);
  if (launched) removeProfile(launched.profile);
});

test('the library is there on a fresh profile and does not count as personal snippets', async () => {
  await nav('Snippets').click();
  await expect(page.getByTestId('snippets-view').getByText('Noch keine Snippets')).toBeVisible();
  await expect(page.getByTestId('snippets-view').getByText('0 gespeicherte Befehle')).toBeVisible();
  await page.getByRole('button', { name: 'Bibliothek öffnen' }).click();
  await expect(rows().first()).toBeVisible();
  expect(await rows().count()).toBeGreaterThan(100);
});

test('without a terminal, nothing claims to fit', async () => {
  await expect(page.getByTestId('preset-context')).toContainText('bleibt die Eignung unbekannt');
  await expect(page.locator('[data-testid="preset-row"] [data-compat="compatible"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="preset-row"] [data-compat="incompatible"]')).toHaveCount(0);
  await expect(page.getByTestId('preset-hidden')).toHaveCount(0);
});

test('a local terminal is detected and filters what cannot run in it', async () => {
  await page.getByRole('button', { name: 'Local Terminal' }).click();
  await expect(page.getByTestId('terminal-pane').first()).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('pane-status')).toHaveCount(0, { timeout: 15_000 });

  await openLibrary();
  await expect(page.getByTestId('preset-context')).toContainText(windows ? 'Windows · PowerShell' : 'POSIX');
  await expect(page.getByTestId('preset-context')).toContainText('Werkzeugen gefunden', { timeout: 15_000 });

  await expect(page.locator(`[data-testid="preset-row"][data-preset^="${FOREIGN}"]`)).toHaveCount(0);
  await expect(page.getByTestId('preset-hidden')).toBeVisible();
  await expect(page.locator('[data-testid="preset-row"] [data-compat="compatible"]').first()).toBeVisible();

  await page.getByRole('checkbox', { name: 'Nur passende' }).uncheck();
  const foreign = page.locator(`[data-testid="preset-row"][data-preset^="${FOREIGN}"]`).first();
  await expect(foreign.getByTestId('compat-badge')).toHaveAttribute('data-compat', 'incompatible');
  await page.getByRole('checkbox', { name: 'Nur passende' }).check();
});

test('search and categories narrow the list, and the detail shows the command', async () => {
  const all = await rows().count();
  await page.getByRole('group', { name: 'Kategorien' }).getByRole('button', { name: /^Git/ }).click();
  const git = await rows().count();
  expect(git).toBeGreaterThan(0);
  expect(git).toBeLessThan(all);
  await page.getByRole('group', { name: 'Kategorien' }).getByRole('button', { name: /^Alle/ }).click();

  await page.getByLabel('Bibliothek durchsuchen').fill('zzzzqqq');
  await expect(rows()).toHaveCount(0);
  await expect(page.getByTestId('preset-browser').getByText('Keine Treffer')).toBeVisible();

  const detail = await select(READS);
  await expect(detail.getByTestId('preset-command')).toContainText(`{{${READS_PARAM}}}`);
  await expect(detail.getByTestId('risk-badge')).toHaveAttribute('data-risk', 'safe');
});

test('built-in entries offer no way to edit or delete them', async () => {
  await expect(page.getByTestId('preset-browser').getByRole('button', { name: /(?<!Kopie )bearbeiten$/ })).toHaveCount(0);
  await expect(page.getByTestId('preset-browser').getByRole('button', { name: /löschen$/ })).toHaveCount(0);
});

test('a value is checked against its type, and inserting does not run anything', async () => {
  const detail = await select(READS);
  await detail.getByRole('button', { name: 'Einfügen…' }).click();
  const run = page.getByRole('dialog');
  const insert = run.getByRole('button', { name: 'Einfügen', exact: true });
  await expect(insert).toBeDisabled();

  await run.getByLabel(READS_PARAM).fill('-Evil');
  await expect(run.getByText('nicht mit einem Bindestrich beginnen')).toBeVisible();
  await expect(run.getByLabel(READS_PARAM)).toHaveAttribute('aria-invalid', 'true');
  await expect(insert).toBeDisabled();

  await run.getByLabel(READS_PARAM).fill('ryftmarker');
  await expect(run.getByTestId('snippet-preview')).toContainText('ryftmarker');
  await expect(run.getByTestId('snippet-risk')).toHaveAttribute('data-risk', 'safe');
  await insert.click();

  await expect.poll(terminalText, { timeout: 10_000 }).toContain('ryftmarker');
  await page.waitForTimeout(800);
  // It stands on the prompt once. Run, it would have left a second copy in an error message or none at all.
  expect((await terminalText()).split('ryftmarker').length).toBe(2);
  await page.keyboard.press('Control+c');
});

test('a dangerous command needs a tick before it can be confirmed, and can still be called off', async () => {
  await openLibrary();
  const detail = await select(DESTROYS);
  await expect(detail.getByTestId('risk-badge')).toHaveAttribute('data-risk', 'danger');
  await detail.getByRole('button', { name: 'Einfügen…' }).click();
  await page.getByRole('dialog').getByLabel('path').fill('ryft-does-not-exist');
  await expect(page.getByRole('dialog').getByTestId('snippet-risk')).toHaveAttribute('data-risk', 'danger');
  await page.getByRole('button', { name: 'Ausführen…' }).click();

  const confirm = page.getByRole('dialog').filter({ hasText: 'Befehl ausführen?' });
  await expect(confirm).toContainText('ryft-does-not-exist');
  await expect(confirm).toContainText('Gefährlich');
  const go = confirm.getByRole('button', { name: 'Ausführen', exact: true });
  await expect(go).toBeDisabled();
  await confirm.getByRole('checkbox').check();
  await expect(go).toBeEnabled();
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Befehl ausführen?' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a favorite shows up among the own snippets, still read-only', async () => {
  await tab('Bibliothek').click();
  const name = await row(READS).locator('span.font-medium').innerText();
  await row(READS).getByRole('button', { name: `${name} als Favorit markieren` }).click();
  await tab('Snippets').click();
  const favorite = page.getByTestId('snippet-row');
  await expect(favorite).toHaveCount(1);
  await expect(favorite).toContainText('Bibliothek');
  await expect(favorite.getByRole('button', { name: `${name} bearbeiten`, exact: true })).toHaveCount(0);
  await expect(favorite.getByRole('button', { name: `${name} löschen`, exact: true })).toHaveCount(0);
  await expect(page.getByTestId('snippets-view').getByText('0 gespeicherte Befehle')).toBeVisible();
});

test('a copy belongs to the user and keeps the parameter types', async () => {
  await tab('Bibliothek').click();
  const detail = await select(READS);
  const name = await detail.getByRole('heading').innerText();
  await detail.getByRole('button', { name: 'Kopie bearbeiten' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue(`${name} (Kopie)`);
  await expect(editor.getByLabel(`${READS_PARAM}: Typ`)).not.toHaveValue('');
  await editor.getByLabel('Name', { exact: true }).fill('Meine Kopie');
  await editor.getByRole('button', { name: 'Speichern' }).click();
  await expect(editor).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Meine Kopie bearbeiten', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Meine Kopie löschen', exact: true })).toBeVisible();
  await expect(page.getByTestId('snippets-view').getByText('1 gespeicherter Befehl')).toBeVisible();
});

test('a restart imports nothing twice and keeps everything personal', async () => {
  await openLibrary();
  await page.getByRole('checkbox', { name: 'Nur passende' }).uncheck();
  const before = await rows().count();

  launched = await launched.relaunch();
  page = launched.page;
  await openLibrary();
  await page.getByRole('checkbox', { name: 'Nur passende' }).uncheck();
  await expect(rows()).toHaveCount(before);
  await expect(row(READS).getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');

  await tab('Snippets').click();
  await expect(page.getByRole('button', { name: 'Meine Kopie bearbeiten', exact: true })).toBeVisible();
  await expect(page.getByTestId('snippet-row')).toHaveCount(2);
});
