import { expect, test, type Locator, type Page } from '@playwright/test';
import { Channels } from '../src/shared/channels';
import { OllamaFixture } from '../tests/fixtures/ollamaFixture';
import { DEMO_RUNNING, DEMO_STOPPED, stubDocker } from './dockerStub';
import { enableDomRenderer, launchApp, removeProfile, type LaunchedApp, type LooseInvoke } from './launch';

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
const ollama = new OllamaFixture();

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true });
const tabs = (): Locator => page.getByRole('tablist', { name: 'Sitzungen' }).getByRole('tab');
const confirmDialog = (title: string): Locator => page.getByRole('dialog').filter({ hasText: title });

/** Opens one more local terminal, and waits until its shell runs. */
async function openLocalTerminal(): Promise<void> {
  const before = await tabs().count();
  await nav('Local Terminals').click();
  await expect(tabs()).toHaveCount(before + 1);
  await expect(page.getByTestId('pane-status')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(1500);
}

async function textOfTab(index: number): Promise<string> {
  await tabs().nth(index).click();
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-active="true"] .xterm-rows > div');
    // Joined without a separator, because a narrow terminal wraps a marker across two rows.
    return [...rows].filter((row) => (row as HTMLElement).offsetParent !== null).map((row) => row.textContent ?? '').join('');
  });
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

async function focusTerminal(index: number): Promise<void> {
  await tabs().nth(index).click();
  await page.locator('[data-testid="terminal-pane"]:visible .xterm').click();
}

async function closeAllTabs(): Promise<void> {
  while ((await tabs().count()) > 0) {
    await page.getByRole('button', { name: 'Tab schließen' }).first().click();
    const confirm = page.getByRole('dialog');
    if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button').last().click();
    await page.waitForTimeout(100);
  }
}

test.beforeAll(async () => {
  await ollama.listen();
  launched = await launchApp({ width: 1440, height: 900 });
  page = launched.page;
  await enableDomRenderer(page);
});

test.afterAll(async () => {
  await launched?.close().catch(() => undefined);
  if (launched) removeProfile(launched.profile);
  await ollama.close();
});

test('the new tools can be reached by keyboard', async () => {
  await nav('Docker').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('docker-view')).toBeVisible();
  await nav('Sitzungsprotokolle').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('logs-view').getByText('Noch keine Protokolle')).toBeVisible();
});

