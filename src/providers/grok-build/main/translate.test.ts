import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../sessions/shared/events';
import { currentChoices, Translator } from './translate';

const text = (value: string) => ({ type: 'text' as const, text: value });

function translate(updates: SessionUpdate[]): SessionEvent[] {
  const translator = new Translator('/work');
  return updates.flatMap((update) => translator.update(update));
}

describe('messages', () => {
  it('streams chunks of one role into one message until something else comes between', () => {
    const events = translate([
      { sessionUpdate: 'agent_thought_chunk', content: text('Thinking') },
      { sessionUpdate: 'agent_message_chunk', content: text('Hi') },
      { sessionUpdate: 'agent_message_chunk', content: text(' there') },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt', kind: 'read' },
      { sessionUpdate: 'agent_message_chunk', content: text('Done') },
    ]);
    const deltas = events.filter((event) => event.type === 'message-delta');
    expect(deltas.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'thinking', text: 'Thinking' },
      { role: 'agent', text: 'Hi' },
      { role: 'agent', text: ' there' },
      { role: 'agent', text: 'Done' },
    ]);
    const [thought, hi, there, done] = deltas;
    expect(new Set([thought?.id, hi?.id, done?.id]).size).toBe(3);
    expect(there?.id).toBe(hi?.id);
  });

  it('starts a new message once the current one has ended', () => {
    const translator = new Translator('/work');
    const first = translator.update({ sessionUpdate: 'user_message_chunk', content: text('One') });
    translator.endMessage();
    const second = translator.update({ sessionUpdate: 'user_message_chunk', content: text('Two') });
    expect(first[0]).toMatchObject({ role: 'user', text: 'One' });
    expect(second[0]).toMatchObject({ role: 'user', text: 'Two' });
    expect(first[0]?.type === 'message-delta' && first[0].id).not.toBe(
      second[0]?.type === 'message-delta' && second[0].id,
    );
  });

  it('keeps text and images, without empty ones', () => {
    expect(
      translate([
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: '', mimeType: 'image/png' },
        },
        { sessionUpdate: 'agent_message_chunk', content: text('') },
      ]),
    ).toEqual([]);
    const [image] = translate([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      },
    ]);
    expect(image).toMatchObject({
      type: 'message-delta',
      role: 'agent',
      text: '',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
  });
});

