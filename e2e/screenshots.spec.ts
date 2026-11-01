import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Channels } from '../src/shared/channels';
import { OllamaFixture } from '../tests/fixtures/ollamaFixture';
import { SshFixture } from '../tests/fixtures/sshServer';
import { stubDocker } from './dockerStub';
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

test('SFTP and port forwarding against a disposable local server', async () => {
  const sftpRoot = mkdtempSync(join(tmpdir(), 'ryft-shot-sftp-'));
  for (const name of ['releases', 'logs']) mkdirSync(join(sftpRoot, name));
  writeFileSync(join(sftpRoot, 'nginx.conf'), 'x'.repeat(2_400));
  writeFileSync(join(sftpRoot, 'backup.tar.gz'), 'x'.repeat(4_200_000));
  writeFileSync(join(sftpRoot, 'deploy.sh'), 'x'.repeat(860));
  const fixture = new SshFixture({ password: 'screenshot-only', sftpRoot });
  await fixture.listen();

  // The local pane shows its folder, and a temp folder would publish the user name of the machine.
  const profile = resolve(__dirname, '../test-results/shot-home');
  mkdirSync(join(profile, 'Projekte'), { recursive: true });
  writeFileSync(join(profile, 'release-notes.md'), 'x'.repeat(5_300));
  writeFileSync(join(profile, 'site.zip'), 'x'.repeat(1_200_000));
  const tools = await launchApp({ profile, width: 1440, height: 900 });
  try {
    const { page } = tools;
    const host = (await page.evaluate(
      async ({ port, channels }) =>
        (window.ryft.invoke as LooseInvoke)(channels.hostsCreate, {
          name: 'prod-web-01',
          hostname: '127.0.0.1',
          port,
          username: 'deploy',
          authMethod: 'password',
          keyReference: null,
          groupId: null,
          tags: [],
          favorite: false
        }),
      { port: fixture.port, channels: { hostsCreate: Channels.hostsCreate } }
    )) as { id: string };
    await page.evaluate(
      async ({ hostId, channel }) => {
        const invoke = window.ryft.invoke as LooseInvoke;
        const common = { hostId, restoreOnStart: false, autoReconnect: false, allowNonLoopback: false };
        await invoke(channel, { ...common, name: 'Postgres', type: 'local', bindAddress: '127.0.0.1', bindPort: 15432, destHost: 'db.internal', destPort: 5432 });
        await invoke(channel, { ...common, name: 'Webhook-Test', type: 'remote', bindAddress: '127.0.0.1', bindPort: 9000, destHost: '127.0.0.1', destPort: 3000 });
        await invoke(channel, { ...common, name: 'SOCKS-Proxy', type: 'dynamic', bindAddress: '127.0.0.1', bindPort: 1080, destHost: null, destPort: null });
      },
      { hostId: host.id, channel: Channels.forwardsCreate }
    );
    await page.reload();
    await page.waitForSelector('[data-testid="app-shell"]');

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await nav.getByRole('button', { name: 'SFTP' }).click();
    await page.getByLabel('SFTP-Host', { exact: true }).selectOption({ label: 'prod-web-01' });
    await page.getByRole('button', { name: 'Verbinden' }).click();
    await page.getByRole('button', { name: 'Vertrauen & speichern' }).click();
    await page.getByRole('textbox', { name: 'Passwort' }).fill('screenshot-only');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    const remote = page.getByTestId('sftp-pane-remote');
    await expect(remote.getByTestId('sftp-entry').filter({ hasText: 'nginx.conf' })).toBeVisible({ timeout: 15_000 });
    await remote.getByTestId('sftp-entry').filter({ hasText: 'backup.tar.gz' }).click();
    await page.keyboard.press('F5');
    await expect(page.getByTestId('transfer-job').filter({ hasText: 'backup.tar.gz' })).toContainText(/Fertig|fertig/, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot(page, 'sftp');

    await nav.getByRole('button', { name: 'Port Forwarding' }).click();
    await page.getByRole('button', { name: /Postgres.*starten|Starten/ }).first().click();
    await page.waitForTimeout(800);
    await shot(page, 'port-forwarding');
  } finally {
    await tools.close();
    await fixture.close();
    rmSync(sftpRoot, { recursive: true, force: true });
    removeProfile(profile);
  }
});

test('productivity and developer tools', async () => {
  const ollama = new OllamaFixture();
  ollama.models = ['qwen3:8b', 'gemma3:4b'];
  ollama.chunks = ['Das zeigt die Container mit ihrem Status an:\n\n', '```sh\ndocker ps --format "table {{.Names}}\\t{{.Status}}"\n```\n'];
  await ollama.listen();
  // The prompt and the folders show this path, and a temp folder would publish the user name of the machine.
  const profile = resolve(__dirname, '../test-results/shot-home');
  mkdirSync(profile, { recursive: true });
  const tools = await launchApp({ profile, width: 1440, height: 900 });
  try {
    const { page, app } = tools;
    const nav = (name: string) => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true });
    const tabs = page.getByRole('tablist', { name: 'Sitzungen' }).getByRole('tab');

    const openShell = async (count: number) => {
      await nav('Local Terminals').click();
      await expect(tabs).toHaveCount(count);
      await expect(page.getByTestId('pane-status')).toHaveCount(0, { timeout: 15_000 });
      await page.waitForTimeout(1500);
      await page.locator('[data-testid="terminal-pane"]:visible .xterm').click();
      await page.keyboard.type(
        process.platform === 'win32' ? 'function prompt { "PS ~> " }; Clear-Host\n' : "PS1='~ $ '; PROMPT='~ $ '; clear\n"
      );
      await page.waitForTimeout(800);
    };
    await openShell(1);
    await openShell(2);

    // A message from an earlier step would stand in the corner of the next image.
    const clearToasts = async () => {
      for (const close of await page.getByRole('button', { name: 'Meldung schließen' }).all()) await close.click();
    };

    await nav('Snippets').click();
    for (const [name, command] of [
      ['Docker Logs', 'docker logs --tail {{lines:50}} {{container}}'],
      ['Disk Usage', 'df -h {{path:/}}'],
      ['Nginx neu laden', 'sudo systemctl reload nginx']
    ] as const) {
      await page.getByRole('button', { name: 'Snippet', exact: true }).click();
      const editor = page.getByRole('dialog');
      await editor.getByLabel('Name', { exact: true }).fill(name);
      await editor.getByLabel('Befehl', { exact: true }).fill(command);
      await editor.getByRole('button', { name: 'Speichern' }).click();
      await expect(editor).toHaveCount(0);
    }
    await page.waitForTimeout(200);
    await shot(page, 'snippets');

    await page.getByRole('tab', { name: 'Bibliothek', exact: true }).click();
    await page.getByTestId('preset-row').nth(2).getByRole('button').nth(1).click();
    await page.waitForTimeout(300);
    await shot(page, 'snippet-library');

    await nav('SSH Keys').click();
    await page.getByRole('button', { name: 'Erzeugen' }).click();
    const keyDialog = page.getByRole('dialog');
    await keyDialog.getByLabel('Name', { exact: true }).fill('deploy-ed25519');
    await keyDialog.getByRole('button', { name: 'Erzeugen' }).click();
    await expect(page.getByTestId('key-row')).toHaveCount(1);
    await clearToasts();
    await page.waitForTimeout(200);
    await shot(page, 'ssh-keys');

    await nav('Workspaces').click();
    await page.getByRole('button', { name: 'Aktuelles Layout speichern' }).click();
    const workspaceDialog = page.getByRole('dialog');
    await workspaceDialog.getByLabel('Name', { exact: true }).fill('Release-Tag');
    await workspaceDialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByTestId('workspace-row')).toHaveCount(1);
    await clearToasts();
    await page.waitForTimeout(200);
    await shot(page, 'workspaces');

    await stubDocker(app);
    await nav('Docker').click();
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(page.getByTestId('docker-row')).toHaveCount(4);
    await page.getByRole('button', { name: 'Logs von demo-web' }).click();
    await expect(page.getByTestId('docker-log-text')).toContainText('demo log line');
    await clearToasts();
    await page.waitForTimeout(200);
    await shot(page, 'docker');
    await page.getByRole('button', { name: 'Logs schließen' }).click();

    await nav('Hosts').click();
    await tabs.nth(0).click();
    await page.getByRole('button', { name: 'Sitzung aufzeichnen' }).locator('visible=true').click();
    await page.locator('[data-testid="terminal-pane"]:visible .xterm').click();
    await page.keyboard.type('echo deploy finished\r');
    await page.waitForTimeout(800);
    await nav('Sitzungsprotokolle').click();
    await expect(page.getByTestId('log-row')).toHaveCount(1);
    await page.waitForTimeout(200);
    await shot(page, 'session-logs');
    await nav('Hosts').click();

    await page.keyboard.press('Control+Shift+B');
    const broadcast = page.getByRole('dialog').filter({ hasText: 'Broadcast starten' });
    const choices = broadcast.getByTestId('broadcast-choices').getByRole('checkbox');
    await choices.nth(0).check();
    await choices.nth(1).check();
    await broadcast.getByRole('button', { name: /^Broadcast für/ }).click();
    await expect(page.getByTestId('broadcast-bar')).toBeVisible();
    await page.getByTestId('broadcast-bar').getByLabel('Befehl für alle Ziele').fill('uptime');
    await page.waitForTimeout(300);
    await shot(page, 'broadcast');
    await page.keyboard.press('Control+Shift+B');
    await expect(page.getByTestId('broadcast-bar')).toHaveCount(0);

    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await page.getByRole('tab', { name: 'KI-Assistent' }).click();
    await page.getByLabel('Ollama-Adresse').fill(ollama.url);
    await page.getByRole('button', { name: 'Übernehmen' }).click();
    await page.keyboard.press('Escape');
    await nav('AI Assistant').click();
    await page.getByTestId('ai-optin').getByRole('button', { name: 'Einschalten' }).click();
    await page.getByLabel('KI-Modell').selectOption('qwen3:8b');
    await page.getByLabel('Frage').fill('Wie sehe ich, welche Container laufen?');
    await page.getByRole('button', { name: 'Senden' }).click();
    await expect(page.getByTestId('ai-exchange').last()).toHaveAttribute('data-status', 'done');
    await page.waitForTimeout(300);
    await shot(page, 'ai-assistant');
  } finally {
    await tools.close();
    await ollama.close();
    removeProfile(profile);
  }
});
