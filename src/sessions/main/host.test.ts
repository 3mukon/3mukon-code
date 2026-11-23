import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption, ProviderId, QuestionAnswer, SessionEvent } from '../shared/events';
import type { SessionAction, SessionList, SessionSettings } from '../shared/sessions';
import { SessionHost, type SessionsMenuUi } from './host';
import type { Provider, ProviderSession, ResumeOptions, SessionEventListener } from './provider';
import { SessionRecords, type SessionRecord } from './records';
import { memoryInboxStorage, SessionInboxes } from './inbox';
import { memoryTextStorage, type TextStorage } from './texts';

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
    setTitle: vi.fn<NonNullable<ProviderSession['setTitle']>>(() => Promise.resolve()),
    deliverContext: vi.fn<NonNullable<ProviderSession['deliverContext']>>(() => Promise.resolve()),
  };
}

// The past of a fake session: the user's first message, among the settings it reported.
const pastEvents: SessionEvent[] = [
  { type: 'mode', mode: 'auto' },
  { type: 'message', id: 'm1', role: 'user', text: 'Fix the build' },
  { type: 'settings', model: 'sonnet' },
];

// A provider whose sessions the test drives: it reports the sandbox while starting; resuming, it
// replays the session's past and then reports the mode and the settings it was given, as the
// adapters do; its sessions report that they closed as they close, and, where they echo, a message
// sent to them at once, with the turn it starts, as the adapters do. Each session's listener and
// calls go to the test.
function fakeProvider(id: ProviderId, fail = false, echo = false) {
  const listeners: SessionEventListener[] = [];
  const sessions: ReturnType<typeof sessionCalls>[] = [];
  const closed: string[] = [];
  const resumed: ResumeOptions[] = [];
  const listModels = vi.fn<Provider['listModels']>(() => Promise.resolve([]));
  const history = vi.fn<Provider['history']>(() => Promise.resolve(pastEvents));
  const open = (sessionId: string, onEvent: SessionEventListener): Promise<ProviderSession> => {
    listeners.push(onEvent);
    const calls = sessionCalls();
    // A turn of the app's own starts at once, with its context accepted, as the adapters start one.
    calls.deliverContext.mockImplementation((_context, delivery) => {
      onEvent({ type: 'turn-started' });
      delivery.accepted();
      return Promise.resolve();
    });
    if (echo) {
      let turns = 0;
      calls.send.mockImplementation((text) => {
        turns += 1;
        onEvent({ type: 'turn-started' });
        onEvent({ type: 'message', id: `sent-${String(turns)}`, role: 'user', text });
        return Promise.resolve();
      });
    }
    sessions.push(calls);
    return Promise.resolve({
      id: sessionId,
      supportsHostContext: true,
      ...calls,
      close: () => {
        closed.push(sessionId);
        onEvent({ type: 'closed' });
        return Promise.resolve();
      },
    });
  };
  const provider: Provider = {
    id,
    start(_options, onEvent) {
      if (fail) return Promise.reject(new Error('Not signed in.'));
      onEvent({ type: 'settings', sandbox: 'workspace-write' });
      return open(`${id}-${String(sessions.length + 1)}`, onEvent);
    },
    resume(options, onEvent) {
      if (fail) return Promise.reject(new Error('Not signed in.'));
      resumed.push(options);
      for (const event of pastEvents) onEvent(event);
      onEvent({ type: 'replay-finished' });
      onEvent({ type: 'mode', mode: options.mode ?? 'auto' });
      onEvent({
        type: 'settings',
        gateway: options.gateway ?? null,
        model: options.model ?? null,
        effort: options.effort ?? null,
        sandbox: options.sandbox ?? 'workspace-write',
      });
      return open(options.sessionId, onEvent);
    },
    listSessions: () => Promise.resolve([]),
    history,
    listGateways: () => Promise.resolve(['work']),
    listModels,
    close: () => Promise.resolve(),
  };
  return { provider, listeners, sessions, closed, resumed, listModels, history };
}

// The sessions the app keeps, in memory, beginning with these, and every list of them saved.
function memoryRecords(initial: SessionRecord[] = []) {
  const saved: SessionRecord[][] = [];
  const records = new SessionRecords({
    load: () => initial,
    save: (all) => saved.push(all),
  });
  return { records, saved };
}

// A Claude Code session the app started in an earlier run, last in yolo.
const kept = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'kept',
  provider: 'claude-code',
  sessionId: 'claude-9',
  cwd: folder('web'),
  title: 'Fix the build',
  activeAt: 1_000,
  mode: 'yolo',
  gateway: 'work',
  model: 'opus',
  effort: 'high',
  sandbox: 'read-only',
  ...overrides,
});

// The settings kept for that session, which its page resumes it with unless the user changes them.
const keptSettings: SessionSettings = {
  mode: 'yolo',
  gateway: 'work',
  model: 'opus',
  effort: 'high',
  sandbox: 'read-only',
};

// The user in the session's menu and its questions, choosing and answering as the test says.
function menuUi(choice: SessionAction | null, confirm = true) {
  const ui = {
    sessionMenu: vi.fn<SessionsMenuUi['sessionMenu']>(() => Promise.resolve(choice)),
    confirmArchive: vi.fn<SessionsMenuUi['confirmArchive']>(() => Promise.resolve(confirm)),
    confirmRemove: vi.fn<SessionsMenuUi['confirmRemove']>(() => Promise.resolve(confirm)),
  } satisfies SessionsMenuUi;
  return ui;
}

