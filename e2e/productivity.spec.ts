import { expect, test, type Locator, type Page } from '@playwright/test';
import { enableDomRenderer, launchApp, removeProfile, type LaunchedApp } from './launch';
import { SshFixture } from '../tests/fixtures/sshServer';

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true });

async function openLocalTerminal(): Promise<void> {
  await page.getByRole('button', { name: 'Local Terminal' }).click();
  await expect(page.getByTestId('terminal-pane').first()).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('pane-status')).toHaveCount(0, { timeout: 15_000 });
}

function terminalText(): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-active="true"] .xterm-rows > div');
    return [...rows].map((row) => row.textContent ?? '').join('\n');
  });
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

test('tool views explain themselves while empty', async () => {
  await nav('Workspaces').click();
  await expect(page.getByTestId('workspaces-view').getByText('Noch keine Workspaces')).toBeVisible();
  await nav('Snippets').click();
  await expect(page.getByTestId('snippets-view').getByText('Noch keine Snippets')).toBeVisible();
  await nav('SSH Keys').click();
  await expect(page.getByTestId('keys-view').getByText('Noch keine Schlüssel')).toBeVisible();
});

test('a generated key shows a fingerprint and never its private part', async () => {
  await nav('SSH Keys').click();
  await page.getByRole('button', { name: 'Erzeugen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('e2e-key');
  await dialog.getByLabel('Passphrase', { exact: true }).fill('correct horse');
  await dialog.getByLabel('Passphrase wiederholen').fill('wrong horse');
  await dialog.getByRole('button', { name: 'Erzeugen' }).click();
  await expect(dialog.getByText('stimmen nicht überein')).toBeVisible();
  await dialog.getByLabel('Passphrase wiederholen').fill('correct horse');
  await dialog.getByRole('button', { name: 'Erzeugen' }).click();
  const row = page.getByTestId('key-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('key-fingerprint')).toHaveText(/^SHA256:/);
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE KEY');
});

test('a snippet is searchable, previews its substitution and inserts without running', async () => {
  await openLocalTerminal();
  await nav('Snippets').click();
  await page.getByRole('button', { name: 'Snippet', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill('Docker Logs');
  await editor.getByLabel('Befehl', { exact: true }).fill('docker logs --tail {{lines:50}} {{container}}');
  await editor.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByTestId('snippet-row')).toHaveCount(1);

  await page.getByLabel('Snippets suchen').fill('zzzz');
  await expect(page.getByTestId('snippet-row')).toHaveCount(0);
  await page.getByLabel('Snippets suchen').fill('dklogs');
  await expect(page.getByTestId('snippet-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Docker Logs einfügen oder ausführen' }).click();
  const run = page.getByRole('dialog');
  await expect(run.getByLabel('lines')).toHaveValue('50');
  await expect(run.getByRole('button', { name: 'Einfügen' })).toBeDisabled();
  await run.getByLabel('container').fill('web; echo owned');
  const preview = run.getByTestId('snippet-preview');
  await expect(preview).not.toContainText('--tail 50 web; echo owned');
  await run.getByLabel('container').fill('ryft-marker');
  await expect(preview).toContainText('docker logs --tail 50 ryft-marker');
  await run.getByRole('button', { name: 'Einfügen' }).click();

  await expect.poll(terminalText, { timeout: 10_000 }).toContain('ryft-marker');
  // It stands on the prompt: running it would have printed an error from docker or the shell.
  expect((await terminalText()).split('ryft-marker').length).toBe(2);
  await page.keyboard.press('Control+c');
});

test('running a snippet asks first and shows the exact command', async () => {
  await nav('Snippets').click();
  await page.getByRole('button', { name: 'Docker Logs bearbeiten' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill('Marker');
  await editor.getByLabel('Befehl', { exact: true }).fill('echo ryft-{{word}}-done');
  await editor.getByRole('button', { name: 'Speichern' }).click();

  await page.getByRole('button', { name: 'Marker einfügen oder ausführen' }).click();
  await page.getByRole('dialog').getByLabel('word').fill('ran');
  await page.getByRole('button', { name: 'Ausführen…' }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Befehl ausführen?' });
  await expect(confirm).toContainText('echo ryft-ran-done');
  await confirm.getByRole('button', { name: 'Ausführen', exact: true }).click();
  await expect.poll(async () => (await terminalText()).split('ryft-ran-done').length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
});

test('history records completed commands, offers them and forgets on request', async () => {
  const before = 'ryft-history-marker';
  await page.keyboard.type(`echo ${before}\r`);
  await expect.poll(async () => (await terminalText()).split(before).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  await page.keyboard.press('Control+Shift+Space');
  const popup = page.getByTestId('suggestion-popup');
  await expect(popup).toBeVisible();
  await popup.getByRole('combobox').fill('hstmarker');
  await expect(popup.getByRole('option').first()).toContainText(before);
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);

  await nav('Snippets').click();
  await page.getByRole('tab', { name: 'Verlauf' }).click();
  const row = page.getByTestId('history-row').filter({ hasText: before });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Aus dem Verlauf löschen' }).click();
  await expect(row).toHaveCount(0);
});

test('a saved workspace reopens its layout next to running tabs', async () => {
  await nav('Workspaces').click();
  await page.getByRole('button', { name: 'Aktuelles Layout speichern' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('E2E Layout');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  const row = page.getByTestId('workspace-row').filter({ hasText: 'E2E Layout' });
  await expect(row).toHaveCount(1);

  await page.getByRole('button', { name: 'E2E Layout beim Start öffnen' }).click();
  await expect(row.getByText('Standard')).toBeVisible();

  await page.getByRole('button', { name: 'E2E Layout öffnen', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Sitzungen' }).getByRole('tab')).toHaveCount(2);
  // Opened without connecting: the first tab keeps running, the new one waits for the user.
  await expect(page.getByTestId('pane-status')).toHaveCount(1);
});

test('startup commands wait for approval in the editor', async () => {
  await nav('Workspaces').click();
  await page.getByRole('button', { name: 'E2E Layout bearbeiten' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Ich habe die Startbefehle geprüft')).toHaveCount(0);
  await dialog.getByLabel('Startbefehle').first().fill('echo startup-marker');
  await expect(dialog.getByText('Ich habe die Startbefehle geprüft')).toBeVisible();
  await expect(dialog.getByText('Einstellungen › Verbindungen')).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
});

test('the default workspace comes back disconnected after a restart', async () => {
  launched = await launched.relaunch();
  page = launched.page;
  await expect(page.getByTestId('terminal-pane').first()).toBeVisible();
  await expect(page.getByTestId('pane-status').first()).toBeVisible();
  await expect(page.getByTestId('pane-status').first()).not.toHaveAttribute('data-state', 'connected');
});

test.describe('jump hosts', () => {
  let fixture: SshFixture;

  test.beforeAll(async () => {
    fixture = new SshFixture({ password: 'jump-secret' });
    await fixture.listen();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  async function addHost(name: string, jump?: string): Promise<void> {
    await nav('Hosts').click();
    await page.getByRole('button', { name: 'Host hinzufügen' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Host oder IP').fill('127.0.0.1');
    await dialog.getByLabel('Port').fill(String(fixture.port));
    await dialog.getByLabel('Benutzer').fill('tester');
    await dialog.getByLabel('Anmeldung').selectOption('password');
    if (jump) {
      await dialog.getByRole('button', { name: 'Erweitert' }).click();
      await dialog.locator('#host-jump').selectOption({ label: jump });
    }
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog).toHaveCount(0);
  }

  test('the pane header names the route through the jump host', async () => {
    await addHost('E2E Bastion');
    await addHost('E2E Target', 'E2E Bastion');
    await page.getByText('E2E Target', { exact: true }).first().dblclick();
    const route = page.getByTestId('pane-route').last();
    await expect(route).toContainText('über E2E Bastion', { timeout: 10_000 });
  });
});
