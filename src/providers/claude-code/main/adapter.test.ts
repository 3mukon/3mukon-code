import type { ChildProcess } from 'node:child_process';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderInstall } from '../../../installs/main/install';
import type { ToolsetAccess } from '../../../sessions/main/provider';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Availability } from '../../../sessions/shared/automation';
import type { SandboxLevel, SessionEvent } from '../../../sessions/shared/events';
import { createClaudeCodeProvider } from './adapter';
import { sandboxSettings } from './sandbox';

// The app's copy of Claude Code that the adapter runs, which the SDK's fake never starts.
const binary = { path: '/test/claude', version: '2.1.330', source: 'app' } as const;
const install: ProviderInstall = {
  provider: 'claude-code',
  current: () => Promise.resolve(binary),
  prepare: () => Promise.resolve(binary),
  view: () => Promise.resolve({ runs: { source: 'app', version: '2.1.330' }, pinned: '2.1.330' }),
  onChange: () => () => undefined,
};

interface QueryParams {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}

// Stands in for Claude Code: each query is a fake process that the test feeds with messages, and that
// records the messages the session sends it.
const fakes = vi.hoisted(() => {
  class FakeQuery implements AsyncIterable<unknown> {
    readonly inputs: unknown[] = [];
    readonly setModel = vi.fn(() => Promise.resolve());
    readonly applyFlagSettings = vi.fn(() => Promise.resolve());
    readonly setPermissionMode = vi.fn(() => Promise.resolve());
    readonly interrupt = vi.fn(() => Promise.resolve());
    readonly mcpServerStatus = vi.fn(() =>
      Promise.resolve([{ name: '3mukon-code', status: 'connected' }]),
    );
    // Claude Code's own count of the context, which names the model a session uses.
    readonly getContextUsage = vi.fn(() =>
      stalled.has('getContextUsage')
        ? new Promise<typeof usage>(() => undefined)
        : Promise.resolve({ ...usage }),
    );
    closed = false;
    // The process that the app's own spawn starts, where the app gives one, as the SDK starts it: a
    // real one, which reads its input until the input ends and then takes a moment to exit, as Claude
    // Code does.
    readonly child: ChildProcess | undefined;
    private readonly messages: unknown[] = [];
    private wake: (() => void) | null = null;

    constructor(readonly params: QueryParams) {
      const spawnProcess = params.options.spawnClaudeCodeProcess as
        | ((options: {
            command: string;
            args: string[];
            env: NodeJS.ProcessEnv;
            signal: AbortSignal;
          }) => ChildProcess)
        | undefined;
      this.child = spawnProcess?.({
        command: '/bin/sh',
        args: ['-c', 'cat > /dev/null; sleep 0.2'],
        env: process.env,
        signal: new AbortController().signal,
      });
      void (async () => {
        for await (const message of params.prompt) this.inputs.push(message);
      })();
    }

    initializationResult() {
      if (stalled.has('initializationResult')) return new Promise<never>(() => undefined);
      return Promise.resolve({
        models: [
          {
            value: 'default',
            displayName: 'Default (recommended)',
            description: 'Opus · Most capable',
            supportedEffortLevels: ['low', 'high'],
          },
          {
            value: 'opus',
            resolvedModel: 'claude-opus-5',
            displayName: 'Opus',
            description: 'Most capable',
            supportedEffortLevels: ['low', 'high'],
          },
        ],
      });
    }

    push(message: unknown): void {
      this.messages.push(message);
      this.wake?.();
    }

    close(): void {
      this.closed = true;
      this.child?.stdin?.end();
      this.wake?.();
    }

    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = this.messages.shift();
        if (next !== undefined) {
          yield next;
        } else if (this.closed) {
          return;
        } else {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          this.wake = null;
        }
      }
    }
  }
  // What the fake processes count, which a test may change before they start.
  const usage = { totalTokens: 1200, maxTokens: 200_000, model: 'claude-opus-5' };
  // The calls the fake processes never answer, which a test may choose before they start.
  const stalled = new Set<'initializationResult' | 'getContextUsage'>();
  return { FakeQuery, queries: [] as FakeQuery[], usage, stalled };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((params: QueryParams) => {
    const fake = new fakes.FakeQuery(params);
    fakes.queries.push(fake);
    return fake;
  }),
  getSessionMessages: vi.fn(() => Promise.resolve([])),
  getSessionInfo: vi.fn(() => Promise.resolve({ sessionId: 's', summary: 'Fix the build' })),
  listSessions: vi.fn(() => Promise.resolve([])),
  renameSession: vi.fn(() => Promise.resolve()),
}));