// Lets the host's reads and replies settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('SessionHost', () => {
  it('lists a session once its provider has started it', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords().records);
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
    const id = await host.start('claude-code', { cwd: folder('web') });
    expect(host.list()).toEqual({
      sessions: [
        {
          id,
          provider: 'claude-code',
          sessionId: 'claude-code-1',
          cwd: folder('web'),
          status: 'idle',
          activeAt: expect.any(Number) as number,
        },
      ],
      archived: 0,
      shown: [],
    });
    expect(changes).toEqual([host.list()]);
  });

  it('lists a session started with a message once the message is in it, so that its row first shows the message and the running turn', async () => {
    const claude = fakeProvider('claude-code', false, true);
    const host = new SessionHost([claude.provider], memoryRecords().records);
    const rows: [string, string | undefined][] = [];
    host.onChange((list) => {
      for (const summary of list.sessions) rows.push([summary.status, summary.title]);
    });
    const id = await host.start(
      'claude-code',
      { cwd: folder('web') },
      { text: 'Fix the build', images: [] },
    );
    expect(claude.sessions[0]?.send).toHaveBeenCalledExactlyOnceWith('Fix the build', []);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toEqual(['running', 'Fix the build']);
    expect(host.list().sessions.map((summary) => summary.id)).toEqual([id]);
  });

  it('lists a session whose first message its provider refused, and says so', async () => {
    const claude = fakeProvider('claude-code');
    const open = claude.provider.start.bind(claude.provider);
    claude.provider.start = async (options, onEvent) => {
      const session = await open(options, onEvent);
      claude.sessions[0]?.send.mockRejectedValueOnce(new Error('Refused.'));
      return session;
    };
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await expect(
      host.start('claude-code', { cwd: folder('web') }, { text: 'Hi', images: [] }),
    ).rejects.toThrow('Refused.');
    expect(host.list().sessions).toMatchObject([{ status: 'idle', cwd: folder('web') }]);
  });

  it('sets the starting effort for a running session whose model takes one but which has none whose default the provider names', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await host.start('claude-code', { cwd: folder('web') });
    const emit = claude.listeners[0];
    const session = claude.sessions[0];
    if (emit === undefined || session === undefined) throw new Error('no session');
    const models: ModelOption[] = [
      { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], default: true },
      { id: 'haiku', label: 'Haiku', efforts: [] },
      { id: 'gpt', label: 'GPT', efforts: ['low', 'medium'], defaultEffort: 'low' },
    ];
    emit({ type: 'settings', model: 'haiku', effort: null });
    emit({ type: 'models', models });
    // A model that takes no effort needs none.
    expect(session.setEffort).not.toHaveBeenCalled();
    emit({ type: 'settings', model: null });
    await settle();
    expect(session.setEffort.mock.calls).toEqual([['medium']]);
    // Asked once for each model and effort, until the session reports one.
    emit({ type: 'models', models });
    await settle();
    expect(session.setEffort).toHaveBeenCalledOnce();
    emit({ type: 'settings', effort: 'medium' });
    // A model whose default the provider names runs with it, and an effort set stays.
    emit({ type: 'settings', model: 'gpt', effort: null });
    emit({ type: 'settings', model: 'opus', effort: 'high' });
    await settle();
    expect(session.setEffort).toHaveBeenCalledOnce();
  });

  it('reports a session when its title or status changes, not for every event', async () => {
    const codex = fakeProvider('codex');
    const host = new SessionHost([codex.provider], memoryRecords().records);
    await host.start('codex', { cwd: folder('api') });
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
    const emit = codex.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'turn-started' });
    emit({ type: 'message-delta', id: 'm1', role: 'agent', text: 'Hi' });
    emit({ type: 'message-delta', id: 'm1', role: 'agent', text: ' there' });
    emit({ type: 'title', title: 'Greeting' });
    emit({ type: 'turn-ended', outcome: 'completed' });
    emit({ type: 'closed' });
    expect(changes.map(({ sessions: [summary] }) => [summary?.status, summary?.title])).toEqual([
      ['running', undefined],
      ['running', 'Greeting'],
      ['idle', 'Greeting'],
      ['closed', 'Greeting'],
    ]);
  });

  it('passes answers to the provider’s session, and reports since when a session waits on the user', async () => {
    const codex = fakeProvider('codex');
    const host = new SessionHost([codex.provider], memoryRecords().records);
    const id = await host.start('codex', { cwd: folder('api') });
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
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
    expect(
      changes.map(({ sessions: [summary] }) => [summary?.status, summary?.waitingSince]),
    ).toEqual([
      ['waiting', 200],
      ['waiting', 100],
      ['waiting', 200],
      ['idle', undefined],
    ]);
  });

  it('lists a session by its first message until the provider titles it', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await host.start('claude-code', { cwd: folder('web') });
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'message', id: 'm1', role: 'user', text: '  Fix the build\nand run the tests  ' });
    expect(host.list().sessions[0]?.title).toBe('Fix the build and run the tests');
    emit({ type: 'message', id: 'm2', role: 'user', text: 'x'.repeat(120) });
    expect(host.list().sessions[0]?.title).toBe('Fix the build and run the tests');
    emit({ type: 'title', title: 'Build fixes' });
    expect(host.list().sessions[0]?.title).toBe('Build fixes');
  });

  it('shortens a long first message to a title', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await host.start('claude-code', { cwd: folder('web') });
    claude.listeners[0]?.({ type: 'message', id: 'm1', role: 'user', text: 'word '.repeat(40) });
    const title = host.list().sessions[0]?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('numbers each session’s events, which its snapshot counts', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords().records);
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
    const host = new SessionHost([claude.provider], memoryRecords().records);
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
    await expect(host.send('missing', 'Hi')).rejects.toThrow('not open');
  });

  it('offers its providers, their gateways, and their models, kept once found for each gateway', async () => {
    const claude = fakeProvider('claude-code');
    const models: ModelOption[] = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
    claude.listModels.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(models);
    const host = new SessionHost(
      [claude.provider, fakeProvider('codex').provider],
      memoryRecords().records,
    );
    expect(host.providerIds()).toEqual(['claude-code', 'codex']);
    expect(await host.gateways('claude-code')).toEqual(['work']);
    // A failed search is tried again; a found list is kept for a page that does not choose.
    await expect(host.models('claude-code', null)).rejects.toThrow('offline');
    expect(await host.models('claude-code', null)).toEqual(models);
    expect(await host.models('claude-code', null)).toEqual(models);
    expect(await host.models('claude-code', 'work')).toEqual(models);
    expect(claude.listModels.mock.calls).toEqual([[null], [null], ['work']]);
  });

  it('lists models anew in its folder for a new page, once at a time, unless found within 15 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const codex = fakeProvider('codex');
    const first: ModelOption[] = [{ id: 'gpt-a', label: 'A', efforts: [], default: true }];
    const second: ModelOption[] = [{ id: 'gpt-b', label: 'B', efforts: [], default: true }];
    codex.listModels
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error('offline'));
    const host = new SessionHost([codex.provider], memoryRecords().records);
    // Pages opening together share one listing for their folder.
    expect(
      await Promise.all([
        host.models('codex', null, '/work', true),
        host.models('codex', null, '/work', true),
      ]),
    ).toEqual([first, first]);
    vi.setSystemTime(15_999);
    expect(await host.models('codex', null, '/work', true)).toEqual(first);
    // Older than 15 seconds, the list is found again, since the provider's settings may have changed.
    vi.setSystemTime(16_000);
    expect(await host.models('codex', null, '/work', true)).toEqual(second);
    // A listing that fails leaves the list kept as it was.
    vi.setSystemTime(40_000);
    await expect(host.models('codex', null, '/work', true)).rejects.toThrow('offline');
    expect(await host.models('codex', null, '/work', false)).toEqual(second);
    expect(codex.listModels.mock.calls).toEqual([
      [null, '/work'],
      [null, '/work'],
      [null, '/work'],
    ]);
  });

  it('fails a list of models that has not come within a minute, and asks for it again next time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const claude = fakeProvider('claude-code');
    const models: ModelOption[] = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
    claude.listModels
      .mockReturnValueOnce(new Promise<ModelOption[]>(() => undefined))
      .mockResolvedValue(models);
    const host = new SessionHost([claude.provider], memoryRecords().records);
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

  it('lists the most recently active session first: one moves up as the user sends it a message and as its turn ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const claude = fakeProvider('claude-code');
    const grok = fakeProvider('grok-build');
    const host = new SessionHost([claude.provider, grok.provider], memoryRecords().records);
    vi.setSystemTime(1_000);
    const first = await host.start('claude-code', { cwd: folder('a') });
    vi.setSystemTime(2_000);
    await host.start('grok-build', { cwd: folder('b') });
    const order = () => host.list().sessions.map((summary) => summary.cwd);
    expect(order()).toEqual([folder('b'), folder('a')]);
    vi.setSystemTime(3_000);
    await host.send(first, 'Fix the build');
    expect(order()).toEqual([folder('a'), folder('b')]);
    const emit = grok.listeners[0];
    if (emit === undefined) throw new Error('no session');
    // Not while the turn runs, only once it ends.
    vi.setSystemTime(4_000);
    emit({ type: 'turn-started' });
    emit({ type: 'message', id: 'm1', role: 'agent', text: 'Done' });
    expect(order()).toEqual([folder('a'), folder('b')]);
    vi.setSystemTime(5_000);
    emit({ type: 'turn-ended', outcome: 'completed' });
    expect(order()).toEqual([folder('b'), folder('a')]);
    expect(host.list().sessions[0]?.activeAt).toBe(5_000);
  });

  it('starts no session outside a folder, lists or keeps none that failed, and refuses a provider it does not have', async () => {
    const { records, saved } = memoryRecords();
    const host = new SessionHost([fakeProvider('codex', true).provider], records);
    const listener = vi.fn();
    host.onChange(listener);
    writeFileSync(folder('notes.txt'), '');
    await expect(host.start('codex', { cwd: folder('notes.txt') })).rejects.toThrow('folder');
    await expect(host.start('codex', { cwd: folder('missing') })).rejects.toThrow();
    await expect(host.start('codex', { cwd: folder('a') })).rejects.toThrow('Not signed in.');
    await expect(host.start('claude-code', { cwd: folder('a') })).rejects.toThrow('not available');
    expect(host.list()).toEqual({ sessions: [], archived: 0, shown: [] });
    expect(saved).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('closes every session that is open', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords([kept()]).records);
    await host.start('claude-code', { cwd: folder('a') });
    await host.start('claude-code', { cwd: folder('b') });
    await host.closeAll();
    expect(claude.closed).toEqual(['claude-code-1', 'claude-code-2']);
    expect(host.list().sessions.map((summary) => summary.status)).toEqual([
      'closed',
      'closed',
      'closed',
    ]);
  });

  it('waits, closing every session, for each to end as its provider reports a moment later, and for the text its end keeps', async () => {
    const claude = fakeProvider('claude-code');
    const provider: Provider = {
      ...claude.provider,
      start: (_options, onEvent) =>
        Promise.resolve({
          id: 'late-1',
          ...sessionCalls(),
          close: () => {
            setTimeout(() => {
              onEvent({ type: 'closed' });
            }, 20);
            return Promise.resolve();
          },
        }),
    };
    const texts = new Map<string, string>();
    const memory = memoryTextStorage(texts);
    let writing = Promise.resolve();
    // Each write takes a moment.
    const slow: TextStorage = {
      ...memory,
      write: (id, text) => {
        writing = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
          memory.write(id, text),
        );
        return writing;
      },
      settled: () => writing,
    };
    const host = new SessionHost([provider], memoryRecords().records, slow);
    const id = await host.start('claude-code', { cwd: folder('a') });
    await host.closeAll();
    expect(host.list().sessions.map((summary) => summary.status)).toEqual(['closed']);
    expect(texts.has(id)).toBe(true);
  });
});

