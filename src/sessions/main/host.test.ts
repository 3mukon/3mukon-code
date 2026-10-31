import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption, ProviderId, QuestionAnswer, SessionEvent } from '../shared/events';
import type { SessionSummary } from '../shared/sessions';
import { SessionHost } from './host';
import type { Provider, ProviderSession, SessionEventListener } from './provider';

// Sessions start in real folders, which the host checks.
let root: string;
const folder = (name: string) => join(root, name);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-host-'));
  for (const name of ['web', 'api', 'a', 'b']) mkdirSync(folder(name));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

// What a fake session was asked to do.
function sessionCalls() {
  return {
    send: vi.fn<ProviderSession['send']>(() => Promise.resolve()),
    interrupt: vi.fn<ProviderSession['interrupt']>(() => Promise.resolve()),
    setMode: vi.fn<ProviderSession['setMode']>(() => Promise.resolve()),
    setModel: vi.fn<ProviderSession['setModel']>(() => Promise.resolve()),
    setEffort: vi.fn<ProviderSession['setEffort']>(() => Promise.resolve()),
    setSandbox: vi.fn<ProviderSession['setSandbox']>(() => Promise.resolve()),
    setGateway: vi.fn<ProviderSession['setGateway']>(() => Promise.resolve()),
    answerApproval: vi.fn<ProviderSession['answerApproval']>(() => Promise.resolve()),
    answerQuestion: vi.fn<ProviderSession['answerQuestion']>(() => Promise.resolve()),
  };
}

// A provider whose sessions the test drives: it reports the sandbox while starting, and hands each
// session's listener and calls to the test.
function fakeProvider(id: ProviderId, fail = false) {
  const listeners: SessionEventListener[] = [];
  const sessions: ReturnType<typeof sessionCalls>[] = [];
  const closed: string[] = [];
  const listModels = vi.fn<Provider['listModels']>(() => Promise.resolve([]));
  const provider: Provider = {
    id,
    start(_options, onEvent) {
      if (fail) return Promise.reject(new Error('Not signed in.'));
      const sessionId = `${id}-${String(sessions.length + 1)}`;
      listeners.push(onEvent);
      onEvent({ type: 'settings', sandbox: 'workspace-write' });
      const calls = sessionCalls();
      sessions.push(calls);
      return Promise.resolve({
        id: sessionId,
        ...calls,
        close: () => {
          closed.push(sessionId);
          return Promise.resolve();
        },
      });
    },
    resume: () => Promise.reject(new Error('unused')),
    listSessions: () => Promise.resolve([]),
    listGateways: () => Promise.resolve(['work']),
    listModels,
  };
  return { provider, listeners, sessions, closed, listModels };
}

