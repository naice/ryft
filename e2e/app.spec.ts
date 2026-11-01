import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { utils } from 'ssh2';
import { SshFixture } from '../tests/fixtures/sshServer';
import { launchApp, removeProfile, enableDomRenderer, type LaunchedApp } from './launch';

/* Generated per run, so that finding it anywhere on disk can only mean that the app wrote it there. */
const PASSWORD = `ryft-e2e-${createHash('sha256').update(String(process.hrtime.bigint())).digest('hex').slice(0, 24)}`;

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
let fixture: SshFixture;
let problems: string[] = [];

function watchForProblems(target: Page): void {
  target.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  target.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
}

async function open(next: LaunchedApp): Promise<void> {
  launched = next;
  page = next.page;
  watchForProblems(page);
  await enableDomRenderer(page);
}

const panes = (): Locator => page.getByTestId('terminal-pane');
const paneWithText = (text: string | RegExp): Locator => panes().filter({ hasText: text });

function fingerprintOf(privateKey: string): string {
  const key = utils.parseKey(privateKey);
  if (key instanceof Error) throw key;
  const parsed = Array.isArray(key) ? key[0]! : key;
  return `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((file) => join(directory, file))
    .filter((file) => statSync(file).isFile());
}

test.beforeAll(async () => {
  fixture = new SshFixture({ password: PASSWORD });
  await fixture.listen();
  await open(await launchApp({ width: 1440, height: 900 }));
});

test.afterAll(async () => {
  const { profile } = launched;
  await launched.close().catch(() => undefined);
  removeProfile(profile);
  await fixture.close();
});

test.afterEach(() => {
  const seen = problems;
  problems = [];
  expect(seen).toEqual([]);
});

test('validates and saves a host through the editor', async () => {
  await page.getByRole('button', { name: 'Host hinzufügen' }).first().click();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Name erforderlich', { exact: true })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('fixture-host');
  await page.getByLabel('Host oder IP').fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
  await page.getByLabel('Benutzer', { exact: true }).fill('demo');
  await page.getByLabel('Anmeldung').selectOption('password');
  await page.getByLabel('Oder neue Gruppe').fill('Fixtures');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('host-row').filter({ hasText: 'fixture-host' })).toBeVisible();
});

test('shows the real fingerprint, then logs in with a password and runs input through the session', async () => {
  await page.getByRole('button', { name: 'fixture-host auswählen, Doppelklick verbindet' }).dblclick();

  await expect(page.getByRole('heading', { name: 'Unbekannter Host-Schlüssel' })).toBeVisible();
  await expect(page.getByTestId('host-key-fingerprint')).toHaveText(fingerprintOf(fixture.hostKey));
  await page.getByRole('button', { name: 'Vertrauen & speichern' }).click();

  await expect(page.getByRole('heading', { name: 'Passwort eingeben' })).toBeVisible();
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
  await page.getByText('Im Schlüsselbund speichern').click();
  await page.getByRole('button', { name: 'Anmelden' }).click();

  const pane = paneWithText('fixture-host');
  await expect(pane.getByText('Verbunden')).toBeVisible({ timeout: 15_000 });
  await expect(pane.locator('.xterm-rows')).toContainText('fixture$');

  await pane.locator('.xterm').click();
  await page.keyboard.type('hello-from-ryft');
  await expect.poll(() => fixture.received).toContain('hello-from-ryft');
  await expect(pane.locator('.xterm-rows')).toContainText('hello-from-ryft');
  expect(fixture.lastPty?.cols).toBeGreaterThan(20);
});

test('resizing the window reaches the remote PTY', async () => {
  const before = fixture.lastWindow?.cols ?? fixture.lastPty?.cols;
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 800));
  await expect.poll(() => fixture.lastWindow?.cols).toBeLessThan(before!);
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
});

test('an ended session reports its exit code, and reconnects without asking again', async () => {
  const pane = paneWithText('fixture-host');
  await page.keyboard.type('exit');
  await expect(pane.getByTestId('pane-status')).toHaveAttribute('data-state', 'closed');
  await expect(pane.getByText('Exit-Code 7')).toBeVisible();

  await pane.getByRole('button', { name: 'Erneut verbinden' }).click();
  await expect(pane.getByText('Verbunden')).toBeVisible({ timeout: 15_000 });
  // Known key and stored secret: neither prompt may come back.
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('reloading the renderer ends its sessions in the main process', async () => {
  await expect.poll(() => fixture.connectionCount).toBeGreaterThan(0);
  await page.reload();
  await page.waitForSelector('[data-testid="app-shell"]');
  await expect.poll(() => fixture.connectionCount).toBe(0);
  await expect(panes().first().getByTestId('pane-status')).toHaveAttribute('data-state', 'disconnected');
});

test('a local shell runs real commands, and splits open and close', async () => {
  await page.getByRole('button', { name: 'Local Terminal' }).click();
  const shell = panes().locator('visible=true').first();
  await expect(shell.getByText('Verbunden')).toBeVisible({ timeout: 15_000 });
  await expect(shell.locator('.xterm-rows')).not.toBeEmpty();

  await shell.locator('.xterm').click();
  // The output differs from the typed text, so only a real shell can produce it.
  const command = process.platform === 'win32' ? 'Write-Output ("ryft" + "-" + (40 + 2))' : 'echo "ryft-$((40 + 2))"';
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect(shell.locator('.xterm-rows')).toContainText('ryft-42', { timeout: 15_000 });

  await page.keyboard.press('Control+Shift+D');
  await expect(page.getByRole('heading', { name: 'Was soll im neuen Bereich laufen?' })).toBeVisible();
  // After the dialog's close button come the local shells, whose names depend on the machine.
  await page.getByRole('dialog').getByRole('button').nth(1).click();
  await expect(panes().locator('visible=true')).toHaveCount(2);
  await expect(panes().locator('visible=true').nth(1).getByText('Verbunden')).toBeVisible({ timeout: 15_000 });

  await panes().locator('visible=true').nth(1).getByRole('button', { name: 'Bereich schließen' }).click();
  await page.getByRole('button', { name: 'Beenden' }).click();
  await expect(panes().locator('visible=true')).toHaveCount(1);
});

test('the palette and keyboard shortcuts work', async () => {
  const tabs = page.getByTestId('session-tab');
  const count = await tabs.count();

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();

  await page.keyboard.press('Control+Shift+T');
  await expect(tabs).toHaveCount(count + 1);
  await expect(tabs.nth(count)).toHaveAttribute('data-active', 'true');

  await page.keyboard.press('Control+Tab');
  await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(tabs.nth(count)).toHaveAttribute('data-active', 'true');

  await page.keyboard.press('Control+Shift+W');
  await page.getByRole('button', { name: 'Beenden' }).click();
  await expect(tabs).toHaveCount(count);
});

test('a dialog blocks shortcuts behind it', async () => {
  const tabs = page.getByTestId('session-tab');
  const count = await tabs.count();
  await page.getByRole('button', { name: 'Host hinzufügen' }).first().click();
  await page.keyboard.press('Control+Shift+T');
  await page.waitForTimeout(150);
  await expect(tabs).toHaveCount(count);
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});

test('after a restart the metadata is back and no secret is anywhere on disk', async () => {
  const { profile } = launched;
  await launched.close();
  const leaks = filesBelow(profile).filter((file) => {
    try {
      return readFileSync(file).includes(PASSWORD);
    } catch {
      return false;
    }
  });
  expect(leaks).toEqual([]);
  // It has to have been written at all, or the check above would prove nothing.
  expect(filesBelow(profile).some((file) => file.endsWith('secrets.vault.json'))).toBe(true);

  await open(await launchApp({ profile, width: 1440, height: 900 }));
  await expect(page.getByTestId('host-row').filter({ hasText: 'fixture-host' })).toBeVisible();
  await expect(page.getByRole('navigation').getByText('Fixtures')).toBeVisible();

  // The restored pane stays disconnected until asked; known key and stored secret then need no prompt.
  const pane = paneWithText('fixture-host').first();
  await expect(pane.getByTestId('pane-status')).toHaveAttribute('data-state', 'disconnected');
  await page.getByRole('button', { name: 'fixture-host auswählen, Doppelklick verbindet' }).dblclick();
  await expect(pane.getByText('Verbunden')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toBeHidden();
  await pane.getByRole('button', { name: 'Bereich schließen' }).click();
  await page.getByRole('button', { name: 'Beenden' }).click();
});

test('a changed host key blocks the connection and offers no way around it', async () => {
  const port = fixture.port;
  await fixture.close();
  fixture = new SshFixture({ password: PASSWORD });
  await fixture.listen(port);

  await page.getByRole('button', { name: 'fixture-host auswählen, Doppelklick verbindet' }).dblclick();
  const status = paneWithText('fixture-host').first().getByTestId('pane-status');
  await expect(status).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  await expect(status).toContainText('Verbindung blockiert');
  await expect(status.getByRole('button', { name: /verbinden/i })).toHaveCount(0);
  expect(fixture.received).toBe('');
});
