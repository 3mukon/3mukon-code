import { _electron as electron, expect, test } from '@playwright/test';

test('the app opens its window on the built page, without Node.js and sandboxed', async () => {
  const electronApp = await electron.launch({ args: ['.'] });
  try {
    const window = await electronApp.firstWindow();
    expect(window.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/);
    await expect(window).toHaveTitle('3mukon-code');
    await expect(window.getByRole('heading', { name: '3mukon-code' })).toBeVisible();

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
