import { _electron as electron, expect, test } from '@playwright/test';

test('the app opens its window on the built page, without Node.js and sandboxed', async () => {
  const electronApp = await electron.launch({ args: ['.'] });
  try {
    const window = await electronApp.firstWindow();
    expect(window.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/);
    await expect(window).toHaveTitle('3mukon-code');

    expect(await window.evaluate(() => [typeof require, typeof process])).toEqual([
      'undefined',
      'undefined',
    ]);
    const sandboxed = await electronApp.evaluate(({ app, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
      return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed;
    });
    expect(sandboxed).toBe(true);
  } finally {
    await electronApp.close();
  }
});

test('Command-B hides the sidebar and shows it again', async () => {
  const electronApp = await electron.launch({ args: ['.'] });
  try {
    const window = await electronApp.firstWindow();
    const sidebar = window.locator('aside');
    await expect(sidebar).toHaveCSS('width', '220px');
    // The sidebar, and with it its divider, starts at the window's top edge, in the title bar.
    expect((await sidebar.boundingBox())?.y).toBe(0);
    await window.keyboard.press('Meta+B');
    await expect(sidebar).toHaveCSS('width', '0px');
    await expect(sidebar).toHaveAttribute('inert');
    await window.keyboard.press('Meta+B');
    await expect(sidebar).toHaveCSS('width', '220px');
    await expect(sidebar).not.toHaveAttribute('inert');
  } finally {
    await electronApp.close();
  }
});

test('the UI is in Simplified Chinese when the app runs in that language', async () => {
  const electronApp = await electron.launch({ args: ['.', '--lang=zh-CN'] });
  try {
    const window = await electronApp.firstWindow();
    await expect(window.getByRole('heading', { name: '会话' })).toBeVisible();
    await expect(window.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  } finally {
    await electronApp.close();
  }
});
