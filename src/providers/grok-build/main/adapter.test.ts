import {
  agent,
  RequestError,
  type AgentConnection,
  type AnyMessage,
  type ListSessionsResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountNews } from '../../../accounts/main/source';
import type { ToolsetAccess } from '../../../sessions/main/provider';
import type { ProviderSession } from '../../../sessions/main/provider';
import type { SessionEvent } from '../../../sessions/shared/events';
import { createGrokBuildProvider } from './adapter';
import type { GrokProcess } from './process';
import type { AskUserQuestionResult } from './requests';

type Params = Record<string, unknown>;

// The models as Grok lists them when it starts.
const MODEL_STATE = {
  currentModelId: 'grok-default',
  availableModels: [
    {
      modelId: 'grok-default',
      name: 'Grok Default',
      description: 'The usual one',
      _meta: {
        reasoningEfforts: [
          { id: 'high', value: 'high', default: true },
          { id: 'low', value: 'low', default: false },
        ],
      },
    },
    { modelId: 'grok-small', name: 'Grok Small', _meta: { reasoningEfforts: [] } },
  ],
};

// The catalog of Grok's first fetch, where initialize gave only its built-in models.
const NEWER_MODELS = {
  currentModelId: 'grok-newer',
  availableModels: [{ modelId: 'grok-newer', name: 'Grok Newer', _meta: { reasoningEfforts: [] } }],
};

function configOptions(model: string, effort: string): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'grok-default', name: 'Grok Default' },
        { value: 'grok-small', name: 'Grok Small' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: effort,
      options: [
        { value: 'high', name: 'High' },
        { value: 'low', name: 'Low' },
      ],
    },
  ];
}

const OPTIONS: RequestPermissionRequest['options'] = [
  { optionId: 'always-allow', name: 'Always', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
];

function permission(command: string): RequestPermissionRequest {
  return {
    sessionId: 'grok-1',
    toolCall: {
      toolCallId: 'call-1',
      kind: 'execute',
      title: `Execute \`${command}\``,
      rawInput: { command },
    },
    options: OPTIONS,
  };
}

// What the fake Grok does; a test can change it.
let replay: SessionUpdate[];
let failNew: string | undefined;
// An interjection Grok refuses.
let failInterject: string | undefined;
// The sandbox profile whose processes cannot resume a session.
let failResumeAt: string | undefined;
let pages: ListSessionsResponse[];
// Whether a stopped process takes its time to exit, as Grok does.
let slowExit: boolean;
// The catalog x.ai/models/list answers with once Grok's first fetch lands, initialize's by default,
// and whether the Grok has no such call, as an older one.
let listedModels: unknown;
let noModelsList: boolean;
let fakes: FakeGrok[];
let automationCapabilities = false;

it.each(['auto', 'yolo'] as const)(
  'connects HTTP on new and resume in %s and retains context until the native answer',
  async (mode) => {
    automationCapabilities = true;
    const accesses: ToolsetAccess[] = [];
    const linked = vi.fn();
    const bound = {
      name: '3mukon-code',
      callTimeoutMs: 86_400_000,
      open() {
        const access = {
          url: 'http://127.0.0.1:4000/mcp',
          credential: `synthetic-${String(accesses.length)}`,
          tools: ['panel_list'],
          close: vi.fn(),
          result: linked,
          availability: vi.fn(),
        };
        accesses.push(access);
        return access;
      },
    };
    const { session, events, until } = await open((onEvent) =>
      provider.start(
        { cwd: '/work', mode, model: 'grok-small', effort: 'low', toolset: bound },
        onEvent,
      ),
    );
    expect(fake().args).toEqual([
      '--no-plan',
      '--sandbox',
      'workspace',
      '--allow',
      'MCPTool(sanmukon-code__panel_list)',
      'agent',
      '--no-leader',
      'stdio',
    ]);
    // Grok registers none of a server's tools unless its name starts with a letter or an underscore,
    // so the toolset's 3mukon-code reaches Grok as sanmukon-code.
    expect(fake().paramsOf('session/new')[0]?.mcpServers).toEqual([
      {
        type: 'http',
        name: 'sanmukon-code',
        url: accesses[0]?.url,
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-0' }],
      },
    ]);
    await expect(
      fake().request({
        sessionId: 'grok-1',
        toolCall: { toolCallId: 'entry', kind: 'other', title: 'sanmukon-code__panel_list' },
        options: OPTIONS,
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(events.some((e) => e.type === 'approval-requested')).toBe(false);
    const delivery = { accepted: vi.fn(), failed: vi.fn() };
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
    await session.send('Original text', [], { presentationNotices: [notice] }, delivery);
    await fake().prompted();
    // Taken once Grok's first output for the turn comes, not before.
    expect(delivery.accepted).not.toHaveBeenCalled();
    expect(fake().paramsOf('session/prompt')[0]?.prompt).toEqual([
      expect.objectContaining({ type: 'resource' }),
      { type: 'text', text: 'Original text' },
    ]);
    const envelope = {
      automation: { schemaVersion: 1, callId: 'receipt' },
      outcome: { status: 'verified', value: null },
      presentationNotices: [],
    };
    await fake().update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'entry',
      status: 'completed',
      rawOutput: envelope,
    });
    await until(() => linked.mock.calls.length === 1);
    expect(linked).toHaveBeenCalledWith('panel_list', 'entry', envelope.automation);
    expect(delivery.accepted).toHaveBeenCalledOnce();
    fake().endPrompt('end_turn');
    await until(has('turn-ended'));
    expect(delivery.accepted).toHaveBeenCalledOnce();
    await session.setSandbox('read-only');
    expect(accesses).toHaveLength(2);
    expect(accesses[0]?.close).toHaveBeenCalled();
    expect(fake(1).args).toContain('MCPTool(sanmukon-code__panel_list)');
    expect(fake(1).paramsOf('session/resume')[0]?.mcpServers).toEqual([
      {
        type: 'http',
        name: 'sanmukon-code',
        url: accesses[1]?.url,
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-1' }],
      },
    ]);
    expect(fake(1).paramsOf('session/set_config_option')).toContainEqual({
      sessionId: 'grok-1',
      configId: 'model',
      value: 'grok-small',
    });
    expect(fake(1).paramsOf('session/set_config_option')).toContainEqual({
      sessionId: 'grok-1',
      configId: 'reasoning_effort',
      value: 'low',
    });
    await session.close();
    expect(accesses[1]?.close).toHaveBeenCalled();
  },
);

// Grok Build 1.0.70's observed dispatcher sequence, with synthetic IDs and content. Its metadata
// names use_tool in grok_build, not the MCP server; the initial title changes to the bare tool name.
const USE_TOOL_META = {
  'x.ai/tool': {
    version: 1,
    name: 'use_tool',
    kind: 'use_tool',
    namespace: 'grok_build',
    label: 'Use Tool',
    read_only: false,
  },
};
function useToolFixture(id: string, name: string): SessionUpdate[] {
  const input = {
    tool_name: name,
    tool_input: {
      actionId: 'fixture-present',
      reuseKey: 'fixture',
      title: 'Fixture',
      version: 0,
      items: [{ kind: 'file', path: '/work/notes.md' }],
    },
  };
  return [
    {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'use_tool',
      _meta: USE_TOOL_META,
      rawInput: { variant: null, ...input },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      title: name,
      kind: 'other',
      _meta: USE_TOOL_META,
      rawInput: { variant: 'UseTool', ...input },
    },
  ];
}

it('identifies the app’s browser tool on Grok’s first dispatcher update', async () => {
  automationCapabilities = true;
  const { session, events, until } = await open((onEvent) =>
    provider.start(
      {
        cwd: '/work',
        toolset: {
          name: '3mukon-code',
          callTimeoutMs: 86_400_000,
          open: () => ({
            url: 'http://127.0.0.1:4000/mcp',
            credential: 'synthetic',
            tools: ['browser_navigate'],
            close: vi.fn(),
          }),
        },
      },
      onEvent,
    ),
  );
  const url = 'https://fixture.example/';
  const appBrowser = { server: '3mukon-code', tool: 'browser_navigate', app: true, subject: url };
  const cases = [
    ['sanmukon-code__browser_navigate', appBrowser],
    ['browser_navigate', appBrowser],
    ['foreign__browser_navigate', undefined],
    ['sanmukon-code__browser_unregistered', undefined],
  ] as const;
  try {
    for (const [name, mcp] of cases) {
      await fake().update({
        sessionUpdate: 'tool_call',
        toolCallId: name,
        title: 'use_tool',
        _meta: USE_TOOL_META,
        rawInput: { variant: null, tool_name: name, tool_input: { url } },
      });
      await until(() => last(events, 'tool')?.id === name);
      expect(last(events, 'tool')?.mcp).toEqual(mcp);
    }
  } finally {
    await session.close();
  }
});

it.each([
  { name: 'panel_present', status: 'completed' as const },
  { name: 'sanmukon-code__panel_present', status: 'completed' as const },
  { name: 'panel_present', status: 'failed' as const },
  { name: 'sanmukon-code__panel_present', status: 'failed' as const },
])(
  'forwards the recorded MCP result wrapper from $name ($status) for host validation',
  async ({ name, status }) => {
    automationCapabilities = true;
    const linked = vi.fn();
    const { session, until } = await open((onEvent) =>
      provider.start(
        {
          cwd: '/work',
          toolset: {
            name: '3mukon-code',
            callTimeoutMs: 86_400_000,
            open: () => ({
              url: 'http://127.0.0.1:4000/mcp',
              credential: 'synthetic',
              tools: ['panel_present'],
              result: linked,
              close: vi.fn(),
            }),
          },
        },
        onEvent,
      ),
    );
    await session.send('Present the fixture');
    await fake().prompted();
    for (const update of useToolFixture('entry', name)) await fake().update(update);
    // The activity names the call as the app's own tool, by the title it presents.
    await until((events) =>
      events.some(
        (event) =>
          event.type === 'tool' &&
          event.mcp?.app === true &&
          event.mcp.tool === 'panel_present' &&
          event.mcp.subject === 'Fixture',
      ),
    );
    const receipt = { schemaVersion: 1, callId: 'synthetic-receipt' };
    await fake().update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'entry',
      status,
      rawOutput: {
        type: 'MCP',
        server_name: 'sanmukon-code',
        tool_name: 'panel_present',
        // Grok's MCPOutputDetails: OkayOutput for a result, and Error with is_error for one the
        // server marked isError, as the toolset marks a refusal, which Grok reports as failed.
        ...(status === 'completed'
          ? {
              output: {
                OkayOutput: JSON.stringify({
                  automation: receipt,
                  frames: [],
                  outcome: { status: 'verified', value: null },
                  presentationNotices: [],
                }),
              },
            }
          : {
              output: {
                Error: JSON.stringify({
                  automation: receipt,
                  frames: [],
                  outcome: { status: 'refused', code: 'invalid-request', dispatched: false },
                  presentationNotices: [],
                }),
              },
              is_error: true,
            }),
      },
    });
    await until(() => linked.mock.calls.length === 1);
    expect(linked).toHaveBeenCalledWith('panel_present', 'entry', receipt);
    await session.close();
  },
);

