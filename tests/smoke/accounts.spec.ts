import { expect, test } from '@playwright/test';
import { dataFolder, launchIsolated } from './app';

test('the Accounts panel opens from the gauge and says which providers are not signed in, as session pages do', async () => {
  const data = dataFolder();
  try {
    const app = await launchIsolated(data.path);
    try {
      const window = await app.firstWindow();
      await window.getByRole('button', { name: 'Accounts' }).click();
      const main = window.getByRole('main');
      const accounts = main.getByRole('region', { name: 'Accounts' });
      await expect(accounts).toHaveAttribute('aria-current', 'true');
      // Each provider reads its own settings, which sign it in to nothing here.
      const rows = accounts.getByRole('listitem');
      await expect(rows).toHaveCount(3);
      for (const provider of ['Claude Code', 'Codex CLI']) {
        const row = rows.filter({ hasText: provider });
        await expect(row).toContainText('Not signed in', { timeout: 30_000 });
        await expect(row.getByRole('button', { name: 'Sign In' })).toBeVisible();
      }
      // Opening the panel again focuses the one there.
      await window.getByRole('button', { name: 'Accounts' }).click();
      await expect(main.getByRole('region', { name: 'Accounts' })).toHaveCount(1);
      // A session page marks its provider as not signed in, and offers the sign-in.
      await window.getByRole('button', { name: 'New session' }).click();
      const page = main.getByRole('region', { name: 'New session' });
      await expect(page).toContainText('Claude Code is not signed in.');
      await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
  }
});