// A new message's notice, as the host gives it.
const inboxNotice = {
  id: 'm1',
  from: 'child',
  fromTitle: 'Write the tests',
  summary: 'Tests written',
  sentAt: 1,
};

const init = { type: 'system', subtype: 'init', permissionMode: 'auto', model: 'claude-opus-5' };
const result = { type: 'result', subtype: 'success', is_error: false, result: 'Done' };
// Claude Code's own default row goes, since the model it stands for is listed.
const opus = {
  id: 'opus',
  label: 'Opus',
  description: 'Most capable',
  efforts: ['low', 'high'],
  default: true,
};

let gatewaysDir: string;
beforeEach(() => {
  fakes.queries.length = 0;
  fakes.usage.model = 'claude-opus-5';
  fakes.stalled.clear();
  gatewaysDir = mkdtempSync(join(tmpdir(), 'gateways-'));
  writeFileSync(join(gatewaysDir, 'work.json'), '{}');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(gatewaysDir, { recursive: true, force: true });
});

// The latest fake process.
function current() {
  const fake = fakes.queries.at(-1);
  if (fake === undefined) throw new Error('No query was started.');
  return fake;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

// The flag settings of a level for the tests' session folder, which does not exist.
function levelSettings(level: SandboxLevel, leavingReadOnly = false) {
  const temporary = [...new Set([realpathSync(tmpdir()), realpathSync('/tmp')])];
  return sandboxSettings(level, { cwd: '/work', temporary }, leavingReadOnly);
}

async function startSession(
  options: { gateway?: string; model?: string; effort?: string; sandbox?: SandboxLevel } = {},
) {
  const events: SessionEvent[] = [];
  const provider = createClaudeCodeProvider({ gatewaysDir, install });
  const session = await provider.start({ cwd: '/work', ...options }, (event) => {
    events.push(event);
  });
  return { session, events };
}

// A session with the toolset bound, and what its adapter told the toolset of its availability.
async function startBound(gateway?: string) {
  const events: SessionEvent[] = [];
  const availability = vi.fn<(value: Availability) => void>();
  const session = await createClaudeCodeProvider({ gatewaysDir, install }).start(
    {
      cwd: '/work',
      ...(gateway === undefined ? {} : { gateway }),
      toolset: {
        name: '3mukon-code',
        callTimeoutMs: 86_400_000,
        open: () => ({
          url: 'http://127.0.0.1:4000/mcp',
          credential: 'synthetic',
          tools: ['panel_list'],
          close: vi.fn(),
          availability,
        }),
      },
    },
    (event) => {
      events.push(event);
    },
  );
  return { session, events, availability };
}

// Plays one turn: the session sends the message, and the fake process answers and ends the turn.
async function playTurn(
  session: { send(text: string): Promise<void> },
  events: SessionEvent[],
  text: string,
  first: Record<string, unknown> = init,
) {
  const ended = events.filter((event) => event.type === 'turn-ended').length;
  await session.send(text);
  current().push(first);
  current().push(result);
  await waitFor(() => events.filter((event) => event.type === 'turn-ended').length > ended);
}

describe('the Claude Code provider', () => {
  it.each(['auto', 'yolo'] as const)(
    'connects the bound tools in %s and waits for the native context receipt',
    async (mode) => {
      const accesses: ToolsetAccess[] = [];
      const resultLink = vi.fn();
      const bound = {
        name: '3mukon-code',
        callTimeoutMs: 86_400_000,
        open() {
          const access = {
            url: 'http://127.0.0.1:4000/mcp',
            credential: `synthetic-${String(accesses.length)}`,
            tools: ['panel_list'],
            close: vi.fn(),
            result: resultLink,
            availability: vi.fn(),
          };
          accesses.push(access);
          return access;
        },
      };
      const events: SessionEvent[] = [];
      const provider = createClaudeCodeProvider({ gatewaysDir, install });
      const session = await provider.start({ cwd: '/work', mode, toolset: bound }, (e) =>
        events.push(e),
      );
      const first = current();
      expect(first.params.options.mcpServers).toEqual({
        '3mukon-code': {
          type: 'http',
          url: accesses[0]?.url,
          headers: { Authorization: 'Bearer synthetic-0' },
          alwaysLoad: true,
          timeout: 86_400_000,
        },
      });
      expect(first.params.options.mcpServersDelivery).toBe('initialize');
      const ask = first.params.options.canUseTool as CanUseTool;
      await expect(
        ask(
          'mcp__3mukon-code__panel_list',
          {},
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-1',
            requestId: 'request-1',
            suggestions: [],
          },
        ),
      ).resolves.toMatchObject({ behavior: 'allow' });
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
      await session.send('Keep this exact text', [], { presentationNotices: [notice] }, delivery);
      await waitFor(() => first.inputs.length === 1);
      expect(delivery.accepted).not.toHaveBeenCalled();
      expect(first.inputs[0]).toMatchObject({
        message: {
          content: [{ type: 'document' }, { type: 'text', text: 'Keep this exact text' }],
        },
      });
      first.push(first.inputs[0]);
      await waitFor(() => delivery.accepted.mock.calls.length === 1);
      const envelope = {
        automation: { schemaVersion: 1, callId: 'receipt' },
        outcome: { status: 'refused', code: 'sandbox-denied' },
        presentationNotices: [],
      };
      first.push({
        type: 'assistant',
        uuid: 'a',
        parent_tool_use_id: null,
        message: {
          id: 'a',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'mcp__3mukon-code__panel_list', input: {} },
          ],
        },
      });
      first.push({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              is_error: true,
              content: [{ type: 'text', text: JSON.stringify(envelope) }],
            },
          ],
        },
      });
      await waitFor(() => resultLink.mock.calls.length === 1);
      expect(resultLink).toHaveBeenCalledWith('panel_list', 'tool-1', envelope.automation);
      first.push(result);
      await waitFor(() => events.some((e) => e.type === 'turn-ended'));
      await session.setGateway('work');
      expect(accesses).toHaveLength(2);
      expect(accesses[0]?.close).toHaveBeenCalled();
      expect(current().params.options.mcpServers).toMatchObject({
        '3mukon-code': { headers: { Authorization: 'Bearer synthetic-1' } },
      });
      await session.close();
      expect(accesses[1]?.close).toHaveBeenCalled();
    },
  );
  it.each([
    ['a Claude model', 'claude-opus-5', undefined, 'supported'],
    ['another model', 'other-model', undefined, 'unknown'],
    ['a gateway, whatever its model’s name', 'claude-opus-5', 'work', 'unknown'],
  ] as const)(
    'tells the toolset whether the model takes images: %s',
    async (_name, model, gateway, images) => {
      fakes.usage.model = model;
      const { availability } = await startBound(gateway);
      expect(availability.mock.calls).toEqual([[{ tools: 'ready', images }]]);
    },
  );

  it('tells the toolset of image input again as a turn starts on another kind of model, and only then', async () => {
    const { session, events, availability } = await startBound();
    await playTurn(session, events, 'hello');
    expect(availability).toHaveBeenCalledOnce();
    const servers = [{ name: '3mukon-code', status: 'connected' }];
    await playTurn(session, events, 'on another model', {
      ...init,
      model: 'other-model',
      mcp_servers: servers,
    });
    expect(availability).toHaveBeenLastCalledWith({ tools: 'ready', images: 'unknown' });
    await playTurn(session, events, 'and back', { ...init, mcp_servers: servers });
    expect(availability).toHaveBeenLastCalledWith({ tools: 'ready', images: 'supported' });
    expect(availability).toHaveBeenCalledTimes(3);
  });

  it('starts a session with the chosen gateway, model and effort, and reports them and the models', async () => {
    const { events } = await startSession({ gateway: 'work', model: 'opus', effort: 'high' });
    expect(current().params.options).toMatchObject({
      // The app's copy, which runs with Claude Code's updater off, since it follows the pin.
      pathToClaudeCodeExecutable: '/test/claude',
      env: { DISABLE_AUTOUPDATER: '1' },
      settings: join(gatewaysDir, 'work.json'),
      model: 'opus',
      effort: 'high',
      // Thinking shows as summaries.
      extraArgs: { 'thinking-display': 'summarized' },
    });
    expect(events).toContainEqual({
      type: 'settings',
      gateway: 'work',
      model: 'opus',
      effort: 'high',
      sandbox: 'workspace-write',
    });
    expect(events).toContainEqual({ type: 'models', models: [opus] });
  });

  it('puts the process on the sandbox level before the first message', async () => {
    const { session, events } = await startSession({ sandbox: 'read-only' });
    expect(current().applyFlagSettings).toHaveBeenCalledExactlyOnceWith(levelSettings('read-only'));
    expect(current().params.options).not.toHaveProperty('sandbox');
    expect(events).toContainEqual(expect.objectContaining({ sandbox: 'read-only' }));
    await playTurn(session, events, 'hello');
    expect(current().applyFlagSettings).toHaveBeenCalledOnce();
  });

  it('refuses a gateway that does not exist and an effort Claude Code does not have', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    const ignore = () => undefined;
    await expect(provider.start({ cwd: '/work', gateway: 'gone' }, ignore)).rejects.toThrow(
      'does not exist',
    );
    await expect(provider.start({ cwd: '/work', effort: 'extreme' }, ignore)).rejects.toThrow(
      'no reasoning effort',
    );
    expect(fakes.queries).toHaveLength(0);
  });

  it('lists gateways, and models from a probe that gets no message, with the model a session uses marked', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    expect(await provider.listGateways()).toEqual(['work']);
    // Through a gateway, the probe reads only the gateway's file.
    expect(await provider.listModels('work')).toEqual([opus]);
    const probe = current();
    expect(probe.params.options).toMatchObject({
      pathToClaudeCodeExecutable: '/test/claude',
      settingSources: [],
      persistSession: false,
      settings: join(gatewaysDir, 'work.json'),
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1' },
    });
    expect(probe.closed).toBe(true);
    expect(probe.inputs).toEqual([]);
    // Otherwise it reads the user's own settings, with their hooks off, and no project's; its auto-memory
    // is off either way, so it leaves no folder in Claude Code's projects folder.
    expect(await provider.listModels(null)).toEqual([opus]);
    expect(current().params.options).toMatchObject({
      settingSources: ['user'],
      settings: { disableAllHooks: true },
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });
  });

  it('keeps Claude Code’s own default row when no other row is the model a session uses', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    fakes.usage.model = 'claude-elsewhere';
    expect((await provider.listModels(null)).map((model) => [model.id, model.default])).toEqual([
      ['default', true],
      ['opus', undefined],
    ]);
  });

  it('closes a probe that has not started within 30 seconds, and fails the list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakes.stalled.add('initializationResult');
    const listing = createClaudeCodeProvider({ gatewaysDir, install }).listModels(null);
    const failed = expect(listing).rejects.toThrow('did not start in time');
    await vi.waitFor(() => {
      expect(fakes.queries).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(current().closed).toBe(true);
  });

  it('keeps Claude Code’s own default row marked when its count of the context takes too long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakes.stalled.add('getContextUsage');
    const listing = createClaudeCodeProvider({ gatewaysDir, install }).listModels(null);
    await vi.waitFor(() => {
      expect(fakes.queries).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await listing).map((model) => [model.id, model.default])).toEqual([
      ['default', true],
      ['opus', undefined],
    ]);
    expect(current().closed).toBe(true);
  });
});

