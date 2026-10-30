import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { answerDialogs, dataFolder, launch } from './app';

// Answers the next questions in native sheets with the button at this index, and counts them.
async function answerSheets(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, response) => {
    const asked = globalThis as unknown as { sheets?: number };
    asked.sheets = 0;
    dialog.showMessageBox = () => {
      asked.sheets = (asked.sheets ?? 0) + 1;
      return Promise.resolve({ response, checkboxChecked: false });
    };
    dialog.showMessageBoxSync = () => {
      asked.sheets = (asked.sheets ?? 0) + 1;
      return response;
    };
  }, response);
}

const sheetsAsked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { sheets?: number }).sheets ?? 0);

test('a file opened from a tree is edited, saved with ⌘S, follows changes on disk and asks before unsaved changes go', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-files-')));
  const notes = join(folder, 'notes.ts');
  writeFileSync(notes, 'const a = 1;\n');
  writeFileSync(join(folder, 'image.bin'), Buffer.from([0x89, 0x00, 0x01]));
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
      const main = window.getByRole('main');

      // Return on a file's row opens it in an editor.
      await row('notes.ts').focus();
      await window.keyboard.press('Enter');
      const panel = main.getByRole('region', { name: 'notes.ts' });
      const editor = panel.getByRole('textbox', { name: 'notes.ts' });
      await expect(editor).toContainText('const a = 1;');

      // Typing marks the panel's unsaved changes, and ⌘S saves them.
      await editor.click();
      await window.keyboard.press('Meta+ArrowDown');
      await window.keyboard.type('const b = 2;');
      await expect(panel.getByText('Unsaved changes')).toHaveCount(1);
      await window.keyboard.press('Meta+s');
      await expect.poll(() => readFileSync(notes, 'utf8')).toBe('const a = 1;\nconst b = 2;');
      await expect(panel.getByText('Unsaved changes')).toHaveCount(0);

      // A change on disk shows at once; under unsaved changes, the editor offers to reload it.
      writeFileSync(notes, 'const c = 3;\n');
      await expect(editor).toContainText('const c = 3;');
      await window.keyboard.type('// mine');
      writeFileSync(notes, 'const d = 4;\n');
      await expect(panel.getByText('This file changed on disk.')).toBeVisible();
      await expect(editor).toContainText('// mine');
      await panel.getByRole('button', { name: 'Reload' }).click();
      await expect(editor).not.toContainText('// mine');
      await expect(editor).toContainText('const d = 4;');

      // Closing the panel with unsaved changes asks first; Don't Save closes it as it is.
      await editor.click();
      await window.keyboard.type('x');
      await answerSheets(app, 2);
      await window.keyboard.press('Meta+w');
      await expect(panel).toHaveCount(0);
      expect(await sheetsAsked(app)).toBe(1);
      expect(readFileSync(notes, 'utf8')).toBe('const d = 4;\n');

      // A file that is not text opens as a notice.
      await row('image.bin').focus();
      await window.keyboard.press('Enter');
      await expect(
        main.getByText('image.bin isn’t a text file, so it can’t be edited here.'),
      ).toBeVisible();

      // While an editor holds unsaved changes, the window asks before it closes: Cancel keeps it.
      await row('notes.ts').focus();
      await window.keyboard.press('Enter');
      await editor.click();
      await window.keyboard.type('y');
      await answerSheets(app, 0);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
      await expect.poll(() => sheetsAsked(app)).toBe(1);
      await expect(editor).toContainText('y');
      await answerSheets(app, 1);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
        .toBe(0);
      expect(readFileSync(notes, 'utf8')).toBe('const d = 4;\n');
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
