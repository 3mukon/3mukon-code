import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { answerQuestion, dataFolder, isolatedEnvironment, pickFolder } from './app';

// A model's service that fails every request to the model with an error 500, which the providers
// retry, Claude Code's to /v1/messages and Codex's to /v1/responses, and answers anything else with a
// 404.
async function failingService(): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    request.resume();
    const path = request.url?.split('?')[0];
    const failing =
      request.method === 'POST' && (path === '/v1/messages' || path === '/v1/responses');
    response.writeHead(failing ? 500 : 404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: failing
          ? { type: 'api_error', message: 'Internal server error' }
          : { type: 'not_found_error', message: 'Not found' },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => {
      server.close();
    },
  };
}

// Codex's own settings, with a model provider that sends Codex's requests to the given service,
// without a key. Codex retries a request that failed up to four times by default without saying so,
// and only then reports a retry, of five by default; without the former, it reports a retry after
// each request that fails, until it has made five. It reports the first retry over HTTP, which this
// provider uses, though not over its WebSocket transport. Its plugins are off, for which it otherwise
// reaches chatgpt.com and GitHub as it starts.
function codexSettings(service: string): string {
  return `model_provider = "failing"

[model_providers.failing]
name = "Failing service"
base_url = "${service}/v1"
request_max_retries = 0
stream_max_retries = 5
supports_websockets = false

[features]
plugins = false
`;
}

// The app in English on the given data folder, in the isolated environment, so that the variables of
// whatever runs the test, such as an agent session's own, never reach the providers (L-0006) and each
// provider reads its settings from a folder inside it (L-0007), with Claude Code and Codex sending
// their requests to the given service. Claude Code makes at most three retries, and sends nothing
// without a key; this one is a placeholder that no service takes. Codex takes its provider from its
// settings, and reaches the service directly: it otherwise sends even requests to 127.0.0.1 through
// the Mac's proxy, where one is set, and retries without end while that proxy is down. The test only
// clicks and types, so it launches the app itself, as the settings' smoke test does (L-0004).
function launchAgainst(data: string, service: string) {
  const env = isolatedEnvironment(data);
  const codexHome = env.CODEX_HOME;
  if (codexHome === undefined) throw new Error('The isolated environment has no CODEX_HOME.');
  writeFileSync(join(codexHome, 'config.toml'), codexSettings(service));
  return electron.launch({
    args: ['.', `--user-data-dir=${data}`, '--lang=en-US'],
    env: {
      ...env,
      ANTHROPIC_BASE_URL: service,
      ANTHROPIC_API_KEY: 'placeholder',
      CLAUDE_CODE_MAX_RETRIES: '3',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      NO_PROXY: '127.0.0.1',
    },
  });
}

// Each provider, as the session page offers it, with its notice of a retry: which one it makes, of
// how many, and why, in the provider's words.
const cases = [
  {
    provider: 'Claude Code',
    id: 'claude-code',
    // The retry, of the three Claude Code makes, with the status and Claude Code's kind of error.
    notice: /^Retrying, attempt [1-3] of 3: 500 server error$/,
  },
  {
    provider: 'Codex',
    id: 'codex',
    // The retry, of the five Codex reports, with Codex's own words for an error 500.
    notice:
      /^Retrying, attempt [1-5] of 5: We’re currently experiencing high demand, which may cause temporary errors\.$/,
  },
];

for (const { provider, id, notice } of cases) {
  test(`a session says under Working which retry ${provider} makes of a request that failed, and why, until the turn ends`, async () => {
    test.setTimeout(120_000);
    const service = await failingService();
    const data = dataFolder();
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-retrying-')));
    try {
      const app = await launchAgainst(data.path, service.url);
      try {
        const window = await app.firstWindow();
        await pickFolder(app, folder);
        await window.getByRole('button', { name: 'Add workspace' }).click();
        await answerQuestion(window, 'Trust');
        await window.getByRole('button', { name: 'New session' }).click();
        const main = window.getByRole('main');
        await main.getByRole('combobox', { name: 'Provider' }).selectOption(id);
        // The provider's models, which the window asks for as it opens, so that the session starts
        // after the window's own process of the provider: Codex sets its home up as the first
        // app-server starts in it, and of app-servers that start at once in a home not yet set up,
        // some fail (Codex 0.166.0).
        await expect
          .poll(() => main.getByRole('combobox', { name: 'Model' }).locator('option').count(), {
            timeout: 30_000,
          })
          .toBeGreaterThan(1);
        const composer = main.getByRole('textbox', { name: 'Message' });
        await composer.fill('Say hello.');
        await composer.press('Enter');
        await expect(main.getByText(notice)).toBeVisible({ timeout: 60_000 });
        await expect(main.getByText('Working', { exact: true })).toBeVisible();
        // The provider gives up after its last retry, and the turn's end takes the notice with it.
        await expect(main.getByText(/^Retrying,/)).toHaveCount(0, { timeout: 60_000 });
        await expect(main.getByText('Working', { exact: true })).toHaveCount(0);
      } finally {
        await app.close();
      }
    } finally {
      service.close();
      data.remove();
      rmSync(folder, { recursive: true, force: true });
    }
  });
}
