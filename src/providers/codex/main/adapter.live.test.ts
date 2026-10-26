import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProviderSession } from '../../../sessions/main/provider';
import type { SessionEvent } from '../../../sessions/shared/events';
import {
  applyEvent,
  initialSessionState,
  type SessionState,
} from '../../../sessions/shared/session-state';
import { startToolset, type RunningToolset } from '../../../toolset/main/server';
import { createCodexProvider } from './adapter';

// Drives a real Codex session on the signed-in account, in a throwaway folder, on a small model at low
// effort, with the app's toolset. Only `corepack pnpm run test:live` runs it, never the check command:
// it needs Codex signed in, and it uses a little of the account's usage. Codex's own question tool
// works only in its plan mode, so the agent asks through the toolset's.

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'codex-live-')));
// A gateway that keeps Codex's own provider, so that switching to it keeps the account's sign-in.
const gatewaysDir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-gateways-')));
writeFileSync(join(gatewaysDir, 'plain.toml'), 'model_provider = "openai"\n');
let toolset: RunningToolset;
beforeAll(async () => {
  toolset = await startToolset({ version: '0.0.0' });
});
afterAll(async () => {
  await toolset.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(gatewaysDir, { recursive: true, force: true });
});

// Folds a session's events into its state, so that the test can wait for a condition on it.
function recorder() {
  const events: SessionEvent[] = [];
  let state = initialSessionState();
  let check: (() => void) | null = null;
  return {
    events,
    get state(): SessionState {
      return state;
    },
    onEvent(event: SessionEvent): void {
      events.push(event);
      state = applyEvent(state, event);
      check?.();
    },
    until(predicate: (state: SessionState, events: SessionEvent[]) => boolean): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          check = null;
          reject(new Error('Timed out waiting for the session.'));
        }, 180_000);
        check = () => {
          if (!predicate(state, events)) return;
          clearTimeout(timer);
          check = null;
          resolve();
        };
        check();
      });
    },
  };
}

const turnsEnded = (events: SessionEvent[]) =>
  events.filter((event) => event.type === 'turn-ended').length;

function lastAgentText(state: SessionState): string {
  const messages = state.timeline.filter(
    (item) => item.type === 'message' && item.role === 'agent',
  );
  const last = messages.at(-1);
  return last?.type === 'message' ? last.text : '';
}

