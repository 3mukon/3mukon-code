import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolsetAccess, ToolsetSession } from '../../sessions/main/provider';
import type { Question, QuestionAnswer } from '../../sessions/shared/events';
import { startToolset, TOOLSET_NAME, type RunningToolset } from './server';

// Stands in for a session: it records each question the toolset asks and lets the test answer it.
class FakeSession implements ToolsetSession {
  readonly asked: {
    questions: Question[];
    signal: AbortSignal;
    answer: (a: QuestionAnswer) => void;
  }[] = [];

  ask(questions: Question[], signal: AbortSignal): Promise<QuestionAnswer> {
    return new Promise((resolve) => {
      this.asked.push({ questions, signal, answer: resolve });
      signal.addEventListener(
        'abort',
        () => {
          resolve({ decision: 'decline' });
        },
        { once: true },
      );
    });
  }
}

let toolset: RunningToolset;
const clients: Client[] = [];
beforeEach(async () => {
  toolset = await startToolset({ version: '1.2.3' });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await toolset.close();
});

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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
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

const question = {
  question: 'Which library?',
  header: 'Library',
  options: [{ label: 'React', description: 'The usual one' }, { label: 'Solid' }],
};

describe('the toolset', () => {
  it('introduces itself and offers the question tool, read-only', async () => {
    const client = await connect(toolset.open(new FakeSession()));
    expect(client.getServerVersion()).toMatchObject({ name: TOOLSET_NAME, version: '1.2.3' });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['ask_user']);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools[0]?.inputSchema.required).toEqual(['questions']);
  });

  it('asks the session and returns the answers in the order asked', async () => {
    const session = new FakeSession();
    const client = await connect(toolset.open(session));
    const call = client.callTool({
      name: 'ask_user',
      arguments: {
        questions: [question, { question: 'Anything else?', multiSelect: true }],
      },
    });
    await waitFor(() => session.asked.length === 1);
    expect(session.asked[0]?.questions).toEqual([
      {
        id: 'q0',
        header: 'Library',
        text: 'Which library?',
        options: [{ label: 'React', description: 'The usual one' }, { label: 'Solid' }],
        multiSelect: false,
        freeText: true,
        secret: false,
      },
      {
        id: 'q1',
        text: 'Anything else?',
        options: [],
        multiSelect: true,
        freeText: true,
        secret: false,
      },
    ]);
    session.asked[0]?.answer({
      decision: 'answer',
      answers: { q1: { selected: [], text: 'Keep it small' }, q0: { selected: ['Solid'] } },
    });
    const result = await call;
    const expected = {
      status: 'answered',
      answers: [
        { question: 'Which library?', selected: ['Solid'] },
        { question: 'Anything else?', selected: [], text: 'Keep it small' },
      ],
    };
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
  });

  it('returns cancelled when the user declines', async () => {
    const session = new FakeSession();
    const client = await connect(toolset.open(session));
    const call = client.callTool({ name: 'ask_user', arguments: { questions: [question] } });
    await waitFor(() => session.asked.length === 1);
    session.asked[0]?.answer({ decision: 'decline' });
    expect((await call).structuredContent).toEqual({ status: 'cancelled', answers: [] });
  });

  it('ends a running call when the provider gives it up', async () => {
    const session = new FakeSession();
    const client = await connect(toolset.open(session));
    const giveUp = new AbortController();
    const call = client.callTool(
      { name: 'ask_user', arguments: { questions: [question] } },
      undefined,
      {
        signal: giveUp.signal,
      },
    );
    await waitFor(() => session.asked.length === 1);
    giveUp.abort();
    await expect(call).rejects.toThrow();
    await waitFor(() => session.asked[0]?.signal.aborted === true);
  });

  it('ends running calls and refuses the credential once the access is closed', async () => {
    const session = new FakeSession();
    const access = toolset.open(session);
    const client = await connect(access);
    const call = client.callTool({ name: 'ask_user', arguments: { questions: [question] } });
    await waitFor(() => session.asked.length === 1);
    access.close();
    expect(session.asked[0]?.signal.aborted).toBe(true);
    expect((await call).structuredContent).toEqual({ status: 'cancelled', answers: [] });
    expect((await post(access.url, { Authorization: `Bearer ${access.credential}` })).status).toBe(
      401,
    );
  });

  it('keeps each session to its own calls', async () => {
    const first = new FakeSession();
    const second = new FakeSession();
    await connect(toolset.open(first));
    const client = await connect(toolset.open(second));
    const call = client.callTool({ name: 'ask_user', arguments: { questions: [question] } });
    await waitFor(() => second.asked.length === 1);
    expect(first.asked).toHaveLength(0);
    second.asked[0]?.answer({ decision: 'decline' });
    await call;
  });

  it('refuses a call outside the limits without asking', async () => {
    const session = new FakeSession();
    const client = await connect(toolset.open(session));
    const five = { questions: Array.from({ length: 5 }, () => question) };
    const nine = {
      questions: [
        { question: 'Pick', options: Array.from({ length: 9 }, (_, i) => ({ label: String(i) })) },
      ],
    };
    const twice = { questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'A' }] }] };
    for (const input of [five, nine, twice, { questions: [] }]) {
      const result = await client.callTool({ name: 'ask_user', arguments: input });
      expect(result.isError).toBe(true);
    }
    expect(session.asked).toHaveLength(0);
  });

  it('refuses requests without a session’s credential, from a web page or by another name', async () => {
    const access = toolset.open(new FakeSession());
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

  it('ends every running call and every access when it stops', async () => {
    const session = new FakeSession();
    const access = toolset.open(session);
    const client = await connect(access);
    const call = client
      .callTool({ name: 'ask_user', arguments: { questions: [question] } })
      .catch(() => 'ended');
    await waitFor(() => session.asked.length === 1);
    await toolset.close();
    expect(session.asked[0]?.signal.aborted).toBe(true);
    await client.close();
    expect(await call).toBeDefined();
    expect(
      await post(access.url, { Authorization: `Bearer ${access.credential}` }).catch(
        () => 'refused',
      ),
    ).toBe('refused');
    toolset = await startToolset({ version: '1.2.3' });
  });
});
