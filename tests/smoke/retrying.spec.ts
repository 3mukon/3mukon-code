import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { answerQuestion, dataFolder, loginEnvironment, pickFolder } from './app';

// A model's service that fails every request to the model with an error 500, which Claude Code retries,
// and answers anything else with a 404.
async function failingService(): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    request.resume();
    const failing = request.method === 'POST' && request.url?.split('?')[0] === '/v1/messages';
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

// The app in English on the given data folder, in a login's environment, so that the variables of
// whatever runs the test, such as an agent session's own, never reach Claude Code (L-0006), with each
// provider reading its settings from a folder inside it and Claude Code sending its requests to the
// given service, through at most three retries. Claude Code sends nothing without a key; this one is
// a placeholder that no service takes. The test only clicks and types, so it launches the app itself,
// as the settings' smoke test does (L-0004).
function launchAgainst(data: string, service: string) {
  const folders = {
    CLAUDE_CONFIG_DIR: join(data, 'claude'),
    CODEX_HOME: join(data, 'codex'),
    GROK_HOME: join(data, 'grok'),
    ZDOTDIR: join(data, 'zsh'),
  };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  return electron.launch({
    args: ['.', `--user-data-dir=${data}`, '--lang=en-US'],
    env: {
      ...loginEnvironment(),
      ...folders,
      SHELL: '/bin/zsh',
      ANTHROPIC_BASE_URL: service,
      ANTHROPIC_API_KEY: 'placeholder',
      CLAUDE_CODE_MAX_RETRIES: '3',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
}

test('a session says under Working which retry Claude Code makes of a request that failed, and why, until the turn ends', async () => {
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
      const composer = main.getByRole('textbox', { name: 'Message' });
      await composer.fill('Say hello.');
      await composer.press('Enter');
      // The retry, of the three Claude Code makes, with the status and Claude Code's kind of error.
      const notice = main.getByText(/^Retrying, attempt [1-3] of 3: 500 server error$/);
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(main.getByText('Working', { exact: true })).toBeVisible();
      // Claude Code gives up after its last retry, and the turn's end takes the notice with it.
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
