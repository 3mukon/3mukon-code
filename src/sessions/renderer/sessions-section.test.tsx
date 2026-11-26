import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { SessionsSection, type SessionFolder } from './sessions-section';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function session(id: string, cwd: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    provider: 'claude-code',
    sessionId: `p-${id}`,
    cwd,
    status: 'idle',
    activeAt: 0,
    ...extra,
  };
}

const folders: SessionFolder[] = [
  { id: 'w1', name: 'web', path: '/Users/me/web' },
  { id: 'w2', name: 'api', path: '/Users/me/api' },
];

const sessions = [
  session('s1', '/Users/me/web', { title: 'Fix the build', status: 'running' }),
  session('s2', '/Users/me/web/packages/ui', { provider: 'codex-cli', status: 'waiting' }),
  session('s3', '/Users/me/website', { title: 'Landing page', status: 'closed' }),
  session('s4', '/Users/me/api', { provider: 'grok-build', title: '' }),
];

// A thousand sessions, the list's limit, the first of them the most recently active.
const many = Array.from({ length: 1_000 }, (_, index) =>
  session(`s${String(index)}`, '/Users/me/web', { title: `Session ${String(index)}` }),
);

// A search that finds nothing, for the tests that do not search.
const unsearched: Pick<SessionsBridge, 'search'> = {
  search: () => Promise.resolve({ matches: [], unread: 0 }),
};

const region = () => screen.getByRole('region', { name: 'Sessions' });
const rows = () =>
  within(region())
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

