import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../sessions/shared/sessions';
import { dockAttention, type Dock } from './dock';

const sessions = (statuses: SessionSummary['status'][]): SessionSummary[] =>
  statuses.map((status, index) => ({
    id: `s${String(index)}`,
    provider: 'codex-cli',
    sessionId: `p${String(index)}`,
    cwd: '/Users/me/web',
    status,
    activeAt: 0,
  }));

describe('dockAttention', () => {
  it('shows the waiting sessions on the Dock icon, and bounces it once when one more waits unseen', () => {
    const dock = { setBadge: vi.fn<Dock['setBadge']>(), bounce: vi.fn<Dock['bounce']>(() => 1) };
    let focused = true;
    const show = dockAttention(dock, () => focused);
    show(sessions(['running', 'idle']));
    expect(dock.setBadge).not.toHaveBeenCalled();
    show(sessions(['waiting', 'idle']));
    expect(dock.setBadge).toHaveBeenLastCalledWith('1');
    expect(dock.bounce).not.toHaveBeenCalled();
    focused = false;
    show(sessions(['waiting', 'waiting']));
    expect(dock.setBadge).toHaveBeenLastCalledWith('2');
    expect(dock.bounce.mock.calls).toEqual([['informational']]);
    show(sessions(['waiting', 'waiting']));
    show(sessions(['waiting', 'running']));
    expect(dock.bounce).toHaveBeenCalledTimes(1);
    show(sessions(['idle', 'running']));
    expect(dock.setBadge).toHaveBeenLastCalledWith('');
  });
});
