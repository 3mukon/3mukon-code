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
      },
    ]);
  });

  it('gives a tool call first seen through its output neutral defaults', () => {
    const state = applyEvent(initialSessionState(), { type: 'tool-output', id: 't9', text: 'x' });
    expect(state.timeline).toEqual([
      { type: 'tool', id: 't9', kind: 'other', title: '', status: 'pending', output: 'x' },
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

  it('ignores the resolution of a request it never saw', () => {
    const state = initialSessionState();
    expect(
      applyEvent(state, { type: 'request-resolved', requestId: 'nope', outcome: 'answered' }),
    ).toBe(state);
  });
});
