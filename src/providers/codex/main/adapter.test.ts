import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountNews } from '../../../accounts/main/source';
import type { Toolset, ToolsetAccess } from '../../../sessions/main/provider';
import type { SandboxLevel, SessionEvent } from '../../../sessions/shared/events';
import { createCodexProvider } from './adapter';
import { CodexError, type Launch, type Rpc, type RpcHandlers } from './rpc';

type Params = Record<string, unknown>;

// The workspace sandbox as the fake app-server's own settings shape it, unlike Codex's default.
const WORKSPACE = {
  type: 'workspaceWrite',
  writableRoots: ['/extra'],
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};
const READ_ONLY = { type: 'readOnly', networkAccess: false };

const MODELS = [
  {
    model: 'gpt-default',
    inputModalities: ['text', 'image'],
    displayName: 'Default',
    description: 'The usual one',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
  },
  {
    model: 'gpt-small',
    inputModalities: ['text'],
    displayName: 'Small',
    description: '',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  },
  { model: 'gpt-hidden', hidden: true, supportedReasoningEfforts: [] },
];

// What the fake app-server answers; a test can change it.
let failStart: string | undefined;
// What a thread/resume through the gateway's provider fails with.
let failResume: Error | undefined;
// A sandbox the fake's own settings hold every thread to, whatever was asked for.
let heldSandbox: Params | undefined;
// Runs while the fake handles a thread/resume, before it answers.
let duringResume: (() => void) | undefined;
// A turn/steer refused, as Codex refuses one into a turn that cannot take it.
let failSteer: string | undefined;
// The name thread/read gives a thread, the title Codex keeps for it.
let threadName: string | null;

function sandboxOf(mode: unknown): Params {
  if (heldSandbox !== undefined) return heldSandbox;
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  return mode === 'read-only' ? READ_ONLY : WORKSPACE;
}

function reply(method: string, params: Params): unknown {
  const config = (params.config ?? {}) as Params;
  const thread = (id: string) => ({
    thread: { id },
    model: params.model ?? config.model ?? 'gpt-default',
    modelProvider: params.modelProvider ?? 'openai',
    sandbox: sandboxOf(params.sandbox),
    reasoningEffort: 'medium',
  });
  switch (method) {
    case 'initialize':
      return {
        userAgent: 'fake',
        codexHome: '/home/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      };
    case 'thread/start':
      if (failStart !== undefined) throw new Error(failStart);
      return thread('th1');
    case 'thread/resume':
      duringResume?.();
      if (failResume !== undefined && params.modelProvider === 'proxy') throw failResume;
      return thread(params.threadId as string);
    case 'thread/turns/list':
      return params.cursor === undefined
        ? {
            data: [
              {
                id: 'old1',
                items: [
                  {
                    type: 'userMessage',
                    id: 'u1',
                    content: [{ type: 'text', text: 'Earlier', text_elements: [] }],
                  },
                ],
              },
            ],
            nextCursor: 'page2',
          }
        : {
            data: [{ id: 'old2', items: [{ type: 'agentMessage', id: 'a1', text: 'Reply' }] }],
            nextCursor: null,
          };
    case 'thread/read':
      return { thread: { id: params.threadId, name: threadName } };
    case 'model/list':
      return { data: MODELS, nextCursor: null };
    case 'turn/start':
      return {
        turn: {
          id: `turn-${String(fakes.flatMap((fake) => fake.calls).filter((call) => call.method === 'turn/start').length)}`,
        },
      };
    case 'turn/steer':
      if (failSteer !== undefined) throw new Error(failSteer);
      return { turnId: params.expectedTurnId };
    case 'thread/list':
      return {
        data: [
          {
            id: 'a',
            name: null,
            preview: 'First message',
            cwd: '/work',
            updatedAt: 100,
            parentThreadId: null,
          },
          {
            id: 'b',
            name: 'Named',
            preview: 'x',
            cwd: '/work',
            updatedAt: 50,
            parentThreadId: null,
          },
          {
            id: 'c',
            name: null,
            preview: 'subagent',
            cwd: '/work',
            updatedAt: 70,
            parentThreadId: 'a',
          },
        ],
        nextCursor: null,
      };
    case 'account/read':
      return {
        account: { type: 'chatgpt', email: null, planType: 'plus' },
        requiresOpenaiAuth: true,
      };
    case 'account/rateLimits/read':
      return {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 20 },
          secondary: null,
        },
        rateLimitResetCredits: { availableCount: 1, credits: null },
      };
    case 'account/rateLimitResetCredit/consume':
      return { outcome: 'reset' };
    default:
      return {};
  }
}

// Stands in for one app-server process. The test plays the server through emit, ask and stop.
class FakeCodex implements Rpc {
  readonly calls: { method: string; params: Params }[] = [];
  closed = false;

