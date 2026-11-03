import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, QuestionRequest, SessionEvent } from './events';
import {
  applyEvent,
  initialSessionState,
  openRequests,
  sessionStatus,
  type SessionState,
} from './session-state';

const approval: ApprovalRequest = {
  id: 'approval-1',
  action: 'command',
  command: 'pnpm test',
  cwd: '/work',
  canAllowForSession: true,
  denyByDefault: false,
  requestedAt: 2000,
};

const question: QuestionRequest = {
  id: 'question-1',
  questions: [
    {
      id: 'q1',
      header: 'Terminal',
      text: 'Keep the terminal open by default?',
      options: [{ label: 'Collapsed' }, { label: 'Expanded' }],
      multiSelect: false,
      freeText: true,
      secret: false,
    },
  ],
  requestedAt: 1000,
};

function fold(events: SessionEvent[], state = initialSessionState()): SessionState {
  return events.reduce(applyEvent, state);
}

describe('applyEvent', () => {
  it('keeps the latest count of the context the conversation takes', () => {
    expect(
      fold([
        { type: 'context', used: 1200, size: 200_000 },
        { type: 'context', used: 4800, size: null },
      ]).context,
    ).toEqual({ used: 4800, size: null });
  });

  it('assembles a streamed message, and a full message replaces it', () => {
    const streamed = fold([
      { type: 'message-delta', id: 'm1', role: 'agent', text: 'Refactor' },
      { type: 'message-delta', id: 'm1', role: 'agent', text: 'ing the layout.' },
    ]);
    expect(streamed.timeline).toEqual([
      { type: 'message', id: 'm1', role: 'agent', text: 'Refactoring the layout.' },
    ]);
    const replaced = applyEvent(streamed, {
      type: 'message',
      id: 'm1',
      role: 'agent',
      text: 'Done.',
    });
    expect(replaced.timeline).toEqual([
      { type: 'message', id: 'm1', role: 'agent', text: 'Done.' },
    ]);
  });

  it('starts a tool call, updates only the fields an event names, and appends output', () => {
    const state = fold([
      {
        type: 'tool',
        id: 't1',
        kind: 'execute',
        title: 'Run tests',
        status: 'running',
        command: 'pnpm test',
      },
      { type: 'tool-output', id: 't1', text: 'ok 1\n' },
      { type: 'tool-output', id: 't1', text: 'ok 2\n' },
      { type: 'tool', id: 't1', status: 'completed' },
    ]);
    expect(state.timeline).toEqual([
      {
        type: 'tool',
        id: 't1',
        kind: 'execute',
        title: 'Run tests',
        status: 'completed',
        command: 'pnpm test',
        output: 'ok 1\nok 2\n',
        changes: [],
      },
    ]);
  });

  it('keeps a message’s images, the streamed ones added at its end, and a tool call’s', () => {
    const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const jpeg = { mediaType: 'image/jpeg', data: '/9j/4AAQ' };
    const state = fold([
      { type: 'message', id: 'u1', role: 'user', text: 'Look', images: [png] },
      { type: 'message-delta', id: 'a1', role: 'agent', text: 'Here', images: [png] },
      { type: 'message-delta', id: 'a1', role: 'agent', text: ' it is', images: [jpeg] },
      { type: 'message-delta', id: 'a1', role: 'agent', text: '.' },
      { type: 'tool', id: 't1', kind: 'read', title: 'shot.png', status: 'running' },
      { type: 'tool', id: 't1', status: 'completed', images: [png] },
    ]);
    expect(state.timeline).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Look', images: [png] },
      { type: 'message', id: 'a1', role: 'agent', text: 'Here it is.', images: [png, jpeg] },
      {
        type: 'tool',
        id: 't1',
        kind: 'read',
        title: 'shot.png',
        status: 'completed',
        output: '',
        changes: [],
        images: [png],
      },
    ]);
  });

  it('shows the files a tool call changed with the call, and other changes on their own', () => {
    const change = (id: string, diff: string) =>
      ({ id, path: 'src/a.ts', kind: 'update', diff }) as const;
    const state = fold([
      { type: 'tool', id: 't1', kind: 'edit', title: 'src/a.ts', status: 'running' },
      { type: 'tool', id: 't1', status: 'completed' },
      { type: 'file-change', change: change('t1:0', '@@ -1 +1 @@\n-a\n+b\n'), toolId: 't1' },
      { type: 'file-change', change: change('t1:1', '@@ -1 +1 @@\n-c\n+d\n'), toolId: 't1' },
      { type: 'file-change', change: change('t1:0', '@@ -1 +1 @@\n-a\n+e\n'), toolId: 't1' },
      { type: 'file-change', change: change('c9', '@@ -1 +1 @@\n-x\n+y\n'), toolId: 'gone' },
    ]);
    expect(state.timeline).toEqual([
      {
        type: 'tool',
        id: 't1',
        kind: 'edit',
        title: 'src/a.ts',
        status: 'completed',
        output: '',
        changes: [change('t1:0', '@@ -1 +1 @@\n-a\n+e\n'), change('t1:1', '@@ -1 +1 @@\n-c\n+d\n')],
      },
      { type: 'file-change', change: change('c9', '@@ -1 +1 @@\n-x\n+y\n') },
    ]);
  });

  it('gives a tool call first seen through its output neutral defaults', () => {
    const state = applyEvent(initialSessionState(), { type: 'tool-output', id: 't9', text: 'x' });
    expect(state.timeline).toEqual([
      {
        type: 'tool',
        id: 't9',
        kind: 'other',
        title: '',
        status: 'pending',
        output: 'x',
        changes: [],
      },
    ]);
  });

  it('keeps the timeline in the order things first happened', () => {
    const state = fold([
      { type: 'message', id: 'u1', role: 'user', text: 'Refactor the layout.' },
      { type: 'tool', id: 't1', kind: 'read', title: 'Read Workspace.tsx', status: 'running' },
      {
        type: 'file-change',
        change: {
          id: 'c1',
          path: 'src/ui/Workspace.tsx',
          kind: 'update',
          diff: '@@ -1 +1 @@\n-a\n+b\n',
        },
      },
      { type: 'tool', id: 't1', status: 'completed' },
    ]);
    expect(state.timeline.map((item) => item.type)).toEqual(['message', 'tool', 'file-change']);
  });

  it('replaces the task list as a whole', () => {
    const state = fold([
      { type: 'tasks', tasks: [{ text: 'Inspect sidebar components', status: 'in_progress' }] },
      {
        type: 'tasks',
        tasks: [
          { text: 'Inspect sidebar components', status: 'completed' },
          { text: 'Add resizable split panes', status: 'in_progress' },
        ],
      },
    ]);
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[0]?.status).toBe('completed');
  });

  it('records the title, the mode and the end of a replay', () => {
    const state = fold(
      [
        { type: 'title', title: 'layout-refactor' },
        { type: 'mode', mode: 'yolo' },
        { type: 'replay-finished' },
      ],
      initialSessionState(true),
    );
    expect(state).toMatchObject({
      title: 'layout-refactor',
      mode: 'yolo',
      loadingHistory: false,
    });
  });

  it('folds a session’s history at once, not running, and says when it could not be read', () => {
    const closed = { ...initialSessionState(true), closed: true, mode: 'yolo' as const };
    const past = applyEvent(closed, {
      type: 'history',
      events: [
        { type: 'message', id: 'm1', role: 'user', text: 'Fix the build' },
        { type: 'turn-started' },
        { type: 'message-delta', id: 'm2', role: 'agent', text: 'On ' },
        { type: 'message-delta', id: 'm2', role: 'agent', text: 'it.' },
        { type: 'approval-requested', request: approval },
        { type: 'title', title: 'Build fixes' },
      ],
    });
    expect(past).toMatchObject({
      closed: true,
      mode: 'yolo',
      title: 'Build fixes',
      turnRunning: false,
      loadingHistory: false,
      historyFailed: false,
    });
    expect(past.timeline).toEqual([
      { type: 'message', id: 'm1', role: 'user', text: 'Fix the build' },
      { type: 'message', id: 'm2', role: 'agent', text: 'On it.' },
      { type: 'approval', request: approval, resolution: 'cancelled' },
    ]);
    expect(openRequests(past)).toEqual([]);
    const unread = applyEvent(closed, { type: 'history', events: [], failed: true });
    expect(unread).toMatchObject({ loadingHistory: false, historyFailed: true, timeline: [] });
  });

  it('runs a resumed session again, its history kept', () => {
    const past = applyEvent(
      { ...initialSessionState(), closed: true, historyFailed: true },
      { type: 'message', id: 'm1', role: 'user', text: 'Fix the build' },
    );
    const resumed = applyEvent(past, { type: 'resumed' });
    expect(resumed).toMatchObject({ closed: false, historyFailed: false });
    expect(resumed.timeline).toEqual(past.timeline);
    expect(sessionStatus(resumed)).toBe('idle');
  });

  it('keeps the user’s answer with its request, an approval’s with an approval and a question’s with a question', () => {
    const state = fold([
      { type: 'approval-requested', request: approval },
      { type: 'question-asked', request: question },
      { type: 'request-answered', requestId: 'approval-1', answer: { decision: 'allow-once' } },
      { type: 'request-answered', requestId: question.id, answer: { decision: 'decline' } },
      { type: 'request-answered', requestId: question.id, answer: { decision: 'deny' } },
      { type: 'request-answered', requestId: 'nope', answer: { decision: 'decline' } },
    ]);
    expect(
      state.timeline.map((item) =>
        item.type === 'approval' || item.type === 'question' ? item.answer : undefined,
      ),
    ).toEqual([{ decision: 'allow-once' }, { decision: 'decline' }]);
  });

  it('never changes the state it is given', () => {
    const before = fold([
      { type: 'message', id: 'm1', role: 'agent', text: 'a' },
      { type: 'approval-requested', request: approval },
    ]);
    const snapshot = structuredClone(before);
    fold(
      [
        { type: 'message-delta', id: 'm1', role: 'agent', text: 'b' },
        { type: 'request-resolved', requestId: 'approval-1', outcome: 'answered' },
        { type: 'tasks', tasks: [] },
        { type: 'closed' },
      ],
      before,
    );
    expect(before).toEqual(snapshot);
  });

  it('holds only data that survives JSON, so the state can cross to the renderer', () => {
    const state = fold([
      { type: 'turn-started' },
      { type: 'message', id: 'm1', role: 'agent', text: 'Working' },
      { type: 'tool', id: 't1', kind: 'edit', title: 'Edit', status: 'running', paths: ['a.ts'] },
      { type: 'question-asked', request: question },
      { type: 'error', message: 'Rate limited' },
    ]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

describe('sessionStatus and openRequests', () => {
  it('follows a turn from running to waiting and back, to idle', () => {
    let state = initialSessionState();
    expect(sessionStatus(state)).toBe('idle');
    state = applyEvent(state, { type: 'turn-started' });
    expect(sessionStatus(state)).toBe('running');
    state = applyEvent(state, { type: 'approval-requested', request: approval });
    expect(sessionStatus(state)).toBe('waiting');
    state = applyEvent(state, {
      type: 'request-resolved',
      requestId: 'approval-1',
      outcome: 'answered',
    });
    expect(sessionStatus(state)).toBe('running');
    state = applyEvent(state, { type: 'turn-ended', outcome: 'completed' });
    expect(sessionStatus(state)).toBe('idle');
  });

  it('lists open requests oldest first', () => {
    const state = fold([
      { type: 'approval-requested', request: approval },
      { type: 'question-asked', request: question },
    ]);
    expect(openRequests(state).map((request) => request.id)).toEqual(['question-1', 'approval-1']);
  });

  it('cancels requests left open when the turn ends, and records a failure', () => {
    const state = fold([
      { type: 'turn-started' },
      { type: 'question-asked', request: question },
      { type: 'turn-ended', outcome: 'failed', error: 'Connection lost' },
    ]);
    expect(openRequests(state)).toEqual([]);
    expect(state.timeline).toEqual([
      { type: 'question', request: question, resolution: 'cancelled' },
      { type: 'error', message: 'Connection lost' },
    ]);
    expect(sessionStatus(state)).toBe('idle');
  });

  it('keeps a question answered by message open after its turn, until the session closes', () => {
    const byMessage = { ...question, id: 'question-2', byMessage: true };
    let state = fold([
      { type: 'turn-started' },
      { type: 'question-asked', request: question },
      { type: 'question-asked', request: byMessage },
      { type: 'turn-ended', outcome: 'completed' },
    ]);
    expect(openRequests(state)).toEqual([byMessage]);
    expect(sessionStatus(state)).toBe('waiting');
    state = applyEvent(state, { type: 'closed' });
    expect(openRequests(state)).toEqual([]);
  });

  it('closes, cancelling what is still open', () => {
    const state = fold([
      { type: 'turn-started' },
      { type: 'approval-requested', request: approval },
      { type: 'closed', error: 'The provider exited' },
    ]);
    expect(sessionStatus(state)).toBe('closed');
    expect(openRequests(state)).toEqual([]);
    expect(state.turnRunning).toBe(false);
  });

  it('keeps the latest gateway, model, effort and sandbox, and the models the session can use', () => {
    const models = [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }];
    const state = fold([
      { type: 'settings', gateway: null, model: null, effort: null, sandbox: 'workspace-write' },
      { type: 'models', models },
      { type: 'settings', model: 'claude-opus-5' },
      { type: 'settings', gateway: 'work', effort: 'high' },
      { type: 'settings', sandbox: 'read-only' },
    ]);
    expect(state).toMatchObject({
      gateway: 'work',
      model: 'claude-opus-5',
      effort: 'high',
      sandbox: 'read-only',
      models,
    });
  });

  it('ignores the resolution of a request it never saw', () => {
    const state = initialSessionState();
    expect(
      applyEvent(state, { type: 'request-resolved', requestId: 'nope', outcome: 'answered' }),
    ).toBe(state);
  });
});