it('does not auto-approve bare or foreign names, or infer receipts from their arguments', async () => {
  automationCapabilities = true;
  const linked = vi.fn();
  const { session, events, until } = await open((onEvent) =>
    provider.start(
      {
        cwd: '/work',
        toolset: {
          name: '3mukon-code',
          callTimeoutMs: 86_400_000,
          open: () => ({
            url: 'http://127.0.0.1:4000/mcp',
            credential: 'synthetic',
            tools: ['panel_present'],
            result: linked,
            close: vi.fn(),
          }),
        },
      },
      onEvent,
    ),
  );
  await session.send('Use a tool');
  await fake().prompted();
  // The toolset's own name, 3mukon-code, is not the one Grok knows it by, so it is foreign too.
  for (const name of ['panel_present', 'foreign__panel_present', '3mukon-code__panel_present']) {
    for (const update of useToolFixture(name, name)) await fake().update(update);
    const pending = fake().request({
      sessionId: 'grok-1',
      toolCall: { toolCallId: name, kind: 'other', title: name, _meta: USE_TOOL_META },
      options: OPTIONS,
    });
    await until((all) =>
      all.some((e) => e.type === 'approval-requested' && e.request.title === name),
    );
    await session.answerApproval(last(events, 'approval-requested')?.request.id ?? '', {
      decision: 'deny',
    });
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
    await fake().update({
      sessionUpdate: 'tool_call_update',
      toolCallId: name,
      status: 'failed',
      rawOutput: {
        nested: {
          automation: { schemaVersion: 1, callId: 'injected' },
          outcome: { status: 'verified', value: null },
          presentationNotices: [],
        },
      },
    });
  }
  await session.close();
  expect(linked).not.toHaveBeenCalled();
});

it('rejects foreign, conflicting and malformed MCP wrappers without falling back to content', async () => {
  automationCapabilities = true;
  const linked = vi.fn();
  const { session, until } = await open((onEvent) =>
    provider.start(
      {
        cwd: '/work',
        toolset: {
          name: '3mukon-code',
          callTimeoutMs: 86_400_000,
          open: () => ({
            url: 'http://127.0.0.1:4000/mcp',
            credential: 'synthetic',
            tools: ['panel_present', 'panel_list'],
            result: linked,
            close: vi.fn(),
          }),
        },
      },
      onEvent,
    ),
  );
  const envelope = {
    automation: { schemaVersion: 1, callId: 'must-not-link' },
    outcome: { status: 'verified', value: null },
    presentationNotices: [],
  };
  const text = JSON.stringify(envelope);
  const wrapper = {
    type: 'MCP',
    server_name: 'sanmukon-code',
    tool_name: 'panel_present',
    output: { OkayOutput: text },
  };
  const cases = [
    { ...wrapper, server_name: 'foreign' },
    { ...wrapper, server_name: '3mukon-code' },
    { ...wrapper, server_name: undefined },
    { ...wrapper, tool_name: 'panel_list' },
    { ...wrapper, tool_name: undefined },
    { ...wrapper, type: 'SearchTool' },
    { ...wrapper, type: undefined },
    { ...wrapper, output: { OkayOutput: envelope } },
    { ...wrapper, output: { ErrorOutput: text } },
    { ...wrapper, output: { Error: text } },
    { ...wrapper, is_error: true },
    { ...wrapper, output: { OkayOutput: text, Error: text } },
    { ...wrapper, output: { OkayOutput: text, Error: text }, is_error: true },
    { ...wrapper, output: { OkayOutput: '{broken' } },
    { ...wrapper, output: { OkayOutput: ' '.repeat(256 * 1024) + text } },
    { ...wrapper, output: { OkayOutput: JSON.stringify({ nested: envelope }) } },
    { ...wrapper, ...envelope, server_name: 'foreign' },
  ];
  try {
    await session.send('Present a fixture');
    await fake().prompted();
    for (const [index, rawOutput] of cases.entries()) {
      const id = `rejected-${String(index)}`;
      for (const update of useToolFixture(id, 'sanmukon-code__panel_present'))
        await fake().update(update);
      await fake().update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'completed',
        rawOutput,
        content: [{ type: 'content', content: { type: 'text', text } }],
      });
      await until((events) =>
        events.some((e) => e.type === 'tool' && e.id === id && e.status === 'completed'),
      );
      expect(linked).not.toHaveBeenCalled();
    }
  } finally {
    await session.close();
  }
});