test('the session chooser offers WSL only where it exists', async () => {
  await nav('Hosts').click();
  const status = await page.evaluate((channel) => (window.ryft.invoke as LooseInvoke)(channel), Channels.wslStatus) as { distros: { name: string }[] };
  await page.getByRole('button', { name: 'Neue Sitzung' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Lokal', { exact: true })).toBeVisible();
  await expect(dialog.getByText('WSL', { exact: true })).toHaveCount(status.distros.length > 0 ? 1 : 0);
  for (const distro of status.distros) await expect(dialog.getByRole('button', { name: distro.name })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Neue Sitzung' })).toBeFocused();
});

test('recording is off until asked for, finds what was shown and can be deleted', async () => {
  await openLocalTerminal();
  await expect(page.getByTestId('pane-rec')).toHaveAttribute('data-recording', 'false');
  await page.getByRole('button', { name: 'Sitzung aufzeichnen' }).click();
  await expect(page.getByTestId('pane-rec')).toHaveAttribute('data-recording', 'true');

  await focusTerminal(0);
  await page.keyboard.type('echo ryft-log-marker\r');
  await expect.poll(async () => count(await textOfTab(0), 'ryft-log-marker'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  await nav('Sitzungsprotokolle').click();
  const row = page.getByTestId('log-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByText('REC')).toBeVisible();
  await expect(row.getByRole('button', { name: /löschen/ })).toBeDisabled();

  await page.getByLabel('Protokolle durchsuchen').fill('RYFT-LOG-MARKER');
  await page.getByRole('button', { name: 'Suchen' }).click();
  await expect(page.getByTestId('log-match').first()).toContainText('ryft-log-marker');
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();

  await nav('Hosts').click();
  await page.getByRole('button', { name: 'Aufzeichnung beenden' }).click();
  await expect(page.getByTestId('pane-rec')).toHaveAttribute('data-recording', 'false');

  await nav('Sitzungsprotokolle').click();
  await expect(row.getByText('REC')).toHaveCount(0);
  await row.getByRole('button', { name: /löschen/ }).click();
  await confirmDialog('Protokoll löschen?').getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByText('Noch keine Protokolle')).toBeVisible();
  await nav('Hosts').click();
});

test('the assistant stays silent until it is turned on', async () => {
  await nav('AI Assistant').click();
  await expect(page.getByTestId('ai-optin')).toBeVisible();
  expect(ollama.requests).toHaveLength(0);

  // The endpoint is set first, so that the real default never receives anything from this test.
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('tab', { name: 'KI-Assistent' }).click();
  const address = page.getByLabel('Ollama-Adresse');
  await address.fill('https://api.example.com');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByText('Nur Adressen auf diesem Rechner')).toBeVisible();
  await address.fill(ollama.url);
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByText('Nur Adressen auf diesem Rechner')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('ai-optin').getByRole('button', { name: 'Einschalten' }).click();
  await expect(page.getByTestId('ai-endpoint')).toContainText(ollama.url);
  await expect(page.getByLabel('KI-Modell').locator('option', { hasText: 'tiny:1' })).toHaveCount(1);
  await page.getByLabel('KI-Modell').selectOption('tiny:1');
});

test('an answer streams, and its command only runs after showing exactly what will run', async () => {
  await page.getByLabel('Frage').fill('Sag etwas');
  await page.getByRole('button', { name: 'Senden' }).click();
  const exchange = page.getByTestId('ai-exchange').last();
  await expect(exchange).toHaveAttribute('data-status', 'done');
  await expect(exchange.getByTestId('ai-answer')).toContainText('Hier der Befehl');
  const card = exchange.getByTestId('ai-command');
  await expect(card).toContainText('echo ryft-from-model');

  // Only the question went out, and none of what the terminal shows.
  const request = ollama.requests.at(-1);
  expect(request?.messages.at(-1)?.content).toBe('Sag etwas');
  expect(JSON.stringify(request)).not.toContain('ryft-log-marker');

  await card.getByRole('button', { name: 'Ausführen…' }).click();
  const confirm = confirmDialog('Vorschlag des Modells ausführen?');
  await expect(confirm).toContainText('echo ryft-from-model');
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  await page.waitForTimeout(500);
  expect(count(await textOfTab(0), 'ryft-from-model')).toBe(0);

  await card.getByRole('button', { name: 'Einfügen…' }).click();
  await confirmDialog('Vorschlag des Modells einfügen?').getByRole('button', { name: 'Einfügen' }).click();
  await expect.poll(async () => count(await textOfTab(0), 'ryft-from-model'), { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(500);
  // Still only on the prompt: running it would have printed it a second time.
  expect(count(await textOfTab(0), 'ryft-from-model')).toBe(1);
  await focusTerminal(0);
  await page.keyboard.press('Control+c');
});

test('text goes to the model only when someone attaches it', async () => {
  await focusTerminal(0);
  await page.keyboard.type('echo ryft-selected-text\r');
  await expect.poll(async () => count(await textOfTab(0), 'ryft-selected-text'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  const before = ollama.requests.length;
  await page.getByRole('button', { name: 'Auswahl anhängen' }).click();
  await expect(page.getByTestId('ai-context')).toHaveCount(0);

  const row = page.locator('[data-testid="terminal-pane"]:visible .xterm-rows > div', { hasText: 'ryft-selected-text' }).first();
  // At screen coordinates, because xterm's own layer above the rows takes the mouse.
  const box = await row.boundingBox();
  await page.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + (box?.height ?? 0) / 2, { clickCount: 3 });
  await page.getByRole('button', { name: 'Auswahl anhängen' }).click();
  await expect(page.getByTestId('ai-context')).toContainText('ryft-selected-text');
  await expect(page.getByTestId('ai-context')).toContainText('Wird mitgeschickt');
  await page.getByLabel('Frage').fill('Erkläre das');
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByTestId('ai-exchange').last()).toHaveAttribute('data-status', 'done');
  expect(ollama.requests).toHaveLength(before + 1);
  expect(ollama.requests.at(-1)?.messages.at(-1)?.content).toContain('ryft-selected-text');
});

test('a running answer can be cancelled, and a broken service is explained', async () => {
  ollama.hang = true;
  await page.getByLabel('Frage').fill('Lange Antwort');
  await page.getByRole('button', { name: 'Senden' }).click();
  const exchange = page.getByTestId('ai-exchange').last();
  await expect(exchange.getByTestId('ai-answer')).toContainText('Denke nach');
  await exchange.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(exchange).toHaveAttribute('data-status', 'cancelled');
  await expect.poll(() => ollama.clientGone).toBe(1);
  ollama.hang = false;

  ollama.errorStatus = 500;
  await page.getByLabel('Frage').fill('Noch einmal');
  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByTestId('ai-exchange').last().getByRole('alert')).toContainText('model not loaded');
  ollama.errorStatus = null;

  await page.getByRole('button', { name: 'AI Assistant einklappen' }).click();
  await expect(page.getByTestId('ai-panel')).toHaveCount(0);
});

test('broadcast reaches the chosen sessions only, after confirmation', async () => {
  await openLocalTerminal();
  await openLocalTerminal();
  expect(await tabs().count()).toBe(3);

  await focusTerminal(0);
  await page.keyboard.press('Control+Shift+B');
  const dialog = page.getByRole('dialog').filter({ hasText: 'Broadcast starten' });
  await expect(dialog).toBeVisible();
  const choices = dialog.getByTestId('broadcast-choices').getByRole('checkbox');
  await expect(choices).toHaveCount(3);
  const start = dialog.getByRole('button', { name: /^Broadcast für/ });
  await expect(start).toBeDisabled();
  await choices.nth(0).check();
  await choices.nth(1).check();
  await start.click();

  const bar = page.getByTestId('broadcast-bar');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('broadcast-targets')).toContainText('2 Sitzungen');
  await tabs().nth(0).click();
  await expect(page.getByTestId('pane-broadcast').locator('visible=true')).toHaveCount(1);
  await tabs().nth(2).click();
  await expect(page.getByTestId('pane-broadcast').locator('visible=true')).toHaveCount(0);

  // Opened after the start, so it must stay out.
  await openLocalTerminal();
  await expect(page.getByTestId('broadcast-targets')).toContainText('2 Sitzungen');

  await bar.getByLabel('Befehl für alle Ziele').fill('echo ryft-broadcast-marker');
  await bar.getByRole('button', { name: 'Senden…' }).click();
  const confirm = confirmDialog('Befehl an 2 Sitzungen senden?');
  await expect(confirm).toContainText('echo ryft-broadcast-marker');
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  await page.waitForTimeout(300);
  expect(count(await textOfTab(0), 'ryft-broadcast-marker')).toBe(0);

  await bar.getByRole('button', { name: 'Senden…' }).click();
  await confirmDialog('Befehl an 2 Sitzungen senden?').getByRole('button', { name: 'Überall ausführen' }).click();
  for (const index of [0, 1]) {
    await expect.poll(async () => count(await textOfTab(index), 'ryft-broadcast-marker'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  }
  for (const index of [2, 3]) expect(count(await textOfTab(index), 'ryft-broadcast-marker')).toBe(0);

  await page.keyboard.press('Control+Shift+B');
  await expect(bar).toHaveCount(0);
});

test('mirroring keys stops at once and ends when too few targets remain', async () => {
  await page.keyboard.press('Control+Shift+B');
  const dialog = page.getByRole('dialog').filter({ hasText: 'Broadcast starten' });
  const choices = dialog.getByTestId('broadcast-choices').getByRole('checkbox');
  await choices.nth(0).check();
  await choices.nth(1).check();
  await dialog.getByLabel('Art').selectOption('keys');
  await expect(dialog.getByText('Auch Passwörter')).toBeVisible();
  await dialog.getByRole('button', { name: /^Broadcast für/ }).click();
  await expect(page.getByTestId('broadcast-bar')).toContainText('Jeder Tastendruck');

  await focusTerminal(0);
  await page.keyboard.type('echo ryft-mirror\r');
  await expect.poll(async () => count(await textOfTab(1), 'ryft-mirror'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(count(await textOfTab(2), 'ryft-mirror')).toBe(0);

  // Typing in a session outside of the selection stays there.
  await focusTerminal(2);
  await page.keyboard.type('echo ryft-outside\r');
  await expect.poll(async () => count(await textOfTab(2), 'ryft-outside'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(count(await textOfTab(0), 'ryft-outside')).toBe(0);

  await focusTerminal(0);
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByTestId('broadcast-bar')).toHaveCount(0);
  await page.keyboard.type('echo ryft-solo\r');
  await expect.poll(async () => count(await textOfTab(0), 'ryft-solo'), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(count(await textOfTab(1), 'ryft-solo')).toBe(0);

  await page.keyboard.press('Control+Shift+B');
  await choices.nth(0).check();
  await choices.nth(1).check();
  await dialog.getByRole('button', { name: /^Broadcast für/ }).click();
  await expect(page.getByTestId('broadcast-bar')).toBeVisible();
  await tabs().nth(1).click();
  await page.keyboard.press('Control+w');
  const close = page.getByRole('dialog');
  if (await close.isVisible().catch(() => false)) await close.getByRole('button').last().click();
  await expect(page.getByTestId('broadcast-bar')).toHaveCount(0);
  await closeAllTabs();
});

test('the Docker view explains, filters and asks before anything is stopped', async () => {
  const actions = await stubDocker(launched.app);
  await nav('Docker').click();
  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  const rows = page.getByTestId('docker-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'demo-web' })).toContainText('0.0.0.0:8080->80/tcp');
  await expect(page.getByRole('alert').filter({ hasText: 'unverschlüsseltes TCP' })).toBeVisible();
  await expect(page.getByLabel('Docker-Kontext').locator('option')).toHaveCount(1);

  await page.getByLabel('Container suchen').fill('nginx');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Container suchen').fill('');
  await page.getByLabel('Nach Status filtern').selectOption('stopped');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Nach Status filtern').selectOption('all');

  await page.getByRole('button', { name: 'demo-web stoppen' }).click();
  const confirm = confirmDialog('„demo-web“ stoppen?');
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  expect(await actions()).toEqual([]);
  await page.getByRole('button', { name: 'demo-web stoppen' }).click();
  await confirm.getByRole('button', { name: 'Stoppen' }).click();
  await expect.poll(actions).toEqual([{ containerId: DEMO_RUNNING, action: 'stop' }]);

  // Starting ends nothing, so it needs no question.
  await page.getByRole('button', { name: 'demo-job starten' }).click();
  await expect.poll(actions).toContainEqual({ containerId: DEMO_STOPPED, action: 'start' });

  await page.getByRole('button', { name: 'Logs von demo-web' }).click();
  await expect(page.getByTestId('docker-log-text')).toContainText('demo log line');
  await page.getByRole('button', { name: 'Logs schließen' }).click();

  await page.getByRole('button', { name: 'Details von demo-web' }).click();
  await expect(page.getByRole('dialog')).toContainText('3 Variablen');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await nav('Hosts').click();
});