describe('SessionHost titles', () => {
  // A session that ran a turn of the given length, from its start to its end.
  const turn = (emit: SessionEventListener, ms: number, at: { now: number }) => {
    emit({ type: 'turn-started' });
    at.now += ms;
    vi.setSystemTime(at.now);
    emit({ type: 'turn-ended', outcome: 'completed' });
  };
  const settleTitle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const titled = (reply = 'Build fixes') => {
    const claude = fakeProvider('claude-code', false, true);
    const writeTitle = vi.fn<NonNullable<Provider['writeTitle']>>(() => Promise.resolve(reply));
    const provider: Provider = { ...claude.provider, writeTitle };
    return { ...claude, provider, writeTitle };
  };

  it('writes a title once the session has run three turns, with its model and title effort through its gateway, and keeps and gives it back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = { now: 1_000 };
    vi.setSystemTime(at.now);
    const claude = titled('"Fix the flaky build."');
    const { records, saved } = memoryRecords();
    const host = new SessionHost([claude.provider], records);
    const id = await host.start(
      'claude-code',
      { cwd: folder('web'), gateway: 'work' },
      {
        text: 'The build fails on CI',
      },
    );
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'turn-ended', outcome: 'completed' });
    emit({ type: 'message', id: 'a1', role: 'agent', text: 'Looking into it.' });
    emit({
      type: 'models',
      models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], default: true }],
    });
    emit({ type: 'settings', model: 'opus', effort: 'high' });
    turn(emit, 1_000, at);
    expect(claude.writeTitle).not.toHaveBeenCalled();
    turn(emit, 1_000, at);
    expect(claude.writeTitle).toHaveBeenCalledOnce();
    const [request] = claude.writeTitle.mock.calls[0] ?? [];
    expect(request).toMatchObject({ gateway: 'work', model: 'opus', effort: 'low' });
    expect(request?.prompt).toContain('User: The build fails on CI\n\nAgent: Looking into it.');
    // The list keeps the first message until the title comes.
    expect(host.list().sessions[0]?.title).toBe('The build fails on CI');
    await settleTitle();
    expect(host.list().sessions[0]?.title).toBe('Fix the flaky build');
    expect(saved.at(-1)?.find((record) => record.id === id)).toMatchObject({
      title: 'Fix the flaky build',
      titled: 'Fix the flaky build',
    });
    expect(claude.sessions[0]?.setTitle.mock.calls).toEqual([['Fix the flaky build']]);
    // The provider reports the title it was given; nothing is asked again.
    emit({ type: 'title', title: 'Fix the flaky build' });
    turn(emit, 120_000, at);
    expect(claude.writeTitle).toHaveBeenCalledOnce();
  });

  it('writes a title at the end of the first turn once the turns have run a minute in all', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = { now: 1_000 };
    vi.setSystemTime(at.now);
    const claude = titled();
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await host.start('claude-code', { cwd: folder('web') }, { text: 'Refactor the list' });
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    // The turn the message started runs for a minute.
    at.now += 60_000;
    vi.setSystemTime(at.now);
    emit({ type: 'turn-ended', outcome: 'completed' });
    expect(claude.writeTitle).toHaveBeenCalledOnce();
    expect(claude.writeTitle.mock.calls[0]?.[0]).toMatchObject({ model: null, effort: null });
  });

  it('tries a failed title again at the next turn’s end, three times at most', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = { now: 1_000 };
    vi.setSystemTime(at.now);
    const claude = titled('  ');
    claude.writeTitle.mockRejectedValueOnce(new Error('Overloaded.'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await host.start('claude-code', { cwd: folder('web') }, { text: 'Hi' });
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'turn-ended', outcome: 'completed' });
    for (let index = 0; index < 6; index += 1) {
      turn(emit, 1_000, at);
      await settleTitle();
    }
    expect(claude.writeTitle).toHaveBeenCalledTimes(3);
    expect(host.list().sessions[0]?.title).toBe('Hi');
    error.mockRestore();
  });

  it('keeps a title the provider gives, its own or the user’s, writing none, and writes one where it gives none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = { now: 1_000 };
    vi.setSystemTime(at.now);
    const claude = titled();
    const grok = fakeProvider('grok-build', false, true);
    const grokTitle = vi.fn<NonNullable<Provider['writeTitle']>>(() =>
      Promise.resolve('Search speed-up'),
    );
    const host = new SessionHost(
      [claude.provider, { ...grok.provider, writeTitle: grokTitle }],
      memoryRecords().records,
    );
    await host.start('claude-code', { cwd: folder('web') }, { text: 'Hi' });
    await host.start('grok-build', { cwd: folder('api') }, { text: 'Make search faster' });
    const [claudeEmit] = claude.listeners;
    const [grokEmit] = grok.listeners;
    if (claudeEmit === undefined || grokEmit === undefined) throw new Error('no session');
    // Claude Code titles the session on its own after its first turn; Grok gives none.
    claudeEmit({ type: 'turn-ended', outcome: 'completed' });
    claudeEmit({ type: 'title', title: 'Greeting check' });
    grokEmit({ type: 'turn-ended', outcome: 'completed' });
    for (const emit of [claudeEmit, grokEmit]) {
      turn(emit, 1_000, at);
      turn(emit, 1_000, at);
    }
    await settleTitle();
    expect(claude.writeTitle).not.toHaveBeenCalled();
    expect(grokTitle).toHaveBeenCalledOnce();
    const titles = () => host.list().sessions.map((summary) => summary.title);
    expect(titles()).toEqual(expect.arrayContaining(['Greeting check', 'Search speed-up']));
    expect(grok.sessions[0]?.setTitle).toHaveBeenCalledWith('Search speed-up');
    // A title the provider reports later, as one the user gives in its own tools, stands.
    grokEmit({ type: 'title', title: 'Renamed in Grok' });
    claudeEmit({ type: 'title', title: 'Renamed in Claude Code' });
    expect(titles()).toEqual(expect.arrayContaining(['Renamed in Claude Code', 'Renamed in Grok']));
  });

  it('drops a title that comes once the session has closed, and shows a kept one in later runs without asking again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = { now: 1_000 };
    vi.setSystemTime(at.now);
    const claude = titled();
    let answer: (title: string) => void = () => undefined;
    claude.writeTitle.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const host = new SessionHost([claude.provider], memoryRecords().records);
    await host.start('claude-code', { cwd: folder('web') }, { text: 'Hi' });
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'turn-ended', outcome: 'completed' });
    turn(emit, 1_000, at);
    turn(emit, 1_000, at);
    emit({ type: 'closed' });
    answer('Too late');
    await settleTitle();
    expect(host.list().sessions[0]?.title).toBe('Hi');

    const later = new SessionHost(
      [claude.provider],
      memoryRecords([kept({ title: 'Fix the build', titled: 'Fix the build' })]).records,
    );
    expect(later.list().sessions[0]?.title).toBe('Fix the build');
  });
});