it('uses the Grok-only server name on history load without renaming the shared toolset', async () => {
  automationCapabilities = true;
  const toolset = {
    name: '3mukon-code',
    callTimeoutMs: 86_400_000,
    open: () => ({
      url: 'http://127.0.0.1:4000/mcp',
      credential: 'synthetic',
      tools: ['panel_list'],
      close: vi.fn(),
    }),
  };
  const { session } = await open((onEvent) =>
    provider.resume(
      {
        cwd: '/work',
        sessionId: 'grok-1',
        toolset,
      },
      onEvent,
    ),
  );
  try {
    expect(fake().paramsOf('session/load')[0]?.mcpServers).toEqual([
      {
        type: 'http',
        name: 'sanmukon-code',
        url: 'http://127.0.0.1:4000/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer synthetic' }],
      },
    ]);
    expect(fake().args).toContain('MCPTool(sanmukon-code__panel_list)');
    expect(fake().args).not.toContain('MCPTool(3mukon-code__panel_list)');
    expect(toolset.name).toBe('3mukon-code');
  } finally {
    await session.close();
  }
});

it('reports unsupported HTTP without disabling ordinary chat', async () => {
  const availability = vi.fn();
  const access = {
    url: 'http://127.0.0.1:4000/mcp',
    credential: 'synthetic',
    close: vi.fn(),
    availability,
  };
  const { session } = await open((onEvent) =>
    provider.resume(
      {
        cwd: '/work',
        sessionId: 'grok-1',
        toolset: { name: '3mukon-code', callTimeoutMs: 86_400_000, open: () => access },
      },
      onEvent,
    ),
  );
  expect(availability).toHaveBeenCalledWith({
    tools: 'unavailable',
    images: 'unsupported',
    reason: { code: 'transport-unsupported', transport: 'streamable-http' },
  });
  expect(fake().paramsOf('session/load')[0]?.mcpServers).toEqual([]);
  await session.send('Chat still works');
  await fake().prompted();
  await session.close();
});

beforeEach(() => {
  replay = [];
  failNew = undefined;
  failInterject = undefined;
  failResumeAt = undefined;
  pages = [];
  slowExit = false;
  listedModels = MODEL_STATE;
  noModelsList = false;
  fakes = [];
  automationCapabilities = false;
});

function memoryStreams(): [Stream, Stream] {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  return [
    { readable: toClient.readable, writable: toAgent.writable },
    { readable: toAgent.readable, writable: toClient.writable },
  ];
}

// Stands in for one Grok Build process, on the ACP SDK's own agent side. The test plays the agent
// through update, endPrompt, request and ask, and the process's end through crash.
class FakeGrok {
  readonly calls: { method: string; params: Params }[] = [];
  readonly process: GrokProcess;
  stopped = false;
  private readonly connection: AgentConnection;
  private prompt: ((stopReason: StopReason, meta?: Params) => void) | null = null;
  private failPrompt: ((message: string) => void) | null = null;
  private model = 'grok-default';
  private effort = 'high';
  private end: (reason: string | undefined) => void = () => undefined;

