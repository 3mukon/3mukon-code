import {
  agent,
  RequestError,
  type AgentConnection,
  type AnyMessage,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
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
import type { ProviderInstall } from '../../../installs/main/install';
import type { ProviderSession, ToolsetAccess } from '../../../sessions/main/provider';
import type { SessionEvent } from '../../../sessions/shared/events';
import { createAntigravityProvider, launchEnv } from './adapter';
import type { AgyProcess } from './process';

type Params = Record<string, unknown>;

// Each model's thinking levels, as Antigravity 1.5.18 lists them for an account.
const HYDROGEN = ['low', 'medium', 'high', 'xhigh'];
const FLASH = ['low', 'medium', 'high'];
const LEVELS: Record<string, string[]> = {
  'gemini-4-hydrogen': HYDROGEN,
  'gemini-3.8-flash': FLASH,
  'claude-sonnet-4-6': [],
};

function configOptions(model: string, effort: string): SessionConfigOption[] {
  const levels = LEVELS[model] ?? [];
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      ],
    },
    ...(levels.length === 0
      ? []
      : [
          {
            id: 'thought_level',
            name: 'Thinking Level',
            category: 'thought_level' as const,
            type: 'select' as const,
            currentValue: effort,
            options: levels.map((value) => ({ value, name: value })),
          },
        ]),
  ];
}

// ACP's list of models, which names each model's thinking-level variants.
const LISTED = {
  currentModelId: 'gemini-4-hydrogen-high',
  availableModels: [
    ...HYDROGEN.map((level) => ({ modelId: `gemini-4-hydrogen-${level}` })),
    ...FLASH.map((level) => ({ modelId: `gemini-3.8-flash-${level}` })),
    { modelId: 'claude-sonnet-4-6' },
  ],
};

const OPTIONS: RequestPermissionRequest['options'] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

function permission(
  rawInput: Params,
  kind: 'execute' | 'edit' = 'execute',
): RequestPermissionRequest {
  return {
    sessionId: 'agy-1',
    toolCall: {
      toolCallId: 'call-1',
      kind,
      title: typeof rawInput.CommandLine === 'string' ? rawInput.CommandLine : 'Edit',
      rawInput,
      ...(kind === 'edit' ? { locations: [{ path: '/work/a.md' }] } : {}),
    },
    options: OPTIONS,
  };
}

// As Antigravity's question tool asks one.
const FORM: CreateElicitationRequest = {
  sessionId: 'agy-1',
  toolCallId: 'ask',
  mode: 'form',
  message: 'The agent has a question.',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        type: 'string',
        title: 'Red or blue?',
        oneOf: [
          { const: '1', title: 'red' },
          { const: '2', title: 'blue' },
        ],
      },
      q1_other: { type: 'string', title: 'Other' },
    },
  },
};

// What the fake Antigravity does; a test can change it.
let replay: SessionUpdate[];
let pages: ListSessionsResponse[];
let autoOffered: boolean;
let signedIn: boolean;
let tier: Params | undefined;
// Processes without the terminal sandbox cannot resume a session.
let failResumeInYolo: boolean;
let fakes: FakeAgy[];

beforeEach(() => {
  replay = [];
  pages = [];
  autoOffered = false;
  signedIn = true;
  tier = { name: 'Antigravity Starter Quota', id: 'free-tier' };
  failResumeInYolo = false;
  fakes = [];
});

function memoryStreams(): [Stream, Stream] {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  return [
    { readable: toClient.readable, writable: toAgent.writable },
    { readable: toAgent.readable, writable: toClient.writable },
  ];
}

