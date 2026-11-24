import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { answerQuestion, dataFolder, launch, pickFolder, withApp } from './app';

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
      parts: [
        'accounts',
        'approvals',
        'automation',
        'browser',
        'computer',
        'files',
        'panels',
        'presentations',
        'prompts',
        'sessions',
        'settings',
        'setup',
        'terminal',
        'workspaces',
      ],
      calls: [
        [
          'browser',
          [
            'bind:function',
            'command:function',
            'onFileDrag:function',
            'onFocus:function',
            'place:function',
            'release:function',
            'snapshot:function',
            'subscribe:function',
            'tabRef:function',
          ],
        ],
        ['computer', ['command:function', 'preview:function']],
        [
          'automation',
          [
            'answer:function',
            'callFrames:function',
            'callRecord:function',
            'capabilities:function',
            'endGrant:function',
            'endOperation:function',
            'icon:function',
            'snapshot:function',
            'stop:function',
            'subscribe:function',
          ],
        ],
        ['presentations', ['artifact:function', 'onMessage:function', 'send:function']],
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
            'act:function',
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
            'search:function',
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
            'image:function',
            'onChange:function',
            'open:function',
            'save:function',
            'watch:function',
          ],
        ],
        ['approvals', ['answerApproval:function', 'answerQuestion:function']],
        ['setup', ['act:function', 'snapshot:function', 'subscribe:function']],
        ['settings', ['get:function', 'initial:object', 'onChange:function', 'set:function']],
        [
          'terminal',
          [
            'close:function',
            'confirmClose:function',
            'onExit:function',
            'onOutput:function',
            'open:function',
            'openLink:function',
            'resize:function',
            'write:function',
          ],
        ],
        [
          'accounts',
          [
            'list:function',
            'onChange:function',
            'reset:function',
            'setShown:function',
            'signIn:function',
          ],
        ],
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

test('Command-B and the sidebar’s button hide the sidebar and show it again', async () => {
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
    // The button keeps its place just after the traffic lights whether the sidebar shows or not.
    const hide = window.getByRole('button', { name: 'Hide Sidebar' });
    const shown = await hide.boundingBox();
    await hide.click();
    await expect(sidebar).toHaveCSS('width', '0px');
    const show = window.getByRole('button', { name: 'Show Sidebar' });
    expect(await show.boundingBox()).toEqual(shown);
    await show.click();
    await expect(sidebar).toHaveCSS('width', '220px');
  });
});

test('the traffic lights are centred in the 40px title bar, on one line with the buttons beside them', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    // The traffic lights, 14pt circles, set 13pt from the top: their centre lies 20pt down, as the
    // sidebar's button's does, centred in the page's title bar.
    const position = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
    );
    expect(position).toEqual({ x: 12, y: 13 });
    const toggle = await window.getByRole('button', { name: 'Hide Sidebar' }).boundingBox();
    if (toggle === null) throw new Error('The sidebar’s button is not shown.');
    expect(toggle.y + toggle.height / 2).toBe(13 + 14 / 2);
    // It lies just after them, the archived sessions' button just after it, then the accounts' gauge
    // and the settings' gear, on the same line.
    expect(toggle.x).toBe(84);
    const button = await window.getByRole('button', { name: 'Archived sessions' }).boundingBox();
    if (button === null) throw new Error('The archived sessions’ button is not shown.');
    expect(button.y + button.height / 2).toBe(13 + 14 / 2);
    expect(button.x).toBe(toggle.x + toggle.width + 4);
    const gauge = await window.getByRole('button', { name: 'Accounts' }).boundingBox();
    if (gauge === null) throw new Error('The accounts’ gauge is not shown.');
    expect(gauge.y + gauge.height / 2).toBe(13 + 14 / 2);
    expect(gauge.x).toBe(button.x + button.width + 4);
    const gear = await window.getByRole('button', { name: 'Settings' }).boundingBox();
    if (gear === null) throw new Error('The settings’ gear is not shown.');
    expect(gear.y + gear.height / 2).toBe(13 + 14 / 2);
    expect(gear.x).toBe(gauge.x + gauge.width + 4);
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

test('the Sessions heading, New session, the workspace filter and the search glass share one centre line', async () => {
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-row-')));
  try {
    const app = await launch(data.path);
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      const sessions = window.getByRole('region', { name: 'Sessions' });
      const parts = [
        sessions.getByRole('heading', { name: 'Sessions' }),
        sessions.getByRole('button', { name: 'New session' }),
        sessions.getByRole('combobox', { name: 'Filter sessions by workspace' }),
        // The filter's own text, which stands on the heading's baseline.
        sessions.locator('span[aria-hidden="true"]').filter({ hasText: /^All$/ }),
        sessions.getByRole('button', { name: 'Search sessions' }),
      ];
      await expect(parts[2] ?? sessions).toBeVisible();
      const middles = await Promise.all(
        parts.map(async (part) => {
          const box = await part.boundingBox();
          if (box === null) throw new Error('A part of the heading’s row is not shown.');
          return box.y + box.height / 2;
        }),
      );
      for (const middle of middles) expect(Math.abs(middle - (middles[0] ?? 0))).toBeLessThan(0.5);
      // The filter's select covers nothing beside its text: the glass takes its own click.
      await sessions.getByRole('button', { name: 'Search sessions' }).click();
      await expect(sessions.getByRole('searchbox', { name: 'Search sessions' })).toBeFocused();
    } finally {
      await app.close();
    }
  } finally {
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
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
