import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { answerQuestion, dataFolder, launch, pickFolder } from './app';

test('a workspace added with its trust answer is selected, opens into its tree and is kept after a restart', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-workspace-')));
  mkdirSync(join(folder, '.git'));
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'README.md'), '');
  const name = `${basename(folder)}, Untrusted`;
  try {
    let app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Don’t Trust');
      const workspace = window.getByRole('treeitem', { name, exact: true });
      await expect(workspace).toHaveAttribute('aria-selected', 'true');
      await expect(workspace.locator('> div')).toHaveAttribute('title', folder);
      // The tree opens from the keyboard, with folders first and without .git.
      await workspace.focus();
      await window.keyboard.press('ArrowRight');
      const entries = workspace.getByRole('group').getByRole('treeitem');
      await expect(entries).toHaveCount(2);
      await expect(entries.nth(0)).toHaveAttribute('aria-label', 'src');
      await expect(entries.nth(1)).toHaveAttribute('aria-label', 'README.md');
    } finally {
      await app.close();
    }

    app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await expect(window.getByRole('treeitem', { name, exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a workspace’s menu is drawn in the window, stays as the press that opened it is released, and changes the trust answer', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-workspace-menu-')));
  try {
    const app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      const line = window
        .getByRole('treeitem', { name: basename(folder), exact: true })
        .locator('> div');
      const lineBox = await line.boundingBox();
      if (lineBox === null) throw new Error('The workspace is not listed.');
      // The menu shows while the button is still down, as a person right-clicks, and stays as it
      // comes up.
      await window.mouse.move(lineBox.x + 20, lineBox.y + lineBox.height / 2);
      await window.mouse.down({ button: 'right' });
      const menu = window.getByRole('menu');
      await expect(menu).toBeVisible();
      await window.mouse.up({ button: 'right' });
      await expect(menu).toBeVisible();
      const trusted = menu.getByRole('menuitemcheckbox', { name: 'Trusted' });
      await expect(trusted).toHaveAttribute('aria-checked', 'true');
      await expect(menu.getByRole('menuitem')).toHaveText(['Remove Workspace']);
      await trusted.click();
      await expect(menu).toHaveCount(0);
      await expect(
        window.getByRole('treeitem', { name: `${basename(folder)}, Untrusted`, exact: true }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a click opens and closes a workspace, a double click selects it, and the filter lists the workspaces just below itself', async () => {
  const data = dataFolder();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-workspaces-')));
  const folders = ['web', 'api'].map((name) => join(parent, name));
  for (const folder of folders) mkdirSync(join(folder, 'src'), { recursive: true });
  try {
    const app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      for (const folder of folders) {
        await pickFolder(app, folder);
        await window.getByRole('button', { name: 'Add workspace' }).click();
        await answerQuestion(window, 'Trust');
        await expect(
          window.getByRole('treeitem', { name: basename(folder), exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
      }
      const web = window.getByRole('treeitem', { name: 'web', exact: true });
      const line = web.locator('> div');
      await line.click();
      await expect(web).toHaveAttribute('aria-expanded', 'true');
      await line.click();
      await expect(web).toHaveAttribute('aria-expanded', 'false');
      await expect(web).toHaveAttribute('aria-selected', 'false');
      // A double click selects the workspace without opening or closing it, even for a moment, closed
      // or open.
      expect(await doubleClickAtHumanPace(window, web)).toEqual([]);
      await expect(web).toHaveAttribute('aria-selected', 'true');
      await expect(web).toHaveAttribute('aria-expanded', 'false');
      await line.click();
      await expect(web).toHaveAttribute('aria-expanded', 'true');
      expect(await doubleClickAtHumanPace(window, web)).toEqual([]);
      await expect(web).toHaveAttribute('aria-expanded', 'true');

      // The filter's list opens just below it, from its left edge, which stays where it is whatever
      // the filter shows.
      const filter = window.getByRole('combobox', { name: 'Filter sessions by workspace' });
      const closed = await box(filter);
      await filter.click();
      const options = window.getByRole('option');
      await expect(options).toHaveText(['All workspaces', 'web', 'api']);
      const first = await box(options.first());
      expect(first.y).toBeGreaterThanOrEqual(closed.y + closed.height);
      expect(first.y).toBeLessThan(closed.y + closed.height + 12);
      expect(first.x).toBeGreaterThanOrEqual(closed.x);
      expect(first.x).toBeLessThan(closed.x + 8);
      await options.nth(1).click();
      await expect(options.first()).toBeHidden();
      expect((await box(filter)).x).toBe(closed.x);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(parent, { recursive: true, force: true });
  }
});

// Double-clicks a workspace's row as a person does, holding each press 60ms with 80ms between the
// first click and the second press, and returns each value its aria-expanded took meanwhile and in the
// 300ms after, which outlast the time a click waits for a second press.
async function doubleClickAtHumanPace(window: Page, row: Locator): Promise<string[]> {
  await row.evaluate((element: Watched) => {
    const page = globalThis as unknown as Observers;
    const values: string[] = [];
    new page.MutationObserver(() => {
      values.push(element.getAttribute('aria-expanded') ?? '');
    }).observe(element, { attributes: true, attributeFilter: ['aria-expanded'] });
    element.values = values;
  });
  const line = await box(row.locator('> div'));
  await window.mouse.move(line.x + 40, line.y + line.height / 2);
  await window.mouse.down({ clickCount: 1 });
  await window.waitForTimeout(60);
  await window.mouse.up({ clickCount: 1 });
  await window.waitForTimeout(80);
  await window.mouse.down({ clickCount: 2 });
  await window.waitForTimeout(60);
  await window.mouse.up({ clickCount: 2 });
  await window.waitForTimeout(300);
  return row.evaluate((element: Watched) => element.values ?? []);
}

// The page's side of that check, described as far as it needs, since the smoke tests compile for
// Node.js without the DOM's types.
interface Watched {
  getAttribute(name: string): string | null;
  values?: string[];
}
interface Observers {
  MutationObserver: new (callback: () => void) => {
    observe(target: Watched, options: { attributes: boolean; attributeFilter: string[] }): void;
  };
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('The element is not shown.');
  return found;
}
