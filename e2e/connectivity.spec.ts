import { createConnection, createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SshFixture } from '../tests/fixtures/sshServer';
import { Channels } from '../src/shared/channels';
import { launchApp, removeProfile, type LaunchedApp, type LooseInvoke } from './launch';

const PASSWORD = `ryft-e2e-${process.hrtime.bigint().toString(36)}`;

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
let fixture: SshFixture;
let sftpRoot: string;
let home: string;
let problems: string[] = [];

const nav = (): Locator => page.getByRole('navigation', { name: 'Hauptnavigation' });
const remote = (): Locator => page.getByTestId('sftp-pane-remote');
const local = (): Locator => page.getByTestId('sftp-pane-local');
const entry = (pane: Locator, name: string): Locator => pane.getByTestId('sftp-entry').filter({ hasText: name });
const job = (name: string): Locator => page.getByTestId('transfer-job').filter({ hasText: name });

const contentsOf = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);

async function answerConnectPrompts(): Promise<void> {
  const trust = page.getByRole('button', { name: 'Vertrauen & speichern' });
  const password = page.getByRole('button', { name: 'Anmelden' });
  await expect(trust.or(password).first()).toBeVisible({ timeout: 15_000 });
  if (await trust.isVisible()) {
    await trust.click();
    await expect(password).toBeVisible({ timeout: 15_000 });
  }
  await page.getByRole('textbox', { name: 'Passwort' }).fill(PASSWORD);
  await page.getByLabel('Im Schlüsselbund speichern').check();
  await password.click();
}

test.beforeAll(async () => {
  sftpRoot = mkdtempSync(join(tmpdir(), 'ryft-e2e-sftp-'));
  writeFileSync(join(sftpRoot, 'from-server.txt'), 'hello from the server');
  mkdirSync(join(sftpRoot, 'folder'));
  writeFileSync(join(sftpRoot, 'folder', 'nested.txt'), 'nested');
  fixture = new SshFixture({ password: PASSWORD, sftpRoot });
  await fixture.listen();

  launched = await launchApp({ width: 1440, height: 900 });
  page = launched.page;
  home = launched.profile;
  writeFileSync(join(home, 'from-client.txt'), 'hello from the client');
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });

  await page.getByRole('button', { name: 'Host hinzufügen' }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('sftp-host');
  await page.getByLabel('Host oder IP').fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill(String(fixture.port));
  await page.getByLabel('Benutzer', { exact: true }).fill('demo');
  await page.getByLabel('Anmeldung').selectOption('password');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test.afterAll(async () => {
  await launched.close().catch(() => undefined);
  removeProfile(home);
  await fixture.close();
  rmSync(sftpRoot, { recursive: true, force: true });
});

test.afterEach(() => {
  const seen = problems;
  problems = [];
  expect(seen).toEqual([]);
});

test('SFTP shows both sides after trusting the key and logging in', async () => {
  await nav().getByRole('button', { name: 'SFTP' }).click();
  await expect(page.getByTestId('sftp-view')).toBeVisible();
  await expect(entry(local(), 'from-client.txt')).toBeVisible();
  await expect(remote().getByText('Nicht verbunden')).toBeVisible();

  await page.getByLabel('SFTP-Host', { exact: true }).selectOption({ label: 'sftp-host' });
  await page.getByRole('button', { name: 'Verbinden' }).click();
  await answerConnectPrompts();
  await expect(entry(remote(), 'from-server.txt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Trennen' })).toBeVisible();
});

test('uploads and downloads with the keyboard and by double click', async () => {
  await entry(local(), 'from-client.txt').dblclick();
  await expect(entry(remote(), 'from-client.txt')).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(join(sftpRoot, 'from-client.txt'), 'utf8')).toBe('hello from the client');

  await entry(remote(), 'from-server.txt').click();
  await page.keyboard.press('F5');
  await expect(entry(local(), 'from-server.txt')).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(join(home, 'from-server.txt'), 'utf8')).toBe('hello from the server');
});

test('transfers a folder recursively', async () => {
  await entry(remote(), 'folder').click();
  await page.keyboard.press('F5');
  await expect(entry(local(), 'folder')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => existsSync(join(home, 'folder', 'nested.txt'))).toBe(true);
  expect(readFileSync(join(home, 'folder', 'nested.txt'), 'utf8')).toBe('nested');
});

