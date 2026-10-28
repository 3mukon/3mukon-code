import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '../shared/events';
import type { SessionSummary } from '../shared/sessions';
import { SessionHost } from './host';
import type { Provider, ProviderSession, SessionEventListener } from './provider';

afterEach(() => {
  vi.useRealTimers();
});

// A provider whose sessions the test drives: it reports a title while starting, and hands each
// session's listener to the test.
function fakeProvider(id: ProviderId, fail = false) {
  const listeners: SessionEventListener[] = [];
  const closed: string[] = [];
  let count = 0;
  const provider: Provider = {
    id,
    start(_options, onEvent) {
      if (fail) return Promise.reject(new Error('Not signed in.'));
      count += 1;
      const sessionId = `${id}-${String(count)}`;
      listeners.push(onEvent);
      onEvent({ type: 'settings', sandbox: 'workspace-write' });
      const session: ProviderSession = {
        id: sessionId,
        send: vi.fn(),
        interrupt: vi.fn(),
        answerApproval: vi.fn(),
        answerQuestion: vi.fn(),
        setMode: vi.fn(),
        setModel: vi.fn(),
        setEffort: vi.fn(),
        setSandbox: vi.fn(),
        setGateway: vi.fn(),
        close: () => {
          closed.push(sessionId);
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
    resume: () => Promise.reject(new Error('unused')),
    listSessions: () => Promise.resolve([]),
    listGateways: () => Promise.resolve([]),
    listModels: () => Promise.resolve([]),
  };
  return { provider, listeners, closed };
}

describe('SessionHost', () => {
  it('lists a session once its provider has started it', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    const changes: SessionSummary[][] = [];
    host.onChange((sessions) => changes.push(sessions));
    const id = await host.start('claude-code', { cwd: '/Users/me/web' });
    expect(host.list()).toEqual([
      {
        id,
        provider: 'claude-code',
        sessionId: 'claude-code-1',
        cwd: '/Users/me/web',
        status: 'idle',
        openedAt: expect.any(Number) as number,
      },
    ]);
    expect(changes).toEqual([host.list()]);
  });

  it('reports a session when its title or status changes, not for every event', async () => {
    const codex = fakeProvider('codex');
    const host = new SessionHost([codex.provider]);
    await host.start('codex', { cwd: '/Users/me/api' });
    const changes: SessionSummary[][] = [];
    host.onChange((sessions) => changes.push(sessions));
    const emit = codex.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'turn-started' });
    emit({ type: 'message-delta', id: 'm1', role: 'agent', text: 'Hi' });
    emit({ type: 'message-delta', id: 'm1', role: 'agent', text: ' there' });
    emit({ type: 'title', title: 'Greeting' });
    emit({ type: 'turn-ended', outcome: 'completed' });
    emit({ type: 'closed' });
    expect(changes.map(([summary]) => [summary?.status, summary?.title])).toEqual([
      ['running', undefined],
      ['running', 'Greeting'],
      ['idle', 'Greeting'],
      ['closed', 'Greeting'],
    ]);
  });

  it('lists the newest session first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const claude = fakeProvider('claude-code');
    const grok = fakeProvider('grok-build');
    const host = new SessionHost([claude.provider, grok.provider]);
    vi.setSystemTime(1_000);
    await host.start('claude-code', { cwd: '/a' });
    vi.setSystemTime(2_000);
    await host.start('grok-build', { cwd: '/b' });
    expect(host.list().map((summary) => summary.cwd)).toEqual(['/b', '/a']);
  });

  it('lists no session that failed to start, and refuses a provider it does not have', async () => {
    const host = new SessionHost([fakeProvider('codex', true).provider]);
    const listener = vi.fn();
    host.onChange(listener);
    await expect(host.start('codex', { cwd: '/a' })).rejects.toThrow('Not signed in.');
    await expect(host.start('claude-code', { cwd: '/a' })).rejects.toThrow('not available');
    expect(host.list()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('closes every session', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    await host.start('claude-code', { cwd: '/a' });
    await host.start('claude-code', { cwd: '/b' });
    await host.closeAll();
    expect(claude.closed).toEqual(['claude-code-1', 'claude-code-2']);
  });
});
