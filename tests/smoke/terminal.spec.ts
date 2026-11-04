import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { answerQuestion, dataFolder, launchIsolated, pickFolder } from './app';

// Types a command into the terminal and runs it.
async function run(window: Page, terminal: Locator, command: string) {
  await terminal.locator('.xterm').click();
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

test('a workspace’s menu opens a terminal in its folder, ⌃` another beside it, and closing one asks before ending its program', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-terminal-')));
  try {
    const app = await launchIsolated(data.path);
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      await window.getByRole('treeitem', { selected: true }).click({ button: 'right' });
      await window.getByRole('menu').getByRole('menuitem', { name: 'Open in Terminal' }).click();
      const main = window.getByRole('main');
      const terminal = main.getByRole('region', { name: 'Terminal' });
      await expect(terminal).toHaveCount(1);
      // The login shell runs in the workspace's folder, as the app's terminal, at its panel's size.
      await run(window, terminal, 'echo "$TERM_PROGRAM in $PWD:"; echo "size:$(stty size):"');
      const rows = terminal.locator('.xterm-rows');
      await expect(rows).toContainText(`3mukon-code in ${folder}:`);
      // The terminal's program has as many rows as the emulator draws.
      const drawn = await rows.locator('> div').count();
      await expect(rows).toContainText(new RegExp(`size:${String(drawn)} \\d+:`));
      // ⌃` opens another terminal beside the focused one, in its folder.
      await window.keyboard.press('Control+Backquote');
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(2);
      const second = main.getByRole('region', { name: 'Terminal' }).nth(1);
      await run(window, second, 'pwd');
      await expect(second.locator('.xterm-rows')).toContainText(folder);
      // A program other than the shell runs, so closing its panel asks first, and Cancel keeps it.
      await run(window, second, 'sleep 30');
      await expect
        .poll(async () => second.locator('.xterm-rows').textContent())
        .toContain('sleep 30');
      await second.getByRole('button', { name: 'Close panel' }).click();
      await expect(window.getByRole('alertdialog')).toContainText('End sleep');
      await answerQuestion(window, 'Cancel');
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(2);
      await second.getByRole('button', { name: 'Close panel' }).click();
      await answerQuestion(window, 'Close');
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(1);
      // With the shell alone, the panel closes at once.
      await terminal.getByRole('button', { name: 'Close panel' }).click();
      await expect(main.getByRole('region', { name: 'Terminal' })).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
