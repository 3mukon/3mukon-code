import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { dataFolder, launch } from './app';

// Stands in for the user in the native folder picker and trust question, which a test cannot click:
// the picker chooses the folder, and the question gets the answer.
async function answerDialogs(app: ElectronApplication, folder: string, trust: boolean) {
  await app.evaluate(
    ({ dialog }, { folder, trust }) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = () =>
        Promise.resolve({ response: trust ? 0 : 1, checkboxChecked: false });
    },
    { folder, trust },
  );
}

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
      await answerDialogs(app, folder, false);
      await window.getByRole('button', { name: 'Add workspace' }).click();
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
      // The filter offers the workspace.
      const filter = window.getByRole('combobox', { name: 'Filter sessions by workspace' });
      await expect(filter.getByRole('option')).toHaveText(['All workspaces', basename(folder)]);
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