describe('SessionHost coordination', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // A parent session running Claude Code in the web folder, in workspace-write, with Opus at high.
  const withParent = async (inboxes = new SessionInboxes(memoryInboxStorage())) => {
    const claude = fakeProvider('claude-code', false, true);
    const codex = fakeProvider('codex', false, true);
    const { records, saved } = memoryRecords();
    const host = new SessionHost(
      [claude.provider, codex.provider],
      records,
      memoryTextStorage(),
      undefined,
      inboxes,
    );
    const parent = await host.start(
      'claude-code',
      { cwd: folder('web'), gateway: 'work', model: 'opus', effort: 'high' },
      { text: 'Lead the work' },
    );
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({
      type: 'settings',
      gateway: 'work',
      model: 'opus',
      effort: 'high',
      sandbox: 'workspace-write',
    });
    return { host, claude, codex, parent, emit, saved, coordinator: host.coordinator() };
  };

  it('lists the sessions of the Sessions list with what addresses them', async () => {
    const { coordinator, parent } = await withParent();
    expect(coordinator.list(parent)).toEqual([
      {
        id: parent,
        title: 'Lead the work',
        provider: 'claude-code',
        folder: folder('web'),
        status: 'running',
      },
    ]);
    expect(() => coordinator.list('stranger')).toThrow('does not know');
  });

  it('starts a child in its parent’s folder, in auto, with its parent’s settings, beneath it', async () => {
    const { host, claude, coordinator, parent } = await withParent();
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    expect(child).toMatchObject({
      title: 'Write the tests',
      provider: 'claude-code',
      folder: folder('web'),
      parent,
    });
    expect(claude.sessions[1]?.send).toHaveBeenCalledWith('Write the tests', []);
    const summary = host.list().sessions.find((one) => one.id === child.id);
    expect(summary?.parent).toBe(parent);
    expect(host.snapshot(child.id)?.state.timeline[0]).toMatchObject({
      role: 'user',
      text: 'Write the tests',
    });
  });

  it('starts a child of another provider, a narrower sandbox and a title of its parent’s choosing, which stands', async () => {
    const { host, codex, coordinator, parent } = await withParent();
    const child = await coordinator.start(parent, {
      prompt: 'Review the change',
      provider: 'codex',
      sandbox: 'read-only',
      title: 'Reviewer',
    });
    expect(child).toMatchObject({ provider: 'codex', title: 'Reviewer' });
    expect(codex.sessions[0]?.setTitle).toHaveBeenCalledWith('Reviewer');
    const kept = host.list().sessions.find((one) => one.id === child.id);
    expect(kept?.title).toBe('Reviewer');
    await expect(
      coordinator.start(parent, { prompt: 'x', sandbox: 'full-access' }),
    ).rejects.toThrow('wider sandbox');
  });

  it('starts no child from a child, and at most eight running children at once', async () => {
    const { coordinator, parent } = await withParent();
    const children = [];
    for (let index = 0; index < 8; index += 1) {
      children.push(await coordinator.start(parent, { prompt: `Task ${String(index)}` }));
    }
    expect(coordinator.mayStart(parent)).toBe(true);
    expect(coordinator.mayStart(children[0]?.id ?? '')).toBe(false);
    await expect(coordinator.start(children[0]?.id ?? '', { prompt: 'x' })).rejects.toThrow(
      'cannot start sessions',
    );
    await expect(coordinator.start(parent, { prompt: 'One more' })).rejects.toThrow('at most 8');
    // Children still starting count too.
    await coordinator.end(parent, children[1]?.id ?? '');
    const both = await Promise.allSettled([
      coordinator.start(parent, { prompt: 'First of two' }),
      coordinator.start(parent, { prompt: 'Second of two' }),
    ]);
    expect(both.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await coordinator.end(parent, children[0]?.id ?? '');
    await expect(coordinator.start(parent, { prompt: 'One more' })).resolves.toMatchObject({
      parent,
    });
  });

  it('ends a child, which stays listed and closed, lets a child end itself a moment later, and ends nothing else', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { host, coordinator, parent } = await withParent();
    const first = await coordinator.start(parent, { prompt: 'One' });
    const second = await coordinator.start(parent, { prompt: 'Two' });
    await coordinator.end(parent, first.id);
    expect(host.list().sessions.find((one) => one.id === first.id)?.status).toBe('closed');
    await expect(coordinator.end(second.id, parent)).rejects.toThrow('only the children');
    await expect(coordinator.end(parent, parent)).rejects.toThrow('only the children');
    await coordinator.end(second.id, second.id);
    expect(host.list().sessions.find((one) => one.id === second.id)?.status).not.toBe('closed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.list().sessions.find((one) => one.id === second.id)?.status).toBe('closed');
  });

  it('tells an idle session of a new message in a turn of its own, by its summary alone, and shows it', async () => {
    const { host, claude, coordinator, parent, emit } = await withParent();
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    emit({ type: 'turn-ended', outcome: 'completed' });
    await tick();
    const sent = coordinator.send(child.id, parent, 'Tests written', 'All 12 pass.');
    expect(sent).toMatchObject({
      from: child.id,
      fromTitle: 'Write the tests',
      summary: 'Tests written',
      read: false,
    });
    const [context] = claude.sessions[0]?.deliverContext.mock.calls[0] ?? [];
    expect(context?.inboxNotices).toEqual([
      {
        id: sent.id,
        from: child.id,
        fromTitle: 'Write the tests',
        summary: 'Tests written',
        sentAt: sent.sentAt,
      },
    ]);
    expect(JSON.stringify(context)).not.toContain('All 12 pass.');
    expect(host.snapshot(parent)?.state.timeline.at(-1)).toMatchObject({
      type: 'inbox',
      notices: [{ id: sent.id }],
    });
    // Told once: the next moments carry nothing.
    expect(coordinator.notices(parent)).toBeUndefined();
    expect(coordinator.inbox(parent)).toMatchObject([{ id: sent.id, read: false }]);
    expect(coordinator.read(parent, sent.id)).toMatchObject({ body: 'All 12 pass.', read: true });
    expect(() => coordinator.read(child.id, sent.id)).toThrow('no message');
  });

  it('tells a session that is working with its next tool result, or beside the user’s next message', async () => {
    const { host, claude, coordinator, parent, emit } = await withParent();
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    const first = coordinator.send(child.id, parent, 'First', 'x');
    // The parent's turn runs, so it is not woken.
    expect(claude.sessions[0]?.deliverContext).not.toHaveBeenCalled();
    const notices = coordinator.notices(parent);
    expect(notices?.notices.map((notice) => notice.id)).toEqual([first.id]);
    notices?.told();
    expect(coordinator.notices(parent)).toBeUndefined();
    const second = coordinator.send(child.id, parent, 'Second', 'y');
    await host.send(parent, 'And then?');
    const call = claude.sessions[0]?.send.mock.calls.at(-1);
    expect(call?.[2]?.inboxNotices?.map((notice) => notice.id)).toEqual([second.id]);
    call?.[3]?.accepted();
    expect(coordinator.notices(parent)).toBeUndefined();
    emit({ type: 'turn-ended', outcome: 'completed' });
    await tick();
    expect(claude.sessions[0]?.deliverContext).not.toHaveBeenCalled();
  });

  it('wakes a session as its turn ends with messages untold, and never while it waits on the user', async () => {
    const { claude, coordinator, parent, emit } = await withParent();
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    // A question answered by message waits on the user after its turn.
    emit({
      type: 'question-asked',
      request: { id: 'q1', questions: [], requestedAt: 1, byMessage: true },
    });
    coordinator.send(child.id, parent, 'Done', 'z');
    emit({ type: 'turn-ended', outcome: 'completed' });
    await tick();
    expect(claude.sessions[0]?.deliverContext).not.toHaveBeenCalled();
    emit({ type: 'request-resolved', requestId: 'q1', outcome: 'answered' });
    coordinator.send(child.id, parent, 'Also', 'w');
    expect(claude.sessions[0]?.deliverContext).toHaveBeenCalledOnce();
    const [context] = claude.sessions[0]?.deliverContext.mock.calls[0] ?? [];
    expect(context?.inboxNotices?.map((notice) => notice.summary)).toEqual(['Done', 'Also']);
  });

  it('refuses a message to itself, to a session not in the list, or out of bounds', async () => {
    const { coordinator, parent } = await withParent();
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    expect(() => coordinator.send(parent, parent, 'Hi', '')).toThrow('itself');
    expect(() => coordinator.send(parent, 'gone', 'Hi', '')).toThrow('no session');
    expect(() => coordinator.send(parent, child.id, ' ', '')).toThrow('summary');
    expect(() => coordinator.send(parent, child.id, 'x'.repeat(301), '')).toThrow('summary');
    expect(() => coordinator.send(parent, child.id, 'Hi', 'x'.repeat(64 * 1024 + 1))).toThrow(
      'body',
    );
  });

  it('archives, unarchives and removes a parent’s children with it, asking first where a child works', async () => {
    const inboxes = new SessionInboxes(memoryInboxStorage());
    const { host, coordinator, parent, emit } = await withParent(inboxes);
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    emit({ type: 'turn-ended', outcome: 'completed' });
    const ui = menuUi('archive', false);
    expect(await host.act(parent, 'archive', ui)).toBeNull();
    expect(ui.confirmArchive).toHaveBeenCalled();
    await host.archive(parent);
    expect(host.list().sessions).toEqual([]);
    expect(
      host
        .archived()
        .map((one) => one.id)
        .sort(),
    ).toEqual([child.id, parent].sort());
    host.unarchive(parent);
    expect(
      host
        .list()
        .sessions.map((one) => one.id)
        .sort(),
    ).toEqual([child.id, parent].sort());
    coordinator.send(parent, child.id, 'Hi', 'there');
    await host.remove(parent);
    expect(host.list().sessions).toEqual([]);
    expect(inboxes.list(child.id)).toEqual([]);
  });

  it('keeps which session is whose child for later runs', async () => {
    const { coordinator, parent, saved } = await withParent();
    const child = await coordinator.start(parent, { prompt: 'Write the tests' });
    const records = saved.at(-1) ?? [];
    expect(records.find((record) => record.id === child.id)?.parent).toBe(parent);
    const later = new SessionHost(
      [fakeProvider('claude-code').provider],
      memoryRecords(records).records,
    );
    expect(later.list().sessions.find((one) => one.id === child.id)?.parent).toBe(parent);
    expect(later.coordinator().mayStart(child.id)).toBe(false);
  });
});

