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

test('a drop takes the grabbing cursor off the pointer at once, even when what it opens keeps the page busy', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-cursor-')));
  mkdirSync(join(folder, 'src'));
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
      const row = workspace.getByRole('treeitem', { name: 'src', exact: true }).locator('> div');
      await expect(row).toBeVisible();
      // The cursors Chromium gives the window, as it sets them.
      await app.evaluate(({ BrowserWindow }) => {
        const page = globalThis as unknown as { cursors: { at: number; type: string }[] };
        page.cursors = [];
        BrowserWindow.getAllWindows()[0]?.webContents.on('cursor-changed', (_event, type) => {
          page.cursors.push({ at: Date.now(), type });
        });
      });
      const cursors = () =>
        app.evaluate(
          () => (globalThis as unknown as { cursors: { at: number; type: string }[] }).cursors,
        );
      // The page that opens keeps the page busy for a second, as one that shows a long session can.
      await window.evaluate(`(() => {
        const main = document.querySelector('main');
        const observer = new MutationObserver(() => {
          if (main.querySelector('section') === null) return;
          observer.disconnect();
          const until = Date.now() + 1000;
          while (Date.now() < until) {}
        });
        observer.observe(main, { childList: true, subtree: true });
      })()`);
      const from = await box(row);
      const to = await box(window.getByRole('main'));
      await window.mouse.move(from.x + 20, from.y + from.height / 2);
      await window.mouse.down();
      await window.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await expect.poll(async () => (await cursors()).at(-1)?.type).toBe('grabbing');
      const released = Date.now();
      await window.mouse.up();
      await expect(
        window.getByRole('main').getByRole('region', { name: 'New session' }),
      ).toBeVisible();
      // The pointer left the grabbing hand within a few frames, long before the page was free again.
      const after = (await cursors()).filter((cursor) => cursor.at >= released);
      expect(after[0]?.type).not.toBe('grabbing');
      expect((after[0]?.at ?? Infinity) - released).toBeLessThan(500);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a panel’s header keeps its title whole and lets its detail give way where both do not fit', async () => {
  const data = dataFolder();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-headers-')));
  // A workspace whose name, the detail of the files in it, is longer than any panel's header.
  const folder = join(
    parent,
    'a-workspace-whose-name-is-far-longer-than-a-panel-header-'.repeat(4),
  );
  mkdirSync(folder);
  writeFileSync(join(folder, 'notes.md'), '');
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
      const file = workspace.getByRole('treeitem', { name: 'notes.md', exact: true });
      await file.focus();
      await window.keyboard.press('Enter');
      const header = window
        .getByRole('main')
        .getByRole('region', { name: 'notes.md', exact: true })
        .locator('header');
      const detail = header.locator('small');
      await expect(detail).toHaveText(basename(folder));
      // The folder's name does not fit and is cut short, while the file's name stays whole.
      expect(await overflows(detail)).toBe(true);
      expect(await overflows(header.getByText('notes.md', { exact: true }))).toBe(false);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(parent, { recursive: true, force: true });
  }
});

// Whether the element's text runs past its box, as text cut short with an ellipsis does.
function overflows(locator: Locator) {
  return locator.evaluate((element: Measured) => element.scrollWidth > element.clientWidth);
}

// The page's side of that check, described as far as it needs, since the smoke tests compile for
// Node.js without the DOM's types.
interface Measured {
  scrollWidth: number;
  clientWidth: number;
}