describe('SessionHost', () => {
  it('lists a session once its provider has started it', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    const changes: SessionSummary[][] = [];
    host.onChange((sessions) => changes.push(sessions));
    const id = await host.start('claude-code', { cwd: folder('web') });
    expect(host.list()).toEqual([
      {
        id,
        provider: 'claude-code',
        sessionId: 'claude-code-1',
        cwd: folder('web'),
        status: 'idle',
        openedAt: expect.any(Number) as number,
      },
    ]);
    expect(changes).toEqual([host.list()]);
  });

  it('reports a session when its title or status changes, not for every event', async () => {
    const codex = fakeProvider('codex');
    const host = new SessionHost([codex.provider]);
    await host.start('codex', { cwd: folder('api') });
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

  it('passes answers to the provider’s session, and reports since when a session waits on the user', async () => {
    const codex = fakeProvider('codex');
    const host = new SessionHost([codex.provider]);
    const id = await host.start('codex', { cwd: folder('api') });
    const changes: SessionSummary[][] = [];
    host.onChange((sessions) => changes.push(sessions));
    const emit = codex.listeners[0];
    const session = codex.sessions[0];
    if (emit === undefined || session === undefined) throw new Error('no session');
    emit({
      type: 'approval-requested',
      request: {
        id: 'r1',
        action: 'command',
        canAllowForSession: false,
        denyByDefault: false,
        requestedAt: 200,
      },
    });
    emit({
      type: 'question-asked',
      request: {
        id: 'q1',
        questions: [
          {
            id: 'name',
            text: 'Name?',
            options: [],
            multiSelect: false,
            freeText: true,
            secret: false,
          },
          {
            id: 'token',
            text: 'Token?',
            options: [],
            multiSelect: false,
            freeText: true,
            secret: true,
          },
        ],
        requestedAt: 100,
      },
    });
    await host.answerApproval(id, 'r1', { decision: 'allow-once' });
    const answer: QuestionAnswer = {
      decision: 'answer',
      answers: { name: { selected: [], text: 'web' }, token: { selected: [], text: 's3cret' } },
    };
    await host.answerQuestion(id, 'q1', answer);
    expect(session.answerApproval.mock.calls).toEqual([['r1', { decision: 'allow-once' }]]);
    // The provider gets the whole answer; the session's state keeps it without the secret.
    expect(session.answerQuestion.mock.calls).toEqual([['q1', answer]]);
    const recorded = host
      .snapshot(id)
      ?.state.timeline.map((item) =>
        item.type === 'approval' || item.type === 'question' ? item.answer : undefined,
      );
    expect(recorded).toEqual([
      { decision: 'allow-once' },
      {
        decision: 'answer',
        answers: { name: { selected: [], text: 'web' }, token: { selected: [] } },
      },
    ]);
    emit({ type: 'request-resolved', requestId: 'q1', outcome: 'answered' });
    emit({ type: 'request-resolved', requestId: 'r1', outcome: 'answered' });
    expect(changes.map(([summary]) => [summary?.status, summary?.waitingSince])).toEqual([
      ['waiting', 200],
      ['waiting', 100],
      ['waiting', 200],
      ['idle', undefined],
    ]);
  });

  it('lists a session by its first message until the provider titles it', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    await host.start('claude-code', { cwd: folder('web') });
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'message', id: 'm1', role: 'user', text: '  Fix the build\nand run the tests  ' });
    expect(host.list()[0]?.title).toBe('Fix the build and run the tests');
    emit({ type: 'message', id: 'm2', role: 'user', text: 'x'.repeat(120) });
    expect(host.list()[0]?.title).toBe('Fix the build and run the tests');
    emit({ type: 'title', title: 'Build fixes' });
    expect(host.list()[0]?.title).toBe('Build fixes');
  });

  it('shortens a long first message to a title', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    await host.start('claude-code', { cwd: folder('web') });
    claude.listeners[0]?.({ type: 'message', id: 'm1', role: 'user', text: 'word '.repeat(40) });
    const title = host.list()[0]?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('numbers each session’s events, which its snapshot counts', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    const heard: [string, number, SessionEvent][] = [];
    host.onEvent((id, seq, event) => heard.push([id, seq, event]));
    const id = await host.start('claude-code', { cwd: folder('web') });
    claude.listeners[0]?.({ type: 'turn-started' });
    expect(heard).toEqual([
      [id, 1, { type: 'settings', sandbox: 'workspace-write' }],
      [id, 2, { type: 'turn-started' }],
    ]);
    expect(host.snapshot(id)).toMatchObject({
      seq: 2,
      state: { turnRunning: true, sandbox: 'workspace-write' },
    });
    expect(host.snapshot('missing')).toBeNull();
  });

  it('passes messages, stops and switches to the provider’s session', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    const id = await host.start('claude-code', { cwd: folder('web') });
    await host.send(id, 'Fix the build');
    await host.interrupt(id);
    await host.setMode(id, 'yolo');
    await host.setGateway(id, 'work');
    await host.setModel(id, null);
    await host.setEffort(id, 'high');
    await host.setSandbox(id, 'read-only');
    const session = claude.sessions[0];
    if (session === undefined) throw new Error('no session');
    expect(session.send.mock.calls).toEqual([['Fix the build', []]]);
    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(session.setMode.mock.calls).toEqual([['yolo']]);
    expect(session.setGateway.mock.calls).toEqual([['work']]);
    expect(session.setModel.mock.calls).toEqual([[null]]);
    expect(session.setEffort.mock.calls).toEqual([['high']]);
    expect(session.setSandbox.mock.calls).toEqual([['read-only']]);
    expect(() => host.send('missing', 'Hi')).toThrow('not open');
  });

  it('offers its providers, their gateways, and their models, found once per gateway', async () => {
    const claude = fakeProvider('claude-code');
    const models: ModelOption[] = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
    claude.listModels.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(models);
    const host = new SessionHost([claude.provider, fakeProvider('codex').provider]);
    expect(host.providerIds()).toEqual(['claude-code', 'codex']);
    expect(await host.gateways('claude-code')).toEqual(['work']);
    // A failed search is tried again; a found list is kept.
    await expect(host.models('claude-code', null)).rejects.toThrow('offline');
    expect(await host.models('claude-code', null)).toEqual(models);
    expect(await host.models('claude-code', null)).toEqual(models);
    expect(await host.models('claude-code', 'work')).toEqual(models);
    expect(claude.listModels.mock.calls).toEqual([[null], [null], ['work']]);
  });

  it('fails a list of models that has not come within a minute, and asks for it again next time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const claude = fakeProvider('claude-code');
    const models: ModelOption[] = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
    claude.listModels
      .mockReturnValueOnce(new Promise<ModelOption[]>(() => undefined))
      .mockResolvedValue(models);
    const host = new SessionHost([claude.provider]);
    let failure: unknown;
    const late = host.models('claude-code', null).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await late;
    expect(String(failure)).toContain('did not list its models in time');
    expect(await host.models('claude-code', null)).toEqual(models);
  });

  it('lists the newest session first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const claude = fakeProvider('claude-code');
    const grok = fakeProvider('grok-build');
    const host = new SessionHost([claude.provider, grok.provider]);
    vi.setSystemTime(1_000);
    await host.start('claude-code', { cwd: folder('a') });
    vi.setSystemTime(2_000);
    await host.start('grok-build', { cwd: folder('b') });
    expect(host.list().map((summary) => summary.cwd)).toEqual([folder('b'), folder('a')]);
  });

  it('starts no session outside a folder, lists none that failed, and refuses a provider it does not have', async () => {
    const host = new SessionHost([fakeProvider('codex', true).provider]);
    const listener = vi.fn();
    host.onChange(listener);
    writeFileSync(folder('notes.txt'), '');
    await expect(host.start('codex', { cwd: folder('notes.txt') })).rejects.toThrow('folder');
    await expect(host.start('codex', { cwd: folder('missing') })).rejects.toThrow();
    await expect(host.start('codex', { cwd: folder('a') })).rejects.toThrow('Not signed in.');
    await expect(host.start('claude-code', { cwd: folder('a') })).rejects.toThrow('not available');
    expect(host.list()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('closes every session', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider]);
    await host.start('claude-code', { cwd: folder('a') });
    await host.start('claude-code', { cwd: folder('b') });
    await host.closeAll();
    expect(claude.closed).toEqual(['claude-code-1', 'claude-code-2']);
  });
});
