import { defineConfig } from 'vitest/config';

// Live tests drive real providers on the user's own sign-in. Only `corepack pnpm run test:live` runs
// them; the check command does not.
export default defineConfig({
  test: { include: ['src/**/*.live.test.ts'], testTimeout: 300_000 },
});
