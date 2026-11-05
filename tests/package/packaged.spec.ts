import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { isolatedEnvironment } from '../smoke/app';

// The packaged app, as scripts/package.sh builds it.
const executable = join('dist', 'mac-arm64', '3mukon-code.app', 'Contents', 'MacOS', '3mukon-code');

test('the packaged app starts, and runs each provider’s binary and a terminal from outside its archive', async () => {
  const data = mkdtempSync(join(tmpdir(), '3mukon-code-packaged-'));
  // The app starts in the isolated environment, each provider reading settings in the throwaway
  // folder, which sign it in to nothing, so that the test reads none of the user's accounts and asks
  // no provider's service, and the shell none of the user's startup files; with launchd's minimal
  // PATH, as when opened from the Finder.
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${join(data, 'app')}`, '--lang=en-US'],
    env: { ...isolatedEnvironment(data), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  try {
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    // It takes the login shell's PATH, which macOS's own startup files lengthen (ADR-0019).
    expect(await app.evaluate(() => process.env.PATH)).toContain('/usr/local/bin');
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    // Each provider answers that it is signed in to nothing: Claude Code's and Codex's binaries run
    // from beside the archive, and Grok Build's is unpacked from inside it into the app's data.
    await window.getByRole('button', { name: 'Accounts' }).click();
    const accounts = window.getByRole('main').getByRole('region', { name: 'Accounts' });
    for (const provider of ['Claude Code', 'Codex CLI', 'Grok Build']) {
      await expect(accounts.getByRole('listitem').filter({ hasText: provider })).toContainText(
        'Not signed in',
        { timeout: 120_000 },
      );
    }
    // Claude Code starts through the SDK, as its sessions do, from the path the adapter gives it, and
    // lists its models on a session page.
    await window.getByRole('button', { name: 'New session' }).click();
    const page = window.getByRole('main').getByRole('region', { name: 'New session' });
    await expect
      .poll(() => page.getByRole('combobox', { name: 'Model' }).locator('option').count(), {
        timeout: 120_000,
      })
      .toBeGreaterThan(1);
    // node-pty's module and spawn helper run from beside the archive too.
    await window.keyboard.press('Control+Backquote');
    const terminal = window.getByRole('main').getByRole('region', { name: 'Terminal' });
    await terminal.locator('.xterm').click();
    await window.keyboard.type('echo "running in $TERM_PROGRAM"');
    await window.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('running in 3mukon-code');
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});