it('runs turns in auto, writes a file, asks through the toolset, switches mode, model, gateway and sandbox, and resumes', async () => {
  const provider = createCodexProvider({ toolset, gatewaysDir });
  expect(await provider.listGateways()).toEqual(['plain']);
  const models = await provider.listModels(null);
  // Small models keep the test cheap.
  const small = models.filter((model) => model.id.includes('luna'));
  const model = small[0]?.id ?? models.at(-1)?.id;
  if (model === undefined) throw new Error('Codex offers no models.');
  const otherModel = small[1]?.id ?? model;

  const live = recorder();
  const session: ProviderSession = await provider.start({ cwd, model, effort: 'low' }, (event) => {
    live.onEvent(event);
    // Codex's automatic reviewer decides in auto; anything that still reaches the user is allowed
    // only for the files this test asks for.
    if (event.type === 'approval-requested') {
      const wanted =
        event.request.paths?.some((path) => path.endsWith('hello.txt')) === true ||
        event.request.command?.includes('again.txt') === true;
      void session.answerApproval(event.request.id, {
        decision: wanted ? 'allow-once' : 'deny',
      });
    }
    // Chooses Tabs where a question offers it, and declines anything else.
    if (event.type === 'question-asked') {
      const question = event.request.questions[0];
      const choice = question?.options.find((option) => option.label === 'Tabs');
      void session.answerQuestion(
        event.request.id,
        question === undefined || choice === undefined
          ? { decision: 'decline' }
          : { decision: 'answer', answers: { [question.id]: { selected: [choice.label] } } },
      );
    }
  });
  expect(live.state.mode).toBe('auto');
  expect(live.state.models?.length).toBeGreaterThan(0);

  await session.send('Reply with exactly one word: ready');
  await live.until((_, events) => turnsEnded(events) === 1);
  expect(lastAgentText(live.state).toLowerCase()).toContain('ready');
  expect(live.events.some((event) => event.type === 'message-delta')).toBe(true);

  await session.send(
    'Use your apply_patch tool to create a file named hello.txt that contains exactly: hi',
  );
  await live.until((_, events) => turnsEnded(events) === 2);
  expect(readFileSync(join(cwd, 'hello.txt'), 'utf8').trim()).toBe('hi');
  expect(
    live.events.some(
      (event) =>
        event.type === 'file-change' &&
        event.change.path === 'hello.txt' &&
        event.change.kind === 'add',
    ),
  ).toBe(true);

  // The question tool runs in auto without asking for approval, and its answer reaches the agent.
  await session.send(
    'Use the ask_user tool of the 3mukon-code MCP server to ask me one question, whether I prefer tabs or spaces, with the options Tabs and Spaces. Then reply with one word: the option I chose.',
  );
  await live.until((_, events) => turnsEnded(events) === 3);
  const asked = live.events.flatMap((event) =>
    event.type === 'question-asked' ? [event.request.id] : [],
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]?.startsWith('toolset-')).toBe(true);
  expect(lastAgentText(live.state).toLowerCase()).toContain('tabs');

  // Yolo runs commands without asking, from the next turn on, still in the workspace sandbox; the model
  // switches the same way.
  await session.setMode('yolo');
  await session.setModel(otherModel);
  await session.send(
    'Run the shell command `printf yolo > again.txt`, then reply with one word: done',
  );
  await live.until((_, events) => turnsEnded(events) === 4);
  expect(existsSync(join(cwd, 'again.txt'))).toBe(true);
  expect(live.events.some((event) => event.type === 'tool' && event.kind === 'execute')).toBe(true);
  expect(live.state.mode).toBe('yolo');

  // The gateway switches between turns, by resuming the thread on a new app-server.
  await session.setGateway('plain');
  expect(live.state.gateway).toBe('plain');
  await session.send(
    'What was the one word you replied with first in this conversation? Reply with that word only.',
  );
  await live.until((_, events) => turnsEnded(events) === 5);
  expect(lastAgentText(live.state).toLowerCase()).toContain('ready');
  expect(live.events.some((event) => event.type === 'closed' || event.type === 'error')).toBe(
    false,
  );

  // Read-only takes over from the next turn, and in yolo nothing may leave it.
  await session.setSandbox('read-only');
  expect(live.state.sandbox).toBe('read-only');
  await session.send(
    'Run the shell command `printf blocked > blocked.txt` once, and do not try any other way. Then reply with one word: done',
  );
  await live.until((_, events) => turnsEnded(events) === 6);
  expect(existsSync(join(cwd, 'blocked.txt'))).toBe(false);

  await session.close();
  await live.until((state) => state.closed);

  const history = await provider.listSessions(cwd, 10);
  expect(history.map((entry) => entry.id)).toContain(session.id);

  // The app keeps a session's level and gives it back on resume.
  const replay = recorder();
  const resumed = await provider.resume(
    { cwd, sessionId: session.id, sandbox: 'read-only' },
    (event) => {
      replay.onEvent(event);
    },
  );
  await replay.until((state) => !state.loadingHistory && state.sandbox !== undefined);
  expect(replay.state.sandbox).toBe('read-only');
  const userTexts = replay.events.flatMap((event) =>
    event.type === 'message' && event.role === 'user' ? [event.text] : [],
  );
  expect(userTexts[0]).toBe('Reply with exactly one word: ready');
  await resumed.close();
  await replay.until((state) => state.closed);
}, 600_000);
