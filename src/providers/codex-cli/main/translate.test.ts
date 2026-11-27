import { describe, expect, it } from 'vitest';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import { Translator } from './translate';

const cwd = '/work/app';
const turn = { threadId: 't1', turnId: 'u1' };

it('keeps original user text when native history also carries marked host context', () => {
  const translator = new Translator(cwd);
  expect(
    translator.history({
      type: 'userMessage',
      id: 'user',
      content: [
        {
          type: 'text',
          text: 'Host state',
          text_elements: [
            { byteRange: { start: 0, end: 10 }, placeholder: '3mukon-code:presentation-state' },
          ],
        },
        { type: 'text', text: 'User text', text_elements: [] },
      ],
    } as ThreadItem),
  ).toEqual([{ type: 'message', id: 'user', role: 'user', text: 'User text' }]);
});

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
    // A request that Codex retries is not the turn's error.
    translator.live('error', {
      ...turn,
      willRetry: true,
      error: { message: 'Reconnecting... 1/5', additionalDetails: 'stream disconnected' },
    });
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

  it('reports each retry of a request to the model, with the count Codex gives and its details as the reason', () => {
    const translator = new Translator(cwd);
    const retry = (message: string, additionalDetails: string | null) =>
      translator.live('error', {
        ...turn,
        willRetry: true,
        error: {
          message,
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 500 } },
          additionalDetails,
          misalignment: null,
        },
      });
    const details = 'unexpected status 500 Internal Server Error: Service temporarily unavailable';
    expect(retry('Reconnecting... 2/5', details)).toEqual([
      { type: 'retrying', attempt: 2, maxRetries: 5, reason: details },
    ]);
    expect(retry('Reconnecting... 3/5', null)).toEqual([
      { type: 'retrying', attempt: 3, maxRetries: 5 },
    ]);
    // Without a count, as while Codex waits for the network, the notice says why where it has no
    // details.
    expect(retry('Reconnecting... waiting for network', null)).toEqual([
      { type: 'retrying', reason: 'Reconnecting... waiting for network' },
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
        output: "Codex CLI's automatic review denied this: It deletes files",
      },
    ]);
    expect(translator.live('item/autoApprovalReview/completed', review('approved'))).toEqual([]);
  });
});

describe('MCP and dynamic tool calls', () => {
  it('names an MCP tool’s call by its server and tool, the app’s own with what it acts on', () => {
    const item = {
      type: 'mcpToolCall',
      id: 'm1',
      server: '3mukon-code',
      tool: 'panel_present',
      status: 'inProgress',
      arguments: { title: 'Benchmarks', reuseKey: 'b', version: 0, items: [] },
      result: null,
      error: null,
    } as unknown as ThreadItem;
    expect(new Translator(cwd).live('item/started', { ...turn, item })).toMatchObject([
      {
        type: 'tool',
        id: 'm1',
        title: '3mukon-code: panel_present',
        mcp: { server: '3mukon-code', tool: 'panel_present', app: true, subject: 'Benchmarks' },
      },
    ]);
  });

  it('titles a dynamic tool’s call by its name in words', () => {
    const item = {
      type: 'dynamicToolCall',
      id: 'd1',
      namespace: null,
      tool: 'view_image',
      arguments: {},
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    } as unknown as ThreadItem;
    expect(new Translator(cwd).live('item/started', { ...turn, item })).toMatchObject([
      { type: 'tool', id: 'd1', title: 'view image' },
    ]);
  });

  it('shows clock.sleep’s waits, Codex’s own agent calls and an item of a kind it does not know, rather than none', () => {
    const live = (item: unknown) =>
      new Translator(cwd).live('item/completed', { ...turn, item: item as ThreadItem });
    expect(live({ type: 'sleep', id: 's1', durationMs: 30_000 })).toMatchObject([
      { type: 'tool', id: 's1', title: 'clock.sleep 30 s', status: 'completed' },
    ]);
    expect(
      live({
        type: 'collabAgentToolCall',
        id: 'c1',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 't1',
        receiverThreadIds: ['t2'],
        prompt: 'Review the diff',
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      }),
    ).toMatchObject([{ type: 'tool', id: 'c1', status: 'completed', output: 'Review the diff' }]);
    expect(live({ type: 'futureItem', id: 'f1' })).toMatchObject([
      { type: 'tool', id: 'f1', kind: 'other' },
    ]);
    expect(live({ type: 'contextCompaction', id: 'k1' })).toEqual([]);
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

  it('gives back the notices of new messages the app gave beside a message or alone, apart from its text', () => {
    const translator = new Translator(cwd);
    const notice = { id: 'n1', from: 'child', fromTitle: 'Tests', summary: 'Done', sentAt: 1 };
    const block = JSON.stringify({ source: '3mukon-code:inbox', messages: [notice] });
    const inbox = {
      type: 'text',
      text: block,
      text_elements: [
        { byteRange: { start: 0, end: block.length }, placeholder: '3mukon-code:inbox' },
      ],
    };
    const beside = {
      type: 'userMessage',
      id: 'u1',
      content: [inbox, { type: 'text', text: 'Go on', text_elements: [] }],
    } as unknown as ThreadItem;
    expect(translator.history(beside)).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Go on' },
      { type: 'inbox', notices: [notice] },
    ]);
    const alone = { type: 'userMessage', id: 'u2', content: [inbox] } as unknown as ThreadItem;
    expect(translator.history(alone)).toEqual([{ type: 'inbox', notices: [notice] }]);
  });
});

