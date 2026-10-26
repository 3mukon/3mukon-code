import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexRpc, type Launch, type RpcHandlers } from './rpc';

// A stand-in for codex app-server: answers echo with its params and launch with its arguments and one
// variable of its environment, fails on fail, asks a question of its own on ask, sends the responses it
// receives back as notifications, and exits on exit.
const SERVER = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stderr.write('a log line\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'echo') send({ id: message.id, result: message.params });
  else if (message.method === 'launch') send({ id: message.id, result: { args: process.argv.slice(2), variable: process.env.CODEX_RPC_TEST ?? null } });
  else if (message.method === 'fail') send({ id: message.id, error: { code: -32600, message: 'No such thing' } });
  else if (message.method === 'ask') send({ id: 'server-1', method: 'question', params: { text: 'Why?' } });
  else if (message.method === 'exit') process.exit(3);
  else if (message.method === undefined) send({ method: 'answered', params: message });
});
`;

const dir = mkdtempSync(join(tmpdir(), 'codex-rpc-'));
writeFileSync(join(dir, 'server.mjs'), SERVER);
// The stand-in runs on the Node.js that runs the tests, with the arguments it was started with.
const binary = join(dir, 'codex');
writeFileSync(
  binary,
  `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${join(dir, 'server.mjs')}" "$@"\n`,
);
chmodSync(binary, 0o755);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function connect(answer: (method: string, params: unknown) => Promise<unknown>, launch?: Launch) {
  const notifications: { method: string; params: unknown }[] = [];
  const exits: (string | undefined)[] = [];
  const handlers: RpcHandlers = {
    notification: (method, params) => notifications.push({ method, params }),
    request: answer,
    exit: (error) => exits.push(error),
  };
  return { rpc: CodexRpc.start(binary, dir, handlers, launch), notifications, exits };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe('CodexRpc', () => {
  it('sends requests and matches their results and errors', async () => {
    const { rpc } = connect(() => Promise.resolve(null));
    expect(await rpc.request('echo', { a: 1 })).toEqual({ a: 1 });
    await expect(rpc.request('fail', {})).rejects.toThrow('No such thing');
    await rpc.close();
  });

  it('answers the server’s own requests, with a result or an error', async () => {
    const { rpc, notifications } = connect((method, params) =>
      method === 'question'
        ? Promise.resolve({ answer: 'Because', asked: params })
        : Promise.reject(new Error('Unknown')),
    );
    rpc.notify('ask');
    await waitFor(() => notifications.length === 1);
    expect(notifications[0]).toEqual({
      method: 'answered',
      params: { id: 'server-1', result: { answer: 'Because', asked: { text: 'Why?' } } },
    });
    await rpc.close();
  });

  it('reports an unexpected exit, and fails what was waiting', async () => {
    const { rpc, exits } = connect(() => Promise.resolve(null));
    await expect(rpc.request('exit', {})).rejects.toThrow('Codex has stopped.');
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual(['Codex stopped unexpectedly (exit code 3).']);
    await expect(rpc.request('echo', {})).rejects.toThrow('Codex has stopped.');
  });

  it('starts the app-server with the launch’s arguments and environment', async () => {
    const plain = connect(() => Promise.resolve(null));
    expect(await plain.rpc.request('launch', {})).toEqual({ args: ['app-server'], variable: null });
    await plain.rpc.close();
    const { rpc } = connect(() => Promise.resolve(null), {
      args: ['-c', 'x=1'],
      env: { CODEX_RPC_TEST: 'set' },
    });
    expect(await rpc.request('launch', {})).toEqual({
      args: ['app-server', '-c', 'x=1'],
      variable: 'set',
    });
    await rpc.close();
  });

  it('reports no error when closed', async () => {
    const { rpc, exits } = connect(() => Promise.resolve(null));
    expect(await rpc.request('echo', 1)).toBe(1);
    await rpc.close();
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([undefined]);
  });
});
