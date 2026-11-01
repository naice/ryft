import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  projects: [
    { name: 'e2e', testMatch: /(app|connectivity|productivity|developer|snippetLibrary)\.spec\.ts/ },
    { name: 'visual', testMatch: /screenshots\.spec\.ts/ },
    { name: 'packaged', testMatch: /packaged\.spec\.ts/ }
  ]
});
