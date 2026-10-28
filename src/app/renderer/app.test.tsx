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
    sessions: { list: () => Promise.resolve(sessions), onChange: () => () => undefined },
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
    expect(newSession).toHaveProperty('disabled', true);
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
