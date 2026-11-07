import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { initialSessionState } from '../../sessions/shared/session-state';
import type { SessionList, SessionSummary } from '../../sessions/shared/sessions';
import type { AppSettings } from '../../settings/shared/settings';
import type { WorkspaceList } from '../../workspaces/shared/workspaces';
import type { Bridge } from '../shared/bridge';
import { App } from './app';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

// A bridge whose main process has these workspaces and sessions, the archived ones apart.
function fakeBridge(
  list: WorkspaceList = { workspaces: [], selectedId: null },
  sessions: SessionSummary[] = [],
): Bridge {
  const archived = sessions.filter((session) => session.archived === true);
  const sessionList: SessionList = {
    sessions: sessions.filter((session) => session.archived !== true),
    archived: archived.length,
    shown: [],
  };
  return {
    workspaces: {
      get: () => Promise.resolve(list),
      onChange: () => () => undefined,
      add: () => Promise.resolve(),
      addDropped: () => Promise.resolve(),
      select: () => Promise.resolve(),
      showMenu: () => Promise.resolve(null),
      listFolder: () => Promise.resolve({ entries: [] }),
    },
    sessions: {
      list: () => Promise.resolve(sessionList),
      onChange: () => () => undefined,
      archived: () => Promise.resolve(archived),
      resume: () => Promise.resolve(),
      showMenu: () => Promise.resolve(null),
      act: () => Promise.resolve(null),
      search: () => Promise.resolve({ matches: [], unread: 0 }),
      providers: () => Promise.resolve(['claude-code']),
      dayFolder: () => Promise.resolve('/Users/me/3mukon-code/2026-10-28'),
      gateways: () => Promise.resolve([]),
      models: () => Promise.resolve([]),
      choices: () => Promise.resolve({ folders: {}, dayRoot: '/Users/me/3mukon-code' }),
      rememberChoice: () => Promise.resolve(),
      confirmYolo: () => Promise.resolve(false),
      start: () => Promise.resolve('s9'),
      send: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      setMode: () => Promise.resolve(false),
      setGateway: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      setEffort: () => Promise.resolve(),
      setSandbox: () => Promise.resolve(),
      copyText: () => Promise.resolve(),
      copyImage: () => Promise.resolve(),
      saveImage: () => Promise.resolve(false),
      imageMenu: () => Promise.resolve(null),
      snapshot: () => Promise.resolve(null),
      preload: () => Promise.resolve(),
      onEvent: () => () => undefined,
    },
    panels: { itemsAt: () => Promise.resolve([]) },
    files: {
      open: () => Promise.resolve({ kind: 'text', text: '', bom: false }),
      save: () => Promise.resolve({ saved: true }),
      watch: () => Promise.resolve(),
      onChange: () => () => undefined,
      confirmClose: () => Promise.resolve('cancel'),
      image: () => Promise.resolve(null),
    },
    approvals: {
      answerApproval: () => Promise.resolve(),
      answerQuestion: () => Promise.resolve(),
    },
    settings: {
      initial: { language: 'system', appearance: 'system', tooltips: false },
      get: () => Promise.resolve({ language: 'system', appearance: 'system', tooltips: false }),
      set: () => Promise.resolve(),
      onChange: () => () => undefined,
    },
    terminal: {
      open: () => Promise.resolve({ id: 't1', cwd: '/Users/me', program: 'zsh' }),
      write: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      onOutput: () => () => undefined,
      onExit: () => () => undefined,
      confirmClose: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      openLink: () => Promise.resolve(),
    },
    accounts: {
      list: () => Promise.resolve({ accounts: [] }),
      onChange: () => () => undefined,
      setShown: () => Promise.resolve(),
      signIn: () => Promise.resolve({ id: 't2', cwd: '/Users/me' }),
      reset: () => Promise.resolve(null),
    },
    prompts: { onPrompt: () => () => undefined, answer: () => Promise.resolve() },
  };
}