// Stands in for one `agy acp` process, on the ACP SDK's own agent side. A prompt sent while another
// waits steers its turn, as Antigravity's does: the waiting one is answered at once.
class FakeAgy {
  readonly calls: { method: string; params: Params }[] = [];
  readonly process: AgyProcess;
  stopped = false;
  private readonly connection: AgentConnection;
  private prompts: ((stopReason: StopReason) => void)[] = [];
  private failPrompt: ((error: RequestError) => void) | null = null;
  private model = 'gemini-4-hydrogen';
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
    const modes = () => ({
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'plan', name: 'Plan' },
        ...(autoOffered ? [{ id: 'auto', name: 'Auto' }] : []),
      ],
    });
    const options = () => configOptions(this.model, this.effort);
    this.connection = agent()
      .onRequest('initialize', ({ params }) => {
        record('initialize', params);
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, embeddedContext: true },
            mcpCapabilities: { http: this.args.includes('--process-per-session') },
          },
          authMethods: [],
        };
      })
      .onRequest('session/new', ({ params }) => {
        record('session/new', params);
        return { sessionId: 'agy-1', configOptions: options(), modes: modes(), models: LISTED };
      })
      .onRequest('session/load', async ({ params, client }) => {
        record('session/load', params);
        for (const update of replay) {
          await client.notify('session/update', { sessionId: params.sessionId, update });
        }
        return { configOptions: options(), modes: modes(), models: LISTED };
      })
      .onRequest('session/resume', ({ params }) => {
        record('session/resume', params);
        if (failResumeInYolo && this.args.includes('--dangerously-skip-permissions')) {
          throw new RequestError(-32000, 'Antigravity could not resume the session.');
        }
        return { configOptions: options(), modes: modes() };
      })
      .onRequest('session/set_mode', ({ params }) => {
        record('session/set_mode', params);
        if (!modes().availableModes.some((mode) => mode.id === params.modeId)) {
          throw new RequestError(-32602, 'Auto mode is not available');
        }
        return {};
      })
      .onRequest('session/set_config_option', ({ params }) => {
        record('session/set_config_option', params);
        if (params.configId === 'model') {
          this.model = String(params.value);
          if (!(LEVELS[this.model] ?? []).includes(this.effort)) this.effort = 'high';
        } else {
          this.effort = String(params.value);
        }
        return { configOptions: options() };
      })
      .onRequest('session/prompt', ({ params }) => {
        record('session/prompt', params);
        // A prompt during a turn steers it: the one waiting is answered at once.
        for (const steered of this.prompts.splice(0)) steered('end_turn');
        return new Promise((resolve, reject) => {
          this.prompts.push((stopReason) => {
            resolve({ stopReason });
          });
          this.failPrompt = reject;
        });
      })
      .onNotification('session/cancel', ({ params }) => {
        record('session/cancel', params);
        this.endPrompt('cancelled');
      })
      .onRequest('session/list', ({ params }) => {
        record('session/list', params);
        if (!signedIn) throw new RequestError(-32000, 'Authentication required');
        return pages[params.cursor == null ? 0 : Number(params.cursor)] ?? { sessions: [] };
      })
      .onRequest('session/close', ({ params }) => {
        record('session/close', params);
        return {};
      })
      .onRequest('authenticate', ({ params }) => {
        record('authenticate', params);
        return tier === undefined ? {} : { _meta: { antigravity: { tier } } };
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
        return Promise.resolve();
      },
    };
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  paramsOf(method: string): Params[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  async update(update: SessionUpdate, sessionId = 'agy-1'): Promise<void> {
    await this.connection.client.notify('session/update', { sessionId, update });
  }

  // Resolves once as many prompts as given have reached the fake.
  async prompted(count = 1): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this.paramsOf('session/prompt').length >= count && this.prompts.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('No prompt reached Antigravity.');
  }

  endPrompt(stopReason: StopReason): void {
    for (const prompt of this.prompts.splice(0)) prompt(stopReason);
  }

  refuseSignIn(): void {
    this.failPrompt?.(new RequestError(-32000, 'Authentication required'));
    this.prompts = [];
  }

  request(
    params: RequestPermissionRequest,
    cancellationSignal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.connection.client.request('session/request_permission', params, {
      ...(cancellationSignal === undefined ? {} : { cancellationSignal }),
    });
  }

  ask(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    return this.connection.client.request('elicitation/create', params);
  }

  crash(reason: string): void {
    this.connection.close();
    this.end(reason);
  }
}

const provider = createAntigravityProvider({
  startAgy: (cwd, args) => {
    const fake = new FakeAgy(cwd, args);
    fakes.push(fake);
    return Promise.resolve(fake.process);
  },
});

function fake(index = 0): FakeAgy {
  const found = fakes[index];
  if (found === undefined) throw new Error(`No Antigravity process ${String(index)} started.`);
  return found;
}

type Until = (predicate: (events: SessionEvent[]) => boolean) => Promise<void>;

