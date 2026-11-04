import { defineConfig } from '@playwright/test';

// The packaged app's test drives the app in dist/; the test:package script packages it first.
export default defineConfig({
  testDir: 'tests/package',
  workers: 1,
  timeout: 180_000,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI !== undefined ? 'github' : 'list',
});
