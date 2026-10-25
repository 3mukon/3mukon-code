import { defineConfig } from '@playwright/test';

// Smoke tests drive the built app in out/; the test:smoke script builds it first.
export default defineConfig({
  testDir: 'tests/smoke',
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI !== undefined ? 'github' : 'list',
});
