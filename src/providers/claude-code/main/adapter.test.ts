import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxLevel, SessionEvent } from '../../../sessions/shared/events';
import { createClaudeCodeProvider } from './adapter';
import { sandboxSettings } from './sandbox';

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
    // Claude Code's own count of the context, which names the model a session uses.
    readonly getContextUsage = vi.fn(() =>
      stalled.has('getContextUsage')
        ? new Promise<typeof usage>(() => undefined)
        : Promise.resolve({ ...usage }),
    );
    closed = false;
    private readonly messages: unknown[] = [];
    private wake: (() => void) | null = null;

    constructor(readonly params: QueryParams) {
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
}));

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
  const provider = createClaudeCodeProvider({ gatewaysDir });
  const session = await provider.start({ cwd: '/work', ...options }, (event) => {
    events.push(event);
  });
  return { session, events };
}

// Plays one turn: the session sends the message, and the fake process answers and ends the turn.
async function playTurn(
  session: { send(text: string): Promise<void> },
  events: SessionEvent[],
  text: string,
) {
  const ended = events.filter((event) => event.type === 'turn-ended').length;
  await session.send(text);
  current().push(init);
  current().push(result);
  await waitFor(() => events.filter((event) => event.type === 'turn-ended').length > ended);
}

describe('the Claude Code provider', () => {
  it('starts a session with the chosen gateway, model and effort, and reports them and the models', async () => {
    const { events } = await startSession({ gateway: 'work', model: 'opus', effort: 'high' });
    expect(current().params.options).toMatchObject({
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
    const provider = createClaudeCodeProvider({ gatewaysDir });
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
    const provider = createClaudeCodeProvider({ gatewaysDir });
    expect(await provider.listGateways()).toEqual(['work']);
    // Through a gateway, the probe reads only the gateway's file.
    expect(await provider.listModels('work')).toEqual([opus]);
    const probe = current();
    expect(probe.params.options).toMatchObject({
      settingSources: [],
      persistSession: false,
      settings: join(gatewaysDir, 'work.json'),
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
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
    const provider = createClaudeCodeProvider({ gatewaysDir });
    fakes.usage.model = 'claude-elsewhere';
    expect((await provider.listModels(null)).map((model) => [model.id, model.default])).toEqual([
      ['default', true],
      ['opus', undefined],
    ]);
  });

  it('closes a probe that has not started within 30 seconds, and fails the list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakes.stalled.add('initializationResult');
    const listing = createClaudeCodeProvider({ gatewaysDir }).listModels(null);
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
    const listing = createClaudeCodeProvider({ gatewaysDir }).listModels(null);
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
    const starting = createClaudeCodeProvider({ gatewaysDir }).start({ cwd: '/work' }, (event) => {
      events.push(event);
    });
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
    await playTurn(session, events, 'Fix the build');
    await waitFor(() => events.some((event) => event.type === 'title'));
    expect(events).toContainEqual({ type: 'context', used: 4800, size: 200_000 });
    expect(events).toContainEqual({ type: 'title', title: 'Fix the build' });
    // The same title is not reported again.
    await playTurn(session, events, 'Again');
    await waitFor(() => events.filter((event) => event.type === 'context').length === 3);
    expect(events.filter((event) => event.type === 'title')).toHaveLength(1);
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

  it('reports closed once when closed', async () => {
    const { session, events } = await startSession();
    await session.close();
    await waitFor(() => events.some((event) => event.type === 'closed'));
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
  });
});