describe('SessionHost history', () => {
  it('keeps each session it starts, with its title, its latest activity, the context it takes and the settings it has now, for later runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000);
    const claude = fakeProvider('claude-code');
    const { records, saved } = memoryRecords();
    const host = new SessionHost([claude.provider], records);
    const id = await host.start('claude-code', {
      cwd: folder('web'),
      mode: 'yolo',
      gateway: 'work',
      model: 'opus',
      effort: 'high',
      sandbox: 'read-only',
    });
    // The settings the session reports stand over those it started with.
    const started: SessionRecord = {
      id,
      provider: 'claude-code',
      sessionId: 'claude-code-1',
      cwd: folder('web'),
      activeAt: 5_000,
      mode: 'yolo',
      gateway: 'work',
      model: 'opus',
      effort: 'high',
      sandbox: 'workspace-write',
    };
    expect(saved).toEqual([[started]]);
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' });
    vi.setSystemTime(6_000);
    await host.send(id, 'Fix the build');
    emit({ type: 'turn-started' });
    emit({ type: 'settings', model: null, effort: null });
    emit({ type: 'mode', mode: 'auto' });
    emit({ type: 'title', title: 'Build fixes' });
    vi.setSystemTime(7_000);
    emit({ type: 'turn-ended', outcome: 'completed' });
    emit({ type: 'context', used: 25_000, size: 200_000 });
    const titled = { ...started, title: 'Fix the build' };
    const switched = { ...titled, activeAt: 6_000, model: null, effort: null };
    const ended = { ...switched, mode: 'auto' as const, title: 'Build fixes', activeAt: 7_000 };
    expect(saved.slice(1)).toEqual([
      [titled],
      [{ ...titled, activeAt: 6_000 }],
      [switched],
      [{ ...switched, mode: 'auto' }],
      [{ ...switched, mode: 'auto', title: 'Build fixes' }],
      [ended],
      [{ ...ended, context: { used: 25_000, size: 200_000 } }],
    ]);
  });

  it('lists the sessions of earlier runs as closed, the most recently active first, and gives the archived ones only when asked', async () => {
    const { records } = memoryRecords([
      kept({ id: 'older', sessionId: 'claude-8', title: undefined, activeAt: 500, archived: true }),
      kept({ id: 'oldest', sessionId: 'claude-7', activeAt: 100, archived: true }),
      kept(),
    ]);
    const host = new SessionHost([fakeProvider('claude-code').provider], records);
    const past = { provider: 'claude-code', cwd: folder('web'), status: 'closed' } as const;
    expect(host.list()).toEqual({
      sessions: [
        { ...past, id: 'kept', sessionId: 'claude-9', title: 'Fix the build', activeAt: 1_000 },
      ],
      archived: 2,
      shown: [],
    });
    expect(host.archived()).toEqual([
      { ...past, id: 'older', sessionId: 'claude-8', activeAt: 500, archived: true },
      {
        ...past,
        id: 'oldest',
        sessionId: 'claude-7',
        title: 'Fix the build',
        activeAt: 100,
        archived: true,
      },
    ]);
    const id = await host.start('claude-code', { cwd: folder('a') });
    expect(host.list().sessions.map((summary) => summary.id)).toEqual([id, 'kept']);
  });

  it('gives an archived session whose page the window shows among the shown sessions, and reports it from then on', async () => {
    const claude = fakeProvider('claude-code');
    const { records } = memoryRecords([
      kept({ id: 'older', sessionId: 'claude-8', title: undefined, activeAt: 500, archived: true }),
      kept(),
    ]);
    const host = new SessionHost([claude.provider], records);
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
    // The page of a session the Sessions list holds changes nothing there.
    host.snapshot('kept');
    expect(changes).toEqual([]);
    host.snapshot('older');
    host.snapshot('older');
    const past = { provider: 'claude-code', cwd: folder('web'), status: 'closed' } as const;
    expect(changes).toEqual([
      {
        sessions: [
          { ...past, id: 'kept', sessionId: 'claude-9', title: 'Fix the build', activeAt: 1_000 },
        ],
        archived: 1,
        shown: [{ ...past, id: 'older', sessionId: 'claude-8', activeAt: 500, archived: true }],
      },
    ]);
    // Its history, read once it is shown, gives it its title.
    await settle();
    expect(changes.at(-1)?.shown).toMatchObject([{ id: 'older', title: 'Fix the build' }]);
    host.unarchive('older');
    expect(changes.at(-1)).toMatchObject({
      sessions: [{ id: 'kept' }, { id: 'older' }],
      shown: [],
    });
    await host.archive('older');
    expect(changes.at(-1)).toMatchObject({ archived: 1, shown: [{ id: 'older' }] });
  });

  it('lists no more than the 1,000 sessions the records keep, the archived ones aside, and gives one that leaves while shown among the shown sessions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000);
    const claude = fakeProvider('claude-code');
    const { records } = memoryRecords([
      ...Array.from({ length: 1_000 }, (_, index) =>
        kept({ id: `k${String(index)}`, sessionId: `c${String(index)}`, activeAt: index + 1 }),
      ),
      kept({ id: 'archived', sessionId: 'c-archived', activeAt: 0, archived: true }),
    ]);
    const host = new SessionHost([claude.provider], records);
    host.snapshot('k1');
    const first = await host.start('claude-code', { cwd: folder('a') });
    let list = host.list();
    expect(list.sessions).toHaveLength(1_000);
    expect(list.sessions[0]?.id).toBe(first);
    expect(list.sessions.some((summary) => summary.id === 'k0')).toBe(false);
    expect(list.archived).toBe(1);
    expect(list.shown).toEqual([]);
    // A session the records no longer keep stays where the window shows it.
    await host.start('claude-code', { cwd: folder('b') });
    list = host.list();
    expect(list.sessions).toHaveLength(1_000);
    expect(list.shown).toMatchObject([{ id: 'k1', status: 'closed' }]);
  });

  it('shows a session of an earlier run with the settings it last had, and reads its history once, without resuming it', async () => {
    const claude = fakeProvider('claude-code');
    const { records, saved } = memoryRecords([kept()]);
    const host = new SessionHost([claude.provider], records);
    const heard: [string, number, SessionEvent][] = [];
    host.onEvent((id, seq, event) => heard.push([id, seq, event]));
    expect(host.snapshot('kept')).toEqual({
      seq: 0,
      state: {
        timeline: [],
        tasks: [],
        turnRunning: false,
        closed: true,
        loadingHistory: true,
        historyFailed: false,
        ...keptSettings,
      },
    });
    host.snapshot('kept');
    await settle();
    expect(claude.history.mock.calls).toEqual([['claude-9', folder('web')]]);
    // The settings the history reports are left out: the app keeps the session's own.
    const past: SessionEvent = {
      type: 'history',
      events: [{ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' }],
    };
    expect(heard).toEqual([['kept', 1, past]]);
    expect(host.snapshot('kept')).toMatchObject({
      seq: 1,
      state: {
        closed: true,
        loadingHistory: false,
        mode: 'yolo',
        model: 'opus',
        timeline: [{ type: 'message', role: 'user', text: 'Fix the build' }],
      },
    });
    expect(host.list().sessions[0]).toMatchObject({ status: 'closed', activeAt: 1_000 });
    expect(claude.resumed).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('shows the context a session of an earlier run last took, which only its provider’s process counts, before and after its history is read', async () => {
    const claude = fakeProvider('claude-code');
    const context = { used: 25_000, size: 200_000 };
    const { records, saved } = memoryRecords([kept({ context })]);
    const host = new SessionHost([claude.provider], records);
    expect(host.snapshot('kept')).toMatchObject({ state: { loadingHistory: true, context } });
    await settle();
    expect(host.snapshot('kept')).toMatchObject({ state: { loadingHistory: false, context } });
    expect(saved).toEqual([]);
  });

  it('reads a session’s history ahead of its first snapshot, once, without showing the session', async () => {
    const claude = fakeProvider('claude-code');
    const { records } = memoryRecords([
      kept(),
      kept({ id: 'older', sessionId: 'claude-8', activeAt: 500, archived: true }),
    ]);
    const host = new SessionHost([claude.provider], records);
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
    host.preload('kept');
    host.preload('older');
    host.preload('kept');
    host.preload('gone');
    await settle();
    expect(claude.history.mock.calls).toEqual([
      ['claude-9', folder('web')],
      ['claude-8', folder('web')],
    ]);
    // The first snapshot has the history already, and reads nothing more.
    expect(host.snapshot('kept')?.state).toMatchObject({
      loadingHistory: false,
      timeline: [{ type: 'message', role: 'user', text: 'Fix the build' }],
    });
    expect(claude.history).toHaveBeenCalledTimes(2);
    // The archived session, read ahead but not shown, stays out of the shown sessions.
    expect(changes.every((list) => list.shown.length === 0)).toBe(true);
    expect(host.list().shown).toEqual([]);
  });

  it('says when a session’s history could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const claude = fakeProvider('claude-code');
    claude.history.mockRejectedValue(new Error('No such session.'));
    const host = new SessionHost(
      [claude.provider],
      memoryRecords([kept(), kept({ id: 'grok', provider: 'grok-build' })]).records,
    );
    host.snapshot('kept');
    host.snapshot('grok');
    await settle();
    for (const id of ['kept', 'grok']) {
      expect(host.snapshot(id)?.state).toMatchObject({
        closed: true,
        loadingHistory: false,
        historyFailed: true,
        timeline: [],
      });
    }
  });

  it('resumes a session with the settings it is given, yolo too, without showing its history twice, and sends it the message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(9_000);
    const claude = fakeProvider('claude-code');
    const { records, saved } = memoryRecords([kept()]);
    const host = new SessionHost([claude.provider], records);
    host.snapshot('kept');
    await settle();
    const heard: SessionEvent[] = [];
    host.onEvent((_id, _seq, event) => heard.push(event));
    await host.resume('kept', keptSettings);
    expect(claude.resumed).toEqual([
      {
        sessionId: 'claude-9',
        cwd: folder('web'),
        mode: 'yolo',
        sandbox: 'read-only',
        gateway: 'work',
        model: 'opus',
        effort: 'high',
      },
    ]);
    expect(heard.map((event) => event.type)).toEqual(['mode', 'settings', 'resumed']);
    expect(host.snapshot('kept')?.state).toMatchObject({
      closed: false,
      mode: 'yolo',
      timeline: [{ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' }],
    });
    expect(host.snapshot('kept')?.state.timeline).toHaveLength(1);
    expect(host.list().sessions[0]).toMatchObject({ id: 'kept', status: 'idle', activeAt: 1_000 });
    // Nothing kept has changed yet; the message moves the session up.
    expect(saved).toEqual([]);
    await host.send('kept', 'And the tests');
    expect(claude.sessions[0]?.send.mock.calls).toEqual([['And the tests', []]]);
    expect(saved).toEqual([[kept({ activeAt: 9_000 })]]);
  });

  it('reads the history first when a session is resumed before it is shown', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords([kept()]).records);
    await host.resume('kept', { ...keptSettings, mode: 'auto' });
    expect(claude.history).toHaveBeenCalledOnce();
    expect(claude.resumed[0]?.mode).toBe('auto');
    expect(host.snapshot('kept')?.state.timeline).toHaveLength(1);
  });

  it('shows what the provider replays as the history when the history could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const claude = fakeProvider('claude-code');
    claude.history.mockRejectedValue(new Error('offline'));
    const host = new SessionHost([claude.provider], memoryRecords([kept()]).records);
    const heard: SessionEvent[] = [];
    host.onEvent((_id, _seq, event) => heard.push(event));
    await host.resume('kept', keptSettings);
    expect(heard.map((event) => event.type)).toEqual([
      'history',
      'history',
      'mode',
      'settings',
      'resumed',
    ]);
    expect(heard[1]).toEqual({
      type: 'history',
      events: [{ type: 'message', id: 'm1', role: 'user', text: 'Fix the build' }],
    });
    expect(host.snapshot('kept')?.state).toMatchObject({
      closed: false,
      historyFailed: false,
      timeline: [{ type: 'message', role: 'user', text: 'Fix the build' }],
    });
  });

  it('resumes a session whose provider stopped in this run, keeping what it showed', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords().records);
    const id = await host.start('claude-code', { cwd: folder('web') });
    const emit = claude.listeners[0];
    if (emit === undefined) throw new Error('no session');
    emit({ type: 'message', id: 'u1', role: 'user', text: 'Hi' });
    emit({ type: 'closed', error: 'Claude Code stopped.' });
    expect(host.list().sessions[0]?.status).toBe('closed');
    await expect(host.send(id, 'Still there?')).rejects.toThrow('not open');
    await host.resume(id, { ...keptSettings, gateway: null });
    expect(claude.history).not.toHaveBeenCalled();
    expect(claude.resumed).toMatchObject([{ sessionId: 'claude-code-1', mode: 'yolo' }]);
    expect(host.snapshot(id)?.state.timeline).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Hi' },
      { type: 'error', message: 'Claude Code stopped.' },
    ]);
    expect(host.list().sessions[0]?.status).toBe('idle');
    // Only the resumed session is heard from now on.
    emit({ type: 'turn-started' });
    expect(host.list().sessions[0]?.status).toBe('idle');
    await host.send(id, 'Still there?');
    expect(claude.sessions[1]?.send.mock.calls).toEqual([['Still there?', []]]);
  });

  it('resumes on the provider’s own configuration once the session’s gateway is gone', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords([kept()]).records);
    await host.resume('kept', { ...keptSettings, gateway: 'retired' });
    expect(claude.resumed).toEqual([
      { sessionId: 'claude-9', cwd: folder('web'), mode: 'yolo', sandbox: 'read-only' },
    ]);
  });

  it('resumes a session once, leaves a running one as it is, and refuses one it does not have', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords([kept()]).records);
    const first = host.resume('kept', keptSettings);
    expect(host.resume('kept', keptSettings)).toBe(first);
    await first;
    await host.resume('kept', keptSettings);
    const id = await host.start('claude-code', { cwd: folder('a') });
    await host.resume(id, keptSettings);
    expect(claude.resumed).toHaveLength(1);
    await expect(host.resume('missing', keptSettings)).rejects.toThrow('no such session');
  });

  it('keeps a session it could not resume as it was, and tries again when asked', async () => {
    const { records, saved } = memoryRecords([
      kept(),
      kept({ id: 'moved', cwd: folder('gone') }),
      kept({ id: 'grok', provider: 'grok-build' }),
    ]);
    const failing = fakeProvider('claude-code', true);
    const host = new SessionHost([failing.provider], records);
    const listener = vi.fn();
    host.onChange(listener);
    await expect(host.resume('kept', keptSettings)).rejects.toThrow('Not signed in.');
    await expect(host.resume('moved', keptSettings)).rejects.toThrow();
    await expect(host.resume('grok', keptSettings)).rejects.toThrow('not available');
    expect(host.list().sessions.map((summary) => [summary.id, summary.status])).toEqual([
      ['kept', 'closed'],
      ['moved', 'closed'],
      ['grok', 'closed'],
    ]);
    expect(host.snapshot('kept')?.state).toMatchObject({ closed: true, mode: 'yolo' });
    expect(saved).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    await expect(host.resume('kept', keptSettings)).rejects.toThrow('Not signed in.');
  });
});