test('asks before overwriting', async () => {
  writeFileSync(join(sftpRoot, 'from-client.txt'), 'changed on the server');
  await entry(local(), 'from-client.txt').dblclick();
  const dialog = page.getByRole('dialog', { name: /existiert bereits/ });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Überspringen' }).click();
  await expect(job('from-client.txt').first()).toBeVisible();
  expect(readFileSync(join(sftpRoot, 'from-client.txt'), 'utf8')).toBe('changed on the server');

  await entry(local(), 'from-client.txt').dblclick();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Überschreiben' }).click();
  // The fixture has no posix-rename, so the fallback removes the destination for a moment.
  await expect.poll(() => contentsOf(join(sftpRoot, 'from-client.txt'))).toBe('hello from the client');
});

test('creates, renames and deletes on the server, with a confirmation', async () => {
  await remote().getByRole('button', { name: 'Neuer Ordner' }).click();
  const create = page.getByRole('dialog', { name: 'Neuer Ordner' });
  await create.getByLabel('Name').fill('made-in-ryft');
  await create.getByRole('button', { name: 'Anlegen' }).click();
  await expect(entry(remote(), 'made-in-ryft')).toBeVisible();
  expect(existsSync(join(sftpRoot, 'made-in-ryft'))).toBe(true);

  await entry(remote(), 'made-in-ryft').click();
  await page.keyboard.press('F2');
  const rename = page.getByRole('dialog', { name: /umbenennen/ });
  await rename.getByLabel('Neuer Name').fill('renamed');
  await rename.getByRole('button', { name: 'Umbenennen' }).click();
  await expect(entry(remote(), 'renamed')).toBeVisible();

  await entry(remote(), 'renamed').click();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: /löschen/ })).toBeVisible();
  expect(existsSync(join(sftpRoot, 'renamed'))).toBe(true);
  await page.getByRole('dialog', { name: /löschen/ }).getByRole('button', { name: 'Löschen' }).click();
  await expect(entry(remote(), 'renamed')).toBeHidden();
  expect(existsSync(join(sftpRoot, 'renamed'))).toBe(false);
});

test('changes the mode of a remote file', async () => {
  await entry(remote(), 'from-server.txt').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rechte ändern' }).click();
  const dialog = page.getByRole('dialog', { name: /Rechte von/ });
  await dialog.getByLabel('Besitzer Ausführen').check();
  await dialog.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('filters and sorts', async () => {
  await remote().getByLabel(/filtern$/).fill('nothing-matches');
  await expect(remote().getByText('Keine Treffer')).toBeVisible();
  await remote().getByLabel(/filtern$/).fill('');
  await expect(entry(remote(), 'from-server.txt')).toBeVisible();
  await remote().getByRole('button', { name: 'Größe' }).click();
  await expect(remote().getByRole('button', { name: 'Größe' })).toHaveAttribute('aria-sort', 'ascending');
});

test('cancels a running download and leaves no partial file behind', async () => {
  writeFileSync(join(sftpRoot, 'large.bin'), Buffer.alloc(32 * 1024 * 1024, 7));
  fixture.sftpReadDelayMs = 40;
  await remote().getByRole('button', { name: 'Aktualisieren' }).click();
  await entry(remote(), 'large.bin').dblclick();
  await expect(job('large.bin')).toHaveAttribute('data-state', 'running', { timeout: 15_000 });

  await job('large.bin').getByRole('button', { name: 'large.bin abbrechen' }).click();
  await expect(job('large.bin')).toHaveAttribute('data-state', 'cancelled', { timeout: 15_000 });
  expect(readdirSync(home).filter((name) => name.includes('large.bin'))).toEqual([]);
});

test('a lost connection fails the transfer clearly, and it can be retried after reconnecting', async () => {
  await job('large.bin').getByRole('button', { name: 'large.bin wiederholen' }).click();
  await expect(job('large.bin')).toHaveAttribute('data-state', 'running', { timeout: 15_000 });

  fixture.dropConnections();
  await expect(job('large.bin')).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
  await expect(page.getByText('Die SFTP-Verbindung wurde getrennt').first()).toBeVisible();
  expect(readdirSync(home).filter((name) => name.includes('large.bin'))).toEqual([]);

  fixture.sftpReadDelayMs = 0;
  await page.getByRole('button', { name: 'Verbinden' }).click();
  await expect(entry(remote(), 'from-server.txt')).toBeVisible({ timeout: 15_000 });
  await job('large.bin').getByRole('button', { name: 'large.bin wiederholen' }).click();
  await expect(job('large.bin')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  expect(readFileSync(join(home, 'large.bin')).length).toBe(32 * 1024 * 1024);
});

test('a -L forward starts, carries traffic, shows its status and stops', async () => {
  const echo: Server = createServer((socket) => socket.on('data', (data) => socket.write(data)));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const { port: echoPort } = echo.address() as { port: number };

  try {
    await nav().getByRole('button', { name: 'Port Forwarding' }).click();
    await expect(page.getByTestId('forwards-view')).toBeVisible();
    await page.getByRole('button', { name: 'Weiterleitung', exact: true }).first().click();
    const editor = page.getByRole('dialog', { name: 'Weiterleitung hinzufügen' });
    await editor.getByLabel('Name', { exact: true }).fill('echo-tunnel');
    await editor.getByLabel('Host', { exact: true }).selectOption({ label: 'sftp-host' });
    await editor.getByLabel('Bind-Adresse').fill('127.0.0.1');
    await editor.getByLabel('Quellport').fill('0');
    await editor.getByLabel('Zielhost').fill('127.0.0.1');
    await editor.getByLabel('Zielport').fill(String(echoPort));
    await editor.getByRole('button', { name: 'Speichern' }).click();
    await expect(editor).toBeHidden();

    const row = page.getByTestId('forward-row').filter({ hasText: 'echo-tunnel' });
    await row.getByRole('button', { name: 'echo-tunnel starten' }).click();
    await expect(row.getByTestId('forward-status')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });

    const bound = await page.evaluate(async (channel) => {
      const runtime = (await (window.ryft.invoke as LooseInvoke)(channel)) as { boundPort: number | null }[];
      return runtime[0]?.boundPort ?? 0;
    }, Channels.forwardsRuntime);
    expect(bound).toBeGreaterThan(0);
    await expect(row).toContainText(`127.0.0.1:${bound}`);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(bound, '127.0.0.1', () => socket.write('through the tunnel'));
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.once('error', reject);
    });
    expect(answer).toBe('through the tunnel');

    await row.getByRole('button', { name: 'echo-tunnel stoppen' }).click();
    await expect(row.getByTestId('forward-status')).toHaveAttribute('data-status', 'stopped', { timeout: 15_000 });
    await expect
      .poll(
        () =>
          new Promise<boolean>((resolve) => {
            const socket = createConnection(bound, '127.0.0.1', () => {
              socket.destroy();
              resolve(true);
            });
            socket.once('error', () => resolve(false));
          })
      )
      .toBe(false);
  } finally {
    echo.close();
  }
});

