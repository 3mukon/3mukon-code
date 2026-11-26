import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { integrity, serve, tarball } from '../../src/installs/main/builds-fake';
import { dataFolder, launch, launchWith, providerProcesses, stillRunning } from './app';

test('the Accounts panel opens from the gauge and says which providers are not signed in, as session pages do, and quitting ends the providers’ processes', async () => {
  const data = dataFolder();
  try {
    const app = await launch(data.path, '--lang=en-US');
    let running: number[] = [];
    try {
      const window = await app.firstWindow();
      await window.getByRole('button', { name: 'Accounts' }).click();
      const main = window.getByRole('main');
      const accounts = main.getByRole('region', { name: 'Accounts' });
      await expect(accounts).toHaveAttribute('aria-current', 'true');
      // Each provider reads its own settings, which sign it in to nothing here.
      const rows = accounts.getByRole('listitem');
      await expect(rows).toHaveCount(4);
      for (const provider of ['Claude Code', 'Codex CLI']) {
        const row = rows.filter({ hasText: provider });
        await expect(row).toContainText('Not signed in', { timeout: 30_000 });
        await expect(row.getByRole('button', { name: 'Sign In' })).toBeVisible();
      }
      // Antigravity has no package, so the tests have no copy of it: it is not installed, and never
      // runs here (L-0007), and Sign In would download Google's build.
      const antigravity = rows.filter({ hasText: 'Antigravity' });
      await expect(antigravity).toContainText('Not installed');
      await expect(antigravity.getByRole('button', { name: 'Sign In' })).toBeVisible();
      // Each runs the CLI the app found where it looks for them, here the test's copies of the pinned
      // packages' binaries (ADR-0039).
      await expect(rows.filter({ hasText: 'Claude Code' })).toContainText('Runs your CLI, 2.1.330');
      // Opening the panel again focuses the one there.
      await window.getByRole('button', { name: 'Accounts' }).click();
      await expect(main.getByRole('region', { name: 'Accounts' })).toHaveCount(1);
      // A session page marks its provider as not signed in, and offers the sign-in.
      await window.getByRole('button', { name: 'New session' }).click();
      const page = main.getByRole('region', { name: 'New session' });
      await expect(page).toContainText('Claude Code is not signed in.');
      await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
      // The providers' processes still running as the app quits, such as those reading the accounts
      // or listing the models, which quitting ends and waits for, so that none writes to the data
      // folder after the app has gone.
      running = providerProcesses(app);
    } finally {
      await app.close();
    }
    expect(stillRunning(running)).toEqual([]);
  } finally {
    data.remove();
  }
});

test('a sign-in downloads the app’s copy of a provider that is not installed, which runs from then on, and says why a download failed', async () => {
  const data = dataFolder();
  const bodies = new Map<string, Buffer>();
  const { server, url } = await serve(bodies);
  try {
    // A build of the test's own for Codex, which prints its version and signs in to nothing.
    const build = tarball(data.path, {
      'bin/codex':
        '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 0.171.0"; else echo "signing in"; fi\n',
    });
    const pins = join(data.path, 'pins.json');
    writeFileSync(
      pins,
      JSON.stringify({
        'codex-cli': {
          version: '0.171.0',
          url: `${url}/codex.tgz`,
          integrity: integrity(build),
          folder: 'package/bin',
          binary: 'codex',
        },
      }),
    );
    // No CLI where the app looks, so that no provider is installed.
    const empty = join(data.path, 'no-clis');
    mkdirSync(empty);
    bodies.set('/codex.tgz', Buffer.from('not the build'));
    const app = await launchWith(data.path, {
      args: ['--lang=en-US', `--provider-pins=${pins}`],
      providerPath: empty,
    });
    try {
      const window = await app.firstWindow();
      await window.getByRole('button', { name: 'Accounts' }).click();
      const accounts = window.getByRole('main').getByRole('region', { name: 'Accounts' });
      const codex = accounts.getByRole('listitem').filter({ hasText: 'Codex CLI' });
      await expect(codex).toContainText('Not installed');
      await expect(codex).toContainText('Sign In downloads the app’s copy, 0.171.0, first.');
      // A download that does not match its checksum runs nothing, and says so.
      await codex.getByRole('button', { name: 'Sign In' }).click();
      await expect(codex).toContainText('didn’t match its checksum');
      await expect(codex).toContainText('Not installed');
      // Tried again with the build, it runs the copy's own sign-in in a terminal.
      bodies.set('/codex.tgz', build);
      await codex.getByRole('button', { name: 'Sign In' }).click();
      await expect(codex).toContainText('Runs the app’s copy, 0.171.0', { timeout: 30_000 });
      await expect(codex).not.toContainText('checksum');
      const terminal = window.getByRole('main').getByRole('region', { name: 'Terminal' });
      await expect(terminal.locator('.xterm-rows')).toContainText('signing in');
    } finally {
      await app.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    data.remove();
  }
});