async function open(
  start: (onEvent: (event: SessionEvent) => void) => Promise<ProviderSession>,
): Promise<{ session: ProviderSession; events: SessionEvent[]; until: Until }> {
  const events: SessionEvent[] = [];
  const session = await start((event) => {
    events.push(event);
  });
  const until: Until = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate(events)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out; the events were ${JSON.stringify(events)}`);
  };
  return { session, events, until };
}

function toolset(tools: string[] = ['panel_list']) {
  const accesses: ToolsetAccess[] = [];
  return {
    accesses,
    bound: {
      name: '3mukon-code',
      callTimeoutMs: 86_400_000,
      open() {
        const access = {
          url: 'http://127.0.0.1:4000/mcp',
          credential: `synthetic-${String(accesses.length)}`,
          tools,
          close: vi.fn(),
          availability: vi.fn(),
        };
        accesses.push(access);
        return access;
      },
    },
  };
}

describe('a session', () => {
  it('runs in a process of its own with the toolset over HTTP, at its level’s sandbox, and reports its settings and models', async () => {
    const { bound } = toolset();
    const { events } = await open((onEvent) =>
      provider.start({ cwd: '/work', toolset: bound }, onEvent),
    );
    expect(fake().args).toEqual(['acp', '--process-per-session', '--sandbox']);
    expect(fake().paramsOf('session/new')[0]?.mcpServers).toEqual([
      {
        type: 'http',
        name: '3mukon-code',
        url: 'http://127.0.0.1:4000/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-0' }],
      },
    ]);
    expect(events).toContainEqual({ type: 'mode', mode: 'auto' });
    expect(events).toContainEqual({
      type: 'settings',
      gateway: null,
      model: 'gemini-4-hydrogen',
      effort: 'high',
      sandbox: 'workspace-write',
    });
    expect(events).toContainEqual({
      type: 'models',
      models: [
        {
          id: 'gemini-4-hydrogen',
          label: 'Gemini 4 Hydrogen',
          efforts: ['low', 'medium', 'high', 'xhigh'],
          default: true,
          defaultEffort: 'high',
        },
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
      ],
    });
    // Without auto mode on the account, Antigravity's default mode runs, which needs no switch.
    expect(fake().methods()).not.toContain('session/set_mode');
  });

  it.each([
    ['auto', ['acp', '--process-per-session', '--sandbox'], ['auto'], 'workspace-write'],
    ['yolo', ['acp', '--process-per-session', '--dangerously-skip-permissions'], [], 'full-access'],
  ] as const)(
    'in %s, runs a process of its own with Antigravity’s mode behind it, at the level the mode counts as, whatever level was asked for (ADR-0043)',
    async (mode, args, switched, level) => {
      autoOffered = true;
      const { events } = await open((onEvent) =>
        provider.start({ cwd: '/work', sandbox: 'read-only', mode }, onEvent),
      );
      expect(fake().args).toEqual(args);
      expect(
        fake()
          .paramsOf('session/set_mode')
          .map((params) => params.modeId),
      ).toEqual(switched);
      expect(events).toContainEqual(expect.objectContaining({ type: 'settings', sandbox: level }));
    },
  );

  it('applies the chosen model and thinking level, and leaves a level the model does not take to Antigravity', async () => {
    await open((onEvent) =>
      provider.start({ cwd: '/work', model: 'gemini-3.8-flash', effort: 'low' }, onEvent),
    );
    expect(fake().paramsOf('session/set_config_option')).toEqual([
      { sessionId: 'agy-1', configId: 'model', value: 'gemini-3.8-flash' },
      { sessionId: 'agy-1', configId: 'thought_level', value: 'low' },
    ]);
    await open((onEvent) =>
      provider.start({ cwd: '/work', model: 'gemini-3.8-flash', effort: 'xhigh' }, onEvent),
    );
    expect(fake(1).paramsOf('session/set_config_option')).toEqual([
      { sessionId: 'agy-1', configId: 'model', value: 'gemini-3.8-flash' },
    ]);
  });

  it('sends a message as a prompt with its images, and ends the turn with the prompt’s answer', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Make search faster', [{ mediaType: 'image/png', data: 'aGk=' }]);
    await fake().prompted();
    expect(fake().paramsOf('session/prompt')[0]?.prompt).toEqual([
      { type: 'text', text: 'Make search faster' },
      { type: 'image', mimeType: 'image/png', data: 'aGk=' },
    ]);
    expect(events).toContainEqual({ type: 'turn-started' });
    fake().endPrompt('end_turn');
    await until((seen) => seen.some((event) => event.type === 'turn-ended'));
    expect(events.filter((event) => event.type === 'turn-ended')).toEqual([
      { type: 'turn-ended', outcome: 'completed' },
    ]);
  });

  it('steers the running turn with a message sent during it, and ends the turn once, with its last prompt’s answer', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Run the tests');
    await fake().prompted();
    await session.send('Also end your reply with STEERED');
    await fake().prompted(2);
    // Antigravity answered the first prompt as the second took over; the turn goes on.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    expect(events.some((event) => event.type === 'turn-ended')).toBe(false);
    fake().endPrompt('end_turn');
    await until((seen) => seen.some((event) => event.type === 'turn-ended'));
    expect(events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
  });

  it('delivers new messages’ notices alone in a turn of the app’s, taken once Antigravity’s first output comes, so that they show before it', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    const notice = { id: 'n1', from: 'child', fromTitle: 'Tests', summary: 'Done', sentAt: 1 };
    const delivery = { accepted: vi.fn(), failed: vi.fn() };
    await session.deliverContext?.({ presentationNotices: [], inboxNotices: [notice] }, delivery);
    await fake().prompted();
    expect(fake().paramsOf('session/prompt')[0]?.prompt).toEqual([
      expect.objectContaining({ type: 'resource' }),
    ]);
    expect(events.some((event) => event.type === 'message')).toBe(false);
    // Neither a title nor any other update that is not the agent's output takes it.
    await fake().update({ sessionUpdate: 'session_info_update', title: 'Tests' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(delivery.accepted).not.toHaveBeenCalled();
    await fake().update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Reading it' },
    });
    await until(() => delivery.accepted.mock.calls.length === 1);
    expect(events.some((event) => event.type === 'turn-ended')).toBe(false);
    fake().endPrompt('end_turn');
    await until((seen) => seen.some((event) => event.type === 'turn-ended'));
    expect(delivery.accepted).toHaveBeenCalledOnce();
    expect(delivery.failed).not.toHaveBeenCalled();
  });

  it('interrupts with session/cancel, and what is still open ends as cancelled', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Run something long');
    await fake().prompted();
    const answered = fake().request(permission({ CommandLine: 'sleep 20' }));
    await until((seen) => seen.some((event) => event.type === 'approval-requested'));
    await session.interrupt();
    await expect(answered).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await until((seen) => seen.some((event) => event.type === 'turn-ended'));
    expect(fake().methods()).toContain('session/cancel');
    expect(events).toContainEqual({ type: 'turn-ended', outcome: 'interrupted' });
  });

  it('passes on a turn refused for want of a sign-in', async () => {
    const news: AccountNews[] = [];
    const stop = provider.onAccountNews((item) => news.push(item));
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Hello');
    await fake().prompted();
    fake().refuseSignIn();
    await until((seen) => seen.some((event) => event.type === 'turn-ended'));
    expect(news).toEqual([{ type: 'signed-out' }]);
    expect(events).toContainEqual({
      type: 'turn-ended',
      outcome: 'failed',
      error: 'Authentication required',
    });
    stop();
  });

  it('ends when its process ends', async () => {
    const { events, until } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    fake().crash('Antigravity stopped unexpectedly (exit code 1).');
    await until((seen) => seen.some((event) => event.type === 'closed'));
    expect(events).toContainEqual({
      type: 'closed',
      error: 'Antigravity stopped unexpectedly (exit code 1).',
    });
  });
});

describe('approvals and questions', () => {
  it('asks the user in auto, with the answers Antigravity offers', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    const answered = fake().request(permission({ CommandLine: 'echo probe-123' }));
    await until((seen) => seen.some((event) => event.type === 'approval-requested'));
    const asked = events.find((event) => event.type === 'approval-requested');
    if (asked?.type !== 'approval-requested') throw new Error('No approval was asked.');
    expect(asked.request).toMatchObject({
      action: 'command',
      command: 'echo probe-123',
      denyByDefault: false,
    });
    await session.answerApproval(asked.request.id, { decision: 'allow-once' });
    await expect(answered).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  });

  it('in yolo allows any request that still comes, a command outside the sandbox and an edit too (ADR-0043)', async () => {
    const { events } = await open((onEvent) =>
      provider.start({ cwd: '/work', mode: 'yolo' }, onEvent),
    );
    await expect(
      fake().request(permission({ CommandLine: 'npm install', BypassSandbox: true })),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await expect(fake().request(permission({}, 'edit'))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(events.some((event) => event.type === 'approval-requested')).toBe(false);
  });

  it('in auto asks an edit, and a command outside the sandbox with denial preselected', async () => {
    const { events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work', sandbox: 'read-only' }, onEvent),
    );
    void fake().request(permission({}, 'edit'));
    void fake().request(permission({ CommandLine: 'npm i', BypassSandbox: true }));
    await until((seen) => seen.filter((event) => event.type === 'approval-requested').length === 2);
    const asked = events.filter((event) => event.type === 'approval-requested');
    expect(asked[0]).toMatchObject({ request: { action: 'edit', denyByDefault: false } });
    expect(asked[1]).toMatchObject({
      request: { action: 'command', command: 'npm i', denyByDefault: true },
    });
  });

  it('allows the approvals waiting as the session enters yolo, and those that come before its process moves', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    await session.send('Install it', []);
    await fake().prompted();
    const waiting = fake().request(permission({ CommandLine: 'npm i', BypassSandbox: true }));
    await until((seen) => seen.some((event) => event.type === 'approval-requested'));
    await session.setMode('yolo');
    await expect(waiting).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await expect(fake().request(permission({ CommandLine: 'npm test' }))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    // The turn still runs in the process it started in; the move waits for its end.
    expect(fakes).toHaveLength(1);
    expect(events.filter((event) => event.type === 'approval-requested')).toHaveLength(1);
  });

  it('allows a call of the app’s own tools without asking, since the broker authorizes it', async () => {
    const { bound } = toolset();
    const { events } = await open((onEvent) =>
      provider.start({ cwd: '/work', toolset: bound }, onEvent),
    );
    await expect(
      fake().request({
        sessionId: 'agy-1',
        toolCall: {
          toolCallId: 'entry',
          kind: 'other',
          title: 'Run mcp_3mukon-code_panel_list',
          ...{ name: 'mcp_3mukon-code_panel_list' },
        },
        options: OPTIONS,
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(events.some((event) => event.type === 'approval-requested')).toBe(false);
  });

  it('asks a form’s questions, and answers with the choices’ values or declines', async () => {
    const { session, events, until } = await open((onEvent) =>
      provider.start({ cwd: '/work' }, onEvent),
    );
    const first = fake().ask(FORM);
    await until((seen) => seen.some((event) => event.type === 'question-asked'));
    const asked = events.find((event) => event.type === 'question-asked');
    if (asked?.type !== 'question-asked') throw new Error('No question was asked.');
    expect(asked.request.questions[0]).toMatchObject({
      id: 'q1',
      text: 'Red or blue?',
      options: [{ label: 'red' }, { label: 'blue' }],
      freeText: true,
    });
    await session.answerQuestion(asked.request.id, {
      decision: 'answer',
      answers: { q1: { selected: ['blue'] } },
    });
    await expect(first).resolves.toEqual({ action: 'accept', content: { q1: '2' } });
    const second = fake().ask(FORM);
    await until((seen) => seen.filter((event) => event.type === 'question-asked').length === 2);
    const again = events.filter((event) => event.type === 'question-asked')[1];
    if (again?.type !== 'question-asked') throw new Error('No second question was asked.');
    await session.answerQuestion(again.request.id, { decision: 'decline' });
    await expect(second).resolves.toEqual({ action: 'decline' });
  });
});

describe('mode switches', () => {
  it('moves to a new process to switch between auto and yolo, which resumes the session, and takes no sandbox level (ADR-0043)', async () => {
    autoOffered = true;
    const { session, events } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await session.setMode('yolo');
    expect(fakes).toHaveLength(2);
    expect(fake(0).stopped).toBe(true);
    expect(fake(1).args).toEqual([
      'acp',
      '--process-per-session',
      '--dangerously-skip-permissions',
    ]);
    expect(fake(1).paramsOf('session/resume')[0]).toMatchObject({ sessionId: 'agy-1' });
    expect(fake(1).paramsOf('session/set_mode')).toEqual([]);
    expect(events.filter((event) => event.type === 'settings').at(-1)).toEqual({
      type: 'settings',
      sandbox: 'full-access',
    });
    await session.setMode('auto');
    expect(fakes).toHaveLength(3);
    expect(fake(2).args).toEqual(['acp', '--process-per-session', '--sandbox']);
    expect(
      fake(2)
        .paramsOf('session/set_mode')
        .map((params) => params.modeId),
    ).toEqual(['auto']);
    await expect(session.setSandbox('read-only')).rejects.toThrow('takes no sandbox level');
    expect(fakes).toHaveLength(3);
  });

  it('moves once the turn ends when asked for during one', async () => {
    const { session, until } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await session.send('Go on', []);
    await fake().prompted();
    await session.setMode('yolo');
    expect(fakes).toHaveLength(1);
    fake().endPrompt('end_turn');
    await until(() => fakes.length === 2 && fake(1).methods().includes('session/resume'));
    expect(fake(1).args).toContain('--dangerously-skip-permissions');
  });
});

describe('a failed switch', () => {
  it('goes back to the mode the session’s process served, and keeps every model’s thinking levels', async () => {
    failResumeInYolo = true;
    const { session, events } = await open((onEvent) => provider.start({ cwd: '/work' }, onEvent));
    await expect(session.setMode('yolo')).rejects.toThrow('could not resume');
    // The new process failed; the session runs again in auto, under the sandbox.
    expect(fakes).toHaveLength(3);
    expect(fake(2).args).toContain('--sandbox');
    expect(events.filter((event) => event.type === 'mode').at(-1)).toEqual({
      type: 'mode',
      mode: 'auto',
    });
    expect(events.filter((event) => event.type === 'settings').at(-1)).toEqual({
      type: 'settings',
      sandbox: 'workspace-write',
    });
    const models = events.filter((event) => event.type === 'models').at(-1);
    expect(models).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'gemini-3.8-flash', efforts: ['low', 'medium', 'high'] }),
      ]) as unknown,
    });
  });
});

describe('history and models', () => {
  it('loads a past session’s events, its title last, and lists the folder’s sessions alone', async () => {
    replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      { sessionUpdate: 'session_info_update', title: 'Greeting' },
    ];
    const events = await provider.history('agy-1', '/work');
    expect(events.map((event) => event.type)).toEqual(['message-delta', 'message-delta', 'title']);
    expect(events[0]).toMatchObject({ role: 'user', text: 'Hello' });
    pages = [
      {
        sessions: [
          { sessionId: 'old', cwd: '/work', title: 'Old', updatedAt: '2026-11-25T10:00:00Z' },
          { sessionId: 'elsewhere', cwd: '/other', title: 'X', updatedAt: '2026-11-26T10:00:00Z' },
          { sessionId: 'new', cwd: '/work', title: 'New', updatedAt: '2026-11-26T09:00:00Z' },
        ],
      },
    ];
    expect((await provider.listSessions('/work', 10)).map((entry) => entry.id)).toEqual([
      'new',
      'old',
    ]);
  });

  it('lists the models of a probe’s session, which runs no turn and is closed', async () => {
    const models = await provider.listModels(null);
    expect(models.map((model) => model.id)).toEqual([
      'gemini-4-hydrogen',
      'gemini-3.8-flash',
      'claude-sonnet-4-6',
    ]);
    expect(fake().args).toEqual(['acp']);
    expect(fake().methods()).toEqual(['initialize', 'session/new', 'session/close']);
    await expect(provider.listModels('gateway')).rejects.toThrow('no gateways');
  });
});

describe('the account', () => {
  it('is signed out where Antigravity refuses to list sessions for want of a sign-in', async () => {
    signedIn = false;
    expect(await provider.readAccount(true)).toEqual({ signIn: { state: 'signed-out' } });
  });

  it('holds a subscription where Antigravity reports a tier, whose usage limits it offers no program', async () => {
    expect(await provider.readAccount(true)).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
      usageProblem: 'unoffered',
    });
    expect(fake().paramsOf('authenticate')).toEqual([{ methodId: 'terminal-login' }]);
    expect(await provider.readAccount(false)).toEqual({
      signIn: { state: 'signed-in', method: 'subscription' },
    });
  });

  it('is signed in through another backend where Antigravity reports no tier', async () => {
    tier = undefined;
    expect(await provider.readAccount(true)).toEqual({
      signIn: { state: 'signed-in', method: 'backend' },
    });
  });

  it('signs in with agy acp --login from the binary a sign-in runs', async () => {
    const install: ProviderInstall = {
      provider: 'antigravity',
      current: () => Promise.resolve({ path: '/bin/agy', version: '1.5.18', source: 'user' }),
      prepare: () => Promise.resolve({ path: '/bin/agy', version: '1.5.18', source: 'user' }),
      view: () => Promise.resolve({ runs: null, pinned: '1.5.18' }),
      onChange: () => () => undefined,
    };
    const installed = createAntigravityProvider({ install });
    expect(await installed.signInCommand()).toEqual({ file: '/bin/agy', args: ['acp', '--login'] });
  });

  it('runs the app’s copy with Antigravity’s updater off, and the user’s CLI as the user keeps it', () => {
    expect(launchEnv({ path: '/copy/antigravity', version: '1.5.18', source: 'app' })).toEqual({
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    });
    expect(launchEnv({ path: '/bin/agy', version: '1.5.18', source: 'user' })).toEqual({});
  });
});