  constructor(
    readonly cwd: string,
    private readonly handlers: RpcHandlers,
    readonly launch: Launch | undefined,
  ) {}

  request<Result>(method: string, params: unknown): Promise<Result> {
    this.calls.push({ method, params: params as Params });
    try {
      return Promise.resolve(reply(method, params as Params) as Result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  notify(method: string): void {
    this.calls.push({ method, params: {} });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.handlers.exit(undefined);
    }
    return Promise.resolve();
  }

  emit(method: string, params: unknown): void {
    this.handlers.notification(method, params);
  }

  ask(method: string, params: unknown, id: string | number): Promise<unknown> {
    return this.handlers.request(method, params, id);
  }

  stop(error: string): void {
    this.handlers.exit(error);
  }

  params(method: string, index = -1): Params | undefined {
    return this.calls.filter((call) => call.method === method).at(index)?.params;
  }
}

// Stands in for the app's toolset: it keeps each session's access.
class FakeToolset implements Toolset {
  readonly result = vi.fn();
  readonly availability = vi.fn();
  readonly name = '3mukon-code';
  readonly opened: { access: ToolsetAccess; closed: boolean }[] = [];

  open(): ToolsetAccess {
    const entry = {
      closed: false,
      access: {
        url: 'http://127.0.0.1:4000/mcp',
        credential: `credential-${String(this.opened.length + 1)}`,
        tools: ['panel_list'],
        result: this.result,
        availability: this.availability,
        close: () => {
          entry.closed = true;
        },
      },
    };
    this.opened.push(entry);
    return entry.access;
  }
}

it('merges queued presentation state once, acknowledging only the latest notices that fit the final block', async () => {
  const { session } = await startSession();
  await session.send('Start');
  failSteer = 'Turn cannot be steered';
  const notices = Array.from({ length: 50 }, (_, n) => ({
    noticeId: `n${String(n)}`,
    owner: 'owner',
    reuseKey: `r${String(n)}`,
    presentation: {
      id: `p${String(n)}`,
      version: 1,
      title: 'Synthetic',
      items: [{ content: { kind: 'file' as const, path: `/${'界'.repeat(1000)}` }, box: null }],
    },
  }));
  const first = { accepted: vi.fn(), failed: vi.fn() };
  const second = { accepted: vi.fn(), failed: vi.fn() };
  await session.send('First', [], { presentationNotices: notices }, first);
  const newer = notices.map((notice) => ({
    ...notice,
    presentation: { ...notice.presentation, version: 2 },
  }));
  await session.send('Second', [], { presentationNotices: newer }, second);
  expect(first.accepted).not.toHaveBeenCalled();
  current().emit('turn/completed', completed('turn-1'));
  await waitFor(() => second.accepted.mock.calls.length === 1);
  const input = current().params('turn/start')?.input as { text: string }[];
  const context = input[0]?.text ?? '';
  const selected = second.accepted.mock.calls[0]?.[0] as typeof newer;
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(64 * 1024);
  expect(selected.length).toBeLessThan(newer.length);
  expect(selected.every((notice) => notice.presentation.version === 2)).toBe(true);
  expect(new Set(selected.map((notice) => notice.presentation.id)).size).toBe(selected.length);
  expect(JSON.parse(context)).toMatchObject({ presentations: selected });
  expect(first.accepted).toHaveBeenCalledExactlyOnceWith(selected);
  expect(input[1]?.text).toBe('First\n\nSecond');
  await session.close();
});

it('correlates only this toolset’s live native result and acknowledges a separately marked context block', async () => {
  const { session, events } = await startSession();
  const notice = {
    noticeId: 'n',
    owner: 'owner',
    reuseKey: 'r',
    presentation: {
      id: 'p',
      title: 'Fixture',
      version: 1,
      items: [{ content: { kind: 'file' as const, path: '/work/a.md' }, box: null }],
    },
  };
  const delivery = { accepted: vi.fn(), failed: vi.fn() };
  await session.send('Original text', [], { presentationNotices: [notice] }, delivery);
  expect(current().params('turn/start')?.input).toEqual([
    expect.objectContaining({
      type: 'text',
      text_elements: [expect.objectContaining({ placeholder: '3mukon-code:presentation-state' })],
    }),
    { type: 'text', text: 'Original text', text_elements: [] },
  ]);
  expect(events).toContainEqual(expect.objectContaining({ role: 'user', text: 'Original text' }));
  expect(delivery.accepted).toHaveBeenCalledOnce();
  const envelope = {
    automation: { schemaVersion: 1, callId: 'receipt' },
    outcome: { status: 'verified', value: null },
    presentationNotices: [],
  };
  const item = {
    type: 'mcpToolCall',
    id: 'entry',
    server: 'other',
    tool: 'panel_list',
    status: 'completed',
    result: { structuredContent: envelope, content: [] },
    error: null,
  };
  current().emit('item/completed', { threadId: 'th1', item });
  expect(toolset.result).not.toHaveBeenCalled();
  current().emit('item/completed', { threadId: 'th1', item: { ...item, server: '3mukon-code' } });
  expect(toolset.result).toHaveBeenCalledExactlyOnceWith(
    'panel_list',
    'entry',
    envelope.automation,
  );
  await session.close();
});

it('delivers pending presentation state with an async-question reply as separate context', async () => {
  const { session } = await startSession();
  current().emit(
    'item/completed',
    asyncQuestions('reply', [{ title: 'Continue?', options: ['Yes'] }]),
  );
  const notice = {
    noticeId: 'n',
    owner: 'owner',
    reuseKey: 'r',
    presentation: {
      id: 'p',
      title: 'Fixture',
      version: 1,
      items: [{ content: { kind: 'file' as const, path: '/work/a.md' }, box: null }],
    },
  };
  const delivery = { accepted: vi.fn(), failed: vi.fn() };
  await session.answerQuestion(
    'async-reply',
    { decision: 'answer', answers: { '0': { selected: ['Yes'], text: '' } } },
    { presentationNotices: [notice] },
    delivery,
  );
  await waitFor(() => delivery.accepted.mock.calls.length === 1);
  expect(current().params('turn/start')?.input).toEqual([
    expect.objectContaining({
      text_elements: [expect.objectContaining({ placeholder: '3mukon-code:presentation-state' })],
    }),
    { type: 'text', text: 'Yes', text_elements: [] },
  ]);
  await session.close();
});

it('reports modalities for the actual thread model rather than a different gateway catalog default', async () => {
  const gateway = await startSession({ gateway: 'work' });
  expect(toolset.availability).toHaveBeenLastCalledWith({ tools: 'ready', images: 'unknown' });
  await gateway.session.close();
  const normal = await startSession();
  expect(toolset.availability).toHaveBeenLastCalledWith({ tools: 'ready', images: 'supported' });
  await normal.session.setModel('gpt-small');
  await normal.session.send('Synthetic prompt');
  expect(toolset.availability).toHaveBeenLastCalledWith({ tools: 'ready', images: 'unsupported' });
  await normal.session.close();
});

let fakes: FakeCodex[] = [];
let toolset: FakeToolset;
let gatewaysDir: string;
beforeEach(() => {
  fakes = [];
  toolset = new FakeToolset();
  failStart = undefined;
  failResume = undefined;
  heldSandbox = undefined;
  duringResume = undefined;
  failSteer = undefined;
  threadName = null;
  gatewaysDir = mkdtempSync(join(tmpdir(), 'codex-gateways-'));
  writeFileSync(
    join(gatewaysDir, 'work.toml'),
    [
      'model_provider = "proxy"',
      'model = "gpt-proxy"',
      '[model_providers.proxy]',
      'base_url = "https://proxy.example.com/v1"',
      'experimental_bearer_token = "secret-token-value"',
    ].join('\n'),
  );
});
afterEach(() => {
  rmSync(gatewaysDir, { recursive: true, force: true });
});

function provider() {
  return createCodexProvider({
    toolset,
    gatewaysDir,
    startRpc: (cwd, handlers, launch) => {
      const fake = new FakeCodex(cwd, handlers, launch);
      fakes.push(fake);
      return fake;
    },
  });
}

function current(): FakeCodex {
  const fake = fakes.at(-1);
  if (fake === undefined) throw new Error('No app-server was started.');
  return fake;
}

async function startSession(
  options: {
    gateway?: string;
    model?: string;
    effort?: string;
    mode?: 'auto' | 'yolo';
    sandbox?: SandboxLevel;
  } = {},
) {
  const events: SessionEvent[] = [];
  const session = await provider().start({ cwd: '/work', ...options }, (event) => {
    events.push(event);
  });
  return { session, events };
}

const completed = (turnId: string) => ({
  threadId: 'th1',
  turn: { id: turnId, items: [], status: 'completed', error: null },
});

const approvalParams = {
  threadId: 'th1',
  turnId: 'turn-1',
  itemId: 'c1',
  startedAtMs: 1,
  kind: 'command',
  environmentId: null,
  command: 'rm -rf build',
  cwd: '/work',
};

// An agent message that carries async questions, as Codex completes it for a call of
// request_user_input_async.
const asyncQuestions = (id: string, questions: { title: string; options: string[] | null }[]) => ({
  threadId: 'th1',
  turnId: 'turn-1',
  item: {
    type: 'agentMessage',
    id,
    text: questions.map((question) => question.title).join('\n'),
    phase: 'final_answer',
    memoryCitation: null,
    delivery: 'async',
    questions,
  },
});

// The text of the turn's message, by the turn's place among those started.
const turnText = (index: number) =>
  (current().params('turn/start', index)?.input as { text?: string }[] | undefined)?.[0]?.text;

const turnsStarted = () => current().calls.filter((call) => call.method === 'turn/start').length;

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('the Codex provider', () => {
  it('starts a thread in auto with the gateway’s settings, and reports the mode, settings and models', async () => {
    const { session, events } = await startSession({ gateway: 'work', effort: 'high' });
    expect(
      current()
        .calls.slice(0, 2)
        .map((call) => call.method),
    ).toEqual(['initialize', 'initialized']);
    expect(current().params('thread/start')).toEqual({
      cwd: '/work',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
      modelProvider: 'proxy',
      config: {
        model_provider: 'proxy',
        model: 'gpt-proxy',
        model_providers: {
          proxy: {
            base_url: 'https://proxy.example.com/v1',
            experimental_bearer_token: 'secret-token-value',
          },
        },
      },
    });
    // Codex takes the thread's messages through the provider its command line names, which the
    // app-server's command line gives by its id alone; the file's settings go only with the thread.
    expect(current().launch?.args.slice(-4)).toEqual([
      '-c',
      'model_provider="proxy"',
      '-c',
      'model_providers.proxy.name="proxy"',
    ]);
    expect(JSON.stringify(current().launch)).not.toMatch(/secret-token-value|proxy\.example\.com/);
    expect(session.id).toBe('th1');
    expect(events).toEqual([
      { type: 'mode', mode: 'auto' },
      {
        type: 'settings',
        gateway: 'work',
        model: 'gpt-proxy',
        effort: 'high',
        sandbox: 'workspace-write',
      },
      {
        type: 'models',
        models: [
          { id: 'gpt-proxy', label: 'gpt-proxy', efforts: [] },
          // The model Codex uses when the thread chooses none, and each model's own effort.
          {
            id: 'gpt-default',
            label: 'Default',
            description: 'The usual one',
            efforts: ['low', 'medium'],
            default: true,
            defaultEffort: 'medium',
          },
          { id: 'gpt-small', label: 'Small', efforts: ['low'], defaultEffort: 'low' },
        ],
      },
    ]);
  });

  it('starts a thread on the sandbox level chosen, whatever the mode', async () => {
    await startSession({ mode: 'yolo' });
    expect(current().params('thread/start')).toMatchObject({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    });
    await startSession({ sandbox: 'full-access' });
    expect(current().params('thread/start')).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    });
    await startSession({ mode: 'yolo', sandbox: 'read-only' });
    expect(current().params('thread/start')).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
  });

  it('reports the sandbox that Codex’s own settings hold the thread to', async () => {
    heldSandbox = READ_ONLY;
    const { events } = await startSession({ sandbox: 'full-access' });
    expect(events).toContainEqual(expect.objectContaining({ sandbox: 'read-only' }));
  });

  it('keeps a level switched to while a gateway switch resumes the thread', async () => {
    const { session, events } = await startSession();
    duringResume = () => void session.setSandbox('full-access');
    await session.setGateway('work');
    expect(current().params('thread/resume')).toMatchObject({ sandbox: 'workspace-write' });
    expect(events.at(-2)).toMatchObject({ type: 'settings', sandbox: 'full-access' });
    await session.send('hi');
    expect(current().params('turn/start')).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('tells Codex’s errors without the gateway file’s text', async () => {
    failStart = 'bad provider secret-token-value';
    await expect(startSession({ gateway: 'work' })).rejects.toThrow('bad provider [hidden]');
    expect(current().closed).toBe(true);
    expect(toolset.opened[0]?.closed).toBe(true);
  });

  it('starts no app-server for a gateway whose provider Codex cannot take from its command line', async () => {
    writeFileSync(
      join(gatewaysDir, 'dotted.toml'),
      ['model_provider = "my.proxy"', '[model_providers."my.proxy"]', 'base_url = "x"'].join('\n'),
    );
    await expect(startSession({ gateway: 'dotted' })).rejects.toThrow(
      'The gateway "dotted" defines a provider whose id Codex cannot take',
    );
    expect(fakes).toHaveLength(0);
    expect(toolset.opened[0]?.closed).toBe(true);
  });

  it('starts each session’s app-server with the toolset, its credential in the environment only', async () => {
    await startSession();
    const server = 'mcp_servers.3mukon-code';
    expect(current().launch).toEqual({
      args: [
        `${server}.url="http://127.0.0.1:4000/mcp"`,
        `${server}.bearer_token_env_var="TOOLSET_3MUKON_CODE_TOKEN"`,
        `${server}.default_tools_approval_mode="approve"`,
        `${server}.required=true`,
      ].flatMap((setting) => ['-c', setting]),
      env: { TOOLSET_3MUKON_CODE_TOKEN: 'credential-1' },
    });
    await provider().listSessions('/work', 10);
    expect(current().launch).toBeUndefined();
  });

  it('lists threads newest first without subagents’ threads, and models with the gateway’s own', async () => {
    const codex = provider();
    expect(await codex.listSessions('/work', 10)).toEqual([
      { id: 'a', title: 'First message', cwd: '/work', updatedAt: 100_000 },
      { id: 'b', title: 'Named', cwd: '/work', updatedAt: 50_000 },
    ]);
    expect(current().params('thread/list')).toMatchObject({
      cwd: '/work',
      limit: 10,
      sortKey: 'updated_at',
    });
    expect(current().closed).toBe(true);
    expect((await codex.listModels('work')).map((model) => model.id)).toEqual([
      'gpt-proxy',
      'gpt-default',
      'gpt-small',
    ]);
    expect(current().closed).toBe(true);
    expect(await codex.listGateways()).toEqual(['work']);
  });

  it('reads a thread’s history page by page from a short-lived app-server, with the name Codex keeps for it', async () => {
    const codex = provider();
    expect(await codex.history('th1', '/work')).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Earlier' },
      { type: 'message', id: 'a1', role: 'agent', text: 'Reply' },
    ]);
    expect(current().params('thread/read')).toEqual({ threadId: 'th1', includeTurns: false });
    expect(current().closed).toBe(true);
    threadName = 'Build fixes';
    expect((await codex.history('th1', '/work')).at(-1)).toEqual({
      type: 'title',
      title: 'Build fixes',
    });
  });

  it('resumes a thread and replays its history, page by page', async () => {
    const events: SessionEvent[] = [];
    const session = await provider().resume(
      { cwd: '/work', sessionId: 'th1', sandbox: 'read-only' },
      (event) => {
        events.push(event);
      },
    );
    expect(session.id).toBe('th1');
    expect(current().params('thread/resume')).toMatchObject({
      threadId: 'th1',
      excludeTurns: true,
      sandbox: 'read-only',
    });
    expect(current().params('thread/turns/list', 1)).toMatchObject({
      cursor: 'page2',
      itemsView: 'full',
    });
    expect(events.slice(0, 3)).toEqual([
      { type: 'message', id: 'u1', role: 'user', text: 'Earlier' },
      { type: 'message', id: 'a1', role: 'agent', text: 'Reply' },
      { type: 'replay-finished' },
    ]);
  });
});

