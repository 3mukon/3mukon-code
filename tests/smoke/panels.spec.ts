import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { answerQuestion, dataFolder, launch, pickFolder } from './app';

test('tree rows dragged into the main area open as panels, which split, resize, take focus, close and move', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-panels-')));
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'README.md'), '');
  try {
    const app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      const workspace = window.getByRole('treeitem', { name: basename(folder), exact: true });
      await workspace.focus();
      await window.keyboard.press('ArrowRight');
      const row = (name: string) => workspace.getByRole('treeitem', { name, exact: true });
      await expect(row('README.md')).toBeVisible();
      const main = window.getByRole('main');
      // No drag of the system's starts as tree rows and panels are dragged, so that no copy badge
      // shows (L-0003).
      const drags = () => window.evaluate(() => (globalThis as unknown as { drags: number }).drags);
      await window.evaluate(() => {
        const page = globalThis as unknown as {
          drags: number;
          document: {
            addEventListener: (type: string, listener: () => void, capture: boolean) => void;
          };
        };
        page.drags = 0;
        page.document.addEventListener('dragstart', () => (page.drags += 1), true);
      });

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

      // A panel pressed by its title and moved near another panel's edge moves beside it.
      const readmeBox = await box(readme);
      const title = await box(page.getByText('New session', { exact: true }));
      await window.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
      await window.mouse.down();
      const [x, y] = [readmeBox.x + readmeBox.width - 10, readmeBox.y + readmeBox.height / 2];
      await window.mouse.move(x, y, { steps: 8 });
      // A ghost of the title follows the pointer while the panel moves.
      await expect(window.getByText('New session', { exact: true })).toHaveCount(2);
      await window.mouse.up();
      expect(await drags()).toBe(0);
      await expect(window.getByText('New session', { exact: true })).toHaveCount(1);
      await expect(main.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
      await expect.poll(async () => (await box(page)).x - (await box(readme)).x).toBeGreaterThan(0);

      // ⇧⌥⌘← swaps the focused panel with the one to its left.
      await window.keyboard.press('Shift+Alt+Meta+ArrowLeft');
      await expect.poll(async () => (await box(page)).x - (await box(readme)).x).toBeLessThan(0);
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
