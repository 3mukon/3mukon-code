import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { answerQuestion, dataFolder, launch, pickFolder } from './app';

// A one-pixel PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('files of common formats open rendered, with a toggle to their raw text, and one that does not parse opens raw', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-rendered-')));
  mkdirSync(join(folder, 'img'));
  writeFileSync(join(folder, 'img', 'pixel.png'), PIXEL);
  writeFileSync(
    join(folder, 'README.md'),
    '# Guide\n\nSee [the settings](settings.json).\n\n![pixel](img/pixel.png)\n',
  );
  writeFileSync(
    join(folder, 'settings.json'),
    '{"theme": "ink", "panels": {"left": {"width": 220}}}',
  );
  writeFileSync(join(folder, 'feed.xml'), '<feed>\n  <title>News</entry>\n</feed>\n');
  writeFileSync(
    join(folder, 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  try {
    const app = await launch(data.path, '--lang=en-US');
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      const workspace = window.getByRole('treeitem', { name: basename(folder), exact: true });
      await workspace.focus();
      await window.keyboard.press('ArrowRight');
      const open = async (name: string) => {
        await workspace.getByRole('treeitem', { name, exact: true }).focus();
        await window.keyboard.press('Enter');
      };
      const main = window.getByRole('main');
      // Markdown renders, its image beside it shown as data, and the toggle sits in its header.
      await open('README.md');
      const readme = main.getByRole('region', { name: 'README.md' });
      await expect(readme.getByRole('heading', { level: 1, name: 'Guide' })).toBeVisible();
      await expect(readme.getByRole('img', { name: 'pixel' })).toHaveAttribute(
        'src',
        /^data:image\/png;base64,/,
      );
      await readme.getByRole('button', { name: 'Raw' }).click();
      await expect(readme.locator('.cm-editor')).toBeVisible();
      await expect(readme.getByRole('heading', { name: 'Guide' })).toHaveCount(0);
      await readme.getByRole('button', { name: 'Rendered' }).click();
      // A link to a file opens it in a panel, where JSON shows as a tree.
      await readme.getByRole('link', { name: 'the settings' }).click();
      const settings = main.getByRole('region', { name: 'settings.json' });
      await expect(settings.getByRole('tree')).toContainText('theme: "ink"');
      await expect(settings.getByRole('button', { name: /left/ })).toContainText('1 entry');
      // XML that does not parse opens raw; its rendered view says where it fails.
      await open('feed.xml');
      const feed = main.getByRole('region', { name: 'feed.xml' });
      await expect(feed.locator('.cm-editor')).toBeVisible();
      await expect(feed.getByRole('button', { name: 'Raw' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await feed.getByRole('button', { name: 'Rendered' }).click();
      await expect(feed).toContainText('This XML doesn’t parse at line 2, column');
      // SVG draws as an image.
      await open('mark.svg');
      await expect(
        main.getByRole('region', { name: 'mark.svg' }).getByRole('img', { name: 'mark.svg' }),
      ).toHaveAttribute('src', /^data:image\/svg\+xml/);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
