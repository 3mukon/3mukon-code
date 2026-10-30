import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { SessionSummary } from '../../sessions/shared/sessions';
import type { WorkspaceList } from '../../workspaces/shared/workspaces';
import type { Bridge } from '../shared/bridge';
import { App } from './app';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

function fakeBridge(
  list: WorkspaceList = { workspaces: [], selectedId: null },
  sessions: SessionSummary[] = [],
): Bridge {
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
      list: () => Promise.resolve(sessions),
      onChange: () => () => undefined,
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
  };
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
            openedAt: 1,
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
          openedAt: 1,
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
