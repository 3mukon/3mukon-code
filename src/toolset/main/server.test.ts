import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import type { AutomationTool, ExecutionResult } from './execution';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCoordinator, ToolsetAccess } from '../../sessions/main/provider';
import type { InboxNotice } from '../../sessions/shared/inbox';
import { startToolset, TOOLSET_NAME, type RunningToolset } from './server';

let toolset: RunningToolset;
const clients: Client[] = [];
beforeEach(async () => {
  toolset = await startToolset({ version: '1.2.3' });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await toolset.close();
});

let ownerSerial = 0;
async function open(): Promise<ToolsetAccess> {
  const owner = await toolset.sessions.bind({
    id: `fixture-${String(++ownerSerial)}`,
    cwd: process.cwd(),
    mode: 'auto',
    sandbox: 'workspace-write',
  });
  return owner.toolset.open();
}

async function connect(access: ToolsetAccess): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: { Authorization: `Bearer ${access.credential}` } },
    }),
  );
  clients.push(client);
  return client;
}

// A plain HTTP request, which can set the headers that fetch keeps to itself.
function post(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    sent.on('error', reject);
    sent.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      }),
    );
  });
}

describe('the toolset', () => {
  it('introduces itself and offers cached capability discovery without a backend', async () => {
    const client = await connect(await open());
    expect(client.getServerVersion()).toMatchObject({ name: TOOLSET_NAME, version: '1.2.3' });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toContain("Prefer the app's own browser");
    expect(client.getInstructions()).toContain('Use global for the connected Chrome profile.');
    expect(client.getInstructions()).toContain('once per operation');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'automation_capabilities',
    ]);
    const result = await client.callTool({ name: 'automation_capabilities' });
    expect(result.structuredContent).toMatchObject({
      policy: { mode: 'auto', sandbox: 'workspace-write' },
      tools: [],
    });
  });

  it('gives each session a credential of its own, which ends with its access', async () => {
    const first = await open();
    const second = await open();
    expect(first.credential).not.toBe(second.credential);
    first.close();
    expect((await post(first.url, { Authorization: `Bearer ${first.credential}` })).status).toBe(
      401,
    );
    expect((await post(second.url, { Authorization: `Bearer ${second.credential}` })).status).toBe(
      200,
    );
  });

  it('refuses requests without a session’s credential, from a web page or by another name', async () => {
    const access = await open();
    const { host } = new URL(access.url);
    const valid = { Authorization: `Bearer ${access.credential}` };
    expect((await post(access.url, {})).status).toBe(401);
    expect((await post(access.url, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(access.url, { ...valid, Origin: 'https://example.com' })).status).toBe(403);
    expect((await post(access.url, { ...valid, Host: 'attacker.example:80' })).status).toBe(403);
    expect((await post(access.url.replace('/mcp', '/other'), valid)).status).toBe(404);
    const get = await fetch(access.url, { headers: valid });
    expect(get.status).toBe(405);
    expect(host.startsWith('127.0.0.1:')).toBe(true);
    expect((await post(access.url, valid)).status).toBe(200);
  });

  it('ends every access when it stops', async () => {
    const access = await open();
    const client = await connect(access);
    await toolset.close();
    await client.close();
    expect(
      await post(access.url, { Authorization: `Bearer ${access.credential}` }).catch(
        () => 'refused',
      ),
    ).toBe('refused');
    toolset = await startToolset({ version: '1.2.3' });
  });
});

it('invalidates old bound factories as well as credentials without letting their cleanup affect the replacement', async () => {
  const options = {
    id: 'durable-owner',
    cwd: process.cwd(),
    mode: 'auto' as const,
    sandbox: 'workspace-write' as const,
  };
  const first = await toolset.sessions.bind(options);
  const old = first.toolset.open();
  first.turnStarted();
  const replacement = await toolset.sessions.bind(options);
  const current = replacement.toolset.open();
  expect(() => first.toolset.open()).toThrow('access-revoked');
  await first.close(true);
  expect((await post(old.url, { Authorization: `Bearer ${old.credential}` })).status).toBe(401);
  expect((await post(current.url, { Authorization: `Bearer ${current.credential}` })).status).toBe(
    200,
  );
});

