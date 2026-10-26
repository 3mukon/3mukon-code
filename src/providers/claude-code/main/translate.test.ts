import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { Translator } from './translate';

const cwd = '/work/app';

function assistant(
  uuid: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 's1',
    parent_tool_use_id: null,
    message: { content },
    ...extra,
  } as unknown as SDKMessage;
}

function toolResult(
  id: string,
  content: string,
  structured?: unknown,
  isError = false,
): SDKMessage {
  return {
    type: 'user',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    tool_use_result: structured,
  } as unknown as SDKMessage;
}

function historyMessage(
  type: 'user' | 'assistant',
  uuid: string,
  content: unknown,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: 's1',
    message: { content },
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

describe('Translator.live', () => {
  it('reports the app mode from the init message, and leaves Claude Code’s other modes out', () => {
    const init = (permissionMode: string) =>
      ({ type: 'system', subtype: 'init', permissionMode }) as unknown as SDKMessage;
    const translator = new Translator(cwd);
    expect(translator.live(init('auto'))).toEqual([{ type: 'mode', mode: 'auto' }]);
    expect(translator.live(init('bypassPermissions'))).toEqual([{ type: 'mode', mode: 'yolo' }]);
    expect(translator.live(init('plan'))).toEqual([]);
  });

  it('streams text and thinking as deltas, and does not repeat them from the complete message', () => {
    const translator = new Translator(cwd);
    const stream = (event: unknown, parent: string | null = null) =>
      ({ type: 'stream_event', event, parent_tool_use_id: parent }) as unknown as SDKMessage;
    const deltas = [
      stream({ type: 'message_start', message: { id: 'msg_1' } }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Hm' },
      }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{' },
      }),
      stream(
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '!' } },
        'agent-1',
      ),
    ].flatMap((message) => translator.live(message));
    expect(deltas).toEqual([
      { type: 'message-delta', id: 'msg_1:0', role: 'thinking', text: 'Hm' },
      { type: 'message-delta', id: 'msg_1:1', role: 'agent', text: 'Hel' },
      { type: 'message-delta', id: 'msg_1:1', role: 'agent', text: 'lo' },
    ]);
    const complete = {
      type: 'assistant',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Hm' },
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/app/a.ts' } },
        ],
      },
    } as unknown as SDKMessage;
    expect(translator.live(complete)).toEqual([
      { type: 'tool', id: 't1', kind: 'read', status: 'running', title: 'a.ts', paths: ['a.ts'] },
    ]);
  });

  it('turns text, thinking and a command into a message, thinking and a running tool call', () => {
    const events = new Translator(cwd).live(
      assistant('u1', [
        { type: 'thinking', thinking: 'Checking the tests first.' },
        { type: 'text', text: 'Running the tests.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'pnpm test\n', description: 'Run tests' },
        },
      ]),
    );
    expect(events).toEqual([
      { type: 'message', id: 'u1:0', role: 'thinking', text: 'Checking the tests first.' },
      { type: 'message', id: 'u1:1', role: 'agent', text: 'Running the tests.' },
      {
        type: 'tool',
        id: 't1',
        kind: 'execute',
        status: 'running',
        title: 'Run tests',
        command: 'pnpm test\n',
      },
    ]);
  });

  it('completes a tool call with its output, or fails it', () => {
    const translator = new Translator(cwd);
    translator.live(
      assistant('u1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/app/a.ts' } },
      ]),
    );
    translator.live(
      assistant('u2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }]),
    );
    expect(translator.live(toolResult('t1', 'contents'))).toEqual([
      { type: 'tool', id: 't1', status: 'completed', output: 'contents' },
    ]);
    expect(translator.live(toolResult('t2', 'exit 1', undefined, true))).toEqual([
      { type: 'tool', id: 't2', status: 'failed', output: 'exit 1' },
    ]);
  });

  it('reports an edit as a file change, with the diff from its structured patch', () => {
    const translator = new Translator(cwd);
    translator.live(
      assistant('u1', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: { file_path: '/work/app/src/a.ts', old_string: 'old', new_string: 'new' },
        },
      ]),
    );
    const events = translator.live(
      toolResult('t1', 'The file was updated.', {
        filePath: '/work/app/src/a.ts',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
        ],
      }),
    );
    expect(events[1]).toEqual({
      type: 'file-change',
      change: {
        id: 't1',
        path: 'src/a.ts',
        kind: 'update',
        diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
    });
  });

  it('reports a newly written file as added, with all its lines', () => {
    const translator = new Translator(cwd);
    translator.live(
      assistant('u1', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'Write',
          input: { file_path: '/work/app/n.txt', content: 'hi\n' },
        },
      ]),
    );
    const [, change] = translator.live(
      toolResult('t1', 'File created.', {
        type: 'create',
        filePath: '/work/app/n.txt',
        structuredPatch: [],
      }),
    );
    expect(change).toMatchObject({ type: 'file-change', change: { path: 'n.txt', kind: 'add' } });
    expect(change?.type === 'file-change' ? change.change.diff : '').toContain('+hi');
  });

  it('keeps the task list from TodoWrite, and from TaskCreate and TaskUpdate', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live(
        assistant('u1', [
          {
            type: 'tool_use',
            id: 't1',
            name: 'TodoWrite',
            input: {
              todos: [{ content: 'Inspect', status: 'completed', activeForm: 'Inspecting' }],
            },
          },
        ]),
      ),
    ).toEqual([{ type: 'tasks', tasks: [{ text: 'Inspect', status: 'completed' }] }]);

    const tasks = new Translator(cwd);
    tasks.live(
      assistant('u2', [
        {
          type: 'tool_use',
          id: 't2',
          name: 'TaskCreate',
          input: { subject: 'Persist layout', description: '' },
        },
      ]),
    );
    expect(
      tasks.live(
        toolResult('t2', 'Task #4 created', { task: { id: '4', subject: 'Persist layout' } }),
      ),
    ).toEqual([]);
    expect(
      tasks.live(
        assistant('u3', [
          {
            type: 'tool_use',
            id: 't3',
            name: 'TaskUpdate',
            input: { taskId: '4', status: 'in_progress' },
          },
        ]),
      ),
    ).toEqual([{ type: 'tasks', tasks: [{ text: 'Persist layout', status: 'in_progress' }] }]);
    expect(
      tasks.live(
        assistant('u4', [
          {
            type: 'tool_use',
            id: 't4',
            name: 'TaskUpdate',
            input: { taskId: '4', status: 'deleted' },
          },
        ]),
      ),
    ).toEqual([{ type: 'tasks', tasks: [] }]);
  });

  it('leaves questions and plans to canUseTool, and subagents out', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live(
        assistant('u1', [
          { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [] } },
        ]),
      ),
    ).toEqual([]);
    expect(
      translator.live(
        assistant('u2', [{ type: 'text', text: 'From a subagent' }], {
          parent_tool_use_id: 'agent-1',
        }),
      ),
    ).toEqual([]);
  });

  it('ends the turn on the result, completed or failed', () => {
    const translator = new Translator(cwd);
    const success = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
    } as unknown as SDKMessage;
    const failure = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Connection lost'],
    } as unknown as SDKMessage;
    expect(translator.live(success)).toEqual([{ type: 'turn-ended', outcome: 'completed' }]);
    expect(translator.live(failure)).toEqual([
      { type: 'turn-ended', outcome: 'failed', error: 'Connection lost' },
    ]);
  });

  it('reports an error Claude Code gives instead of an answer once, with the turn that fails', () => {
    // What Claude Code sends when it is not signed in.
    const translator = new Translator(cwd);
    const signIn = 'Not logged in · Please run /login';
    expect(
      translator.live(
        assistant('u9', [{ type: 'text', text: signIn }], { error: 'authentication_failed' }),
      ),
    ).toEqual([]);
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: signIn,
    } as unknown as SDKMessage;
    expect(translator.live(result)).toEqual([
      { type: 'turn-ended', outcome: 'failed', error: signIn },
    ]);
  });

  it('keeps an error from a turn that still completes', () => {
    const translator = new Translator(cwd);
    translator.live(
      assistant('u9', [{ type: 'text', text: 'Rate limited, retrying' }], { error: 'rate_limit' }),
    );
    const success = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
    } as unknown as SDKMessage;
    expect(translator.live(success)).toEqual([
      { type: 'error', message: 'Rate limited, retrying' },
      { type: 'turn-ended', outcome: 'completed' },
    ]);
  });
});