describe('tool calls', () => {
  it('shows a running call, then its status, command and output as they come', () => {
    expect(
      translate([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Run ls',
          rawInput: { command: 'ls' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          kind: 'execute',
          locations: [{ path: '/work/src' }, { path: '/elsewhere/x' }],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'content', content: text('a.txt') }],
        },
      ]),
    ).toEqual([
      { type: 'tool', id: 't1', title: 'Run ls', status: 'running', command: 'ls' },
      { type: 'tool', id: 't1', kind: 'execute', paths: ['src', '/elsewhere/x'] },
      { type: 'tool', id: 't1', status: 'completed', output: 'a.txt' },
    ]);
  });

  it('takes a replayed call complete, and maps the statuses', () => {
    const events = translate([
      { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'A', status: 'completed' },
      { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'B', status: 'failed' },
      { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'C', status: 'in_progress' },
      { sessionUpdate: 'tool_call', toolCallId: 'd', title: 'D', status: 'pending' },
    ]);
    expect(events.map((event) => event.type === 'tool' && event.status)).toEqual([
      'completed',
      'failed',
      'running',
      'pending',
    ]);
  });

  it('reports a completed call’s diffs as file changes, with new and deleted files', () => {
    const events = translate([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        title: 'Edit',
        kind: 'edit',
        content: [
          { type: 'diff', path: '/work/a.txt', oldText: 'one\n', newText: 'two\n' },
          { type: 'diff', path: '/work/new.txt', newText: 'hello\n' },
        ],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'd1',
        title: 'Delete',
        kind: 'delete',
        content: [{ type: 'diff', path: '/work/gone.txt', oldText: 'bye\n', newText: '' }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'd1', status: 'completed' },
    ]);
    expect(events[0]).toMatchObject({ type: 'tool', paths: ['a.txt', 'new.txt'] });
    const changes = events.flatMap((event) => (event.type === 'file-change' ? [event.change] : []));
    expect(changes).toEqual([
      {
        id: 'e1:0',
        path: 'a.txt',
        kind: 'update',
        diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n',
      },
      {
        id: 'e1:1',
        path: 'new.txt',
        kind: 'add',
        diff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n',
      },
      {
        id: 'd1:0',
        path: 'gone.txt',
        kind: 'delete',
        diff: '--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n',
      },
    ]);
  });

  it('takes an empty text before as a new file, as Grok gives a file it creates', () => {
    const events = translate([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'n1',
        title: 'Edit',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: '/work/notes.txt', oldText: '', newText: 'ok' }],
      },
    ]);
    expect(events.find((event) => event.type === 'file-change')).toMatchObject({
      change: { path: 'notes.txt', kind: 'add' },
      toolId: 'n1',
    });
  });

  it('names the file a file tool’s input names, and remembers a call’s files and diffs until it ends', () => {
    const translator = new Translator('/work');
    const started = translator.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'e1',
      title: 'search_replace',
      rawInput: { file_path: '/work/notes.txt', old_string: '', new_string: 'ok' },
    });
    expect(started[0]).toMatchObject({ paths: ['notes.txt'] });
    translator.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      kind: 'edit',
      content: [{ type: 'diff', path: '/work/notes.txt', oldText: '', newText: 'ok' }],
    });
    expect(translator.callOf('e1')).toEqual({
      kind: 'edit',
      paths: ['notes.txt'],
      diffs: [{ type: 'diff', path: '/work/notes.txt', oldText: '', newText: 'ok' }],
    });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'failed' });
    expect(translator.callOf('e1')).toBeUndefined();
  });

  it('reports no file change for a call that failed', () => {
    const events = translate([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        title: 'Edit',
        kind: 'edit',
        content: [{ type: 'diff', path: '/work/a.txt', oldText: 'one\n', newText: 'two\n' }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'failed' },
    ]);
    expect(events.some((event) => event.type === 'file-change')).toBe(false);
  });
});

describe('the rest of a session', () => {
  it('reports the plan as tasks, the title, the mode and the model and effort', () => {
    expect(
      translate([
        {
          sessionUpdate: 'plan',
          entries: [{ content: 'Read the code', priority: 'high', status: 'in_progress' }],
        },
        { sessionUpdate: 'session_info_update', title: 'Fix the tests' },
        { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' },
        { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
        {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: 'reasoning_effort',
              name: 'Effort',
              type: 'select',
              currentValue: 'low',
              options: [{ value: 'low', name: 'Low' }],
            },
          ],
        },
      ]),
    ).toEqual([
      { type: 'tasks', tasks: [{ text: 'Read the code', status: 'in_progress' }] },
      { type: 'title', title: 'Fix the tests' },
      { type: 'mode', mode: 'yolo' },
      { type: 'settings', effort: 'low' },
    ]);
  });

  it('reports how many tokens of its context window the session takes', () => {
    expect(translate([{ sessionUpdate: 'usage_update', used: 52_000, size: 256_000 }])).toEqual([
      { type: 'context', used: 52_000, size: 256_000 },
    ]);
  });

  it('reads the model and effort from the configuration options', () => {
    expect(
      currentChoices([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'grok-4.7',
          options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
        },
        {
          id: 'reasoning_effort',
          name: 'Effort',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
      ]),
    ).toEqual({ model: 'grok-4.7', effort: 'high' });
    expect(currentChoices([])).toEqual({});
  });
});

describe('images', () => {
  it('shows the images a tool call returns', () => {
    const [event] = translate([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'i1',
        title: 'Screenshot',
        kind: 'other',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          },
        ],
      },
    ]);
    expect(event).toMatchObject({
      type: 'tool',
      id: 'i1',
      images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
  });
});
