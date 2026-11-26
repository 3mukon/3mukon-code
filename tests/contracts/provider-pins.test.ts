import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Each provider's pin, by which the app downloads its own copy where the user has no CLI of theirs
// (ADR-0039), is the one the lockfile records for the package that package.json pins: the pins script
// would write nothing new.
it('keeps every provider’s pin equal to the lockfile’s', () => {
  expect(() =>
    execFileSync(process.execPath, ['scripts/provider-pins.mjs', '--check'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
    }),
  ).not.toThrow();
});