describe('SessionsSection', () => {
  it('shows the heading row alone without sessions or folders', () => {
    render(<SessionsSection bridge={unsearched} sessions={[]} folders={[]} />);
    expect(region().textContent).toBe('Sessions');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(within(region()).getByRole('button', { name: 'New session' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows every session with its status and its folder, whose path is the tooltip', () => {
    render(<SessionsSection bridge={unsearched} sessions={sessions} folders={folders} />);
    expect(rows()).toEqual([
      'RunningFix the buildweb',
      'Waiting for youCodex CLIui',
      'ClosedLanding pagewebsite',
      // Without a title, a session goes by its provider.
      'IdleGrok Buildapi',
    ]);
    expect(within(region()).getByText('ui').title).toBe('/Users/me/web/packages/ui');
  });

  it('narrows the list to the sessions in one workspace and its subfolders', () => {
    render(<SessionsSection bridge={unsearched} sessions={sessions} folders={folders} />);
    const filter = screen.getByRole('combobox', { name: 'Filter sessions by workspace' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All workspaces', 'web', 'api']);
    // It comes just after New session, so that it starts in the same place whatever it shows.
    const newSession = within(region()).getByRole('button', { name: 'New session' });
    expect(newSession.nextElementSibling?.contains(filter)).toBe(true);
    fireEvent.change(filter, { target: { value: 'w1' } });
    expect(rows()).toEqual(['RunningFix the buildweb', 'Waiting for youCodex CLIui']);
    fireEvent.change(filter, { target: { value: 'w2' } });
    expect(rows()).toEqual(['IdleGrok Buildapi']);
    fireEvent.change(filter, { target: { value: '' } });
    expect(rows()).toHaveLength(4);
  });

  it('shows each child indented beneath its parent, and on its own where its parent is not shown', () => {
    const family = [
      session('c2', '/Users/me/web', { title: 'Second child', parent: 'p' }),
      session('o', '/Users/me/api', { title: 'Other' }),
      session('p', '/Users/me/api', { title: 'Parent' }),
      session('c1', '/Users/me/web', { title: 'First child', parent: 'p' }),
    ];
    render(<SessionsSection bridge={unsearched} sessions={family} folders={folders} />);
    const items = () => within(region()).queryAllByRole('listitem');
    expect(rows()).toEqual([
      'IdleOtherapi',
      'IdleParentapi',
      'IdleSecond childweb',
      'IdleFirst childweb',
    ]);
    expect(items().map((item) => item.getAttribute('aria-level'))).toEqual(['1', '1', '2', '2']);
    expect(within(items()[2] ?? region()).getByRole('button').className).toContain('pl-6');
    // The filter shows the children without their parent, each on its own.
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter sessions by workspace' }), {
      target: { value: 'w1' },
    });
    expect(rows()).toEqual(['IdleSecond childweb', 'IdleFirst childweb']);
    expect(items().map((item) => item.getAttribute('aria-level'))).toEqual(['1', '1']);
  });

  it('opens a session page with New session, and shows a session clicked in the list', () => {
    const onNewSession = vi.fn();
    const onOpenSession = vi.fn();
    render(
      <SessionsSection
        bridge={unsearched}
        sessions={sessions}
        folders={folders}
        onNewSession={onNewSession}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(within(region()).getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalledOnce();
    fireEvent.click(within(region()).getByRole('button', { name: /Fix the build/ }));
    expect(onOpenSession.mock.calls).toEqual([[sessions[0]]]);
  });

  it('hands a press on a session’s row to whoever drags it elsewhere, and never drags as the system does', () => {
    const onPressSession = vi.fn();
    render(
      <SessionsSection
        bridge={unsearched}
        sessions={sessions}
        folders={folders}
        onOpenSession={vi.fn()}
        onPressSession={onPressSession}
      />,
    );
    const row = within(region()).getByRole('button', { name: /Landing page/ });
    expect(row.hasAttribute('draggable')).toBe(false);
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 40, clientY: 200 });
    expect(onPressSession).toHaveBeenCalledOnce();
    expect(onPressSession.mock.calls[0]?.[0]).toBe(sessions[2]);
    expect(onPressSession.mock.calls[0]?.[1]).toMatchObject({ pointerId: 1, clientX: 40 });
  });

  it('reads ahead the history of a session that is not running, once, as a press begins or once the pointer or the focus has stayed on its row', () => {
    vi.useFakeTimers();
    try {
      const onReadAhead = vi.fn();
      render(
        <SessionsSection
          bridge={unsearched}
          sessions={sessions}
          folders={folders}
          onOpenSession={vi.fn()}
          onReadAhead={onReadAhead}
        />,
      );
      const row = (name: RegExp) => within(region()).getByRole('button', { name });
      // A pointer passing over the row reads nothing.
      fireEvent.pointerEnter(row(/Landing page/));
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.pointerLeave(row(/Landing page/));
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(onReadAhead).not.toHaveBeenCalled();
      // One that stays reads it, and only once.
      fireEvent.pointerEnter(row(/Landing page/));
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(onReadAhead.mock.calls).toEqual([[sessions[2]]]);
      fireEvent.pointerDown(row(/Landing page/));
      fireEvent.focus(row(/Landing page/));
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(onReadAhead).toHaveBeenCalledOnce();
      // A running session has no history to read.
      fireEvent.pointerDown(row(/Fix the build/));
      fireEvent.focus(row(/Fix the build/));
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(onReadAhead).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a session’s menu at a secondary click, in place of the page’s own', () => {
    const onSessionMenu = vi.fn();
    render(
      <SessionsSection
        bridge={unsearched}
        sessions={sessions}
        folders={folders}
        onOpenSession={vi.fn()}
        onSessionMenu={onSessionMenu}
      />,
    );
    const shown = fireEvent.contextMenu(
      within(region()).getByRole('button', { name: /Landing page/ }),
    );
    expect(shown).toBe(false);
    expect(onSessionMenu.mock.calls).toEqual([[sessions[2]]]);
  });

  it('renders only the rows in view and a few on either side, each saying where it lies in the whole list', () => {
    // The scroll area as the window lays it out, ten rows tall.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280);
    render(<SessionsSection bridge={unsearched} sessions={many} folders={[]} />);
    const list = within(region()).getByRole('list', { name: 'Sessions' });
    const places = () =>
      within(list)
        .getAllByRole('listitem')
        .map((item) => Number(item.getAttribute('aria-posinset')));
    // The list is as tall as all its rows; the ten in view render, and eight below them.
    expect(list.style.height).toBe('28000px');
    expect(places()).toEqual(range(1, 18));
    const [first] = within(list).getAllByRole('listitem');
    expect(first?.getAttribute('aria-setsize')).toBe('1000');
    expect(first?.textContent).toBe('IdleSession 0web');
    // Scrolled halfway, it renders the rows then in view, and eight on either side.
    const area = list.parentElement;
    if (area === null) throw new Error('no scroll area');
    area.scrollTop = 500 * 28;
    fireEvent.scroll(area);
    expect(places()).toEqual(range(493, 518));
    const row = within(list).getByText('Session 500').closest('li');
    expect(row?.style.top).toBe('14000px');
    expect(row?.style.height).toBe('28px');
  });

  it('renders the first rows until its scroll area is measured, as while it is out of sight', () => {
    render(<SessionsSection bridge={unsearched} sessions={many} folders={[]} />);
    expect(within(region()).getAllByRole('listitem')).toHaveLength(48);
  });

  it('keeps the row with the keyboard focus while it is scrolled out of view', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280);
    render(
      <SessionsSection bridge={unsearched} sessions={many} folders={[]} onOpenSession={vi.fn()} />,
    );
    const list = within(region()).getByRole('list', { name: 'Sessions' });
    const focused = within(list).getByRole('button', { name: /Session 2 / });
    act(() => {
      focused.focus();
    });
    const area = list.parentElement;
    if (area === null) throw new Error('no scroll area');
    area.scrollTop = 500 * 28;
    fireEvent.scroll(area);
    const places = () =>
      within(list)
        .getAllByRole('listitem')
        .map((item) => Number(item.getAttribute('aria-posinset')));
    expect(places()).toEqual([3, ...range(493, 518)]);
    expect(document.activeElement).toBe(focused);
    act(() => {
      focused.blur();
    });
    expect(places()).toEqual(range(493, 518));
  });

  it('shows every session again when the chosen workspace leaves the list', () => {
    const { rerender } = render(
      <SessionsSection bridge={unsearched} sessions={sessions} folders={folders} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'w2' } });
    expect(rows()).toHaveLength(1);
    rerender(
      <SessionsSection bridge={unsearched} sessions={sessions} folders={folders.slice(0, 1)} />,
    );
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('');
  });
});