test('warns about a public listener and insists on a decision', async () => {
  await page.getByRole('button', { name: 'Weiterleitung', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: 'Weiterleitung hinzufügen' });
  await editor.getByLabel('Name', { exact: true }).fill('public');
  await editor.getByLabel('Host', { exact: true }).selectOption({ label: 'sftp-host' });
  await editor.getByLabel('Bind-Adresse').fill('0.0.0.0');
  await editor.getByLabel('Quellport').fill('0');
  await editor.getByLabel('Zielhost').fill('127.0.0.1');
  await editor.getByLabel('Zielport').fill('80');
  await expect(editor.getByRole('alert')).toContainText('nicht Loopback');
  await editor.getByRole('button', { name: 'Speichern' }).click();
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('forward-row').filter({ hasText: 'public' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Abbrechen' }).click();
});

test('advanced host options and auth profiles persist across a restart', async () => {
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('tab', { name: 'Anmeldeprofile' }).click();
  await page.getByRole('button', { name: 'Profil', exact: true }).click();
  await page.getByLabel('Profilname').fill('Deploy-Login');
  await page.getByLabel('Methode').selectOption('password');
  await page.getByLabel('Benutzer (optional)').fill('deploy');
  await page.getByRole('button', { name: 'Profil speichern' }).click();
  await expect(page.getByTestId('auth-profile').filter({ hasText: 'Deploy-Login' })).toContainText('0 Hosts');
  await page.keyboard.press('Escape');

  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Hosts' }).click();
  await page.getByTestId('host-row').filter({ hasText: 'sftp-host' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
  await page.getByLabel('Anmeldeprofil').selectOption({ label: 'Deploy-Login' });
  await page.getByRole('button', { name: 'Erweitert' }).click();
  await page.getByLabel('Verbindungs-Timeout (s)').fill('42');
  await page.getByLabel('SFTP-Startordner').fill('/folder');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  const { profile } = launched;
  await launched.close();
  launched = await launchApp({ profile, width: 1440, height: 900 });
  page = launched.page;

  await page.getByTestId('host-row').filter({ hasText: 'sftp-host' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
  await expect(page.getByLabel('Anmeldeprofil').locator('option:checked')).toHaveText('Deploy-Login');
  await page.getByRole('button', { name: 'Erweitert' }).click();
  await expect(page.getByLabel('Verbindungs-Timeout (s)')).toHaveValue('42');
  await expect(page.getByLabel('SFTP-Startordner')).toHaveValue('/folder');
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});
