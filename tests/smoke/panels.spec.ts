import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { answerDialogs, dataFolder, launch } from './app';

test('tree rows dragged into the main area open as panels, which split, resize, take focus and close', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-panels-')));
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'README.md'), '');
  try {
    const app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await answerDialogs(app, folder, true);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      const workspace = window.getByRole('treeitem', { name: basename(folder), exact: true });
      await workspace.focus();
      await window.keyboard.press('ArrowRight');
      const row = (name: string) => workspace.getByRole('treeitem', { name, exact: true });
      await expect(row('README.md')).toBeVisible();
      const main = window.getByRole('main');

      // A folder dropped on the empty main area opens a session page that fills it.
      await row('src').locator('> div').dragTo(main);
      const page = main.getByRole('region', { name: 'New session' });
      await expect(page).toHaveAttribute('aria-current', 'true');
      // Its header lies in the title bar, at the window's top edge.
      expect((await box(page)).y).toBe(0);
      await expect(page.getByText('src', { exact: true })).toHaveAttribute(
        'title',
        join(folder, 'src'),
      );

      // A file dropped near the page's right edge splits it, side by side.
      const pageBox = await box(page);
      await row('README.md')
        .locator('> div')
        .dragTo(page, { targetPosition: { x: pageBox.width - 10, y: pageBox.height / 2 } });
      const readme = main.getByRole('region', { name: 'README.md' });
      await expect(readme).toHaveAttribute('aria-current', 'true');
      expect((await box(readme)).x).toBeGreaterThan((await box(page)).x);

      // ⌥⌘← focuses the page to the left, and the keyboard focus follows.
      await window.keyboard.press('Alt+Meta+ArrowLeft');
      await expect(page).toHaveAttribute('aria-current', 'true');
      await expect(page).toBeFocused();

      // The divider moves with the keyboard.
      const divider = main.getByRole('separator', { name: 'Resize panels' });
      await divider.focus();
      await window.keyboard.press('Shift+ArrowRight');
      await expect(divider).toHaveAttribute('aria-valuenow', '60');

      // ⌘W closes the focused page; the file takes its space and the focus.
      await window.keyboard.press('Meta+w');
      await expect(page).toHaveCount(0);
      await expect(readme).toHaveAttribute('aria-current', 'true');
      await expect(divider).toHaveCount(0);

      // ⇧⌘D opens a session page in the file's folder, below it.
      await window.keyboard.press('Shift+Meta+d');
      await expect(main.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
      await expect(page.getByText(basename(folder), { exact: true })).toHaveAttribute(
        'title',
        folder,
      );
      expect((await box(page)).y).toBeGreaterThan((await box(readme)).y);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('The element is not shown.');
  return found;
}
