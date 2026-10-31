import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  it('introduces itself and lists no tools, which Codex needs to start a thread', async () => {
    const client = await connect(toolset.open());
    expect(client.getServerVersion()).toMatchObject({ name: TOOLSET_NAME, version: '1.2.3' });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('gives each session a credential of its own, which ends with its access', async () => {
    const first = toolset.open();
    const second = toolset.open();
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
    const access = toolset.open();
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
    const access = toolset.open();
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
