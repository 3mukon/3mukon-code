import { expect, test } from '@playwright/test';
import { withApp } from './app';

test('the app opens its window on the built page, without Node.js and sandboxed', async () => {
  await withApp(async (electronApp) => {
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
  });
});

test('the page reaches the main process only through the bridge’s functions', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    const bridge = await window.evaluate(() => {
      const page = globalThis as unknown as Record<string, unknown>;
      const parts = page.bridge as Record<string, Record<string, unknown>>;
      return {
        parts: Object.keys(parts).sort(),
        calls: Object.entries(parts).map(([name, part]) => [
          name,
          Object.entries(part)
            .map(([call, value]) => `${call}:${typeof value}`)
            .sort(),
        ]),
        electron: ['ipcRenderer', 'electron', 'webUtils'].filter((name) => name in page),
      };
    });
    expect(bridge).toEqual({
      parts: ['panels', 'sessions', 'workspaces'],
      calls: [
        [
          'workspaces',
          [
            'add:function',
            'addDropped:function',
            'get:function',
            'listFolder:function',
            'onChange:function',
            'select:function',
            'showMenu:function',
          ],
        ],
        ['sessions', ['list:function', 'onChange:function']],
        ['panels', ['itemsAt:function']],
      ],
      electron: [],
    });
  });
});

test('Command-B hides the sidebar and shows it again', async () => {
  await withApp(async (electronApp) => {
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
  });
});

test('Add workspace and New session are plus icons just after their headings, on their rows', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
    for (const [name, label] of [
      ['Workspaces', 'Add workspace'],
      ['Sessions', 'New session'],
    ] as const) {
      const heading = await window.getByRole('heading', { name }).boundingBox();
      const button = await window.getByRole('button', { name: label }).boundingBox();
      if (!heading || !button) throw new Error(`${name} or ${label} is not shown`);
      expect(Math.abs(middle(button) - middle(heading))).toBeLessThan(2);
      const gap = button.x - (heading.x + heading.width);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(10);
    }
    // The Workspaces section comes above the Sessions section.
    const workspaces = await window.getByRole('heading', { name: 'Workspaces' }).boundingBox();
    const sessions = await window.getByRole('heading', { name: 'Sessions' }).boundingBox();
    expect(workspaces?.y).toBeLessThan(sessions?.y ?? 0);
  });
});

test('the sidebar heading is bold and sits just below the title bar', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    const heading = window.getByText('3mukon-code');
    await expect(heading).toHaveCSS('font-weight', '700');
    const box = await heading.boundingBox();
    expect(box?.y).toBeGreaterThanOrEqual(40);
    expect(box?.y).toBeLessThan(48);
  });
});

test('the UI is in Simplified Chinese when the app runs in that language', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    await expect(window.getByRole('heading', { name: '会话' })).toBeVisible();
    await expect(window.getByRole('heading', { name: '工作区' })).toBeVisible();
    await expect(window.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  }, '--lang=zh-CN');
});