describe('a Codex session', () => {
  it('sends a message’s images as data URLs after its text, and shows them with it', async () => {
    const { session, events } = await startSession();
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    await session.send('Look', [image]);
    expect(current().params('turn/start')).toMatchObject({
      input: [
        { type: 'text', text: 'Look', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'user', images: [image] }),
    );
  });

  it('sends a chosen effort with the first turn, and ends the turn when Codex says so', async () => {
    const { session, events } = await startSession({ effort: 'high' });
    await session.send('hi');
    expect(current().params('turn/start')).toEqual({
      threadId: 'th1',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
      effort: 'high',
    });
    current().emit('turn/completed', completed('turn-1'));
    expect(events.at(-1)).toEqual({ type: 'turn-ended', outcome: 'completed' });
    await session.send('again');
    expect(current().params('turn/start')).toEqual({
      threadId: 'th1',
      input: [{ type: 'text', text: 'again', text_elements: [] }],
    });
  });

  it('carries a switched model, effort and mode with the next turn, defaults included', async () => {
    const { session } = await startSession();
    await session.setModel('gpt-small');
    await session.setEffort('low');
    await session.setMode('yolo');
    await session.send('one');
    expect(current().params('turn/start')).toMatchObject({
      model: 'gpt-small',
      effort: 'low',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    });
    expect(current().params('turn/start')).not.toHaveProperty('sandboxPolicy');
    current().emit('turn/completed', completed('turn-1'));
    await session.setModel(null);
    await session.setEffort(null);
    await session.setMode('auto');
    await session.send('two');
    expect(current().params('turn/start')).toMatchObject({
      model: 'gpt-default',
      effort: 'medium',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
  });

  it('carries a switched sandbox with the next turn, without the mode, as Codex shaped it', async () => {
    const { session, events } = await startSession();
    await session.send('one');
    await session.setSandbox('read-only');
    expect(events.at(-1)).toEqual({ type: 'settings', sandbox: 'read-only' });
    expect(current().calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    current().emit('turn/completed', completed('turn-1'));
    await session.send('two');
    expect(current().params('turn/start')).toMatchObject({ sandboxPolicy: READ_ONLY });
    expect(current().params('turn/start')).not.toHaveProperty('approvalPolicy');
    current().emit('turn/completed', completed('turn-2'));
    await session.setSandbox('full-access');
    await session.send('three');
    expect(current().params('turn/start')).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    current().emit('turn/completed', completed('turn-3'));
    // The thread started in workspace-write, so the policy Codex gave it then comes back.
    await session.setSandbox('workspace-write');
    await session.send('four');
    expect(current().params('turn/start')).toMatchObject({ sandboxPolicy: WORKSPACE });
    current().emit('turn/completed', completed('turn-4'));
    await session.send('five');
    expect(current().params('turn/start')).not.toHaveProperty('sandboxPolicy');
  });

  it('sends Codex’s default policy for a level the thread never had', async () => {
    const { session } = await startSession({ sandbox: 'read-only' });
    await session.setSandbox('workspace-write');
    await session.send('one');
    expect(current().params('turn/start')).toMatchObject({
      sandboxPolicy: { ...WORKSPACE, writableRoots: [], networkAccess: false },
    });
  });

  it('asks the user for approvals in auto and allows them by itself in yolo', async () => {
    const { session, events } = await startSession();
    const first = current().ask('item/commandExecution/requestApproval', approvalParams, 5);
    expect(events.at(-1)).toMatchObject({
      type: 'approval-requested',
      request: { id: '5', command: 'rm -rf build' },
    });
    await session.answerApproval('5', { decision: 'allow-for-session' });
    expect(await first).toEqual({ decision: 'acceptForSession' });
    const waiting = current().ask('item/commandExecution/requestApproval', approvalParams, 6);
    await session.setMode('yolo');
    expect(await waiting).toEqual({ decision: 'accept' });
    expect(events).toContainEqual({
      type: 'request-resolved',
      requestId: '6',
      outcome: 'answered',
    });
    const count = events.length;
    expect(
      await current().ask(
        'item/fileChange/requestApproval',
        { ...approvalParams, reason: null },
        7,
      ),
    ).toEqual({
      decision: 'accept',
    });
    expect(events).toHaveLength(count);
  });

  it('asks Codex’s questions and cancels what Codex resolves by itself', async () => {
    const { session, events } = await startSession();
    const question = current().ask(
      'item/tool/requestUserInput',
      {
        threadId: 'th1',
        turnId: 'turn-1',
        itemId: 'q',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'style',
            header: '',
            question: 'Tabs?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Tabs', description: '' }],
          },
        ],
      },
      'q-1',
    );
    expect(events.at(-1)).toMatchObject({ type: 'question-asked', request: { id: 'q-1' } });
    await session.answerQuestion('q-1', {
      decision: 'answer',
      answers: { style: { selected: ['Tabs'] } },
    });
    expect(await question).toEqual({ answers: { style: { answers: ['Tabs'] } } });
    const approval = current().ask('item/commandExecution/requestApproval', approvalParams, 8);
    current().emit('serverRequest/resolved', { threadId: 'th1', requestId: 8 });
    expect(await approval).toEqual({ decision: 'decline' });
    expect(events.at(-1)).toEqual({
      type: 'request-resolved',
      requestId: '8',
      outcome: 'cancelled',
    });
    expect(await current().ask('mcpServer/elicitation/request', {}, 9)).toMatchObject({
      action: 'decline',
    });
    await expect(current().ask('attestation/generate', {}, 10)).rejects.toThrow('does not answer');
  });

  it('asks Codex’s async questions, and sends the answer given during the turn into it', async () => {
    const { session, events } = await startSession();
    await session.send('Ask me');
    current().emit(
      'item/completed',
      asyncQuestions('call-1', [{ title: 'Which?', options: ['A', 'B'] }]),
    );
    expect(events.at(-1)).toEqual({
      type: 'question-asked',
      request: {
        id: 'async-call-1',
        questions: [
          {
            id: '0',
            text: 'Which?',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: false,
            freeText: true,
            secret: false,
          },
        ],
        requestedAt: expect.any(Number) as number,
        byMessage: true,
      },
    });
    await session.answerQuestion('async-call-1', {
      decision: 'answer',
      answers: { '0': { selected: ['B'], text: ' in blue ' } },
    });
    expect(events).toContainEqual({
      type: 'request-resolved',
      requestId: 'async-call-1',
      outcome: 'answered',
    });
    await waitFor(() => current().params('turn/steer') !== undefined);
    expect(current().params('turn/steer')).toMatchObject({
      threadId: 'th1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'B\nin blue', text_elements: [] }],
    });
    expect(turnsStarted()).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'user', text: 'B\nin blue' }),
    );
  });

  it('sends a message during a turn into it, with its images, and one Codex takes into no turn with the next', async () => {
    const { session, events } = await startSession();
    await session.send('Fix the build');
    await session.send('Also the lint', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(current().params('turn/steer')).toMatchObject({
      expectedTurnId: 'turn-1',
      input: [
        { type: 'text', text: 'Also the lint', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    });
    expect(events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    // Codex refuses a message into a turn that cannot take one; it starts the next turn.
    failSteer = 'The active turn cannot be steered.';
    await session.send('And the docs');
    expect(turnsStarted()).toBe(1);
    current().emit('turn/completed', completed('turn-1'));
    await waitFor(() => turnsStarted() === 2);
    expect(turnText(-1)).toBe('And the docs');
    expect(events.flatMap((event) => (event.type === 'message' ? [event.text] : []))).toEqual([
      'Fix the build',
      'Also the lint',
      'And the docs',
    ]);
    // Once the turn has ended, a message starts a turn of its own.
    current().emit('turn/completed', completed('turn-2'));
    await session.send('Thanks');
    expect(turnsStarted()).toBe(3);
  });

  it('keeps async questions open after their turn, and takes a message of the user’s own as the reply', async () => {
    const { session, events } = await startSession();
    await session.send('Ask me');
    current().emit(
      'item/completed',
      asyncQuestions('call-1', [
        { title: 'Name?', options: null },
        { title: 'Colour?', options: ['Red'] },
      ]),
    );
    current().emit(
      'item/completed',
      asyncQuestions('call-2', [{ title: 'Sure?', options: ['Yes'] }]),
    );
    current().emit('item/completed', asyncQuestions('call-3', [{ title: 'Skip?', options: null }]));
    current().emit('turn/completed', completed('turn-1'));
    expect(events.filter((event) => event.type === 'request-resolved')).toEqual([]);
    await session.answerQuestion('async-call-1', {
      decision: 'answer',
      answers: { '0': { selected: [], text: 'Ada' }, '1': { selected: ['Red'] } },
    });
    expect(turnText(-1)).toBe('Name?\nAda\n\nColour?\nRed');
    current().emit('turn/completed', completed('turn-2'));
    await session.answerQuestion('async-call-3', { decision: 'decline' });
    expect(turnsStarted()).toBe(2);
    await session.send('Never mind');
    expect(events).toContainEqual({
      type: 'request-resolved',
      requestId: 'async-call-2',
      outcome: 'answered',
    });
    await expect(session.answerQuestion('async-call-2', { decision: 'decline' })).rejects.toThrow(
      'No question async-call-2 is waiting.',
    );
    current().emit(
      'item/completed',
      asyncQuestions('call-4', [{ title: 'Later?', options: null }]),
    );
    await session.close();
    expect(events).toContainEqual({
      type: 'request-resolved',
      requestId: 'async-call-4',
      outcome: 'cancelled',
    });
  });

  it('switches the gateway between turns by resuming the thread on a new app-server', async () => {
    const { session, events } = await startSession();
    await session.send('hi');
    current().emit('turn/completed', completed('turn-1'));
    const first = current();
    await session.setSandbox('read-only');
    await session.setGateway('work');
    expect(fakes).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(current().params('thread/resume')).toMatchObject({
      threadId: 'th1',
      excludeTurns: true,
      sandbox: 'read-only',
      modelProvider: 'proxy',
      config: { model: 'gpt-proxy' },
    });
    expect(events).toContainEqual({
      type: 'settings',
      gateway: 'work',
      model: 'gpt-proxy',
      sandbox: 'read-only',
    });
    expect(events.some((event) => event.type === 'closed' || event.type === 'error')).toBe(false);
    // The new process rotates the transport access while keeping the app owner.
    expect(toolset.opened).toHaveLength(2);
    expect(toolset.opened[0]?.closed).toBe(true);
    expect(toolset.opened[1]?.closed).toBe(false);
    expect(current().launch).toEqual({
      args: [
        ...(first.launch?.args ?? []),
        '-c',
        'model_provider="proxy"',
        '-c',
        'model_providers.proxy.name="proxy"',
      ],
      env: { TOOLSET_3MUKON_CODE_TOKEN: 'credential-2' },
    });
    await session.send('again');
    expect(current().params('turn/start')).toMatchObject({ threadId: 'th1' });
  });

  it('resumes the thread on its earlier gateway when the new one fails', async () => {
    failResume = new Error('cannot reach secret-token-value');
    const { session, events } = await startSession();
    await expect(session.setGateway('work')).rejects.toThrow('cannot reach [hidden]');
    expect(fakes).toHaveLength(3);
    expect(fakes.slice(0, 2).every((fake) => fake.closed)).toBe(true);
    expect(current().params('thread/resume')).not.toHaveProperty('modelProvider');
    expect(current().launch?.args).not.toContain('model_provider="proxy"');
    expect(events.some((event) => event.type === 'closed' || event.type === 'error')).toBe(false);
    await session.send('still here');
    expect(current().params('turn/start')).toMatchObject({ threadId: 'th1' });
  });

  it('stays on its gateway, and says why, when Codex keeps the thread on the provider it started with', async () => {
    failResume = new CodexError(
      'This chat uses openai, but your current provider is proxy. Switch to openai to continue.',
      'modelProviderMismatch',
    );
    const { session, events } = await startSession();
    const why =
      'Codex keeps this session on the model provider it started with, so it stays on Codex\'s own configuration; the gateway "work" applies to new sessions.';
    await expect(session.setGateway('work')).rejects.toThrow(why);
    expect(fakes).toHaveLength(3);
    expect(current().launch?.args).not.toContain('model_provider="proxy"');
    expect(events).toContainEqual({ type: 'error', message: why });
    expect(events.some((event) => event.type === 'closed')).toBe(false);
    expect(events.some((event) => event.type === 'settings' && event.gateway === 'work')).toBe(
      false,
    );
    await session.send('still here');
    expect(current().params('turn/start')).toMatchObject({ threadId: 'th1' });
  });

  it('switches a gateway asked for during a turn once the turn has ended', async () => {
    const { session, events } = await startSession();
    await session.send('hi');
    await session.setGateway('work');
    expect(fakes).toHaveLength(1);
    current().emit('turn/completed', completed('turn-1'));
    await waitFor(() =>
      events.some((event) => event.type === 'settings' && event.gateway === 'work'),
    );
    expect(fakes).toHaveLength(2);
  });

  it('closes when closed, and reports an unexpected exit, cancelling what was open', async () => {
    const closing = await startSession();
    await closing.session.close();
    expect(closing.events.at(-1)).toEqual({ type: 'closed' });
    const failing = await startSession();
    const approval = current().ask('item/commandExecution/requestApproval', approvalParams, 11);
    current().stop('Codex stopped unexpectedly (exit code 1).');
    expect(await approval).toEqual({ decision: 'decline' });
    expect(failing.events.slice(-2)).toEqual([
      { type: 'request-resolved', requestId: '11', outcome: 'cancelled' },
      { type: 'closed', error: 'Codex stopped unexpectedly (exit code 1).' },
    ]);
  });
});

describe('Codex’s account through the adapter', () => {
  it('asks a running session’s app-server, or else a short-lived one, and passes on what turns report of the account', async () => {
    const codex = provider();
    const news: AccountNews[] = [];
    codex.onAccountNews((heard) => {
      news.push(heard);
    });
    expect(await codex.readAccount(true)).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
      usage: { windows: [{ span: 'five-hour', used: 40, resetsAt: 20_000 }], resets: 1 },
    });
    const probe = current();
    expect(probe.closed).toBe(true);
    expect(probe.cwd).toContain('codex-account-');
    const session = await codex.start({ cwd: '/work' }, () => undefined);
    const running = current();
    await codex.readAccount(false);
    expect(await codex.resetLimits?.()).toBe('reset');
    expect(current()).toBe(running);
    expect(running.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['account/read', 'account/rateLimitResetCredit/consume']),
    );
    running.emit('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 30 },
        secondary: null,
      },
    });
    running.emit('error', {
      error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized', additionalDetails: null },
      willRetry: false,
      threadId: 'th1',
      turnId: 'turn-1',
    });
    expect(news).toEqual([
      { type: 'usage', windows: [{ span: 'five-hour', used: 91, resetsAt: 30_000 }] },
      { type: 'signed-out' },
    ]);
    await session.close();
    await codex.readAccount(false);
    expect(current()).not.toBe(running);
    expect((await codex.signInCommand()).args).toEqual(['login']);
  });
});

