import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import type { AutomationTool, ExecutionResult } from './execution';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolsetAccess } from '../../sessions/main/provider';
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
