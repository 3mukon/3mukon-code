import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  answerQuestion,
  dataFolder,
  isolatedEnvironment,
  launchWith,
  pickFolder,
  providerProcesses,
} from './app';

// A gateway's service that answers every request to the model, Codex's to /v1/responses, with the
// given reply in the Responses API's events, each answer with ids of its own, keeping the
// authorization each request carries, and answers anything else with a 404.
async function gatewayService(
  reply: string,
): Promise<{ url: string; authorizations: string[]; close: () => void }> {
  const authorizations: string[] = [];
  const answer = (n: number) => [
    { type: 'response.created', response: { id: `resp_${String(n)}` } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: `msg_${String(n)}`,
        content: [{ type: 'output_text', text: reply }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: `resp_${String(n)}`,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
  const server = createServer((request, response) => {
    request.resume();
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/responses') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Not found' } }));
      return;
    }
    authorizations.push(request.headers.authorization ?? '');
    const events = answer(authorizations.length);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    authorizations,
    close: () => {
      server.close();
    },
  };
}

// The token the gateway's file holds, which passes to Codex with the thread and nowhere else
// (ADR-0028).
const TOKEN = 'placeholder-gateway-token';

// The app in English on the given data folder, in the isolated environment (L-0006, L-0007), with a
// Codex gateway file, local.toml, whose provider sends Codex's requests to the given service with the
// file's token. Codex's own settings turn its plugins off, for which it otherwise reaches chatgpt.com
// and GitHub as it starts, and NO_PROXY keeps its requests to the service off any proxy the Mac sets,
// which it otherwise sends even requests to 127.0.0.1 through.
function launchWithGateway(data: string, service: string) {
  const codexHome = isolatedEnvironment(data).CODEX_HOME;
  if (codexHome === undefined) throw new Error('The isolated environment has no CODEX_HOME.');
  writeFileSync(join(codexHome, 'config.toml'), '[features]\nplugins = false\n');
  mkdirSync(join(codexHome, 'gateways'));
  writeFileSync(
    join(codexHome, 'gateways', 'local.toml'),
    `model_provider = "local-gateway"

[model_providers.local-gateway]
name = "Local gateway"
base_url = "${service}/v1"
experimental_bearer_token = "${TOKEN}"
`,
  );
  return launchWith(data, { args: ['--lang=en-US'], env: { NO_PROXY: '127.0.0.1' } });
}

test('a Codex session through a gateway gets its answers from the gateway’s service, with the gateway’s token, and stays on it, saying why, when switched to no gateway', async () => {
  test.setTimeout(120_000);
  const service = await gatewayService('Hello from the gateway.');
  const data = dataFolder();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-gateway-')));
  try {
    const app = await launchWithGateway(data.path, service.url);
    try {
      const window = await app.firstWindow();
      await pickFolder(app, folder);
      await window.getByRole('button', { name: 'Add workspace' }).click();
      await answerQuestion(window, 'Trust');
      await window.getByRole('button', { name: 'New session' }).click();
      const main = window.getByRole('main');
      await main.getByRole('combobox', { name: 'Provider' }).selectOption('codex');
      // Codex sets its home up as the first app-server starts in it, and of app-servers that started
      // at once in a home not yet set up, Codex 0.166.0 failed some, though Codex 0.171.0 failed none
      // in repeated tries. The models of Codex's own configuration, which the window asks for as it
      // opens, show that its app-server has, before the gateway's models and the session start one
      // each together.
      await expect
        .poll(() => main.getByRole('combobox', { name: 'Model' }).locator('option').count(), {
          timeout: 30_000,
        })
        .toBeGreaterThan(1);
      await main.getByRole('combobox', { name: 'Gateway' }).selectOption('local');
      const composer = main.getByRole('textbox', { name: 'Message' });
      await composer.fill('Say hello.');
      await composer.press('Enter');
      const answers = main.getByText('Hello from the gateway.');
      await expect(answers).toBeVisible({ timeout: 60_000 });
      await expect(main.getByText('Working', { exact: true })).toHaveCount(0, { timeout: 60_000 });
      // Codex keeps a thread on the provider it started with (Codex 0.171.0), so the session stays on
      // its gateway, says why, and its next message still goes there.
      const gateway = main.getByRole('combobox', { name: 'Gateway' });
      await gateway.selectOption('');
      await expect(
        main.getByText(
          'Codex CLI keeps this session on the model provider it started with, so it stays on the gateway "local"; Codex CLI\'s own configuration applies to new sessions.',
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(gateway).toHaveValue('local');
      await composer.fill('Again.');
      await composer.press('Enter');
      await expect(answers).toHaveCount(2, { timeout: 60_000 });
      // Every request to the model went to the gateway's service with the file's token.
      expect(new Set(service.authorizations)).toEqual(new Set([`Bearer ${TOKEN}`]));
      // The session's app-server names the gateway's provider on its command line, and nothing else
      // of the file: neither its token nor its service.
      // A model/account probe can finish after its PID was listed. Take one snapshot of the listed
      // children so an exited probe does not abort inspection of the still-running session.
      const commandLines = execFileSync(
        'ps',
        ['-o', 'args=', '-p', providerProcesses(app).join(',')],
        { encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
      expect(
        commandLines.some((line) => line.includes('app-server') && line.includes('local-gateway')),
      ).toBe(true);
      expect(
        commandLines.filter((line) => line.includes(TOKEN) || line.includes(service.url)),
      ).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    service.close();
    data.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