describe('web searches', () => {
  const search = (action: unknown, query: string, results: unknown[] | null = null) =>
    ({ type: 'webSearch', id: 'w1', query, action, results }) as unknown as ThreadItem;
  const completed = (item: ThreadItem) =>
    new Translator(cwd).live('item/completed', { ...turn, item });

  it('shows a search by its first query, with all of them as its output when it ran several', () => {
    expect(new Translator(cwd).live('item/started', { ...turn, item: search(null, '') })).toEqual([
      { type: 'tool', id: 'w1', status: 'running', kind: 'search', title: '' },
    ]);
    expect(
      completed(
        search(
          {
            type: 'search',
            query: null,
            queries: ['AI news today', 'AI news this week', 'AI funding'],
          },
          'AI news today ...',
        ),
      ),
    ).toEqual([
      {
        type: 'tool',
        id: 'w1',
        status: 'completed',
        kind: 'search',
        title: 'AI news today',
        output: 'AI news today\nAI news this week\nAI funding',
      },
    ]);
    expect(
      completed(search({ type: 'search', query: 'one query', queries: null }, 'one query')),
    ).toEqual([
      { type: 'tool', id: 'w1', status: 'completed', kind: 'search', title: 'one query' },
    ]);
  });

  it('shows a page it opened by its address, and text it found in one with the page', () => {
    expect(completed(search({ type: 'openPage', url: 'https://example.com/a' }, ''))).toMatchObject(
      [{ kind: 'fetch', title: 'https://example.com/a' }],
    );
    expect(
      completed(
        search({ type: 'findInPage', url: 'https://example.com/a', pattern: 'pricing' }, ''),
      ),
    ).toMatchObject([{ kind: 'search', title: 'pricing · https://example.com/a' }]);
  });

  it('shows pages it opened without a query by their domains, with their titles as its output', () => {
    const results = [
      {
        type: 'text_result',
        domain: 'www.crowdstrike.com',
        title: 'Espionage report',
        url: 'https://www.crowdstrike.com/r',
      },
      {
        type: 'text_result',
        domain: 'mistral.ai',
        title: 'Latest news',
        url: 'https://mistral.ai/news',
      },
      { type: 'text_result', domain: null, title: 'Internal Error', url: null },
      { type: 'text_result', domain: null, title: 'More news', url: 'https://mistral.ai/more' },
      'unexpected',
    ];
    expect(completed(search({ type: 'other' }, '', results))).toEqual([
      {
        type: 'tool',
        id: 'w1',
        status: 'completed',
        kind: 'fetch',
        title: 'crowdstrike.com, mistral.ai',
        output:
          'Espionage report · crowdstrike.com\nLatest news · mistral.ai\nInternal Error\nMore news · mistral.ai',
      },
    ]);
    expect(completed(search({ type: 'other' }, ''))).toMatchObject([{ kind: 'search', title: '' }]);
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
