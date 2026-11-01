import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, removeProfile, resizeWindow, seed, type LaunchedApp, type LooseInvoke } from './launch';

const OUT = resolve(__dirname, '../docs/screenshots');
mkdirSync(OUT, { recursive: true });

/* Harmless documentation-range addresses. Nothing here is ever connected to. */
const SAMPLE = [
  { name: 'prod-web-01', hostname: '192.0.2.10', group: 'Production', favorite: true },
  { name: 'prod-api-01', hostname: '192.0.2.11', group: 'Production' },
  { name: 'prod-db-01', hostname: '192.0.2.12', group: 'Production' },
  { name: 'dev-web-01', hostname: '198.51.100.15', group: 'Development' },
  { name: 'dev-db-01', hostname: '198.51.100.16', group: 'Development' },
  { name: 'nas', hostname: '203.0.113.20', group: 'Homelab' },
  { name: 'pihole', hostname: '203.0.113.21', group: 'Homelab' }
];

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(OUT, `${name}.png`) });

let launched: LaunchedApp;
test.beforeAll(async () => {
  launched = await launchApp({ width: 1440, height: 900 });
  await seed(launched.page, SAMPLE);
});
test.afterAll(async () => {
  const { profile } = launched;
  await launched.close();
  removeProfile(profile);
});

test('workspace with a real local shell and disconnected SSH panes', async () => {
  const { page, app } = launched;
  await page.getByRole('button', { name: 'prod-web-01 auswählen, Doppelklick verbindet' }).click();

  // The upper pane stays disconnected on purpose. The layout is the same split the reference shows.
  await page.evaluate(async () => {
    const invoke = window.ryft.invoke as LooseInvoke;
    const hosts = (await invoke('hosts:list')) as { id: string; name: string }[];
    const ssh = (name: string) => ({
      type: 'pane',
      id: crypto.randomUUID(),
      target: { kind: 'ssh', hostId: hosts.find((host) => host.name === name)!.id }
    });
    const top = ssh('prod-web-01');
    const single = (name: string) => {
      const root = ssh(name);
      return { id: crypto.randomUUID(), activePaneId: root.id, root };
    };
    const main = {
      id: crypto.randomUUID(),
      activePaneId: top.id,
      root: {
        type: 'split',
        direction: 'column',
        ratio: 0.6,
        first: top,
        second: {
          type: 'split',
          direction: 'row',
          ratio: 0.5,
          first: { type: 'pane', id: crypto.randomUUID(), target: { kind: 'local', shellId: null } },
          second: ssh('prod-db-01')
        }
      }
    };
    await invoke('prefs:set', {
      workspaceLayout: { activeTabId: main.id, tabs: [main, single('dev-web-01'), single('dev-db-01')] }
    });
  });
  await page.reload();
  await page.waitForSelector('[data-testid="terminal-pane"]');

  await page.getByRole('button', { name: 'prod-web-01 auswählen, Doppelklick verbindet' }).click();
  // Starts the real local shell in the lower-left pane.
  await page.getByTestId('terminal-pane').nth(1).getByRole('button', { name: 'Verbinden' }).click();
  await expect(page.getByTestId('terminal-pane').nth(1).getByText('Verbunden')).toBeVisible();
  await page.waitForTimeout(1500);
  // These images are published, and the default prompt would show the local user name.
  await page.getByTestId('terminal-pane').nth(1).locator('.xterm').click();
  await page.keyboard.type(
    process.platform === 'win32' ? 'function prompt { "PS ~> " }; Clear-Host\n' : "PS1='~ $ '; PROMPT='~ $ '; clear\n"
  );
  await page.waitForTimeout(1000);
  await shot(page, 'workspace-1440x900');

  await resizeWindow(app, page, 1280, 800);
  await page.waitForTimeout(400);
  await shot(page, 'workspace-1280x800');

  await resizeWindow(app, page, 1920, 1080);
  await page.waitForTimeout(400);
  await shot(page, 'workspace-1920x1080');

  await resizeWindow(app, page, 1000, 680);
  await page.waitForTimeout(400);
  await shot(page, 'workspace-1000x680-rail');

  await resizeWindow(app, page, 1440, 900);
  await page.waitForTimeout(300);
});

test('host editor', async () => {
  const { page } = launched;
  await page.getByRole('button', { name: 'Host hinzufügen' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('staging-web-01');
  await page.getByLabel('Host oder IP').fill('192.0.2.42');
  await page.getByLabel('Benutzer').fill('deploy');
  await page.getByLabel('Anmeldung').selectOption('key');
  await page.waitForTimeout(200);
  await shot(page, 'host-editor');
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});

test('command palette', async () => {
  const { page } = launched;
  await page.getByRole('button', { name: 'Befehlspalette öffnen' }).click();
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, 'command-palette');
  await page.keyboard.press('Escape');
});

test('settings', async () => {
  const { page } = launched;
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.waitForTimeout(200);
  await shot(page, 'settings');
  await page.keyboard.press('Escape');
});

test('connection error from a real failed connection', async () => {
  const { page } = launched;
  const panes = page.getByTestId('terminal-pane');
  // Port 1 on loopback refuses immediately. This is a real attempt, not a mocked error state.
  await page.evaluate(async () => {
    const invoke = window.ryft.invoke as LooseInvoke;
    const hosts = (await invoke('hosts:list')) as { id: string; name: string; [key: string]: unknown }[];
    const target = hosts.find((host) => host.name === 'prod-db-01')!;
    const { id, createdAt: _c, updatedAt: _u, hasStoredSecret: _h, ...input } = target;
    await invoke('hosts:update', { id, input: { ...input, hostname: '127.0.0.1', port: 1 } });
  });
  await page.reload();
  await page.waitForSelector('[data-testid="terminal-pane"]');
  await panes.nth(2).getByRole('button', { name: 'Verbinden' }).click();
  await expect(panes.nth(2).getByTestId('pane-status')).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
  await page.waitForTimeout(200);
  await shot(page, 'connection-error');
});

test('empty state without any hosts', async () => {
  const empty = await launchApp({ width: 1440, height: 900 });
  await empty.page.waitForTimeout(400);
  await shot(empty.page, 'empty-state');
  const { profile } = empty;
  await empty.close();
  removeProfile(profile);
});