// Renders the shell and lets the bridge's first answers arrive.
async function renderApp(bridge = fakeBridge()) {
  await act(async () => {
    render(<App bridge={bridge} />);
    await Promise.resolve();
  });
}

// The frame that ends a drag, after which what it dropped opens.
const dropped = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(resolve);
        });
      }),
  );

describe('App', () => {
  it('opens a terminal with ⌃` in the selected workspace’s folder, beside the focused panel in its folder, and ends one as its panel closes', async () => {
    const bridge = fakeBridge({
      workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
      selectedId: 'w1',
    });
    let next = 0;
    const open = vi.spyOn(bridge.terminal, 'open').mockImplementation((cwd) => {
      next += 1;
      return Promise.resolve({ id: `t${String(next)}`, cwd: cwd ?? '/Users/me', program: 'zsh' });
    });
    const close = vi.spyOn(bridge.terminal, 'close');
    await renderApp(bridge);
    const main = screen.getByRole('main');
    const press = async () => {
      await act(async () => {
        fireEvent.keyDown(window, { key: '`', code: 'Backquote', ctrlKey: true });
        await Promise.resolve();
      });
    };
    await press();
    expect(open.mock.calls).toEqual([['/Users/me/web']]);
    await press();
    expect(open.mock.calls).toEqual([['/Users/me/web'], ['/Users/me/web']]);
    const terminals = within(main).getAllByRole('region', { name: 'Terminal' });
    expect(terminals).toHaveLength(2);
    await act(async () => {
      fireEvent.click(within(terminals[1] ?? main).getByRole('button', { name: 'Close panel' }));
      await Promise.resolve();
    });
    expect(within(main).getAllByRole('region', { name: 'Terminal' })).toHaveLength(1);
    expect(close.mock.calls).toEqual([['t2']]);
  });

  it('opens the accounts from the gauge, whose Sign In runs the provider’s sign-in in a terminal', async () => {
    const bridge = fakeBridge();
    vi.spyOn(bridge.accounts, 'list').mockResolvedValue({
      accounts: [
        { provider: 'codex', signIn: { state: 'signed-out' }, resettable: true, reading: false },
      ],
    });
    const signIn = vi.spyOn(bridge.accounts, 'signIn');
    await renderApp(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    const main = screen.getByRole('main');
    const accounts = within(main).getByRole('region', { name: 'Accounts' });
    await act(async () => {
      fireEvent.click(within(accounts).getByRole('button', { name: 'Sign In' }));
      await Promise.resolve();
    });
    expect(signIn.mock.calls).toEqual([['codex']]);
    expect(within(main).getByRole('region', { name: 'Terminal' })).toBeTruthy();
  });

  it('shows the sidebar beside a blank main area, with no title text', async () => {
    await renderApp();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    within(sidebar).getByText('3mukon-code');
    // Add workspace and New session sit beside their headings as plus icons, and no empty-state text
    // stands in for the workspaces and sessions that do not exist yet.
    const workspaces = within(sidebar).getByRole('region', { name: 'Workspaces' });
    const add = within(workspaces).getByRole('button', { name: 'Add workspace' });
    expect(
      within(workspaces).getByRole('heading', { name: 'Workspaces' }).parentElement?.contains(add),
    ).toBe(true);
    expect(workspaces.textContent).toBe('Workspaces');
    const sessions = within(sidebar).getByRole('region', { name: 'Sessions' });
    const heading = within(sessions).getByRole('heading', { name: 'Sessions' });
    const newSession = within(sessions).getByRole('button', { name: 'New session' });
    expect(heading.parentElement?.contains(newSession)).toBe(true);
    expect(sessions.textContent).toBe('Sessions');
    // The Workspaces section comes first, and a thin line, hidden from VoiceOver, separates the two.
    const line = workspaces.nextElementSibling;
    expect(line?.nextElementSibling).toBe(sessions);
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    expect(line?.className).toContain('border-line');
    // The sidebar's heading is the only place the name appears.
    expect(screen.getAllByText('3mukon-code')).toHaveLength(1);
    expect(screen.getByRole('main').textContent).toBe('');
  });

  it('shows the workspaces and the sessions the bridge reports, and offers the workspaces as filters', async () => {
    await renderApp(
      fakeBridge(
        {
          workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
          selectedId: 'w1',
        },
        [
          {
            id: 's1',
            provider: 'codex',
            sessionId: 'thread-1',
            cwd: '/Users/me/web',
            title: 'Fix the build',
            status: 'running',
            activeAt: 1,
          },
        ],
      ),
    );
    screen.getByRole('treeitem', { name: 'web' });
    within(screen.getByRole('region', { name: 'Sessions' })).getByText('Fix the build');
    const filter = screen.getByRole('combobox', { name: 'Filter sessions by workspace' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All workspaces', 'web']);
  });

  it('opens a tree row in the panel area, whose top-left header clears the window buttons while the sidebar is hidden', async () => {
    await renderApp(
      fakeBridge({
        workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
        selectedId: 'w1',
      }),
    );
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'web' }), {
      key: 'ArrowDown',
      metaKey: true,
    });
    const header = () =>
      within(screen.getByRole('main'))
        .getByRole('region', { name: 'New session' })
        .querySelector('header');
    expect(header()?.className).toContain('pl-5');
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(header()?.className).toContain('pl-[84px]');
  });

  it('opens a session page with New session, in the selected workspace or else the day’s folder', async () => {
    await renderApp(
      fakeBridge({
        workspaces: [{ id: 'w1', name: 'web', path: '/Users/me/web', trusted: true }],
        selectedId: 'w1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const page = within(screen.getByRole('main')).getByRole('region', { name: 'New session' });
    expect(within(page).getByText('web').title).toBe('/Users/me/web');
    within(page).getByRole('textbox', { name: 'Message' });
    cleanup();
    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session' }));
      await Promise.resolve();
    });
    const day = within(screen.getByRole('main')).getByRole('region', { name: 'New session' });
    expect(within(day).getByText('2026-10-28').title).toBe('/Users/me/3mukon-code/2026-10-28');
  });

  it('counts the sessions waiting on the user beside the window buttons, and shows the one that has waited longest', async () => {
    const waiting = (id: string, title: string, waitingSince: number) => ({
      id,
      provider: 'codex' as const,
      sessionId: `thread-${id}`,
      cwd: '/Users/me/web',
      title,
      status: 'waiting' as const,
      activeAt: 1,
      waitingSince,
    });
    await renderApp(
      fakeBridge({ workspaces: [], selectedId: null }, [
        waiting('s1', 'Fix the build', 300),
        waiting('s2', 'Update the docs', 100),
      ]),
    );
    const label = 'Sessions waiting on you: 2. Show the one waiting longest (⇧⌘A).';
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.click(within(sidebar).getByRole('button', { name: label }));
    within(screen.getByRole('main')).getByRole('region', { name: 'Update the docs' });
    // Just after the archived sessions' button and the settings' gear, which keep their places beside
    // the window buttons; with the sidebar hidden, all three lie in the top-left panel's header.
    const named = (element: Element | null | undefined) =>
      [...(element?.querySelectorAll('button') ?? [])].map((button) =>
        button.getAttribute('aria-label'),
      );
    expect(named(within(sidebar).getByRole('button', { name: label }).parentElement)).toEqual([
      'Archived sessions',
      'Accounts',
      'Settings',
      label,
    ]);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    const header = within(screen.getByRole('main'))
      .getByRole('region', { name: 'Update the docs' })
      .querySelector('header');
    expect(named(header?.firstElementChild)).toEqual([
      'Archived sessions',
      'Accounts',
      'Settings',
      label,
    ]);
  });

  it('lists archived sessions apart, in a panel the button beside the window buttons opens, which shows one and acts on it', async () => {
    const summary = (id: string, title: string, archived: boolean): SessionSummary => ({
      id,
      provider: 'codex',
      sessionId: `thread-${id}`,
      cwd: '/Users/me/web',
      title,
      status: 'closed',
      activeAt: 1,
      ...(archived ? { archived: true } : {}),
    });
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      summary('s1', 'Fix the build', false),
      summary('s2', 'Old idea', true),
    ]);
    const act = vi.fn<Bridge['sessions']['act']>(() => Promise.resolve('unarchive'));
    bridge.sessions.act = act;
    await renderApp(bridge);
    const sessions = screen.getByRole('region', { name: 'Sessions' });
    within(sessions).getByText('Fix the build');
    expect(within(sessions).queryByText('Old idea')).toBeNull();
    const main = screen.getByRole('main');
    const button = screen.getByRole('button', { name: 'Archived sessions' });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    const archived = within(main).getByRole('region', { name: 'Archived sessions' });
    expect(within(archived).getByText('1 session')).toBeTruthy();
    // A second click focuses the same panel.
    fireEvent.click(button);
    expect(within(main).getAllByRole('region', { name: 'Archived sessions' })).toHaveLength(1);
    // A session clicked there opens in a panel titled by it, whose page has its provider, though the
    // Sessions list lacks it.
    fireEvent.click(await within(archived).findByRole('button', { name: /Old idea/ }));
    const panel = within(main).getByRole('region', { name: 'Old idea' });
    await waitFor(() => {
      expect(within(panel).getByText('Codex CLI')).toBeTruthy();
    });
    // Its row unarchives it without its menu.
    fireEvent.click(within(archived).getByRole('button', { name: 'Unarchive' }));
    expect(act.mock.calls).toEqual([['s2', 'unarchive']]);
  });

  it('opens the settings in a panel of their own with the gear or ⌘,, and the window takes the language they choose', async () => {
    const bridge = fakeBridge();
    let current: AppSettings = { language: 'system', appearance: 'system', tooltips: false };
    const listeners = new Set<(settings: AppSettings) => void>();
    const set = vi.fn<Bridge['settings']['set']>((change) => {
      current = { ...current, ...change };
      for (const listener of listeners) listener(current);
      return Promise.resolve();
    });
    bridge.settings = {
      initial: current,
      get: () => Promise.resolve(current),
      set,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    await renderApp(bridge);
    const main = screen.getByRole('main');
    const gear = screen.getByRole('button', { name: 'Settings' });
    // The gear lies just after the archived sessions' button and the accounts' gauge, beside the
    // window buttons.
    const gauge = screen.getByRole('button', { name: 'Accounts' });
    expect(screen.getByRole('button', { name: 'Archived sessions' }).nextElementSibling).toBe(
      gauge,
    );
    expect(gauge.nextElementSibling).toBe(gear);
    fireEvent.click(gear);
    const settings = within(main).getByRole('region', { name: 'Settings' });
    expect(fireEvent.keyDown(window, { key: ',', metaKey: true })).toBe(false);
    expect(within(main).getAllByRole('region', { name: 'Settings' })).toHaveLength(1);
    const language = within(settings).getByRole('radiogroup', { name: 'Language' });
    within(language).getByRole('radio', { name: 'System', checked: true });
    // Choosing Simplified Chinese changes the window's language at once.
    await act(async () => {
      fireEvent.click(within(language).getByRole('radio', { name: '简体中文' }));
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledWith({ language: 'zh-Hans' });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: '会话' })).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('zh-Hans');
    await act(async () => {
      fireEvent.click(within(main).getByRole('radio', { name: 'English' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Sessions' })).toBeTruthy();
    });
  });

  it('keeps titling the panel of a session archived while it shows, from the sessions the window has shown', async () => {
    const bridge = fakeBridge();
    const summary: SessionSummary = {
      id: 's1',
      provider: 'codex',
      sessionId: 'thread-1',
      cwd: '/Users/me/web',
      title: 'Fix the build',
      status: 'idle',
      activeAt: 1,
    };
    let report: (list: SessionList) => void = () => undefined;
    bridge.sessions.onChange = (listener) => {
      report = listener;
      return () => undefined;
    };
    await renderApp(bridge);
    act(() => {
      report({ sessions: [summary], archived: 0, shown: [] });
    });
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      }),
    );
    act(() => {
      report({
        sessions: [],
        archived: 1,
        shown: [{ ...summary, status: 'closed', archived: true }],
      });
    });
    const panel = within(screen.getByRole('main')).getByRole('region', { name: 'Fix the build' });
    expect(within(panel).getByText('Codex CLI')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archived sessions' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('offers a session’s menu, and closes the panels of a session removed from the lists', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Fix the build',
        status: 'idle',
        activeAt: 1,
      },
    ]);
    const asked: string[] = [];
    let done: 'archive' | 'remove' | null = 'archive';
    bridge.sessions.showMenu = (id) => {
      asked.push(id);
      return Promise.resolve(done);
    };
    await renderApp(bridge);
    const row = () =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      });
    fireEvent.click(row());
    const shown = () =>
      within(screen.getByRole('main')).queryAllByRole('region', { name: 'Fix the build' });
    expect(shown()).toHaveLength(1);
    // Archived, a session keeps its panel; removed, it loses it.
    await act(async () => {
      fireEvent.contextMenu(row());
      await Promise.resolve();
    });
    expect(shown()).toHaveLength(1);
    done = 'remove';
    await act(async () => {
      fireEvent.contextMenu(row());
      await Promise.resolve();
    });
    expect(asked).toEqual(['s1', 's1']);
    expect(shown()).toHaveLength(0);
  });

  it('shows the request that has waited longest with ⇧⌘A, with the focus on it, and the next waiting session’s at the next press', async () => {
    const waiting = (id: string, title: string, waitingSince: number): SessionSummary => ({
      id,
      provider: 'codex',
      sessionId: `thread-${id}`,
      cwd: '/Users/me/web',
      title,
      status: 'waiting',
      activeAt: 1,
      waitingSince,
    });
    const since: Record<string, number> = { s1: 300, s2: 100 };
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      waiting('s1', 'Fix the build', 300),
      waiting('s2', 'Update the docs', 100),
    ]);
    bridge.sessions.snapshot = (id) =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          turnRunning: true,
          timeline: [
            {
              type: 'approval',
              request: {
                id: `r-${id}`,
                action: 'command',
                command: `run ${id}`,
                canAllowForSession: false,
                denyByDefault: false,
                requestedAt: since[id] ?? 0,
              },
            },
          ],
        },
      });
    await renderApp(bridge);
    const press = () =>
      act(async () => {
        fireEvent.keyDown(window, { key: 'A', metaKey: true, shiftKey: true });
        await Promise.resolve();
      });
    const focusedIn = (title: string) =>
      within(screen.getByRole('main'))
        .getByRole('region', { name: title })
        .contains(document.activeElement);
    await press();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Run this command?');
    });
    expect(focusedIn('Update the docs')).toBe(true);
    await press();
    await waitFor(() => {
      expect(focusedIn('Fix the build')).toBe(true);
    });
    expect(document.activeElement?.textContent).toContain('run s1');
  });

  it('gives the focus to the waiting request in the first of the panels that show its session', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Fix the build',
        status: 'waiting',
        activeAt: 1,
        waitingSince: 100,
      },
    ]);
    bridge.sessions.snapshot = () =>
      Promise.resolve({
        seq: 0,
        state: {
          ...initialSessionState(),
          turnRunning: true,
          timeline: [
            {
              type: 'approval',
              request: {
                id: 'r1',
                action: 'command',
                command: 'run s1',
                canAllowForSession: false,
                denyByDefault: false,
                requestedAt: 100,
              },
            },
          ],
        },
      });
    await renderApp(bridge);
    // happy-dom lays nothing out, so the main area and each panel in it measure 1000 by 600 pixels.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });
    const row = () =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      });
    for (const clientX of [500, 990]) {
      fireEvent.pointerDown(row(), { pointerId: 1, button: 0, clientX: -100, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX, clientY: 300 });
      fireEvent.click(row());
      await dropped();
    }
    const [first, second] = within(screen.getByRole('main')).getAllByRole('region', {
      name: 'Fix the build',
    });
    await waitFor(() => {
      expect(second?.textContent).toContain('run s1');
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'A', metaKey: true, shiftKey: true });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Run this command?');
    });
    expect(first?.contains(document.activeElement)).toBe(true);
    expect(first?.getAttribute('aria-current')).toBe('true');
  });

  it('shows a session clicked in the list in a panel of its own, titled by the session', async () => {
    await renderApp(
      fakeBridge({ workspaces: [], selectedId: null }, [
        {
          id: 's1',
          provider: 'codex',
          sessionId: 'thread-1',
          cwd: '/Users/me/web',
          title: 'Fix the build',
          status: 'running',
          activeAt: 1,
        },
      ]),
    );
    const row = () =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', {
        name: /Fix the build/,
      });
    fireEvent.click(row());
    const panel = within(screen.getByRole('main')).getByRole('region', { name: 'Fix the build' });
    expect(panel.textContent).toContain('Running');
    // A second click shows the same panel.
    fireEvent.click(row());
    expect(
      within(screen.getByRole('main')).getAllByRole('region', { name: 'Fix the build' }),
    ).toHaveLength(1);
  });

  it('drags sessions from the list into the panel area, one into several panels as files go, and has the history of one that is not running read ahead', async () => {
    const bridge = fakeBridge({ workspaces: [], selectedId: null }, [
      {
        id: 's1',
        provider: 'codex',
        sessionId: 'thread-1',
        cwd: '/Users/me/web',
        title: 'Fix the build',
        status: 'closed',
        activeAt: 2,
      },
      {
        id: 's2',
        provider: 'claude-code',
        sessionId: 'p2',
        cwd: '/Users/me/web',
        title: 'Write the docs',
        status: 'running',
        activeAt: 1,
      },
    ]);
    const preload = vi.fn<Bridge['sessions']['preload']>(() => Promise.resolve());
    bridge.sessions.preload = preload;
    await renderApp(bridge);
    // happy-dom lays nothing out, so the main area and each panel in it measure 1000 by 600 pixels.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });
    const row = (name: RegExp) =>
      within(screen.getByRole('region', { name: 'Sessions' })).getByRole('button', { name });
    // A press on a row in the sidebar, dragged to a point in the main area and let go there, with the
    // click the browser gives the release, until the session has opened.
    const dragIn = async (name: RegExp, clientX: number, clientY: number) => {
      fireEvent.pointerDown(row(name), { pointerId: 1, button: 0, clientX: -100, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX, clientY });
      fireEvent.pointerUp(window, { pointerId: 1, clientX, clientY });
      fireEvent.click(row(name));
      await dropped();
    };

    // A press reads the history at once; a running session has none to read.
    for (const name of [/Write the docs/, /Fix the build/]) {
      fireEvent.pointerDown(row(name), { pointerId: 1, button: 0 });
      fireEvent.pointerUp(window, { pointerId: 1 });
    }
    expect(preload.mock.calls).toEqual([['s1']]);

    // Dragged to the empty area, a session fills it; near its panel's edge, it opens again beside it,
    // and the release's click does not show the first.
    expect(row(/Fix the build/).hasAttribute('draggable')).toBe(false);
    await dragIn(/Fix the build/, 500, 300);
    const main = screen.getByRole('main');
    within(main).getByRole('region', { name: 'Fix the build' });
    await dragIn(/Fix the build/, 990, 300);
    const panels = within(main).getAllByRole('region', { name: 'Fix the build' });
    expect(panels.map((panel) => panel.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('hides the sidebar with Command-B and shows it again', async () => {
    await renderApp();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(false);
  });

  it('leaves B without Command, or with another modifier, alone', async () => {
    await renderApp();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'b', metaKey: true, altKey: true });
    expect(sidebar.hasAttribute('inert')).toBe(false);
  });
});
