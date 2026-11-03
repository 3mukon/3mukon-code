import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { ArchivedSessions } from './archived-sessions';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const archived: SessionSummary[] = [
  {
    id: 's1',
    provider: 'codex',
    sessionId: 'thread-1',
    cwd: '/Users/me/web',
    title: 'Fix the build',
    status: 'closed',
    activeAt: 2,
    archived: true,
  },
  {
    id: 's2',
    provider: 'grok-build',
    sessionId: 'grok-1',
    cwd: '/Users/me/api',
    status: 'closed',
    activeAt: 1,
    archived: true,
  },
];

// A bridge that loads the main process's archived sessions, which the test sets, counting each load.
function fakeBridge() {
  const main = { sessions: archived };
  const bridge = {
    archived: vi.fn<SessionsBridge['archived']>(() => Promise.resolve(main.sessions)),
  };
  return { main, bridge };
}

const button = () => screen.getByRole('button', { name: 'Archived sessions' });
const dropdown = () => {
  const found = document.getElementById(button().getAttribute('popovertarget') ?? '');
  if (found === null) throw new Error('no dropdown');
  return found;
};

// Opens or closes the dropdown as the browser would tell it, which happy-dom does not, and lets a load
// it asks for arrive.
async function toggle(newState: 'open' | 'closed') {
  const oldState = newState === 'open' ? 'closed' : 'open';
  await act(async () => {
    fireEvent(dropdown(), Object.assign(new Event('toggle'), { oldState, newState }));
    await Promise.resolve();
  });
}

const rows = () =>
  within(dropdown())
    .queryAllByRole('button')
    .map((row) => row.textContent);

describe('ArchivedSessions', () => {
  it('keeps its button in place, disabled, without archived sessions, and has no dropdown then', () => {
    const { bridge } = fakeBridge();
    render(
      <ArchivedSessions
        bridge={bridge}
        count={0}
        onOpenSession={vi.fn()}
        onSessionMenu={vi.fn()}
      />,
    );
    expect(button()).toHaveProperty('disabled', true);
    expect(button().title).toBe('Archived sessions');
    expect(document.getElementById(button().getAttribute('popovertarget') ?? '')).toBeNull();
    expect(bridge.archived).not.toHaveBeenCalled();
  });

  it('loads the archived sessions only as its dropdown opens, and lists them there', async () => {
    const onOpenSession = vi.fn();
    const onSessionMenu = vi.fn();
    const { bridge } = fakeBridge();
    render(
      <ArchivedSessions
        bridge={bridge}
        count={2}
        onOpenSession={onOpenSession}
        onSessionMenu={onSessionMenu}
      />,
    );
    expect(button()).toHaveProperty('disabled', false);
    // A sheet of the window's paper, as the ui module draws one, out of the title bar's drag area.
    expect(dropdown().getAttribute('popover')).toBe('auto');
    expect(dropdown().className.split(' ')).toEqual(
      expect.arrayContaining(['paper', 'border-dashed', '[-webkit-app-region:no-drag]']),
    );
    // Closed, it holds nothing; while its sessions load, it is as tall as their list will be.
    expect(bridge.archived).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    fireEvent(dropdown(), Object.assign(new Event('toggle'), { newState: 'open' }));
    expect(dropdown().querySelector<HTMLElement>('[aria-busy="true"]')?.style.height).toBe('56px');
    await act(() => Promise.resolve());
    expect(bridge.archived).toHaveBeenCalledOnce();
    expect(rows()).toEqual(['ClosedFix the buildweb', 'ClosedGrok Buildapi']);
    const [first, second] = within(dropdown()).getAllByRole('button');
    if (first === undefined || second === undefined) throw new Error('no rows');
    // Each row hides the dropdown as it shows its session.
    expect(first.getAttribute('popovertarget')).toBe(dropdown().id);
    expect(first.getAttribute('popovertargetaction')).toBe('hide');
    fireEvent.click(first);
    expect(onOpenSession.mock.calls).toEqual([[archived[0]]]);
    fireEvent.contextMenu(second);
    expect(onSessionMenu.mock.calls).toEqual([[archived[1]]]);
  });

  it('loads them again while open as their number changes, and anew each time it opens', async () => {
    const { main, bridge } = fakeBridge();
    const props = { bridge, onOpenSession: vi.fn(), onSessionMenu: vi.fn() };
    const { rerender } = render(<ArchivedSessions {...props} count={2} />);
    await toggle('open');
    expect(rows()).toHaveLength(2);
    // A session unarchived from its menu leaves the list.
    main.sessions = archived.slice(1);
    await act(async () => {
      rerender(<ArchivedSessions {...props} count={1} />);
      await Promise.resolve();
    });
    expect(rows()).toEqual(['ClosedGrok Buildapi']);
    // Closed, it lets them go; a change then loads nothing.
    await toggle('closed');
    expect(rows()).toEqual([]);
    main.sessions = archived;
    rerender(<ArchivedSessions {...props} count={2} />);
    expect(bridge.archived).toHaveBeenCalledTimes(2);
    await toggle('open');
    expect(bridge.archived).toHaveBeenCalledTimes(3);
    expect(rows()).toHaveLength(2);
  });

  it('closes its dropdown once nothing is left in it', async () => {
    const { bridge } = fakeBridge();
    const props = { bridge, onOpenSession: vi.fn(), onSessionMenu: vi.fn() };
    const { rerender } = render(<ArchivedSessions {...props} count={2} />);
    await toggle('open');
    rerender(<ArchivedSessions {...props} count={0} />);
    expect(document.getElementById(button().getAttribute('popovertarget') ?? '')).toBeNull();
    expect(button()).toHaveProperty('disabled', true);
  });
});
