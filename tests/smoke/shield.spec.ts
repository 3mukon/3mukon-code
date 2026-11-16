import { expect, test } from '@playwright/test';
import { withApp } from './app';

test('the smoke shield detaches when the native child closes before its parent', async () => {
  await withApp(async (application) => {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
    const remaining = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No test window.');
      const cover = window.getChildWindows().find((child) => !(child instanceof BrowserWindow));
      if (!cover) throw new Error('The test window has no pointer shield.');
      cover.destroy();
      // Model the native callbacks that can still arrive during early shutdown. These used to
      // throw after the child was destroyed, even though the UI assertions had all passed.
      for (const event of ['ready-to-show', 'show', 'move', 'resize']) window.emit(event);
      return { parentAlive: !window.isDestroyed(), children: window.getChildWindows().length };
    });
    expect(remaining).toEqual({ parentAlive: true, children: 0 });
  });
});
