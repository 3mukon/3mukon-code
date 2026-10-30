import { describe, expect, it } from 'vitest';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import { Translator } from './translate';

const cwd = '/work/app';
const turn = { threadId: 't1', turnId: 'u1' };

function command(status: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'commandExecution',
    id: 'c1',
    command: "/bin/zsh -lc 'cat src/a.ts'",
    cwd,
    status,
    commandActions: [
      { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: '/work/app/src/a.ts' },
    ],
    aggregatedOutput: null,
    exitCode: null,
    ...extra,
  };
}

describe('Translator.live', () => {
  it('streams agent text as deltas and sets the whole message when it completes', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live('item/started', {
        ...turn,
        item: { type: 'agentMessage', id: 'm1', text: '' },
      }),
    ).toEqual([]);
    expect(
      translator.live('item/agentMessage/delta', { ...turn, itemId: 'm1', delta: 'Hel' }),
    ).toEqual([{ type: 'message-delta', id: 'm1', role: 'agent', text: 'Hel' }]);
    expect(
      translator.live('item/completed', {
        ...turn,
        item: { type: 'agentMessage', id: 'm1', text: 'Hello' },
      }),
    ).toEqual([{ type: 'message', id: 'm1', role: 'agent', text: 'Hello' }]);
  });

  it('shows reasoning summaries as thinking', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live('item/reasoning/summaryTextDelta', {
        ...turn,
        itemId: 'r1',
        delta: 'Look',
        summaryIndex: 0,
      }),
    ).toEqual([{ type: 'message-delta', id: 'r1', role: 'thinking', text: 'Look' }]);
    // A new part of the summary starts a paragraph of its own.
    expect(
      translator.live('item/reasoning/summaryTextDelta', {
        ...turn,
        itemId: 'r1',
        delta: 'Then',
        summaryIndex: 1,
      }),
    ).toEqual([{ type: 'message-delta', id: 'r1', role: 'thinking', text: '\n\nThen' }]);
    expect(
      translator.live('item/completed', {
        ...turn,
        item: { type: 'reasoning', id: 'r1', summary: ['Look first', 'Then act'], content: [] },
      }),
    ).toEqual([{ type: 'message', id: 'r1', role: 'thinking', text: 'Look first\n\nThen act' }]);
    expect(
      translator.live('item/completed', {
        ...turn,
        item: { type: 'reasoning', id: 'r2', summary: [], content: [] },
      }),
    ).toEqual([]);
  });

  it('shows a command by what Codex made of it, with its streamed and final output', () => {
    const translator = new Translator(cwd);
    expect(translator.live('item/started', { ...turn, item: command('inProgress') })).toEqual([
      {
        type: 'tool',
        id: 'c1',
        kind: 'read',
        title: 'cat src/a.ts',
        command: 'cat src/a.ts',
        status: 'running',
        paths: ['src/a.ts'],
      },
    ]);
    expect(
      translator.live('item/commandExecution/outputDelta', {
        ...turn,
        itemId: 'c1',
        delta: 'line\n',
      }),
    ).toEqual([{ type: 'tool-output', id: 'c1', text: 'line\n' }]);
    expect(
      translator.live('item/completed', {
        ...turn,
        item: command('declined', { aggregatedOutput: 'denied' }),
      }),
    ).toEqual([
      {
        type: 'tool',
        id: 'c1',
        kind: 'read',
        title: 'cat src/a.ts',
        command: 'cat src/a.ts',
        status: 'failed',
        paths: ['src/a.ts'],
        output: 'denied',
      },
    ]);
  });

  it('keeps a command’s streamed output to the limit', () => {
    const translator = new Translator(cwd);
    const long = 'x'.repeat(15_000);
    expect(
      translator.live('item/commandExecution/outputDelta', { ...turn, itemId: 'c1', delta: long }),
    ).toHaveLength(1);
    const [rest] = translator.live('item/commandExecution/outputDelta', {
      ...turn,
      itemId: 'c1',
      delta: long,
    });
    expect(rest).toEqual({ type: 'tool-output', id: 'c1', text: 'x'.repeat(5_000) });
    expect(
      translator.live('item/commandExecution/outputDelta', {
        ...turn,
        itemId: 'c1',
        delta: 'more',
      }),
    ).toEqual([]);
  });

  it('reports a completed file change as an edit and its files’ diffs, and remembers it for approvals', () => {
    const translator = new Translator(cwd);
    const item = {
      type: 'fileChange',
      id: 'f1',
      changes: [{ path: '/work/app/notes.txt', kind: { type: 'add' }, diff: 'hi\n' }],
      status: 'inProgress',
    };
    expect(translator.live('item/started', { ...turn, item })).toEqual([
      {
        type: 'tool',
        id: 'f1',
        kind: 'edit',
        title: 'notes.txt',
        status: 'running',
        paths: ['notes.txt'],
      },
    ]);
    expect(translator.fileChangeOf('f1')).toEqual({
      paths: ['notes.txt'],
      diff: '--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,1 @@\n+hi\n',
    });
    expect(
      translator.live('item/completed', { ...turn, item: { ...item, status: 'completed' } }),
    ).toEqual([
      {
        type: 'tool',
        id: 'f1',
        kind: 'edit',
        title: 'notes.txt',
        status: 'completed',
        paths: ['notes.txt'],
      },
      {
        type: 'file-change',
        change: {
          id: 'f1:0',
          path: 'notes.txt',
          kind: 'add',
          diff: '--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,1 @@\n+hi\n',
        },
        toolId: 'f1',
      },
    ]);
    expect(translator.fileChangeOf('nope')).toBeUndefined();
  });

  it('turns the plan into the task list', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live('turn/plan/updated', {
        ...turn,
        explanation: null,
        plan: [
          { step: 'Read', status: 'completed' },
          { step: 'Write', status: 'inProgress' },
          { step: 'Test', status: 'pending' },
        ],
      }),
    ).toEqual([
      {
        type: 'tasks',
        tasks: [
          { text: 'Read', status: 'completed' },
          { text: 'Write', status: 'in_progress' },
          { text: 'Test', status: 'pending' },
        ],
      },
    ]);
  });

  it('ends turns as Codex reports them, with an error reported during the turn', () => {
    const translator = new Translator(cwd);
    const ended = (status: string, error: unknown = null) =>
      translator.live('turn/completed', {
        threadId: 't1',
        turn: { id: 'u1', items: [], status, error },
      });
    expect(ended('completed')).toEqual([{ type: 'turn-ended', outcome: 'completed' }]);
    expect(ended('interrupted')).toEqual([{ type: 'turn-ended', outcome: 'interrupted' }]);
    expect(
      translator.live('error', { ...turn, willRetry: true, error: { message: 'Retrying' } }),
    ).toEqual([]);
    translator.live('error', {
      ...turn,
      willRetry: false,
      error: { message: 'Usage limit reached' },
    });
    expect(ended('failed')).toEqual([
      { type: 'turn-ended', outcome: 'failed', error: 'Usage limit reached' },
    ]);
    expect(ended('failed', { message: 'Bad request' })).toEqual([
      { type: 'turn-ended', outcome: 'failed', error: 'Bad request' },
    ]);
  });

  it('reports how much of the context window the thread takes, as of its last request', () => {
    const breakdown = (totalTokens: number) => ({
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(
      new Translator(cwd).live('thread/tokenUsage/updated', {
        ...turn,
        tokenUsage: {
          total: breakdown(90_000),
          last: breakdown(30_000),
          modelContextWindow: 272_000,
        },
      }),
    ).toEqual([{ type: 'context', used: 30_000, size: 272_000 }]);
  });

  it('reports the title, a rerouted model and the automatic review’s denials', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live('thread/name/updated', { threadId: 't1', threadName: 'Fix the build' }),
    ).toEqual([{ type: 'title', title: 'Fix the build' }]);
    expect(
      translator.live('model/rerouted', {
        ...turn,
        fromModel: 'a',
        toModel: 'b',
        reason: 'highRiskCyberActivity',
      }),
    ).toEqual([{ type: 'settings', model: 'b' }]);
    const review = (status: string) => ({
      ...turn,
      reviewId: 'v1',
      targetItemId: 'c1',
      review: { status, riskLevel: 'high', userAuthorization: null, rationale: 'It deletes files' },
    });
    expect(translator.live('item/autoApprovalReview/completed', review('denied'))).toEqual([
      {
        type: 'tool',
        id: 'c1',
        status: 'failed',
        output: "Codex's automatic review denied this: It deletes files",
      },
    ]);
    expect(translator.live('item/autoApprovalReview/completed', review('approved'))).toEqual([]);
  });
});

