import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import type { HostInput, RyftApi } from '../src/shared/contracts';
import { Channels } from '../src/shared/channels';

declare global {
  interface Window {
    ryft: RyftApi;
  }
}

/** Tests call channels by name and rely on the main process validating what they send. */
export type LooseInvoke = (channel: string, input?: unknown) => Promise<unknown>;

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  profile: string;
  close(): Promise<void>;
  relaunch(): Promise<LaunchedApp>;
}

/** Every run gets a throwaway profile and HOME, so the developer's data, keys and known_hosts stay out of it. */
export async function launchApp(
  options: { profile?: string; width?: number; height?: number; executablePath?: string } = {}
): Promise<LaunchedApp> {
  const profile = options.profile ?? mkdtempSync(join(tmpdir(), 'ryft-e2e-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  env.HOME = profile;
  env.USERPROFILE = profile;

  // The throwaway HOME has no macOS keychain, and the dialog asking for one would block the main process.
  const flags = [`--user-data-dir=${join(profile, 'userData')}`, '--use-mock-keychain'];
  const app = await _electron.launch(
    options.executablePath
      ? { executablePath: options.executablePath, args: flags, env }
      : { args: [resolve(__dirname, '..'), ...flags], env }
  );
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="app-shell"]');
  if (options.width && options.height) await resizeWindow(app, page, options.width, options.height);

  const close = async (): Promise<void> => {
    await app.close();
  };
  return {
    app,
    page,
    profile,
    close,
    relaunch: async () => {
      await close();
      return launchApp({ ...options, profile });
    }
  };
}

export async function resizeWindow(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(size.width, size.height);
    },
    { width, height }
  );
  await page.waitForFunction((w) => window.innerWidth === w, width);
}

export function removeProfile(profile: string): void {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chromium may keep a handle for a moment; temp files are cleaned up by the OS eventually.
  }
}

/** Goes through the same validated IPC the UI uses. */
export async function seed(page: Page, hosts: (Partial<HostInput> & { name: string; group?: string })[]): Promise<void> {
  await page.evaluate(
    async ({ hosts: items, channels }) => {
      const invoke = window.ryft.invoke as LooseInvoke;
      const groupIds = new Map<string, string>();
      for (const { group, ...host } of items) {
        let groupId: string | null = null;
        if (group) {
          groupId = groupIds.get(group) ?? null;
          if (!groupId) {
            const created = (await invoke(channels.groupsCreate, { name: group })) as { id: string };
            groupId = created.id;
            groupIds.set(group, groupId);
          }
        }
        await invoke(channels.hostsCreate, {
          hostname: '192.0.2.10',
          port: 22,
          username: 'demo',
          authMethod: 'agent',
          keyReference: null,
          tags: [],
          favorite: false,
          ...host,
          groupId
        });
      }
    },
    { hosts, channels: { groupsCreate: Channels.groupsCreate, hostsCreate: Channels.hostsCreate } }
  );
  await page.reload();
  await page.waitForSelector('[data-testid="app-shell"]');
}

/** DOM rendering lets tests read terminal text; WebGL paints to a canvas only. */
export async function enableDomRenderer(page: Page): Promise<void> {
  await page.evaluate(
    async (channel) => {
      await (window.ryft.invoke as LooseInvoke)(channel, { terminalRenderer: 'dom' });
    },
    Channels.prefsSet
  );
  await page.reload();
  await page.waitForSelector('[data-testid="app-shell"]');
}