describe('SessionHost archive and removal', () => {
  it('archives a session, closing it while it runs, and a message to it returns it to the Sessions list', async () => {
    const claude = fakeProvider('claude-code');
    const { records, saved } = memoryRecords();
    const host = new SessionHost([claude.provider], records);
    const id = await host.start('claude-code', { cwd: folder('web') });
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
    await host.archive(id);
    expect(claude.closed).toEqual(['claude-code-1']);
    expect(host.list()).toEqual({ sessions: [], archived: 1, shown: [] });
    expect(host.archived()).toMatchObject([{ id, status: 'closed', archived: true }]);
    expect(saved.at(-1)).toMatchObject([{ id, archived: true }]);
    // The session leaves the Sessions list; its closing changes nothing there.
    expect(changes).toEqual([{ sessions: [], archived: 1, shown: [] }]);
    await host.resume(id, keptSettings);
    expect(host.archived()).toMatchObject([{ id, status: 'idle' }]);
    await host.send(id, 'Back to it');
    expect(host.list()).toMatchObject({ sessions: [{ id }], archived: 0 });
    expect(host.list().sessions[0]?.archived).toBeUndefined();
    expect(saved.at(-1)?.[0]?.archived).toBeUndefined();
  });

  it('unarchives a session, which stays as it was', () => {
    const { records, saved } = memoryRecords([kept({ archived: true })]);
    const host = new SessionHost([fakeProvider('claude-code').provider], records);
    host.unarchive('kept');
    host.unarchive('kept');
    expect(host.list()).toMatchObject({
      sessions: [{ id: 'kept', status: 'closed' }],
      archived: 0,
    });
    expect(host.list().sessions[0]?.archived).toBeUndefined();
    expect(host.archived()).toEqual([]);
    expect(saved).toEqual([[kept()]]);
  });

  it('removes a session from the lists and the records, closing it while it runs, and hears no more of it', async () => {
    const claude = fakeProvider('claude-code');
    const { records, saved } = memoryRecords([kept()]);
    const host = new SessionHost([claude.provider], records);
    const id = await host.start('claude-code', { cwd: folder('web') });
    const changes: SessionList[] = [];
    host.onChange((list) => changes.push(list));
    await host.remove(id);
    await host.remove('kept');
    expect(claude.closed).toEqual(['claude-code-1']);
    expect(host.list()).toEqual({ sessions: [], archived: 0, shown: [] });
    expect(changes.map((list) => list.sessions.length)).toEqual([1, 0]);
    expect(saved.at(-1)).toEqual([]);
    expect(host.snapshot(id)).toBeNull();
    claude.listeners[0]?.({ type: 'title', title: 'Late' });
    expect(saved.at(-1)).toEqual([]);
  });

  it('archives or removes from the session’s menu, asking first where it stops or removes a session', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost([claude.provider], memoryRecords([kept()]).records);
    const id = await host.start('claude-code', { cwd: folder('web') });
    claude.listeners[0]?.({ type: 'turn-started' });
    // A working session is archived only once the user confirms, which stops it.
    const declined = menuUi('archive', false);
    expect(await host.showMenu(id, declined)).toBeNull();
    expect(declined.sessionMenu.mock.calls).toEqual([[host.list().sessions[0]]]);
    expect(declined.confirmArchive).toHaveBeenCalledOnce();
    expect(host.list().sessions[0]).toMatchObject({ status: 'running' });
    expect(await host.showMenu(id, menuUi('archive'))).toBe('archive');
    expect(claude.closed).toEqual(['claude-code-1']);
    // A session that is not working is archived without a question.
    const idle = menuUi('archive');
    expect(await host.showMenu('kept', idle)).toBe('archive');
    expect(idle.confirmArchive).not.toHaveBeenCalled();
    expect(host.list()).toMatchObject({ sessions: [], archived: 2 });
    expect(await host.showMenu('kept', menuUi('unarchive'))).toBe('unarchive');
    expect(await host.showMenu('kept', menuUi('remove', false))).toBeNull();
    expect(await host.showMenu('kept', menuUi(null))).toBeNull();
    expect(host.list()).toMatchObject({ sessions: [{ id: 'kept' }], archived: 1 });
    const removing = menuUi('remove');
    expect(await host.showMenu('kept', removing)).toBe('remove');
    expect(removing.confirmRemove).toHaveBeenCalledOnce();
    expect(host.list()).toMatchObject({ sessions: [], archived: 1 });
    expect(host.archived().map((summary) => summary.id)).toEqual([id]);
    const unknown = menuUi('remove');
    expect(await host.showMenu('missing', unknown)).toBeNull();
    expect(unknown.sessionMenu).not.toHaveBeenCalled();
  });
});