describe('Translator.history', () => {
  it('replays the user, the agent, and edits with diffs rebuilt from their strings', () => {
    const translator = new Translator(cwd);
    const events = [
      historyMessage('user', 'h1', 'Rename the variable.'),
      historyMessage('assistant', 'h2', [
        { type: 'text', text: 'Renaming it.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: { file_path: '/work/app/a.ts', old_string: 'x', new_string: 'y' },
        },
        {
          type: 'tool_use',
          id: 't2',
          name: 'Write',
          input: { file_path: '/work/app/b.ts', content: 'z' },
        },
      ]),
      historyMessage('user', 'h3', [
        { type: 'tool_result', tool_use_id: 't1', content: 'Updated.' },
      ]),
      historyMessage('user', 'h4', [
        { type: 'tool_result', tool_use_id: 't2', content: 'Written.' },
      ]),
    ].flatMap((message) => translator.history(message));

    expect(events.map((event) => event.type)).toEqual([
      'message',
      'message',
      'tool',
      'tool',
      'tool',
      'file-change',
      'tool',
    ]);
    expect(events[0]).toEqual({
      type: 'message',
      id: 'h1',
      role: 'user',
      text: 'Rename the variable.',
    });
    const change = events[5];
    expect(change?.type === 'file-change' ? change.change.diff : '').toContain('+y');
  });
});
