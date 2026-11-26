import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { answerQuestion, dataFolder, launch, pickFolder, secondCopy, withApp } from './app';

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
    expect(answers.providers).toEqual(['claude-code', 'codex', 'grok-build', 'antigravity']);
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

test('the buttons beside the traffic lights take presses whether the sidebar shows or not, a panel is open or none', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    // A press in a draggable part of the page moves the window instead, and on macOS Electron applies
    // the page's draggable and non-draggable parts in the document's order, each over those before it.
    // Playwright's presses go to the page itself, past that, so this applies the rule at each button's
    // centre: whether a draggable part there comes after every non-draggable one.
    const draggable = () =>
      window.evaluate(() => {
        const names = ['Hide Sidebar', 'Show Sidebar', 'Archived sessions', 'Accounts', 'Settings'];
        return [...document.querySelectorAll('button')]
          .filter((button) => names.includes(button.getAttribute('aria-label') ?? ''))
          .map((button) => {
            const box = button.getBoundingClientRect();
            const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
            let drags = false;
            for (const element of document.querySelectorAll('*')) {
              const style = getComputedStyle(element);
              const region =
                style.getPropertyValue('app-region') ||
                style.getPropertyValue('-webkit-app-region');
              if (region !== 'drag' && region !== 'no-drag') continue;
              const part = element.getBoundingClientRect();
              if (x < part.left || x >= part.right || y < part.top || y >= part.bottom) continue;
              drags = region === 'drag';
            }
            return `${button.getAttribute('aria-label') ?? ''}: ${drags ? 'moves the window' : 'pressed'}`;
          });
      });
    const pressed = (toggle: string) => [
      `${toggle}: pressed`,
      'Archived sessions: pressed',
      'Accounts: pressed',
      'Settings: pressed',
    ];
    const sidebar = window.locator('aside');
    await window.getByRole('button', { name: 'Hide Sidebar' }).waitFor();
    expect(await draggable()).toEqual(pressed('Hide Sidebar'));
    await window.keyboard.press('Meta+B');
    await expect(sidebar).toHaveCSS('width', '0px');
    // No panel is open: the empty strip of the panel area lies beneath them.
    expect(await draggable()).toEqual(pressed('Show Sidebar'));
    await window.keyboard.press('Meta+B');
    await expect(sidebar).toHaveCSS('width', '220px');
    await window.getByRole('button', { name: 'New session' }).click();
    await window.keyboard.press('Meta+B');
    await expect(sidebar).toHaveCSS('width', '0px');
    // The header of the panel at the top left lies beneath them.
    expect(await draggable()).toEqual(pressed('Show Sidebar'));
  });
});

test('as the sidebar closes and opens, the top-left panel’s title never passes beneath the buttons beside the traffic lights', async () => {
  await withApp(async (electronApp) => {
    const window = await electronApp.firstWindow();
    await window.getByRole('button', { name: 'New session' }).click();
    await window.getByRole('main').getByRole('region', { name: 'New session' }).waitFor();
    // Presses the sidebar's button and, at every frame until the sidebar has stopped moving, measures
    // how far the panel's title starts after the traffic lights, which take the title bar's first 84
    // points, and the buttons just after them, wherever they are then; the least of it.
    const leastGap = (button: string) =>
      window.evaluate(async (name) => {
        const toggle = () =>
          document.querySelector(
            'button[aria-label="Hide Sidebar"], button[aria-label="Show Sidebar"]',
          );
        const title = () =>
          document.querySelector('main section header > span.touch-none > .truncate');
        const press = document.querySelector(`button[aria-label="${name}"]`);
        if (!(press instanceof HTMLElement) || title() === null)
          throw new Error('Nothing to measure.');
        let least = Infinity;
        const end = performance.now() + 600;
        press.click();
        await new Promise<void>((done) => {
          const measure = () => {
            const beside = toggle()?.parentElement?.getBoundingClientRect().right ?? 84;
            const left = title()?.getBoundingClientRect().left ?? Infinity;
            least = Math.min(least, left - Math.max(84, beside));
            if (performance.now() < end) requestAnimationFrame(measure);
            else done();
          };
          measure();
        });
        return least;
      }, button);
    expect(await leastGap('Hide Sidebar')).toBeGreaterThanOrEqual(0);
    expect(await leastGap('Show Sidebar')).toBeGreaterThanOrEqual(0);
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

test('a second copy on the same data folder quits before opening a window, and the first comes forward', async () => {
  const data = dataFolder();
  const app = await launch(data.path);
  const minimized = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.isMinimized()),
    );
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize();
    });
    await expect.poll(minimized).toEqual([true]);
    expect(await secondCopy(app, data.path)).toBe(0);
    // The first copy's one window is back, and no other opened.
    await expect.poll(minimized).toEqual([false]);
  } finally {
    await app.close();
    data.remove();
  }
});
