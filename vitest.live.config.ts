import { defineConfig } from 'vitest/config';

// Live tests drive real providers on the user's own sign-in. Only `corepack pnpm run test:live` runs
// them; the check command does not. Their setup leaves vitest's process, in which the adapters start
// the providers, only a login's environment (L-0006).
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    setupFiles: ['tests/live/setup.ts'],
    testTimeout: 300_000,
  },
});