// The whole numbers from first to last.
function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

describe('SessionsSection search', () => {
  // A search of the sessions' conversations that finds these, by id, with their passages.
  function conversations(found: Record<string, string | undefined>, unread = 0) {
    return {
      search: vi.fn<SessionsBridge['search']>(() =>
        Promise.resolve({
          matches: Object.entries(found).map(([id, snippet]) => ({
            id,
            ...(snippet === undefined ? {} : { snippet }),
          })),
          unread,
        }),
      ),
    };
  }

  it('opens a search field in the filter’s place from the magnifying glass after it, and closes it with Escape', () => {
    render(<SessionsSection bridge={unsearched} sessions={sessions} folders={folders} />);
    const glass = within(region()).getByRole('button', { name: 'Search sessions' });
    // The glass comes just after the filter, on the heading's row.
    expect(glass.previousElementSibling?.querySelector('select')).not.toBeNull();
    fireEvent.click(glass);
    const field = within(region()).getByRole('searchbox', { name: 'Search sessions' });
    expect(document.activeElement).toBe(field);
    expect(within(region()).queryByRole('combobox')).toBeNull();
    fireEvent.change(field, { target: { value: 'build' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(within(region()).queryByRole('searchbox')).toBeNull();
    within(region()).getByRole('combobox', { name: 'Filter sessions by workspace' });
    expect(rows()).toHaveLength(4);
  });

  it('closes the field left empty, and keeps it open while it has a query', () => {
    render(<SessionsSection bridge={unsearched} sessions={sessions} folders={[]} />);
    fireEvent.click(within(region()).getByRole('button', { name: 'Search sessions' }));
    fireEvent.blur(within(region()).getByRole('searchbox'));
    expect(within(region()).queryByRole('searchbox')).toBeNull();
    fireEvent.click(within(region()).getByRole('button', { name: 'Search sessions' }));
    fireEvent.change(within(region()).getByRole('searchbox'), { target: { value: 'page' } });
    fireEvent.blur(within(region()).getByRole('searchbox'));
    expect(within(region()).queryByRole('searchbox')).not.toBeNull();
  });

  it('keeps the list as it is until the main process answers, then narrows it to the sessions found within the chosen workspace', async () => {
    vi.useFakeTimers();
    try {
      const bridge = conversations({ s1: undefined, s3: 'the landing page', s4: 'the api' }, 2);
      render(<SessionsSection sessions={sessions} folders={folders} bridge={bridge} />);
      fireEvent.change(within(region()).getByRole('combobox'), { target: { value: 'w1' } });
      fireEvent.click(within(region()).getByRole('button', { name: 'Search sessions' }));
      const field = within(region()).getByRole('searchbox');
      expect(field.getAttribute('placeholder')).toBe('Search in web');
      fireEvent.change(field, { target: { value: 'BUILD' } });
      expect(rows()).toHaveLength(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(bridge.search.mock.calls).toEqual([['BUILD', false]]);
      // s3 and s4, found too, lie outside the chosen workspace.
      expect(rows()).toEqual([expect.stringContaining('Fix the build')]);
      within(region()).getByText('Reading 2 more sessions…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says that no session matches only once the main process knows it, and keeps saying it as the query lengthens', async () => {
    vi.useFakeTimers();
    try {
      const bridge = conversations({ s2: 'the parser' });
      render(<SessionsSection sessions={sessions} folders={[]} bridge={bridge} />);
      fireEvent.click(within(region()).getByRole('button', { name: 'Search sessions' }));
      const field = within(region()).getByRole('searchbox');
      fireEvent.change(field, { target: { value: 'pars' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rows()).toEqual([expect.stringContaining('Codex CLI')]);
      // A longer query keeps what was found until its own answer comes.
      bridge.search.mockResolvedValue({ matches: [], unread: 0 });
      fireEvent.change(field, { target: { value: 'parsx' } });
      expect(rows()).toEqual([expect.stringContaining('Codex CLI')]);
      expect(within(region()).queryByText('No sessions match')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rows()).toEqual([]);
      within(region()).getByText('No sessions match');
      // Lengthened further, it finds no more, so the notice stays while its answer is asked for.
      fireEvent.change(field, { target: { value: 'parsxy' } });
      within(region()).getByText('No sessions match');
      // Shortened, it may find more, so the notice goes until its answer comes.
      bridge.search.mockResolvedValue({ matches: [{ id: 's3' }], unread: 0 });
      fireEvent.change(field, { target: { value: 'par' } });
      expect(within(region()).queryByText('No sessions match')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rows()).toEqual([expect.stringContaining('Landing page')]);
      // A query unlike the one answered shows the whole list until its answer comes.
      fireEvent.change(field, { target: { value: 'build' } });
      expect(rows()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again while the main process still reads sessions for searching, saying nothing of none meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const bridge = conversations({}, 3);
      render(<SessionsSection sessions={sessions} folders={[]} bridge={bridge} />);
      fireEvent.click(within(region()).getByRole('button', { name: 'Search sessions' }));
      fireEvent.change(within(region()).getByRole('searchbox'), { target: { value: 'parser' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(rows()).toEqual([]);
      within(region()).getByText('Reading 3 more sessions…');
      expect(within(region()).queryByText('No sessions match')).toBeNull();
      bridge.search.mockResolvedValue({ matches: [{ id: 's2' }, { id: 's3' }], unread: 0 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(bridge.search).toHaveBeenCalledTimes(2);
      expect(rows()).toEqual([
        expect.stringContaining('Codex CLI'),
        expect.stringContaining('Landing page'),
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bridge.search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