describe('Translator.history', () => {
  it('replays the user’s messages and the rest as completed items', () => {
    const translator = new Translator(cwd);
    const user = {
      type: 'userMessage',
      id: 'u1',
      clientId: null,
      content: [{ type: 'text', text: 'Hello', text_elements: [] }],
    } as unknown as ThreadItem;
    expect(translator.history(user)).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Hello' },
    ]);
    const agent = { type: 'agentMessage', id: 'm1', text: 'Hi' } as unknown as ThreadItem;
    expect(translator.history(agent)).toEqual([
      { type: 'message', id: 'm1', role: 'agent', text: 'Hi' },
    ]);
  });
});

describe('images', () => {
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

  it('shows a generated image as the agent’s, and the images an MCP tool returns with its call', () => {
    const translator = new Translator(cwd);
    expect(
      translator.live('item/completed', {
        ...turn,
        item: {
          type: 'imageGeneration',
          id: 'g1',
          status: 'completed',
          revisedPrompt: null,
          failure: null,
          result: png.data,
        },
      }),
    ).toEqual([{ type: 'message', id: 'g1', role: 'agent', text: '', images: [png] }]);
    expect(
      translator.live('item/completed', {
        ...turn,
        item: {
          type: 'mcpToolCall',
          id: 'm1',
          server: 'shots',
          tool: 'grab',
          status: 'completed',
          arguments: {},
          result: {
            content: [{ type: 'image', data: png.data, mimeType: 'image/png' }],
            structuredContent: null,
            _meta: null,
          },
          error: null,
        },
      }),
    ).toMatchObject([{ type: 'tool', id: 'm1', images: [png] }]);
  });

  it('replays the user’s images, which the app sent as data URLs', () => {
    const translator = new Translator(cwd);
    const user = {
      type: 'userMessage',
      id: 'u1',
      content: [
        { type: 'text', text: 'Look', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    } as unknown as ThreadItem;
    expect(translator.history(user)).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Look', images: [png] },
    ]);
  });
});