// An app-server whose model list runs until it stops, and which exits only once the test lets it,
// as Codex takes its time to.
class SlowCodex extends FakeCodex {
  private stopListing: (error: Error) => void = () => undefined;

  constructor(
    cwd: string,
    handlers: RpcHandlers,
    launch: Launch | undefined,
    private readonly exited: Promise<void>,
  ) {
    super(cwd, handlers, launch);
  }

  override request<Result>(method: string, params: unknown): Promise<Result> {
    if (method !== 'model/list') return super.request(method, params);
    this.calls.push({ method, params: params as Params });
    return new Promise<Result>((_resolve, reject) => {
      this.stopListing = reject;
    });
  }

  override async close(): Promise<void> {
    await this.exited;
    this.stopListing(new Error('Codex has stopped.'));
    await super.close();
  }
}

describe('closing the Codex provider', () => {
  it('stops a short-lived app-server as it closes, waits for it to exit, and starts no more', async () => {
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const codex = createCodexProvider({
      toolset,
      gatewaysDir,
      startRpc: (cwd, handlers, launch) => {
        const fake = new SlowCodex(cwd, handlers, launch, exited);
        fakes.push(fake);
        return fake;
      },
    });
    const listing = codex.listModels(null);
    await waitFor(() => fakes.at(-1)?.calls.some((call) => call.method === 'model/list') === true);
    let closed = false;
    const closing = codex.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    exit();
    await closing;
    await expect(listing).rejects.toThrow('stopped');
    expect(current().closed).toBe(true);
    await expect(codex.listModels(null)).rejects.toThrow('closed');
    expect(fakes).toHaveLength(1);
  });
});
