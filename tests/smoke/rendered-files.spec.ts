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
    [
      '# Guide',
      'See [the settings](settings.json).',
      '![pixel](img/pixel.png)',
      'Use `inline code` in a sentence.',
      '```\nfirst line\nsecond line\n```',
      '```text\nfirst line\nsecond line\n```',
      '```ts\nconst answer = 42;\n```',
      '    indented first line\n    indented second line',
      '> A quote with `nested code`.',
      '| Name | Value |\n| --- | --- |\n| `example` | Paper |',
    ].join('\n\n'),
  );
  writeFileSync(join(folder, 'table.csv'), 'Name,Value\nExample,Paper\n');
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
      const blocks = readme.locator('article pre > code');
      await expect(blocks).toHaveCount(4);
      for (const appearance of ['light', 'dark'] as const) {
        await window.emulateMedia({ colorScheme: appearance });
        const well = appearance === 'light' ? 'rgb(226, 224, 217)' : 'rgb(28, 27, 26)';
        // Opaque fills retain the paper's grain, including inline code nested in a quote or table.
        for (const surface of await readme
          .locator('article pre, article blockquote, article th, article :not(pre) > code')
          .all()) {
          await expect(surface).toHaveCSS('background-color', well);
          await expect(surface).toHaveCSS('background-image', /url\(/);
        }
        // Language labels must not decide whether a block gets the inline-code inset and fill.
        for (const block of await blocks.all()) {
          await expect(block).toHaveCSS('padding', '0px');
          await expect(block).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await expect(block).toHaveCSS('background-image', 'none');
        }
        await expect(readme.getByText('inline code', { exact: true })).toHaveCSS(
          'padding',
          '1px 4px',
        );
      }
      await readme.getByRole('button', { name: 'Raw' }).click();
      await expect(readme.locator('.cm-editor')).toBeVisible();
      await expect(readme.getByRole('heading', { name: 'Guide' })).toHaveCount(0);
      // ⌘F opens the editor's search bar at its top, which counts the matches, finds the next with
      // Return and closes at Escape.
      await window.keyboard.press('Meta+f');
      const find = readme.getByRole('textbox', { name: 'Find' });
      await expect(find).toBeFocused();
      await window.keyboard.type('second line');
      const count = readme.locator('.cm-search').getByRole('status');
      await expect(count).toHaveText('3 found');
      await window.keyboard.press('Enter');
      await expect(count).toHaveText('1 of 3');
      await window.keyboard.press('Escape');
      await expect(find).toHaveCount(0);
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
      await open('table.csv');
      await expect(
        main.getByRole('region', { name: 'table.csv' }).getByRole('columnheader').first(),
      ).toHaveCSS('background-image', /url\(/);
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
