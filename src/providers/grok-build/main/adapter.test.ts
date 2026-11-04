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
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountNews } from '../../../accounts/main/source';
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
let fakes: FakeGrok[];

beforeEach(() => {
  replay = [];
  failNew = undefined;
  failInterject = undefined;
  failResumeAt = undefined;
  pages = [];
  slowExit = false;
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
          agentCapabilities: { loadSession: true },
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
      .onRequest('session/set_mode', ({ params }) => {
        record('session/set_mode', params);
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
      'session/set_mode',
      'session/set_config_option',
      'session/set_config_option',
    ]);
    expect(fake().paramsOf('initialize')[0]).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: '3mukon-code' },
    });
    expect(fake().paramsOf('session/new')[0]).toEqual({
      cwd: '/work',
      mcpServers: [],
      _meta: { askUserQuestion: true },
    });
    expect(fake().paramsOf('session/set_mode')[0]).toMatchObject({ modeId: 'auto' });
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
    expect(fake(0).paramsOf('session/set_mode')[0]).toMatchObject({ modeId: 'bypassPermissions' });
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
    expect(fake().paramsOf('session/set_mode').at(-1)).toMatchObject({
      modeId: 'bypassPermissions',
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
      'session/set_mode',
      'session/set_config_option',
    ]);
    expect(fake(1).paramsOf('session/resume')[0]).toEqual({
      cwd: '/work',
      mcpServers: [],
      _meta: { askUserQuestion: true },
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
    await until(() => fakes.length === 2 && fake(1).methods().includes('session/set_mode'));
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
      _meta: { askUserQuestion: true },
      sessionId: 's9',
    });
    expect(
      events.map((event) =>
        event.type === 'message-delta' ? `${event.role}: ${event.text}` : event.type,
      ),
    ).toEqual(['user: Earlier', 'agent: Reply', 'replay-finished', 'mode', 'settings', 'models']);
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

  it('lists the models as Grok starts, without creating a session or waiting for the process to exit', async () => {
    slowExit = true;
    const models = await provider.listModels(null);
    expect(models.map((model) => model.id)).toEqual(['grok-default', 'grok-small']);
    expect(fake().methods()).toEqual(['initialize']);
    expect(fake().stopped).toBe(true);
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