  constructor(
    readonly cwd: string,
    readonly args: string[],
  ) {
    const [clientSide, agentSide] = memoryStreams();
    const record = (method: string, params: unknown) => {
      this.calls.push({ method, params: params as Params });
    };
    const options = () => configOptions(this.model, this.effort);
    this.connection = agent()
      .onRequest('initialize', ({ params }) => {
        record('initialize', params);
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            ...(automationCapabilities
              ? {
                  mcpCapabilities: { http: true },
                  promptCapabilities: { image: true, embeddedContext: true },
                }
              : {}),
          },
          authMethods: [],
          _meta: { modelState: MODEL_STATE },
        };
      })
      .onRequest('session/new', ({ params }) => {
        record('session/new', params);
        if (failNew !== undefined) throw new RequestError(-32000, failNew);
        return { sessionId: 'grok-1', configOptions: options() };
      })
      .onRequest('session/load', async ({ params, client }) => {
        record('session/load', params);
        for (const update of replay) {
          await client.notify('session/update', { sessionId: params.sessionId, update });
        }
        return { configOptions: options() };
      })
      .onRequest('session/resume', ({ params }) => {
        record('session/resume', params);
        if (failResumeAt !== undefined && this.args.includes(failResumeAt)) {
          throw new RequestError(-32000, 'Grok could not resume the session.');
        }
        return { configOptions: options() };
      })
      // As Grok 1.0.92, which takes a permission mode only as the session's flags.
      .onRequest('session/set_mode', ({ params }) => {
        record('session/set_mode', params);
        if (params.modeId !== 'default' && params.modeId !== 'plan') {
          throw new RequestError(-32602, 'Invalid params', `unknown mode id: ${params.modeId}`);
        }
        return {};
      })
      .onRequest('session/set_config_option', ({ params }) => {
        record('session/set_config_option', params);
        if (params.configId === 'model') this.model = String(params.value);
        else this.effort = String(params.value);
        return { configOptions: options() };
      })
      .onRequest('session/prompt', ({ params }) => {
        record('session/prompt', params);
        return new Promise((resolve, reject) => {
          this.prompt = (stopReason, meta) => {
            resolve({ stopReason, ...(meta === undefined ? {} : { _meta: meta }) });
          };
          this.failPrompt = (message) => {
            reject(new RequestError(-32000, message));
          };
        });
      })
      .onRequest(
        '_x.ai/models/list',
        (params) => params as Params,
        ({ params }) => {
          record('_x.ai/models/list', params);
          if (noModelsList) throw new RequestError(-32601, 'Method not found');
          return { result: listedModels };
        },
      )
      .onRequest(
        '_x.ai/auth/info',
        (params) => params as Params,
        ({ params }) => {
          record('_x.ai/auth/info', params);
          return { methodId: 'cached_token', email: 'someone@example.com' };
        },
      )
      .onRequest(
        '_x.ai/billing',
        (params) => params as Params,
        ({ params }) => {
          record('_x.ai/billing', params);
          return {
            config: {
              currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-09T00:00:00Z' },
              creditUsagePercent: 12,
            },
          };
        },
      )
      .onRequest(
        '_x.ai/interject',
        (params) => params as Params,
        ({ params }) => {
          record('_x.ai/interject', params);
          if (failInterject !== undefined) throw new RequestError(-32000, failInterject);
          return { status: 'queued' };
        },
      )
      .onRequest(
        '_x.ai/session/rename',
        (params) => params as Params,
        ({ params }) => {
          record('_x.ai/session/rename', params);
          return { success: true };
        },
      )
      .onRequest(
        '_x.ai/session/delete',
        (params) => params as Params,
        ({ params }) => {
          record('_x.ai/session/delete', params);
          return { success: true };
        },
      )
      .onNotification('session/cancel', ({ params }) => {
        record('session/cancel', params);
        this.endPrompt('cancelled');
      })
      .onRequest('session/list', ({ params }) => {
        record('session/list', params);
        return pages[params.cursor == null ? 0 : Number(params.cursor)] ?? { sessions: [] };
      })
      .connect(agentSide);
    const ended = new Promise<string | undefined>((resolve) => {
      this.end = resolve;
    });
    this.process = {
      stream: clientSide,
      ended,
      stop: () => {
        this.stopped = true;
        this.connection.close();
        this.end(undefined);
        return slowExit ? new Promise<void>(() => undefined) : Promise.resolve();
      },
    };
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  paramsOf(method: string): Params[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  async update(update: SessionUpdate, sessionId = 'grok-1'): Promise<void> {
    await this.connection.client.notify('session/update', { sessionId, update });
  }

  // Resolves once a prompt has reached the fake and waits for its end.
  async prompted(): Promise<void> {
    for (let attempt = 0; attempt < 200 && this.prompt === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (this.prompt === null) throw new Error('No prompt reached Grok.');
  }

  endPrompt(stopReason: StopReason, meta?: Params): void {
    this.prompt?.(stopReason, meta);
    this.prompt = null;
  }

  // One of Grok's extension notices, such as its queue's.
  async notify(method: string, params: Params): Promise<void> {
    await this.connection.client.notify(method, params);
  }

  rejectPrompt(message: string): void {
    this.failPrompt?.(message);
    this.prompt = null;
  }

  // Refuses the running prompt as Grok does without a sign-in.
  refuseSignIn(): void {
    this.failPrompt?.('Authentication required');
    this.prompt = null;
  }

  request(
    params: RequestPermissionRequest,
    cancellationSignal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.connection.client.request('session/request_permission', params, {
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    });
  }

  ask(params: Params, cancellationSignal?: AbortSignal): Promise<AskUserQuestionResult> {
    return this.connection.client.request<AskUserQuestionResult>(
      '_x.ai/ask_user_question',
      params,
      cancellationSignal === undefined ? {} : { cancellationSignal },
    );
  }

  crash(reason: string): void {
    this.connection.close();
    this.end(reason);
  }
}

const provider = createGrokBuildProvider({
  startGrok: (cwd, args) => {
    const fake = new FakeGrok(cwd, args);
    fakes.push(fake);
    return Promise.resolve(fake.process);
  },
});

function fake(index = 0): FakeGrok {
  const found = fakes[index];
  if (found === undefined) throw new Error(`No Grok process ${String(index)} started.`);
  return found;
}

// A session with its events, and a way to wait until they show something.
async function open(
  start: (onEvent: (event: SessionEvent) => void) => Promise<ProviderSession>,
): Promise<{ session: ProviderSession; events: SessionEvent[]; until: Until }> {
  const events: SessionEvent[] = [];
  const session = await start((event) => {
    events.push(event);
  });
  return { session, events, until: untilIn(events) };
}

type Until = (predicate: (events: SessionEvent[]) => boolean) => Promise<void>;

function untilIn(events: SessionEvent[]): Until {
  return async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate(events)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out; the events were ${JSON.stringify(events)}`);
  };
}

const has = (type: SessionEvent['type']) => (events: SessionEvent[]) =>
  events.some((event) => event.type === type);

function last<Type extends SessionEvent['type']>(
  events: SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }> | undefined {
  return events.findLast(
    (event): event is Extract<SessionEvent, { type: Type }> => event.type === type,
  );
}

describe('starting a session', () => {
  it('runs Grok at the level’s profile, with the question tool on, and reports the session’s settings', async () => {
    const { session, events } = await open((onEvent) =>
      provider.start(
        { cwd: '/work', model: 'grok-small', effort: 'low', sandbox: 'read-only' },
        onEvent,
      ),
    );
    expect(session.id).toBe('grok-1');
    expect(fake().cwd).toBe('/work');
    expect(fake().args).toEqual([
      '--no-plan',
      '--sandbox',
      'read-only',
      'agent',
      '--no-leader',
      'stdio',
    ]);
    expect(fake().methods()).toEqual([
      'initialize',
      'session/new',
      '_x.ai/models/list',
      'session/set_config_option',
      'session/set_config_option',
    ]);
    expect(fake().paramsOf('initialize')[0]).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: '3mukon-code' },
    });
    // The mode goes with the session, as Grok's auto mode.
    expect(fake().paramsOf('session/new')[0]).toEqual({
      cwd: '/work',
      mcpServers: [],
      _meta: { askUserQuestion: true, autoMode: true },
    });
    expect(fake().paramsOf('session/set_config_option')).toEqual([
      { sessionId: 'grok-1', configId: 'model', value: 'grok-small' },
      { sessionId: 'grok-1', configId: 'reasoning_effort', value: 'low' },
    ]);
    expect(events).toEqual([
      { type: 'mode', mode: 'auto' },
      { type: 'settings', gateway: null, model: 'grok-small', effort: 'low', sandbox: 'read-only' },
      {
        type: 'models',
        models: [
          // The model Grok uses when the session chooses none, with its own effort.
          {
            id: 'grok-default',
            label: 'Grok Default',
            description: 'The usual one',
            efforts: ['high', 'low'],
            default: true,
            defaultEffort: 'high',
          },
          { id: 'grok-small', label: 'Grok Small', efforts: [] },
        ],
      },
    ]);
  });

  it('takes each level’s profile, and yolo as Grok’s always-approve mode', async () => {
    await provider.start(
      { cwd: '/work', sandbox: 'workspace-write', mode: 'yolo' },
      () => undefined,
    );
    await provider.start({ cwd: '/work', sandbox: 'full-access' }, () => undefined);
    await provider.start({ cwd: '/work' }, () => undefined);
    expect(fakes.map((entry) => entry.args[2])).toEqual(['workspace', 'off', 'workspace']);
    expect(fake(0).paramsOf('session/new')[0]?._meta).toEqual({
      askUserQuestion: true,
      yoloMode: true,
    });
    expect(fake(1).paramsOf('session/new')[0]?._meta).toEqual({
      askUserQuestion: true,
      autoMode: true,
    });
    expect(fakes.flatMap((entry) => entry.methods())).not.toContain('session/set_mode');
    expect(fake(2).paramsOf('session/set_config_option')).toEqual([]);
  });

  it('stops the process when Grok will not create the session', async () => {
    failNew = 'Authentication required';
    await expect(provider.start({ cwd: '/work' }, () => undefined)).rejects.toThrow(
      'Authentication required',
    );
    expect(fake().stopped).toBe(true);
  });

  it('has no gateways', async () => {
    expect(await provider.listGateways()).toEqual([]);
    await expect(provider.listModels('proxy')).rejects.toThrow('no gateways');
    await expect(
      provider.start({ cwd: '/work', gateway: 'proxy' }, () => undefined),
    ).rejects.toThrow('no gateways');
    const session = await provider.start({ cwd: '/work' }, () => undefined);
    await session.setGateway(null);
    await expect(session.setGateway('proxy')).rejects.toThrow('no gateways');
  });
});

describe('turns', () => {
  it('sends a message’s images in the prompt after its text', async () => {
    const { session } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await session.send('', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    await fake().prompted();
    expect(fake().paramsOf('session/prompt')[0]).toEqual({
      sessionId: 'grok-1',
      prompt: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    });
  });

  it('tells the agent of new messages in a resource of its own, beside a message or in a turn of the app’s own', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    const notice = { id: 'n1', from: 'child', fromTitle: 'Tests', summary: 'Done', sentAt: 1 };
    const context = { presentationNotices: [], inboxNotices: [notice] };
    const inboxBlock = {
      type: 'resource',
      resource: {
        uri: 'app://3mukon-code/inbox',
        mimeType: 'text/plain',
        text: expect.stringContaining('Done') as string,
      },
    };
    await session.send('Go on', [], context, { accepted: vi.fn(), failed: vi.fn() });
    await fake().prompted();
    expect(fake().paramsOf('session/prompt')[0]?.prompt).toEqual([
      inboxBlock,
      { type: 'text', text: 'Go on' },
    ]);
    const delivery = { accepted: vi.fn(), failed: vi.fn() };
    await expect(session.deliverContext?.(context, delivery)).rejects.toThrow('turn is running');
    fake().endPrompt('end_turn');
    await until(has('turn-ended'));
    const messages = events.filter((event) => event.type === 'message').length;
    await session.deliverContext?.(context, delivery);
    await fake().prompted();
    expect(fake().paramsOf('session/prompt')[1]?.prompt).toEqual([inboxBlock]);
    expect(events.filter((event) => event.type === 'message')).toHaveLength(messages);
    // Taken once Grok's first output for the turn comes, so that the notices show before it.
    expect(delivery.accepted).not.toHaveBeenCalled();
    await fake().update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Reading it' },
    });
    await vi.waitFor(() => {
      expect(delivery.accepted).toHaveBeenCalledOnce();
    });
    fake().endPrompt('end_turn');
    await until(has('turn-ended'));
    expect(delivery.accepted).toHaveBeenCalledOnce();
  });

  it('adds a message during a turn through Grok’s interjection, with its images, and holds one it refuses', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    events.length = 0;
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const block = { type: 'image', mimeType: 'image/png', data: image.data };
    await session.send('Fix the build');
    await fake().prompted();
    await session.send('Also the lint');
    await session.send('Like this', [image]);
    expect(fake().paramsOf('_x.ai/interject')).toMatchObject([
      { sessionId: 'grok-1', text: 'Also the lint' },
      { sessionId: 'grok-1', text: 'Like this', content: [block] },
    ]);
    expect(fake().paramsOf('_x.ai/interject')[0]).not.toHaveProperty('content');
    // Images sent alone go with a text of the app's, since Grok goes silent after an interjection
    // without one; the activity shows the message as sent.
    await session.send('', [image, image]);
    expect(fake().paramsOf('_x.ai/interject')[2]).toMatchObject({
      text: '(images attached)',
      content: [block, block],
    });
    expect(events.findLast((event) => event.type === 'message')).toMatchObject({ text: '' });
    // A message that Grok refuses waits for the next turn.
    failInterject = 'Grok cannot take it now.';
    await session.send('And the docs');
    expect(fake().paramsOf('_x.ai/interject')).toHaveLength(4);
    expect(fake().paramsOf('session/prompt')).toHaveLength(1);
    fake().endPrompt('end_turn');
    await until(() => fake().paramsOf('session/prompt').length === 2);
    expect(fake().paramsOf('session/prompt')[1]).toEqual({
      sessionId: 'grok-1',
      prompt: [{ type: 'text', text: 'And the docs' }],
    });
    expect(events.map((event) => event.type)).toEqual([
      'turn-started',
      'message',
      'message',
      'message',
      'message',
      'message',
      'turn-ended',
      'turn-started',
    ]);
  });

  it('follows a turn that Grok runs by itself, as for an interjection after its turn', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    events.length = 0;
    const types = () => events.map((event) => event.type);
    const completed = (promptId: string) => ({
      sessionId: 'grok-1',
      update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' },
    });
    await session.send('Fix the build');
    await fake().prompted();
    // Grok already runs the interjection as a prompt of its own when the turn's answer comes.
    await fake().notify('_x.ai/queue/changed', {
      sessionId: 'grok-1',
      entries: [],
      runningPromptId: 'interject-fallback-1',
      runningKind: 'prompt',
    });
    fake().endPrompt('end_turn', { promptId: 'p1' });
    await until(() => types().length === 4);
    expect(types()).toEqual(['turn-started', 'message', 'turn-ended', 'turn-started']);
    await fake().notify('_x.ai/session_notification', completed('interject-fallback-1'));
    await until(() => types().length === 5);
    expect(events.at(-1)).toEqual({ type: 'turn-ended', outcome: 'completed' });
    // One that Grok starts while no turn runs.
    await fake().notify('_x.ai/queue/changed', {
      sessionId: 'grok-1',
      entries: [],
      runningPromptId: 'interject-fallback-2',
    });
    await until(() => types().length === 6);
    await fake().notify('_x.ai/session_notification', completed('interject-fallback-2'));
    await until(() => types().length === 7);
    expect(types().slice(4)).toEqual(['turn-ended', 'turn-started', 'turn-ended']);
  });

  it('sends the message and streams the turn until Grok answers the prompt', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    events.length = 0;
    await session.send('Hello');
    await fake().prompted();
    expect(fake().paramsOf('session/prompt')[0]).toEqual({
      sessionId: 'grok-1',
      prompt: [{ type: 'text', text: 'Hello' }],
    });
    await fake().update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi' },
    });
    await fake().update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Run ls',
      kind: 'execute',
      rawInput: { command: 'ls' },
    });
    // Updates of other sessions, such as a subagent's, and Grok's echo of the message stay out.
    await fake().update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Elsewhere' } },
      'subagent',
    );
    await fake().update({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Hello' },
    });
    fake().endPrompt('end_turn');
    await until(has('turn-ended'));
    expect(events.map((event) => event.type)).toEqual([
      'turn-started',
      'message',
      'message-delta',
      'tool',
      'turn-ended',
    ]);
    expect(events[1]).toMatchObject({ role: 'user', text: 'Hello' });
    expect(last(events, 'turn-ended')).toEqual({ type: 'turn-ended', outcome: 'completed' });
  });

  it('reports each retry of a request to the model that Grok notices, and leaves its giving up to the turn’s end', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    events.length = 0;
    const retry = (state: Params, sessionId = 'grok-1') =>
      fake().notify('_x.ai/session_notification', {
        sessionId,
        update: { sessionUpdate: 'retry_state', ...state },
      });
    const retries = () => events.filter((event) => event.type === 'retrying');
    await session.send('Fix the build');
    await fake().prompted();
    const reason = 'API error (status 500 Internal Server Error): Service temporarily unavailable';
    await retry({ type: 'retrying', attempt: 1, max_retries: 15, reason, is_rate_limited: false });
    // Another session's, such as a subagent's, stays out.
    await retry({ type: 'retrying', attempt: 1, max_retries: 15, reason }, 'subagent');
    await retry({ type: 'retrying', attempt: 2, max_retries: 15, reason });
    await until(() => retries().length === 2);
    expect(retries()).toEqual([
      { type: 'retrying', attempt: 1, maxRetries: 15, reason },
      { type: 'retrying', attempt: 2, maxRetries: 15, reason },
    ]);
    // Giving up says nothing of its own: the prompt's failure ends the turn, and with it the wait.
    await retry({ type: 'exhausted', attempt: 15, max_retries: 15, reason });
    fake().rejectPrompt(reason);
    await until(has('turn-ended'));
    expect(events.map((event) => event.type)).toEqual([
      'turn-started',
      'message',
      'retrying',
      'retrying',
      'turn-ended',
    ]);
  });

  it('ends a turn as Grok’s stop reason says', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    const turn = async (end: () => void) => {
      const before = events.filter((event) => event.type === 'turn-ended').length;
      await session.send('Go');
      await fake().prompted();
      end();
      await until((all) => all.filter((event) => event.type === 'turn-ended').length > before);
      return last(events, 'turn-ended');
    };
    expect(
      await turn(() => {
        fake().endPrompt('refusal');
      }),
    ).toMatchObject({
      outcome: 'failed',
      error: 'Grok Build refused to go on.',
    });
    expect(
      await turn(() => {
        fake().endPrompt('max_tokens');
      }),
    ).toMatchObject({ outcome: 'failed' });
    expect(
      await turn(() => {
        fake().rejectPrompt('Usage limit reached');
      }),
    ).toMatchObject({
      outcome: 'failed',
      error: 'Usage limit reached',
    });
  });

  it('interrupts the turn and cancels what still waits', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    await fake().prompted();
    const answer = fake().request(permission('rm -rf build'));
    await until(has('approval-requested'));
    await session.interrupt();
    expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
    await until(has('turn-ended'));
    expect(fake().paramsOf('session/cancel')).toEqual([{ sessionId: 'grok-1' }]);
    expect(last(events, 'request-resolved')).toMatchObject({ outcome: 'cancelled' });
    expect(last(events, 'turn-ended')).toEqual({ type: 'turn-ended', outcome: 'interrupted' });
  });
});

describe('approvals and questions', () => {
  it('asks before a tool call and answers with the once option Grok offers', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    const allowed = fake().request(permission('echo hi > a.txt'));
    await until(has('approval-requested'));
    const asked = last(events, 'approval-requested')?.request;
    expect(asked).toMatchObject({
      action: 'command',
      command: 'echo hi > a.txt',
      canAllowForSession: false,
    });
    await session.answerApproval(asked?.id ?? '', { decision: 'allow-once' });
    expect(await allowed).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    const denied = fake().request(permission('rm a.txt'));
    await until((all) => all.filter((event) => event.type === 'approval-requested').length === 2);
    await session.answerApproval(last(events, 'approval-requested')?.request.id ?? '', {
      decision: 'deny',
    });
    expect(await denied).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(events.filter((event) => event.type === 'request-resolved')).toHaveLength(2);
  });

  it('shows an edit’s file and diff, which Grok showed before it asks', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    await fake().update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      kind: 'edit',
      title: 'Edit `/work/notes.txt`',
      locations: [{ path: '/work/notes.txt' }],
      content: [{ type: 'diff', path: '/work/notes.txt', oldText: '', newText: 'ok\n' }],
    });
    void fake().request({
      sessionId: 'grok-1',
      toolCall: {
        toolCallId: 'call-1',
        title: 'Edit `/work/notes.txt`',
        rawInput: { file_path: '/work/notes.txt' },
      },
      options: OPTIONS,
    });
    await until(has('approval-requested'));
    expect(last(events, 'approval-requested')?.request).toMatchObject({
      action: 'edit',
      paths: ['notes.txt'],
      diff: '--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,1 @@\n+ok\n',
    });
  });

  it('allows what Grok still asks in yolo, and what waits once the session switches to it', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    const waiting = fake().request(permission('make'));
    await until(has('approval-requested'));
    await session.setMode('yolo');
    expect(await waiting).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    // The running session takes the mode as a resume in its own process, with its servers again.
    expect(fakes).toHaveLength(1);
    expect(fake().paramsOf('session/resume').at(-1)).toEqual({
      cwd: '/work',
      mcpServers: [],
      sessionId: 'grok-1',
      _meta: { askUserQuestion: true, yoloMode: true },
    });
    expect(last(events, 'mode')).toEqual({ type: 'mode', mode: 'yolo' });
    expect(await fake().request(permission('make test'))).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(events.filter((event) => event.type === 'approval-requested')).toHaveLength(1);
  });

  it('shows Grok’s own questions and answers them by question text', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    const answered = fake().ask({
      sessionId: 'grok-1',
      toolCallId: 'call-2',
      questions: [
        {
          question: 'Which color?',
          options: [{ label: 'Red' }, { label: 'Blue' }],
          multiSelect: null,
        },
      ],
      mode: 'default',
    });
    await until(has('question-asked'));
    const asked = last(events, 'question-asked')?.request;
    expect(asked?.questions).toEqual([
      {
        id: 'q0',
        text: 'Which color?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiSelect: false,
        freeText: true,
        secret: false,
      },
    ]);
    await session.answerQuestion(asked?.id ?? '', {
      decision: 'answer',
      answers: { q0: { selected: ['Blue'] } },
    });
    expect(await answered).toEqual({
      outcome: 'accepted',
      answers: { 'Which color?': 'Blue' },
      annotations: {},
    });
  });

  it('cancels a question that Grok gives up, or the user declines', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    const question = { sessionId: 'grok-1', questions: [{ question: 'Why?' }] };
    const giveUp = new AbortController();
    const givenUp = fake().ask(question, giveUp.signal);
    await until(has('question-asked'));
    giveUp.abort();
    await until(has('request-resolved'));
    expect(last(events, 'request-resolved')).toMatchObject({ outcome: 'cancelled' });
    expect(await givenUp).toEqual({ outcome: 'cancelled' });
    const declined = fake().ask(question);
    await until((all) => all.filter((event) => event.type === 'question-asked').length === 2);
    await session.answerQuestion(last(events, 'question-asked')?.request.id ?? '', {
      decision: 'decline',
    });
    expect(await declined).toEqual({ outcome: 'cancelled' });
  });
});

describe('switching', () => {
  it('switches the model and the effort at once, and back to the defaults', async () => {
    const { session, events } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await session.setModel('grok-small');
    await session.setEffort('low');
    await session.setModel(null);
    await session.setEffort(null);
    expect(
      fake()
        .paramsOf('session/set_config_option')
        .map(({ configId, value }) => [configId, value]),
    ).toEqual([
      ['model', 'grok-small'],
      ['reasoning_effort', 'low'],
      ['model', 'grok-default'],
      ['reasoning_effort', 'high'],
    ]);
    expect(events.slice(-4)).toEqual([
      { type: 'settings', model: 'grok-small' },
      { type: 'settings', effort: 'low' },
      { type: 'settings', model: null },
      { type: 'settings', effort: null },
    ]);
  });

  it('moves the session to a process at the new level, which resumes it, between turns', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work', model: 'grok-small' }, onEvent),
    );
    await session.setSandbox('read-only');
    expect(fake(0).stopped).toBe(true);
    expect(fake(1).args[2]).toBe('read-only');
    expect(fake(1).methods()).toEqual([
      'initialize',
      'session/resume',
      '_x.ai/models/list',
      'session/set_config_option',
    ]);
    // The new process takes the session's mode with the resume.
    expect(fake(1).paramsOf('session/resume')[0]).toEqual({
      cwd: '/work',
      mcpServers: [],
      _meta: { askUserQuestion: true, autoMode: true },
      sessionId: 'grok-1',
    });
    expect(last(events, 'settings')).toEqual({ type: 'settings', sandbox: 'read-only' });
    expect(session.id).toBe('grok-1');
    // The earlier process's end does not end the session, and the next turn runs on the new one.
    await session.send('Go');
    await fake(1).prompted();
    fake(1).endPrompt('end_turn');
    await until(has('turn-ended'));
    expect(events.some((event) => event.type === 'closed')).toBe(false);
  });

  it('switches a level asked for during a turn once the turn ends', async () => {
    const { session, until } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await session.send('Go');
    await fake().prompted();
    await session.setSandbox('full-access');
    expect(fakes).toHaveLength(1);
    fake().endPrompt('end_turn');
    await until(() => fakes.length === 2 && fake(1).methods().includes('_x.ai/models/list'));
    expect(fake(1).args[2]).toBe('off');
  });

  it('goes back to the earlier level when the new process cannot resume the session', async () => {
    failResumeAt = 'read-only';
    const { session, events } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await expect(session.setSandbox('read-only')).rejects.toThrow('could not resume');
    expect(fakes.map((entry) => entry.args[2])).toEqual(['workspace', 'read-only', 'workspace']);
    expect(last(events, 'settings')).toEqual({ type: 'settings', sandbox: 'workspace-write' });
    expect(fake(1).stopped).toBe(true);
    await session.send('Still here');
    await fake(2).prompted();
  });

  it('refreshes the catalog after a failed sandbox switch before restoring the default model', async () => {
    failResumeAt = 'read-only';
    const { session, events } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    // The replacement's initialize still has the built-in catalog, but its model listing has a
    // newer default. Recovery must settle that catalog just as a successful replacement does.
    listedModels = NEWER_MODELS;
    try {
      await expect(session.setSandbox('read-only')).rejects.toThrow('could not resume');
      await session.setModel(null);
      expect(fake(2).paramsOf('session/set_config_option').at(-1)).toEqual({
        sessionId: 'grok-1',
        configId: 'model',
        value: 'grok-newer',
      });
      expect(last(events, 'models')?.models).toEqual([
        { id: 'grok-newer', label: 'Grok Newer', efforts: [], default: true },
      ]);
    } finally {
      await session.close();
    }
  });
});

describe('resuming and history', () => {
  it('loads the session, replays its history and then reports replay-finished', async () => {
    replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply' } },
    ];
    const { session, events } = await open((onEvent) =>
      provider.resume({ cwd: '/work', sessionId: 's9', sandbox: 'read-only' }, onEvent),
    );
    expect(session.id).toBe('s9');
    expect(fake().args[2]).toBe('read-only');
    expect(fake().paramsOf('session/load')[0]).toEqual({
      cwd: '/work',
      mcpServers: [],
      _meta: { askUserQuestion: true, autoMode: true },
      sessionId: 's9',
    });
    expect(
      events.map((event) =>
        event.type === 'message-delta' ? `${event.role}: ${event.text}` : event.type,
      ),
    ).toEqual(['user: Earlier', 'agent: Reply', 'replay-finished', 'mode', 'settings', 'models']);
  });

  it('reads a session’s history from a read-only process, with the title Grok lists for it, which its replay leaves out', async () => {
    replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply' } },
    ];
    pages = [
      {
        sessions: [{ sessionId: 'other', cwd: '/work', title: 'Another', updatedAt: null }],
        nextCursor: '1',
      },
      { sessions: [{ sessionId: 's9', cwd: '/work', title: 'Grok’s own', updatedAt: null }] },
    ];
    const events = await provider.history('s9', '/work');
    expect(
      events.map((event) =>
        event.type === 'message-delta' ? `${event.role}: ${event.text}` : event.type,
      ),
    ).toEqual(['user: Earlier', 'agent: Reply', 'title']);
    expect(events.at(-1)).toEqual({ type: 'title', title: 'Grok’s own' });
    expect(fake().args[2]).toBe('read-only');
    expect(fake().methods()).toEqual([
      'initialize',
      'session/load',
      'session/list',
      'session/list',
    ]);
    // A session Grok lists without a title, or does not list, has none in its history.
    pages = [{ sessions: [{ sessionId: 's9', cwd: '/work', updatedAt: null }] }];
    expect((await provider.history('s9', '/work')).some((event) => event.type === 'title')).toBe(
      false,
    );
  });

  it('lists the folder’s sessions newest first, page by page, from a read-only process', async () => {
    pages = [
      {
        sessions: [
          { sessionId: 'a', cwd: '/work', title: 'First', updatedAt: '2026-10-27T07:00:00Z' },
          { sessionId: 'b', cwd: '/work', updatedAt: '2026-10-27T09:00:00.123456+00:00' },
        ],
        nextCursor: '1',
      },
      { sessions: [{ sessionId: 'c', cwd: '/work', title: 'Third', updatedAt: null }] },
    ];
    expect(await provider.listSessions('/work', 2)).toEqual([
      { id: 'b', title: '', cwd: '/work', updatedAt: Date.parse('2026-10-27T09:00:00.123Z') },
      { id: 'a', title: 'First', cwd: '/work', updatedAt: Date.parse('2026-10-27T07:00:00Z') },
    ]);
    expect(fake().args[2]).toBe('read-only');
    expect(fake().paramsOf('session/list')).toEqual([
      { cwd: '/work' },
      { cwd: '/work', cursor: '1' },
    ]);
    expect(fake().stopped).toBe(true);
  });

  it('lists the models Grok settles on, without creating a session or waiting for the process to exit', async () => {
    slowExit = true;
    const models = await provider.listModels(null);
    expect(models.map((model) => model.id)).toEqual(['grok-default', 'grok-small']);
    expect(fake().methods()).toEqual(['initialize', '_x.ai/models/list']);
    expect(fake().stopped).toBe(true);
  });

  it('lists the catalog of Grok’s first fetch, not the built-in models initialize gives before it', async () => {
    listedModels = NEWER_MODELS;
    const models = await provider.listModels(null);
    expect(models).toEqual([{ id: 'grok-newer', label: 'Grok Newer', efforts: [], default: true }]);
  });

  it('lists the models initialize gives when Grok has no call for its catalog', async () => {
    noModelsList = true;
    const models = await provider.listModels(null);
    expect(models.map((model) => model.id)).toEqual(['grok-default', 'grok-small']);
  });

  it('gives a session the catalog Grok settles on, then the catalog Grok announces', async () => {
    listedModels = NEWER_MODELS;
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    expect(last(events, 'models')?.models.map((model) => model.id)).toEqual(['grok-newer']);
    await fake().notify('_x.ai/models/update', {
      currentModelId: 'grok-newest',
      availableModels: [{ modelId: 'grok-newest', name: 'Grok Newest', _meta: {} }],
    });
    await until((all) => last(all, 'models')?.models[0]?.id === 'grok-newest');
    expect(last(events, 'models')?.models).toEqual([
      { id: 'grok-newest', label: 'Grok Newest', efforts: [], default: true },
    ]);
    await session.close();
  });
});

describe('titles', () => {
  it('writes a title in a session of a read-only process with the model and effort given, and deletes the session', async () => {
    const writing = provider.writeTitle?.({
      gateway: null,
      model: 'grok-code',
      effort: 'low',
      prompt: 'Title this: …',
    });
    await vi.waitFor(() => {
      expect(fakes).toHaveLength(1);
    });
    const grok = fake();
    await grok.prompted();
    expect(grok.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(grok.paramsOf('session/new')[0]).toMatchObject({ cwd: grok.cwd, mcpServers: [] });
    expect(grok.paramsOf('session/set_config_option')).toEqual([
      { sessionId: 'grok-1', configId: 'model', value: 'grok-code' },
      { sessionId: 'grok-1', configId: 'reasoning_effort', value: 'low' },
    ]);
    expect(grok.paramsOf('session/prompt')[0]).toEqual({
      sessionId: 'grok-1',
      prompt: [{ type: 'text', text: 'Title this: …' }],
    });
    await grok.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Fix ' },
    });
    await grok.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'the build' },
    });
    grok.endPrompt('end_turn');
    expect(await writing).toBe('Fix the build');
    expect(grok.paramsOf('_x.ai/session/delete')).toEqual([{ sessionId: 'grok-1' }]);
  });

  it('cancels and fails a title whose agent starts a tool, and still deletes the session', async () => {
    const writing = provider.writeTitle?.({
      gateway: null,
      model: null,
      effort: null,
      prompt: 'x',
    });
    await vi.waitFor(() => {
      expect(fakes).toHaveLength(1);
    });
    const grok = fake();
    await grok.prompted();
    expect(grok.paramsOf('session/set_config_option')).toEqual([]);
    await grok.update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
    });
    await expect(writing).rejects.toThrow('started a tool');
    expect(grok.methods()).toContain('session/cancel');
    expect(grok.paramsOf('_x.ai/session/delete')).toEqual([{ sessionId: 'grok-1' }]);
  });

  it('gives a session a title in Grok’s history, and reports it', async () => {
    const { session, events } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await session.setTitle?.('Build fixes');
    expect(fake().paramsOf('_x.ai/session/rename')).toEqual([
      { sessionId: 'grok-1', title: 'Build fixes' },
    ]);
    expect(events).toContainEqual({ type: 'title', title: 'Build fixes' });
  });
});

describe('the session’s end', () => {
  it('closes with the process, mid-turn too, and reports closed once', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    await session.close();
    await until(has('closed'));
    expect(fake().stopped).toBe(true);
    expect(events.filter((event) => event.type === 'closed')).toEqual([{ type: 'closed' }]);
    expect(events.some((event) => event.type === 'turn-ended')).toBe(false);
    await expect(session.send('Again')).rejects.toThrow('closed');
  });

  it('reports the process’s end, and cancels what still waits', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Go');
    void fake()
      .request(permission('make'))
      .catch(() => undefined);
    await until(has('approval-requested'));
    fake().crash('Grok Build stopped unexpectedly (exit code 1).');
    await until(has('closed'));
    expect(last(events, 'request-resolved')).toMatchObject({ outcome: 'cancelled' });
    expect(last(events, 'closed')).toEqual({
      type: 'closed',
      error: 'Grok Build stopped unexpectedly (exit code 1).',
    });
    expect(events.some((event) => event.type === 'turn-ended')).toBe(false);
  });
});

describe('Grok Build’s account through the adapter', () => {
  it('asks a running session’s process, or else a short-lived one, and passes on a prompt refused for want of a sign-in', async () => {
    // A provider of its own, which no other test's sessions run on.
    const grok = createGrokBuildProvider({
      startGrok: (cwd, args) => {
        const started = new FakeGrok(cwd, args);
        fakes.push(started);
        return Promise.resolve(started.process);
      },
    });
    const news: AccountNews[] = [];
    const stop = grok.onAccountNews((heard) => {
      news.push(heard);
    });
    expect(await grok.readAccount(true)).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
      usage: {
        windows: [{ span: 'week', used: 12, resetsAt: Date.parse('2026-11-09T00:00:00Z') }],
      },
    });
    expect(fakes).toHaveLength(1);
    expect(fake(0).cwd).toContain('grok-account-');
    const { session, until } = await open((onEvent) => grok.start({ cwd: '/work' }, onEvent));
    await grok.readAccount(false);
    expect(fakes).toHaveLength(2);
    expect(fake(1).paramsOf('_x.ai/auth/info')).toHaveLength(1);
    await session.send('Hello');
    // Grok refuses the prompt once it has it.
    for (
      let attempt = 0;
      attempt < 200 && fake(1).paramsOf('session/prompt').length === 0;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    fake(1).refuseSignIn();
    await until((events) => events.some((event) => event.type === 'turn-ended'));
    expect(news).toEqual([{ type: 'signed-out' }]);
    stop();
    await expect(grok.signInCommand()).rejects.toThrow('no binary of its own');
  });
});

describe('closing', () => {
  it('waits for its short-lived processes to exit as it closes, and starts no more', async () => {
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const grok = createGrokBuildProvider({
      startGrok: (cwd, args) => {
        const started = new FakeGrok(cwd, args);
        fakes.push(started);
        // A process that exits only once the test lets it, as Grok takes its time to.
        return Promise.resolve({
          stream: started.process.stream,
          ended: exited.then(() => undefined),
          stop: async () => {
            await started.process.stop();
            await exited;
          },
        });
      },
    });
    // The answer comes before the process has exited.
    expect((await grok.readAccount(false)).signIn.state).toBe('signed-in');
    expect(fake(0).stopped).toBe(true);
    let closed = false;
    const closing = grok.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    exit();
    await closing;
    await expect(grok.listModels(null)).rejects.toThrow('closed');
    expect(fakes).toHaveLength(1);
  });

  it('stops a short-lived process that starts as it closes, before Grok is asked anything', async () => {
    // The process starts once the test lets it, as the binary is unpacked first.
    const starting: { start?: () => void } = {};
    const grok = createGrokBuildProvider({
      startGrok: (cwd, args) =>
        new Promise((resolve) => {
          starting.start = () => {
            const started = new FakeGrok(cwd, args);
            fakes.push(started);
            resolve(started.process);
          };
        }),
    });
    const reading = grok.readAccount(false);
    for (let attempt = 0; attempt < 200 && starting.start === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const closing = grok.close();
    starting.start?.();
    await expect(reading).rejects.toThrow('closed');
    await closing;
    expect(fake(0).stopped).toBe(true);
    expect(fake(0).methods()).toEqual([]);
  });
});