it('records invalid arguments and shares cancellation across separate MCP POST instances', async () => {
  await toolset.close();
  let resolve: (result: ExecutionResult) => void = () => {
    throw new Error('Not started.');
  };
  const completion = new Promise<ExecutionResult>((done) => {
    resolve = done;
  });
  let signal: AbortSignal | undefined;
  const execute = vi.fn<AutomationTool['execute']>((_args, context) => {
    signal = context.signal;
    return completion;
  });
  toolset = await startToolset({
    version: 'fixture',
    tools: [
      {
        name: 'fixture_wait',
        description: 'Synthetic cancellation fixture.',
        family: 'panel',
        inputSchema: z.object({ value: z.number() }),
        availability: { tools: 'ready', images: 'unknown' },
        plan: () => ({
          operation: null,
          effect: 'present',
          delivery: 'background',
          mayActivate: false,
        }),
        execute,
      },
    ],
  });
  const owner = await toolset.sessions.bind({
    id: 'fixture-cancellation',
    cwd: process.cwd(),
    mode: 'auto',
    sandbox: 'workspace-write',
  });
  owner.turnStarted();
  const access = owner.toolset.open();
  const client = await connect(access);
  for (const [arguments_, reason] of [
    [{ value: 1 }, 'required'],
    [{ value: 1, actionId: 42 }, 'invalid-type'],
    [{ value: 1, actionId: '' }, 'too-short'],
    [{ value: 1, actionId: 'x'.repeat(129) }, 'too-long'],
  ] as const) {
    const refused = await client.callTool({ name: 'fixture_wait', arguments: arguments_ });
    expect(refused.isError).toBe(true);
    const expected = {
      status: 'refused',
      code: 'invalid-request',
      dispatched: false,
      detail: { kind: 'argument', field: 'actionId', reason },
    };
    expect(refused.structuredContent).toMatchObject({ outcome: expected });
    expect(refused.content).toEqual([
      { type: 'text', text: JSON.stringify(refused.structuredContent) },
    ]);
    expect(
      toolset.broker.snapshot('fixture-cancellation').value.recentCalls.at(-1)?.outcome,
    ).toEqual(expected);
  }
  const invalid = await client.callTool({
    name: 'fixture_wait',
    arguments: { actionId: 'invalid', value: 'invalid' },
  });
  expect(invalid.isError).toBe(true);
  expect(
    toolset.broker.snapshot('fixture-cancellation').value.recentCalls[0]?.outcome,
  ).toMatchObject({ code: 'invalid-request' });
  expect(execute).not.toHaveBeenCalled();
  const headers = {
    Authorization: `Bearer ${access.credential}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const waiting = fetch(access.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'fixture_wait', arguments: { actionId: 'waiting', value: 1 } },
    }),
  }).then((response) => response.text());
  try {
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    await fetch(access.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 41 },
      }),
    });
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });
    expect(await waiting).toContain('cancelled-after-dispatch');
    expect(
      toolset.broker.snapshot('fixture-cancellation').value.recentCalls.at(-1)?.outcome?.status,
    ).toBe('indeterminate');
  } finally {
    resolve({ outcome: { status: 'verified', value: null } });
    await waiting;
  }
});

it('reports since when a session’s oldest operation approval has waited, and when none waits', async () => {
  toolset = await startToolset({
    version: 'fixture',
    tools: [
      {
        name: 'fixture_change',
        description: 'Synthetic shared-tab fixture.',
        family: 'browser',
        inputSchema: z.object({ target: z.unknown() }),
        availability: { tools: 'ready', images: 'unknown' },
        plan: (raw) => ({
          operation: 'browser-tab',
          effect: 'mutate',
          delivery: 'background',
          mayActivate: false,
          target: (raw as { target: { id: string; kind: 'browser-tab'; generation: number } })
            .target,
        }),
        execute: () => Promise.resolve({ outcome: { status: 'verified', value: null } }),
      },
    ],
  });
  const owner = await toolset.sessions.bind({
    id: 'fixture-waiting',
    cwd: process.cwd(),
    mode: 'auto',
    sandbox: 'workspace-write',
  });
  owner.turnStarted();
  const heard: (number | undefined)[] = [];
  const stop = owner.onWaiting((since) => heard.push(since));
  expect(heard).toEqual([undefined]);
  const target = toolset.broker.register('fixture-waiting', {
    backend: 'fixture-browser',
    key: 'tab-1',
    kind: 'browser-tab',
    mayActivate: false,
    summary: { name: 'Synthetic site', address: 'https://example.test/', sharing: 'app' },
  });
  const access = toolset.broker.openAccess('fixture-waiting');
  const call = toolset.broker.dispatch(
    access,
    'fixture_change',
    { target: target.ref },
    { actionId: 'asked' },
  );
  await vi.waitFor(() => {
    expect(heard).toHaveLength(2);
  });
  const [request] = toolset.broker.snapshot('fixture-waiting').value.pendingApprovals;
  if (request === undefined) throw new Error('The fixture did not ask.');
  expect(heard[1]).toBe(request.requestedAt);
  toolset.broker.answer('fixture-waiting', request.id, { decision: 'allow-once' });
  await call;
  expect(heard).toEqual([undefined, request.requestedAt, undefined]);
  stop();
});

describe('the session tools', () => {
  // A coordinator that answers as the host would, and records who called.
  function coordinator(): SessionCoordinator & { calls: unknown[][]; untold: InboxNotice[] } {
    const calls: unknown[][] = [];
    const untold: InboxNotice[] = [];
    const session = (id: string, parent?: string) => ({
      id,
      title: id === 'lead' ? 'Lead' : 'Helper',
      provider: 'codex-cli' as const,
      folder: '/work',
      status: 'idle' as const,
      ...(parent === undefined ? {} : { parent }),
    });
    return {
      calls,
      untold,
      mayStart: (owner) => owner === 'lead',
      list: (owner) => {
        calls.push(['list', owner]);
        return [session('lead'), session('helper', 'lead')];
      },
      start: (owner, request) => {
        calls.push(['start', owner, request]);
        return Promise.resolve(session('helper', owner));
      },
      end: (owner, id) => {
        calls.push(['end', owner, id]);
        if (id !== 'helper') return Promise.reject(new Error('Not yours to end.'));
        return Promise.resolve(session('helper', owner));
      },
      send: (owner, to, summary, body) => {
        calls.push(['send', owner, to, summary, body]);
        return {
          id: 'm1',
          from: owner,
          fromTitle: 'Lead',
          summary,
          sentAt: 0,
          read: false,
          to,
          toTitle: 'Helper',
        };
      },
      inbox: (owner) => {
        calls.push(['inbox', owner]);
        return [];
      },
      read: (owner, id) => {
        calls.push(['read', owner, id]);
        return {
          id,
          from: 'helper',
          fromTitle: 'Helper',
          summary: 'Done',
          sentAt: 0,
          read: true,
          body: 'All tests pass.',
        };
      },
      notices: () =>
        untold.length === 0
          ? undefined
          : {
              notices: [...untold],
              told: () => {
                untold.length = 0;
              },
            },
    };
  }
  async function session(id: string, sessions: SessionCoordinator) {
    await toolset.close();
    toolset = await startToolset({ version: '1.2.3', coordinator: () => sessions });
    const owner = await toolset.sessions.bind({
      id,
      cwd: process.cwd(),
      mode: 'auto',
      sandbox: 'workspace-write',
    });
    const access = owner.toolset.open();
    return { access, client: await connect(access) };
  }
  const text = (result: unknown) =>
    (result as { content: { text: string }[] }).content[0]?.text ?? '';

  it('offers a session the five tools, and a child no tool to start sessions, all allowed', async () => {
    const sessions = coordinator();
    const lead = await session('lead', sessions);
    const names = (await lead.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'session_list',
        'session_start',
        'session_end',
        'message_send',
        'message_read',
      ]),
    );
    expect(lead.access.tools).toEqual(expect.arrayContaining(['session_start', 'message_read']));
    const helper = await session('helper', sessions);
    const offered = (await helper.client.listTools()).tools.map((tool) => tool.name);
    expect(offered).toContain('message_send');
    expect(offered).not.toContain('session_start');
    const refused = await helper.client.callTool({
      name: 'session_start',
      arguments: { prompt: 'x' },
    });
    expect(refused.isError).toBe(true);
    expect(sessions.calls).toEqual([]);
  });

  it('tells an agent whose models each provider runs, so that it can choose the provider a model needs', async () => {
    const { client } = await session('lead', coordinator());
    const start = (await client.listTools()).tools.find((tool) => tool.name === 'session_start');
    const provider = start?.inputSchema.properties?.provider as
      { enum: string[]; description: string } | undefined;
    // Every provider alike, so that a provider added without its facts fails here as well.
    const runs = {
      'claude-code': 'Anthropic’s Claude models',
      'codex-cli': 'OpenAI’s GPT models',
      'grok-build': 'xAI’s Grok models',
      antigravity: 'Google’s Gemini models',
    };
    expect(provider?.enum).toEqual(Object.keys(runs));
    for (const [id, models] of Object.entries(runs)) {
      expect(provider?.description).toContain(`${id} runs ${models}`);
    }
    expect(provider?.description).toContain(
      'Each may also offer other makers’ models that its account or its own settings add.',
    );
    expect(start?.description).toContain('A child can run on any provider, not only yours');
  });

  it('calls the sessions as the session whose access calls, never as one its arguments name', async () => {
    const sessions = coordinator();
    const { client } = await session('lead', sessions);
    const listed = await client.callTool({ name: 'session_list', arguments: {} });
    expect(text(listed)).toContain('lead: Lead (codex-cli, idle, in /work) [you]');
    expect(text(listed)).toContain('helper: Helper (codex-cli, idle, in /work) [your child]');
    const started = await client.callTool({
      name: 'session_start',
      arguments: { prompt: 'Write the tests', provider: 'claude-code', title: 'Tests' },
    });
    expect(text(started)).toContain('Started the child session helper');
    const sent = await client.callTool({
      name: 'message_send',
      arguments: { to: 'helper', summary: 'Start now', body: 'Details' },
    });
    expect(text(sent)).toBe('Sent to Helper (helper): Start now');
    const read = await client.callTool({ name: 'message_read', arguments: { messageId: 'm7' } });
    expect(text(read)).toContain('Summary: Done\n\nAll tests pass.');
    expect(sessions.calls).toEqual([
      ['list', 'lead'],
      ['start', 'lead', { prompt: 'Write the tests', provider: 'claude-code', title: 'Tests' }],
      ['send', 'lead', 'helper', 'Start now', 'Details'],
      ['read', 'lead', 'm7'],
    ]);
    // A child's list marks its parent.
    const helper = await session('helper', sessions);
    const fromChild = await helper.client.callTool({ name: 'session_list', arguments: {} });
    expect(text(fromChild)).toContain('lead: Lead (codex-cli, idle, in /work) [your parent]');
    expect(text(fromChild)).toContain(
      'helper: Helper (codex-cli, idle, in /work) [you, child of lead]',
    );
  });

  it('says why a call is refused, for bad arguments as for the sessions’ own refusals', async () => {
    const sessions = coordinator();
    const { client } = await session('lead', sessions);
    const bad = await client.callTool({ name: 'message_send', arguments: { to: 'helper' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('summary');
    const refused = await client.callTool({
      name: 'session_end',
      arguments: { sessionId: 'stranger' },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('Not yours to end.');
  });

  it('carries the notices of new messages with the next result, once, by their summaries', async () => {
    const sessions = coordinator();
    const { client } = await session('lead', sessions);
    sessions.untold.push({
      id: 'n1',
      from: 'helper',
      fromTitle: 'Helper',
      summary: 'Tests written',
      sentAt: 0,
    });
    const first = await client.callTool({ name: 'message_read', arguments: {} });
    expect(text(first)).toContain('Your inbox is empty.');
    expect(text(first)).toContain('- n1: from Helper (helper): Tests written');
    expect(first.structuredContent).toMatchObject({
      inbox: { source: '3mukon-code:inbox', messages: [{ id: 'n1' }] },
    });
    const second = await client.callTool({ name: 'message_read', arguments: {} });
    expect(text(second)).toBe('Your inbox is empty.');
    // Any of the app's tools carries them, the automation tools in their JSON.
    sessions.untold.push({
      id: 'n2',
      from: 'helper',
      fromTitle: 'Helper',
      summary: 'More',
      sentAt: 0,
    });
    const capabilities = await client.callTool({ name: 'automation_capabilities', arguments: {} });
    expect(JSON.parse(text(capabilities))).toMatchObject({ inbox: { messages: [{ id: 'n2' }] } });
  });
});