describe('SessionHost search', () => {
  it('keeps each session’s text as its history is read and as its turns end, and forgets a removed one’s', async () => {
    const claude = fakeProvider('claude-code');
    const texts = new Map<string, string>();
    const host = new SessionHost(
      [claude.provider],
      memoryRecords([kept()]).records,
      memoryTextStorage(texts),
    );
    host.snapshot('kept');
    await settle();
    expect(texts.get('kept')).toBe('Fix the build');
    const id = await host.start('claude-code', { cwd: folder('a') });
    claude.listeners[0]?.({ type: 'message', id: 'u1', role: 'user', text: 'Write the docs' });
    claude.listeners[0]?.({ type: 'message', id: 'a1', role: 'agent', text: 'Docs written.' });
    expect(texts.has(id)).toBe(false);
    claude.listeners[0]?.({ type: 'turn-ended', outcome: 'completed' });
    await settle();
    expect(texts.get(id)).toBe('Write the docs\n\nDocs written.');
    await host.remove(id);
    await settle();
    expect(texts.has(id)).toBe(false);
  });

  it('finds the sessions of a list whose title and conversation hold every word, saying how many it has not read', async () => {
    const claude = fakeProvider('claude-code');
    const texts = new Map([['older', 'We moved the parser to Rust.']]);
    const host = new SessionHost(
      [claude.provider],
      memoryRecords([
        kept(),
        kept({ id: 'older', sessionId: 'claude-8', title: 'Speed up', activeAt: 500 }),
        kept({ id: 'unread', sessionId: 'claude-7', title: 'Unread', activeAt: 400 }),
        kept({ id: 'shelved', sessionId: 'claude-6', title: 'Parser idea', archived: true }),
      ]).records,
      memoryTextStorage(texts),
    );
    // A session read in this run is searched as it is now.
    host.snapshot('kept');
    await settle();
    expect(await host.search('PARSER rust', false)).toEqual({
      matches: [{ id: 'older', snippet: 'We moved the parser to Rust.' }],
      unread: 1,
    });
    expect(await host.search('fix build', false)).toEqual({
      matches: [{ id: 'kept', snippet: 'Fix the build' }],
      unread: 1,
    });
    // The archived list is searched apart, by title too.
    expect(await host.search('parser', true)).toEqual({ matches: [{ id: 'shelved' }], unread: 1 });
    expect(await host.search('  ', false)).toEqual({ matches: [], unread: 1 });
  });

  it('catches up on the sessions without a text, the most recently active first, one at a time and once', async () => {
    const claude = fakeProvider('claude-code');
    const failing = fakeProvider('codex');
    failing.history.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const texts = new Map([
      ['kept', 'Already kept'],
      ['gone', 'A session the records no longer keep'],
    ]);
    const host = new SessionHost(
      [claude.provider, failing.provider],
      memoryRecords([
        kept(),
        kept({ id: 'older', sessionId: 'claude-8', activeAt: 500 }),
        kept({ id: 'newer', sessionId: 'claude-7', activeAt: 2_000, archived: true }),
        kept({ id: 'offline', provider: 'codex', sessionId: 'thread-1', activeAt: 100 }),
      ]).records,
      memoryTextStorage(texts),
    );
    await host.catchUp();
    expect(claude.history.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'claude-7',
      'claude-8',
    ]);
    expect(texts.get('newer')).toBe('Fix the build');
    expect(texts.get('older')).toBe('Fix the build');
    expect(texts.get('kept')).toBe('Already kept');
    expect(texts.has('gone')).toBe(false);
    // A session whose history cannot be read is no longer counted as unread in this run.
    expect((await host.search('build', false)).unread).toBe(0);
    // Nothing is read twice, nor kept in the sessions' state.
    await host.catchUp();
    expect(claude.history).toHaveBeenCalledTimes(2);
    expect(host.snapshot('older')?.state.loadingHistory).toBe(true);
  });

  it('stops catching up as the app quits', async () => {
    const claude = fakeProvider('claude-code');
    const host = new SessionHost(
      [claude.provider],
      memoryRecords([kept(), kept({ id: 'older', sessionId: 'claude-8', activeAt: 500 })]).records,
    );
    await host.closeAll();
    await host.catchUp();
    expect(claude.history).not.toHaveBeenCalled();
  });

  it('does what a session’s menu would without its menu, asking first where the menu asks', async () => {
    const host = new SessionHost(
      [fakeProvider('claude-code').provider],
      memoryRecords([kept({ archived: true }), kept({ id: 'other', sessionId: 'claude-8' })])
        .records,
    );
    const ui = menuUi(null, false);
    expect(await host.act('kept', 'unarchive', ui)).toBe('unarchive');
    expect(host.list().archived).toBe(0);
    expect(await host.act('other', 'remove', ui)).toBeNull();
    expect(ui.confirmRemove).toHaveBeenCalledOnce();
    expect(ui.sessionMenu).not.toHaveBeenCalled();
    expect(await host.act('gone', 'remove', ui)).toBeNull();
  });
});

function automationFixture() {
  const accepted = vi.fn();
  const failed = vi.fn();
  // Reports since when an operation approval has waited, as the toolset's binding does.
  const waiting = new Set<(since: number | undefined) => void>();
  const session = {
    toolset: {
      name: 'fixture',
      callTimeoutMs: 86_400_000,
      open: () => ({ url: 'http://127.0.0.1/fixture', credential: 'synthetic', close: vi.fn() }),
    },
    turnStarted: vi.fn(),
    turnEnded: vi.fn(),
    stop: vi.fn(),
    setPolicy: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn<import('./provider').SessionAutomation['close']>(() => Promise.resolve()),
    prepareSend: vi.fn(() => ({ context: { presentationNotices: [] }, accepted, failed })),
    linkResult: vi.fn(),
    onWaiting: (listener: (since: number | undefined) => void) => {
      waiting.add(listener);
      listener(undefined);
      return () => {
        waiting.delete(listener);
      };
    },
  } satisfies import('./provider').SessionAutomation;
  const bind = vi.fn<import('./provider').SessionAutomationHost['bind']>(() =>
    Promise.resolve(session),
  );
  const approvalsSince = (since: number | undefined) => {
    for (const listener of waiting) listener(since);
  };
  return { session, bind, accepted, failed, approvalsSince, waiting };
}

