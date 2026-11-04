import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { ArchivedButton, ArchivedPanel } from './archived-panel';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Now, as the tests' clock has it: 3 November 2026, noon.
const NOW = new Date(2026, 10, 3, 12).getTime();
const HOUR = 3_600_000;

function archived(
  id: string,
  title: string,
  activeAt: number,
  extra: Partial<SessionSummary> = {},
) {
  return {
    id,
    provider: 'codex',
    sessionId: `thread-${id}`,
    cwd: '/Users/me/web',
    title,
    status: 'closed',
    activeAt,
    archived: true,
    ...extra,
  } satisfies SessionSummary;
}

const shelved = [
  archived('a1', 'Old idea', NOW - 2 * HOUR),
  archived('a2', '', NOW - 3 * 24 * HOUR, { provider: 'claude-code', cwd: '/Users/me/api' }),
  archived('a3', 'Parser rewrite', new Date(2025, 4, 6).getTime()),
];

function fakeBridge(sessions: SessionSummary[] = shelved) {
  return {
    archived: vi.fn<SessionsBridge['archived']>(() => Promise.resolve(sessions)),
    search: vi.fn<SessionsBridge['search']>(() => Promise.resolve({ matches: [], unread: 0 })),
  };
}

function renderPanel(bridge = fakeBridge(), count = 3) {
  const handlers = {
    onOpenSession: vi.fn<(session: SessionSummary) => void>(),
    onSessionMenu: vi.fn<(session: SessionSummary) => void>(),
    onAct: vi.fn<(session: SessionSummary, action: 'unarchive' | 'remove') => void>(),
  };
  const view = render(<ArchivedPanel bridge={bridge} count={count} {...handlers} />);
  return { ...handlers, rerender: view.rerender, bridge };
}

const settle = () => act(() => Promise.resolve());
const rows = () =>
  within(screen.getByRole('list', { name: 'Archived sessions' }))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);

describe('ArchivedPanel', () => {
  it('shows each archived session with its status, title, when it was last active, and its folder and provider', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    renderPanel();
    await settle();
    expect(rows()).toEqual([
      'ClosedOld idea2 hours agoweb · Codex CLI',
      'ClosedClaude Code3 days agoapi · Claude Code',
      'ClosedParser rewriteMay 6, 2025web · Codex CLI',
    ]);
  });

  it('shows a session clicked, offers its menu at a secondary click, and unarchives or removes it from its row', async () => {
    const { onOpenSession, onSessionMenu, onAct } = renderPanel();
    await settle();
    const row = screen.getByRole('button', { name: /Old idea/ });
    fireEvent.click(row);
    expect(onOpenSession.mock.calls).toEqual([[shelved[0]]]);
    expect(fireEvent.contextMenu(row)).toBe(false);
    expect(onSessionMenu.mock.calls).toEqual([[shelved[0]]]);
    const item = row.closest('li');
    if (item === null) throw new Error('The row is not in the list.');
    fireEvent.click(within(item).getByRole('button', { name: 'Unarchive' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Remove from List' }));
    expect(onAct.mock.calls).toEqual([
      [shelved[0], 'unarchive'],
      [shelved[0], 'remove'],
    ]);
  });

  it('loads the archived sessions again as their number changes, and says when there are none', async () => {
    const bridge = fakeBridge();
    const { rerender, onOpenSession, onSessionMenu, onAct } = renderPanel(bridge);
    await settle();
    bridge.archived.mockResolvedValue([]);
    rerender(
      <ArchivedPanel
        bridge={bridge}
        count={0}
        onOpenSession={onOpenSession}
        onSessionMenu={onSessionMenu}
        onAct={onAct}
      />,
    );
    await settle();
    expect(bridge.archived).toHaveBeenCalledTimes(2);
    screen.getByText('No archived sessions');
  });

  it('searches the archived sessions by title and by conversation, with the passage that matched, as the main process answers', async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge();
    bridge.search.mockResolvedValue({
      matches: [{ id: 'a2', snippet: '…we moved the parser to Rust…' }, { id: 'a3' }],
      unread: 1,
    });
    renderPanel(bridge);
    await settle();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search archived sessions' }), {
      target: { value: 'parser' },
    });
    // Until the main process answers, the list stays as it was.
    expect(rows()).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(bridge.search.mock.calls).toEqual([['parser', true]]);
    expect(rows()).toEqual([
      expect.stringContaining('…we moved the parser to Rust…'),
      expect.stringContaining('Parser rewrite'),
    ]);
    // The query's words show in ink in the passage.
    expect(screen.getByText('parser').className).toContain('text-ink');
    screen.getByText('Reading 1 more session…');
    bridge.search.mockResolvedValue({ matches: [], unread: 0 });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'parser database' } });
    expect(screen.queryByText('No archived sessions match')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    screen.getByText('No archived sessions match');
    // Escape clears the query, and the field stays.
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(rows()).toHaveLength(3);
  });
});

describe('ArchivedButton', () => {
  it('opens the archived sessions’ panel, and keeps its place, disabled, while there are none', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<ArchivedButton count={2} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archived sessions' }));
    expect(onOpen).toHaveBeenCalledOnce();
    rerender(<ArchivedButton count={0} onOpen={onOpen} />);
    expect(screen.getByRole('button', { name: 'Archived sessions' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
