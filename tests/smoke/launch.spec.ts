import { homedir } from 'node:os';
import { join } from 'node:path';
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
      parts: ['approvals', 'files', 'panels', 'prompts', 'sessions', 'workspaces'],
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
        [
          'sessions',
          [
            'archived:function',
            'choices:function',
            'confirmYolo:function',
            'copyImage:function',
            'copyText:function',
            'dayFolder:function',
            'gateways:function',
            'imageMenu:function',
            'interrupt:function',
            'list:function',
            'models:function',
            'onChange:function',
            'onEvent:function',
            'preload:function',
            'providers:function',
            'rememberChoice:function',
            'resume:function',
            'saveImage:function',
            'send:function',
            'setEffort:function',
            'setGateway:function',
            'setMode:function',
            'setModel:function',
            'setSandbox:function',
            'showMenu:function',
            'snapshot:function',
            'start:function',
          ],
        ],
        ['panels', ['itemsAt:function']],
        [
          'files',
          [
            'confirmClose:function',
            'onChange:function',
            'open:function',
            'save:function',
            'watch:function',
          ],
        ],
        ['approvals', ['answerApproval:function', 'answerQuestion:function']],
        ['prompts', ['answer:function', 'onPrompt:function']],
      ],
      electron: [],
    });
    // The sessions answer through the bridge without starting anything: the providers the app
    // composed, Codex among them once the toolset runs, and the day's folder for a first session
    // page, which is not made until a session starts there.
    const answers = await window.evaluate(async () => {
      const page = globalThis as unknown as {
        bridge: { sessions: { providers(): Promise<string[]>; dayFolder(): Promise<string> } };
      };
      return {
        providers: await page.bridge.sessions.providers(),
        dayFolder: await page.bridge.sessions.dayFolder(),
      };
    });
    expect(answers.providers).toEqual(['claude-code', 'codex', 'grok-build']);
    expect(answers.dayFolder).toMatch(
      new RegExp(`^${join(homedir(), '3mukon-code')}/\\d{4}-\\d{2}-\\d{2}$`),
    );
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

test('the traffic lights are centred in the 40px title bar, on one line with the buttons beside them', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    // The traffic lights, 14pt circles, set 13pt from the top: their centre lies 20pt down, as the
    // archived sessions' button's does, centred in the page's title bar.
    const position = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
    );
    expect(position).toEqual({ x: 12, y: 13 });
    const button = await window.getByRole('button', { name: 'Archived sessions' }).boundingBox();
    if (button === null) throw new Error('The archived sessions’ button is not shown.');
    expect(button.y + button.height / 2).toBe(13 + 14 / 2);
    // It lies just after them.
    expect(button.x).toBe(84);
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
