import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { SshFixture } from '../tests/fixtures/sshServer';
import { enableDomRenderer, launchApp, removeProfile, seed } from './launch';

/** Native modules and asar paths only break in the packaged app, so this drives the real executable. */
const unpacked = resolve(__dirname, '../release');
const executable =
  process.platform === 'win32'
    ? join(unpacked, 'win-unpacked/RYFT.exe')
    : process.platform === 'darwin'
      ? join(unpacked, `mac-${process.arch}/RYFT.app/Contents/MacOS/RYFT`)
      : join(unpacked, 'linux-unpacked/ryft');

test('the packaged app runs a local shell and a real SSH session', async () => {
  test.skip(!existsSync(executable), `Run "npm run package:dir" first: ${executable} is missing`);

  const password = 'packaged-fixture-password';
  const fixture = new SshFixture({ password });
  await fixture.listen();
  const launched = await launchApp({ executablePath: executable, width: 1440, height: 900 });
  const { page } = launched;
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  try {
    await enableDomRenderer(page);
    await seed(page, [{ name: 'packaged-host', hostname: '127.0.0.1', port: fixture.port, authMethod: 'password' }]);

    await page.getByRole('button', { name: 'Local Terminal' }).click();
    const shell = page.getByTestId('terminal-pane').locator('visible=true').first();
    await expect(shell.getByText('Verbunden')).toBeVisible({ timeout: 15_000 });
    await expect(shell.locator('.xterm-rows')).not.toBeEmpty();

    await page.getByRole('button', { name: 'packaged-host auswählen, Doppelklick verbindet' }).dblclick();
    await page.getByRole('button', { name: 'Nur diesmal' }).click();
    await page.getByLabel('Passwort', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    const remote = page.getByTestId('terminal-pane').filter({ hasText: 'packaged-host' });
    await expect(remote.getByText('Verbunden')).toBeVisible({ timeout: 15_000 });
    await expect(remote.locator('.xterm-rows')).toContainText('fixture$');

    expect(problems).toEqual([]);
  } finally {
    await launched.close().catch(() => undefined);
    removeProfile(launched.profile);
    await fixture.close();
  }
});