describe('session automation lifecycle', () => {
  it('lists a session as waiting while an operation approval waits for the user, since the oldest request', async () => {
    const fake = fakeProvider('codex');
    const automation = automationFixture();
    const host = new SessionHost(
      [fake.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    const lists: SessionList[] = [];
    host.onChange((list) => lists.push(list));
    const id = await host.start('codex', { cwd: folder('web') });
    fake.listeners[0]?.({ type: 'turn-started' });
    const summary = () => lists.at(-1)?.sessions.find((session) => session.id === id);
    expect(summary()?.status).toBe('running');
    automation.approvalsSince(500);
    expect(summary()).toMatchObject({ status: 'waiting', waitingSince: 500 });
    fake.listeners[0]?.({
      type: 'approval-requested',
      request: {
        id: 'r1',
        action: 'command',
        command: 'pnpm test',
        canAllowForSession: true,
        denyByDefault: false,
        requestedAt: 900,
      },
    });
    expect(summary()).toMatchObject({ status: 'waiting', waitingSince: 500 });
    automation.approvalsSince(undefined);
    expect(summary()).toMatchObject({ status: 'waiting', waitingSince: 900 });
    fake.listeners[0]?.({ type: 'request-resolved', requestId: 'r1', outcome: 'answered' });
    expect(summary()?.status).toBe('running');
    expect(summary()?.waitingSince).toBeUndefined();
    await host.closeAll();
    expect(automation.waiting.size).toBe(0);
  });

  it('sends the user message and by-message answer even when supplemental context cannot be prepared', async () => {
    const fake = fakeProvider('codex');
    const automation = automationFixture();
    automation.session.prepareSend.mockImplementation(() => {
      throw Error('access-revoked');
    });
    const host = new SessionHost(
      [fake.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    const id = await host.start('codex', { cwd: folder('web') });
    await host.send(id, 'Original message');
    expect(fake.sessions[0]?.send).toHaveBeenCalledExactlyOnceWith('Original message', []);
    fake.listeners[0]?.({
      type: 'question-asked',
      request: { id: 'async', questions: [], requestedAt: 1, byMessage: true },
    });
    const answer = { decision: 'answer' as const, answers: { '0': { selected: ['Yes'] } } };
    await host.answerQuestion(id, 'async', answer);
    expect(fake.sessions[0]?.answerQuestion).toHaveBeenCalledExactlyOnceWith('async', answer);
    await host.closeAll();
  });
  it('offers pending context on question replies that start a message, without consuming a locally queued reply', async () => {
    const fake = fakeProvider('codex');
    const automation = automationFixture();
    const host = new SessionHost(
      [fake.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    const id = await host.start('codex', { cwd: folder('web') });
    fake.listeners[0]?.({
      type: 'question-asked',
      request: { id: 'async-question', questions: [], requestedAt: 1, byMessage: true },
    });
    const answer = {
      decision: 'answer' as const,
      answers: { '0': { selected: ['Yes'], text: '' } },
    };
    await host.answerQuestion(id, 'async-question', answer);
    const sent = fake.sessions[0]?.answerQuestion.mock.calls[0];
    expect(sent?.[2]).toEqual({ presentationNotices: [] });
    expect(automation.accepted).not.toHaveBeenCalled();
    sent?.[3]?.accepted();
    expect(automation.accepted).toHaveBeenCalledOnce();
    await host.closeAll();
  });
  it('binds the app owner before startup, preserving it across a different native ID and resume', async () => {
    const fake = fakeProvider('codex');
    const automation = automationFixture();
    const originalStart = fake.provider.start.bind(fake.provider);
    const start = vi.spyOn(fake.provider, 'start').mockImplementation((options, listener) => {
      expect(automation.bind).toHaveBeenCalledTimes(1);
      expect(options.toolset).toBe(automation.session.toolset);
      return originalStart(options, listener);
    });
    const host = new SessionHost(
      [fake.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    const id = await host.start('codex', { cwd: folder('web') });
    expect(automation.bind.mock.calls[0]?.[0]).toMatchObject({
      id,
      cwd: folder('web'),
      mode: 'auto',
      sandbox: 'workspace-write',
    });
    expect(host.list().sessions[0]?.sessionId).not.toBe(id);
    expect(start).toHaveBeenCalledTimes(1);
    fake.listeners[0]?.({ type: 'turn-started' });
    fake.listeners[0]?.({ type: 'turn-ended', outcome: 'completed' });
    expect(automation.session.turnStarted).toHaveBeenCalledTimes(1);
    expect(automation.session.turnEnded).toHaveBeenCalledTimes(1);
    fake.listeners[0]?.({ type: 'closed' });
    expect(automation.session.disconnect).toHaveBeenCalledTimes(1);
    await host.resume(id, {
      ...keptSettings,
      mode: 'auto',
      sandbox: 'workspace-write',
      gateway: null,
    });
    expect(automation.bind.mock.calls[1]?.[0].id).toBe(id);
    expect(fake.resumed[0]?.toolset).toBe(automation.session.toolset);
    await host.closeAll();
  });
  it('acknowledges notice delivery only after the provider accepts the send', async () => {
    const fake = fakeProvider('codex');
    const automation = automationFixture();
    const host = new SessionHost(
      [fake.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    const id = await host.start('codex', { cwd: folder('web') });
    await host.send(id, 'Hello');
    expect(fake.sessions[0]?.send).toHaveBeenCalledWith(
      'Hello',
      [],
      { presentationNotices: [] },
      expect.objectContaining({ accepted: automation.accepted }),
    );
    expect(automation.accepted).not.toHaveBeenCalled();
    fake.sessions[0]?.send.mock.calls[0]?.[3]?.accepted();
    expect(automation.accepted).toHaveBeenCalledTimes(1);
    fake.sessions[0]?.send.mockRejectedValueOnce(new Error('Send failed.'));
    await expect(host.send(id, 'Retry')).rejects.toThrow('Send failed.');
    expect(automation.accepted).toHaveBeenCalledTimes(1);
    expect(automation.failed).toHaveBeenCalledTimes(1);
    await host.interrupt(id);
    expect(automation.session.stop).toHaveBeenCalled();
    await host.remove(id);
    expect(automation.session.close).toHaveBeenCalledWith(true);
  });
  it('releases a binding after failed startup and restores policy when a provider refuses a change', async () => {
    const failed = fakeProvider('codex', true);
    const automation = automationFixture();
    const host = new SessionHost(
      [failed.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    await expect(host.start('codex', { cwd: folder('web') })).rejects.toThrow('Not signed in.');
    expect(automation.session.close).toHaveBeenCalledWith(true);
    const fake = fakeProvider('codex');
    const active = new SessionHost(
      [fake.provider],
      memoryRecords().records,
      memoryTextStorage(),
      automation,
    );
    const id = await active.start('codex', { cwd: folder('web') });
    fake.sessions[0]?.setSandbox.mockRejectedValueOnce(new Error('Refused.'));
    await expect(active.setSandbox(id, 'read-only')).rejects.toThrow('Refused.');
    expect(automation.session.setPolicy).toHaveBeenLastCalledWith({
      mode: 'auto',
      sandbox: 'workspace-write',
    });
    await active.archive(id);
    expect(automation.session.close).toHaveBeenCalled();
  });
});

it('does not retire host notices when an adapter cannot accept separate turn context', async () => {
  const fake = fakeProvider('codex');
  const automation = automationFixture();
  const original = fake.provider.start.bind(fake.provider);
  vi.spyOn(fake.provider, 'start').mockImplementation(async (options, listener) => ({
    ...(await original(options, listener)),
    supportsHostContext: undefined,
  }));
  const host = new SessionHost(
    [fake.provider],
    memoryRecords().records,
    memoryTextStorage(),
    automation,
  );
  const id = await host.start('codex', { cwd: folder('web') });
  await host.send(id, 'User text');
  expect(fake.sessions[0]?.send).toHaveBeenCalledWith('User text', []);
  expect(automation.accepted).not.toHaveBeenCalled();
  expect(automation.failed).toHaveBeenCalledTimes(1);
  await host.closeAll();
});