describe('a Claude Code session', () => {
  it('starts without a count of the context when Claude Code takes too long to give one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakes.stalled.add('getContextUsage');
    const events: SessionEvent[] = [];
    const starting = createClaudeCodeProvider({ gatewaysDir, install }).start(
      { cwd: '/work' },
      (event) => {
        events.push(event);
      },
    );
    await vi.waitFor(() => {
      expect(fakes.queries).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    const lists = events.flatMap((event) => (event.type === 'models' ? [event.models] : []));
    expect(lists.map((models) => models.map((model) => [model.id, model.default]))).toEqual([
      [
        ['default', true],
        ['opus', undefined],
      ],
    ]);
    expect(events.some((event) => event.type === 'context')).toBe(false);
  });

  it('reports how much of the context the conversation takes, and the title Claude Code keeps', async () => {
    const { session, events } = await startSession();
    expect(events).toContainEqual({ type: 'context', used: 1200, size: 200_000 });
    current().getContextUsage.mockResolvedValue({
      totalTokens: 4800,
      maxTokens: 200_000,
      model: 'claude-opus-5',
    });
    // Without a title of the user's or of Claude Code's own, Claude Code's summary is the latest
    // prompt, which is not reported, or every message would retitle the session.
    const info = { sessionId: 's', lastModified: 0, firstPrompt: 'Fix the build' };
    const asked = vi.mocked(getSessionInfo).mock.calls.length;
    vi.mocked(getSessionInfo)
      .mockResolvedValueOnce({ ...info, summary: 'Fix the build' })
      .mockResolvedValueOnce({ ...info, summary: 'Again', customTitle: 'Build fixes' })
      .mockResolvedValueOnce({ ...info, summary: 'Once more', customTitle: 'Build fixes' });
    await playTurn(session, events, 'Fix the build');
    await waitFor(() => vi.mocked(getSessionInfo).mock.calls.length === asked + 1);
    expect(events).toContainEqual({ type: 'context', used: 4800, size: 200_000 });
    await playTurn(session, events, 'Again');
    await waitFor(() => events.some((event) => event.type === 'title'));
    // The same title is not reported again.
    await playTurn(session, events, 'Once more');
    await waitFor(() => vi.mocked(getSessionInfo).mock.calls.length === asked + 3);
    await waitFor(() => events.filter((event) => event.type === 'context').length === 4);
    expect(events.filter((event) => event.type === 'title')).toEqual([
      { type: 'title', title: 'Build fixes' },
    ]);
  });

  it('writes a title in a Claude Code of its own that keeps no transcript and runs no tools, with the session’s model and effort', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    const writing = provider.writeTitle?.({
      gateway: 'work',
      model: 'opus',
      effort: 'low',
      prompt: 'Title this: …',
    });
    await vi.waitFor(() => {
      expect(fakes.queries).toHaveLength(1);
    });
    const probe = current();
    expect(probe.params.options).toMatchObject({
      settingSources: [],
      settings: join(gatewaysDir, 'work.json'),
      persistSession: false,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
      model: 'opus',
      effort: 'low',
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });
    expect(probe.params.options.systemPrompt).toEqual(expect.stringContaining('titles'));
    await vi.waitFor(() => {
      expect(probe.inputs).toMatchObject([
        { type: 'user', message: { role: 'user', content: 'Title this: …' } },
      ]);
    });
    probe.push({ ...result, result: 'Fix the build' });
    expect(await writing).toBe('Fix the build');
    expect(probe.closed).toBe(true);
  });

  it('fails a title whose turn ends in an error, on the user’s own settings without a gateway', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    const writing = provider.writeTitle?.({
      gateway: null,
      model: null,
      effort: null,
      prompt: 'x',
    });
    await vi.waitFor(() => {
      expect(fakes.queries).toHaveLength(1);
    });
    expect(current().params.options).toMatchObject({
      settingSources: ['user'],
      settings: { disableAllHooks: true },
    });
    expect(current().params.options).not.toHaveProperty('model');
    expect(current().params.options).not.toHaveProperty('effort');
    current().push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Overloaded'],
    });
    await expect(writing).rejects.toThrow('Overloaded');
  });

  it('gives a session a title in Claude Code’s transcript, and reports it', async () => {
    const { session, events } = await startSession();
    await session.setTitle?.('Build fixes');
    expect(vi.mocked(renameSession)).toHaveBeenCalledWith(session.id, 'Build fixes', {
      dir: expect.any(String) as string,
    });
    expect(events).toContainEqual({ type: 'title', title: 'Build fixes' });
  });

  it('tells the agent of new messages in a document of its own beside the message, accepted once Claude Code takes it', async () => {
    const { session, events } = await startSession();
    const delivery = { accepted: vi.fn(), failed: vi.fn() };
    await session.send(
      'Go on',
      [],
      { presentationNotices: [], inboxNotices: [inboxNotice] },
      delivery,
    );
    await waitFor(() => current().inputs.length === 1);
    expect(current().inputs[0]).toMatchObject({
      message: {
        content: [
          { type: 'document', title: 'App inbox', source: { type: 'text' } },
          { type: 'text', text: 'Go on' },
        ],
      },
    });
    const [block] = (
      current().inputs[0] as { message: { content: { source: { data: string } }[] } }
    ).message.content;
    expect(JSON.parse(block?.source.data ?? '')).toMatchObject({ messages: [inboxNotice] });
    expect(events.filter((event) => event.type === 'message')).toEqual([
      expect.objectContaining({ role: 'user', text: 'Go on' }),
    ]);
    expect(delivery.accepted).not.toHaveBeenCalled();
    current().push(current().inputs[0]);
    await waitFor(() => delivery.accepted.mock.calls.length === 1);
  });

  it('starts a turn of the app’s own with the notices alone, which shows no message of the user’s', async () => {
    const { session, events } = await startSession();
    const delivery = { accepted: vi.fn(), failed: vi.fn() };
    await session.deliverContext?.(
      { presentationNotices: [], inboxNotices: [inboxNotice] },
      delivery,
    );
    expect(events).toContainEqual({ type: 'turn-started' });
    expect(events.some((event) => event.type === 'message')).toBe(false);
    await waitFor(() => current().inputs.length === 1);
    expect(current().inputs[0]).toMatchObject({
      message: { content: [{ type: 'document', title: 'App inbox' }] },
    });
    await expect(
      session.deliverContext?.({ presentationNotices: [], inboxNotices: [inboxNotice] }, delivery),
    ).rejects.toThrow('turn is running');
  });

  it('accepts a turn of the app’s own as its first output comes, where Claude Code echoes no message', async () => {
    const { session } = await startSession();
    const delivery = { accepted: vi.fn(), failed: vi.fn() };
    await session.deliverContext?.(
      { presentationNotices: [], inboxNotices: [inboxNotice] },
      delivery,
    );
    await waitFor(() => current().inputs.length === 1);
    expect(delivery.accepted).not.toHaveBeenCalled();
    current().push(init);
    current().push({
      type: 'assistant',
      uuid: 'a1',
      parent_tool_use_id: null,
      message: { id: 'a1', content: [{ type: 'text', text: 'Reading it.' }] },
    });
    await waitFor(() => delivery.accepted.mock.calls.length === 1);
    current().push(result);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivery.accepted).toHaveBeenCalledOnce();
  });

  it('gives back the notices of new messages from Claude Code’s transcript', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'App inbox',
              source: {
                type: 'text',
                media_type: 'text/plain',
                data: JSON.stringify({ source: '3mukon-code:inbox', messages: [inboxNotice] }),
              },
            },
          ],
        },
      },
    ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
    expect(await provider.history('s', '/work')).toEqual([
      { type: 'inbox', notices: [inboxNotice] },
    ]);
  });

  it('switches the model and the effort in place', async () => {
    const { session, events } = await startSession();
    await session.setModel('haiku');
    await session.setEffort('low');
    await session.setEffort(null);
    expect(current().setModel).toHaveBeenCalledWith('haiku');
    expect(current().applyFlagSettings).toHaveBeenNthCalledWith(2, { effortLevel: 'low' });
    expect(current().applyFlagSettings).toHaveBeenNthCalledWith(3, { effortLevel: null });
    await expect(session.setEffort('extreme')).rejects.toThrow('no reasoning effort');
    expect(events).toContainEqual({ type: 'settings', model: 'haiku' });
    expect(events).toContainEqual({ type: 'settings', effort: 'low' });
    expect(fakes.queries).toHaveLength(1);
  });

  it('switches the sandbox level in place, during a turn too, and clears the deny rules of read-only', async () => {
    const { session, events } = await startSession();
    await session.send('hello');
    await session.setSandbox('read-only');
    await session.setSandbox('full-access');
    await session.setSandbox('workspace-write');
    const calls = current().applyFlagSettings.mock.calls as unknown[][];
    expect(calls.map((call) => call[0])).toEqual([
      levelSettings('workspace-write'),
      levelSettings('read-only'),
      levelSettings('full-access', true),
      levelSettings('workspace-write'),
    ]);
    expect(events.filter((event) => event.type === 'settings').slice(1)).toEqual([
      { type: 'settings', sandbox: 'read-only' },
      { type: 'settings', sandbox: 'full-access' },
      { type: 'settings', sandbox: 'workspace-write' },
    ]);
    expect(fakes.queries).toHaveLength(1);
  });

  it('switches the gateway between turns by continuing the session in a new process', async () => {
    const { session, events } = await startSession();
    await playTurn(session, events, 'hello');
    const first = current();
    await session.setGateway('work');
    expect(first.closed).toBe(true);
    expect(fakes.queries).toHaveLength(2);
    expect(current().params.options).toMatchObject({
      resume: session.id,
      settings: join(gatewaysDir, 'work.json'),
    });
    expect(current().applyFlagSettings).toHaveBeenCalledExactlyOnceWith(
      levelSettings('workspace-write'),
    );
    expect(events).toContainEqual({ type: 'settings', gateway: 'work' });
    expect(events.filter((event) => event.type === 'models')).toHaveLength(2);
    expect(events.some((event) => event.type === 'closed')).toBe(false);
    await playTurn(session, events, 'again');
    expect(current().inputs).toHaveLength(1);
  });

  it('lets a switch on its way finish before a gateway switch ends the process, and starts the new one with it', async () => {
    const { session, events } = await startSession();
    await playTurn(session, events, 'hello');
    const first = current();
    // Claude Code answers the effort switch only once the gateway switch has been asked for.
    let answer: () => void = () => undefined;
    first.applyFlagSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const effort = session.setEffort('low');
    const gateway = session.setGateway('work');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.closed).toBe(false);
    answer();
    await effort;
    await gateway;
    expect(first.closed).toBe(true);
    expect(current().params.options).toMatchObject({
      effort: 'low',
      settings: join(gatewaysDir, 'work.json'),
    });
    expect(events).toContainEqual({ type: 'settings', effort: 'low' });
    expect(events).toContainEqual({ type: 'settings', gateway: 'work' });
    // A switch asked for while the gateway switch is under way goes to the new process.
    const switching = session.setGateway(null);
    await session.setModel('haiku');
    await switching;
    expect(current().setModel).toHaveBeenCalledExactlyOnceWith('haiku');
    expect(fakes.queries).toHaveLength(3);
  });

  it('switches a gateway asked for during a turn once the turn has ended', async () => {
    const { session, events } = await startSession();
    await session.send('hello');
    await session.setGateway('work');
    expect(fakes.queries).toHaveLength(1);
    current().push(init);
    current().push(result);
    await waitFor(() =>
      events.some((event) => event.type === 'settings' && event.gateway === 'work'),
    );
    expect(fakes.queries).toHaveLength(2);
    await session.send('next');
    await waitFor(() => current().inputs.length === 1);
  });

  it('starts the new process afresh when the gateway changes before the first message', async () => {
    const { session } = await startSession({ gateway: 'work' });
    await session.setGateway(null);
    expect(current().params.options).toMatchObject({ sessionId: session.id });
    expect(current().params.options).not.toHaveProperty('resume');
    expect(current().params.options).not.toHaveProperty('settings');
  });

  it('sends a message during a turn into Claude Code’s input, with its images, and follows the turn it makes', async () => {
    const { session, events } = await startSession();
    await session.send('Fix the build');
    await session.send('Also the lint', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    await waitFor(() => current().inputs.length === 2);
    expect(current().inputs[1]).toMatchObject({
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
          { type: 'text', text: 'Also the lint' },
        ],
      },
    });
    expect(events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    expect(events.flatMap((event) => (event.type === 'message' ? [event.text] : []))).toEqual([
      'Fix the build',
      'Also the lint',
    ]);
    // Claude Code ran the turn without taking the message into it, and goes on with it as the next.
    current().push(init);
    current().push({ ...result, queued_turn_count: 1 });
    await waitFor(() => events.filter((event) => event.type === 'turn-ended').length === 1);
    const ended = events.findIndex((event) => event.type === 'turn-ended');
    expect(events.slice(ended)).toContainEqual({ type: 'turn-started' });
    current().push({ ...result, queued_turn_count: 0 });
    await waitFor(() => events.filter((event) => event.type === 'turn-ended').length === 2);
    expect(events.filter((event) => event.type === 'turn-started')).toHaveLength(2);
    expect(events.findLast((event) => event.type === 'turn-ended')).toMatchObject({
      outcome: 'completed',
    });
  });

  it('follows a turn Claude Code runs by itself, as for a background task’s notice, from its init to its result', async () => {
    const { session, events } = await startSession();
    await playTurn(session, events, 'Start the job in the background');
    const turns = (type: 'turn-started' | 'turn-ended') =>
      events.filter((event) => event.type === type).length;
    expect([turns('turn-started'), turns('turn-ended')]).toEqual([1, 1]);
    // The job's notice starts a turn without a message of the user's.
    current().push(init);
    await waitFor(() => turns('turn-started') === 2);
    // The turn starts before what its init says.
    expect(events.slice(-2)).toEqual([{ type: 'turn-started' }, { type: 'mode', mode: 'auto' }]);
    current().push({ ...result, origin: { kind: 'task-notification' } });
    await waitFor(() => turns('turn-ended') === 2);
    expect(events.findLast((event) => event.type === 'turn-ended')).toMatchObject({
      outcome: 'completed',
    });
    // A turn of the app's own opens with an init too, which starts nothing more.
    await playTurn(session, events, 'Thanks');
    expect([turns('turn-started'), turns('turn-ended')]).toEqual([3, 3]);
  });

  it('sends a message’s images as content blocks before its text, and shows them with it', async () => {
    const { session, events } = await startSession();
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    await session.send('What is this?', [image]);
    await waitFor(() => current().inputs.length === 1);
    expect(current().inputs[0]).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } },
          { type: 'text', text: 'What is this?' },
        ],
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'user', images: [image] }),
    );
  });

  it('reads the history from Claude Code’s transcript, with the title Claude Code keeps, if any', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: 'Fix the build' },
      },
    ]);
    vi.mocked(getSessionInfo).mockResolvedValueOnce({
      sessionId: 's',
      lastModified: 0,
      summary: 'Fix the build',
      customTitle: 'Build fixes',
    });
    const events = await provider.history('s', '/work');
    expect(events.at(-1)).toEqual({ type: 'title', title: 'Build fixes' });
    expect(events.some((event) => event.type === 'message' && event.text === 'Fix the build')).toBe(
      true,
    );
    // Without such a title, the history has none: its summary would be the latest prompt.
    vi.mocked(getSessionInfo).mockResolvedValueOnce({
      sessionId: 's',
      lastModified: 0,
      summary: 'Fix the build',
    });
    expect((await provider.history('s', '/work')).some((event) => event.type === 'title')).toBe(
      false,
    );
  });

  it('lists the folder’s sessions by the title Claude Code keeps, or else their first prompt', async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { sessionId: 'a', lastModified: 2, summary: 'Latest', firstPrompt: 'First', cwd: '/work' },
      {
        sessionId: 'b',
        lastModified: 1,
        summary: 'Latest',
        customTitle: 'Named',
        firstPrompt: 'x',
      },
    ]);
    expect(
      await createClaudeCodeProvider({ gatewaysDir, install }).listSessions('/work', 10),
    ).toEqual([
      { id: 'a', title: 'First', cwd: '/work', updatedAt: 2 },
      { id: 'b', title: 'Named', cwd: '/work', updatedAt: 1 },
    ]);
  });

  it('reports closed once when closed', async () => {
    const { session, events } = await startSession();
    await session.close();
    await waitFor(() => events.some((event) => event.type === 'closed'));
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
  });
});

describe('closing the Claude Code provider', () => {
  it('waits for its probes’ Claude Code to exit as it closes, and starts no more', async () => {
    const provider = createClaudeCodeProvider({ gatewaysDir, install });
    // The answer comes before the probe's process has exited.
    expect(await provider.listModels(null)).toEqual([opus]);
    const child = current().child;
    expect(current().closed).toBe(true);
    expect(child?.exitCode).toBeNull();
    let closed = false;
    const closing = provider.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    await closing;
    expect(child?.exitCode).toBe(0);
    await expect(provider.listModels(null)).rejects.toThrow('closed');
    expect(fakes.queries).toHaveLength(1);
  });
});
