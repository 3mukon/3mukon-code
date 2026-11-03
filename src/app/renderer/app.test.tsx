import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { initialSessionState } from '../../sessions/shared/session-state';
import type { SessionList, SessionSummary } from '../../sessions/shared/sessions';
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
      showMenu: () => Promise.resolve(),
      listFolder: () => Promise.resolve({ entries: [] }),
    },
    sessions: {
      list: () => Promise.resolve(sessionList),
      onChange: () => () => undefined,
      archived: () => Promise.resolve(archived),
      resume: () => Promise.resolve(),
      showMenu: () => Promise.resolve(null),
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
      onEvent: () => () => undefined,
    },
    panels: { itemsAt: () => Promise.resolve([]) },
    files: {
      open: () => Promise.resolve({ kind: 'text', text: '', bom: false }),
      save: () => Promise.resolve({ saved: true }),
      watch: () => Promise.resolve(),
      onChange: () => () => undefined,
      confirmClose: () => Promise.resolve('cancel'),
    },
    approvals: {
      answerApproval: () => Promise.resolve(),
      answerQuestion: () => Promise.resolve(),
    },
    prompts: { onPrompt: () => () => undefined, answer: () => Promise.resolve() },
  };
}

// Opens a popover as the browser would tell it, which happy-dom does not.
function opened(popover: HTMLElement) {
  fireEvent(popover, Object.assign(new Event('toggle'), { oldState: 'closed', newState: 'open' }));
}

// Renders the shell and lets the bridge's first answers arrive.
async function renderApp(bridge = fakeBridge()) {
  await act(async () => {
    render(<App bridge={bridge} />);
    await Promise.resolve();
  });
}

describe('App', () => {
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
    // Just after the archived sessions' button, which keeps its place beside the window buttons; with
    // the sidebar hidden, both lie in the top-left panel's header.
    const named = (element: Element | null | undefined) =>
      [...(element?.querySelectorAll('button') ?? [])].map((button) =>
        button.getAttribute('aria-label'),
      );
    expect(named(within(sidebar).getByRole('button', { name: label }).parentElement)).toEqual([
      'Archived sessions',
      label,
    ]);
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    const header = within(screen.getByRole('main'))
      .getByRole('region', { name: 'Update the docs' })
      .querySelector('header');
    expect(named(header?.firstElementChild)).toEqual(['Archived sessions', label]);
  });

  it('lists archived sessions apart, from the button beside the window buttons, and shows one from there', async () => {
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
    await renderApp(
      fakeBridge({ workspaces: [], selectedId: null }, [
        summary('s1', 'Fix the build', false),
        summary('s2', 'Old idea', true),
      ]),
    );
    const sessions = screen.getByRole('region', { name: 'Sessions' });
    within(sessions).getByText('Fix the build');
    expect(within(sessions).queryByText('Old idea')).toBeNull();
    const button = screen.getByRole('button', { name: 'Archived sessions' });
    expect(button).toHaveProperty('disabled', false);
    const dropdown = document.getElementById(button.getAttribute('popovertarget') ?? '');
    if (dropdown === null) throw new Error('no dropdown');
    opened(dropdown);
    fireEvent.click(await within(dropdown).findByRole('button', { name: /Old idea/ }));
    // Its panel is titled by it, and its page has its provider, though the Sessions list lacks it.
    const panel = within(screen.getByRole('main')).getByRole('region', { name: 'Old idea' });
    await waitFor(() => {
      expect(within(panel).getByText('Codex CLI')).toBeTruthy();
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
