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
import { afterAll, expect, it } from 'vitest';
import type { ProviderSession } from '../../../sessions/main/provider';
import type { SessionEvent } from '../../../sessions/shared/events';
import {
  applyEvent,
  initialSessionState,
  type SessionState,
} from '../../../sessions/shared/session-state';
import { createClaudeCodeProvider } from './adapter';

// Drives a real Claude Code session on the signed-in account, in a throwaway folder. Only
// `corepack pnpm run test:live` runs it, never the check command: it needs Claude Code signed in, and
// it uses a little of the account's usage.

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-code-live-')));
// A gateway whose settings file changes nothing, so that switching to it keeps the account's own
// sign-in and endpoint.
const gatewaysDir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-code-gateways-')));
writeFileSync(join(gatewaysDir, 'plain.json'), '{}');
afterAll(() => {
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
        }, 120_000);
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

it('streams turns in auto mode, writes, answers a question, switches mode, model, effort and gateway, and resumes', async () => {
  const provider = createClaudeCodeProvider({ gatewaysDir });
  expect(await provider.listGateways()).toEqual(['plain']);
  // The models come from a probe that starts no session.
  expect((await provider.listModels(null)).some((model) => model.id === 'haiku')).toBe(true);

  const live = recorder();
  // Approvals and questions arrive only after start has resolved, so the listener can use the session.
  const session: ProviderSession = await provider.start({ cwd }, (event) => {
    live.onEvent(event);
    if (event.type === 'approval-requested') {
      // Only the file this test asks for may be written; anything else is denied.
      const allowed =
        event.request.action === 'edit' && event.request.paths?.includes('hello.txt') === true;
      void session.answerApproval(event.request.id, {
        decision: allowed ? 'allow-once' : 'deny',
      });
    }
    if (event.type === 'question-asked') {
      // Chooses Tabs or Light, whichever the question offers.
      const question = event.request.questions[0];
      const choice = question?.options.find((option) => ['Tabs', 'Light'].includes(option.label));
      void session.answerQuestion(event.request.id, {
        decision: 'answer',
        answers:
          question === undefined || choice === undefined
            ? {}
            : { [question.id]: { selected: [choice.label] } },
      });
    }
  });

  await session.send('Reply with exactly one word: ready');
  await live.until((_, events) => turnsEnded(events) === 1);
  expect(lastAgentText(live.state).toLowerCase()).toContain('ready');
  expect(live.events.some((event) => event.type === 'message-delta')).toBe(true);
  // The session started in auto, and Claude Code's own init message confirmed it.
  expect(
    live.events.filter((event) => event.type === 'mode' && event.mode === 'auto'),
  ).toHaveLength(2);

  await session.send(
    'Use the Write tool to create a file named hello.txt that contains exactly: hi',
  );
  await live.until((_, events) => turnsEnded(events) === 2);
  expect(existsSync(join(cwd, 'hello.txt'))).toBe(true);
  expect(readFileSync(join(cwd, 'hello.txt'), 'utf8').trim()).toBe('hi');
  expect(
    live.events.some((event) => event.type === 'file-change' && event.change.path === 'hello.txt'),
  ).toBe(true);

  await session.send(
    'Use the AskUserQuestion tool to ask me one question, whether I prefer tabs or spaces, with the options Tabs and Spaces. Then reply with one word: the option I chose.',
  );
  await live.until((_, events) => turnsEnded(events) === 3);
  expect(live.events.some((event) => event.type === 'question-asked')).toBe(true);
  expect(lastAgentText(live.state).toLowerCase()).toContain('tabs');

  await session.setMode('yolo');
  expect(live.state.mode).toBe('yolo');
  expect(live.state.models?.length).toBeGreaterThan(0);

  // The model and the effort switch in place; the next turn's init names the model now in use. In yolo,
  // Claude's questions still reach the user: Claude Code sends AskUserQuestion to canUseTool even in
  // bypassPermissions, although the SDK warns that canUseTool is not invoked there.
  await session.setModel('haiku');
  await session.setEffort('low');
  await session.send(
    'Use the AskUserQuestion tool to ask me one question, whether I prefer a light or a dark theme, with the options Light and Dark. Then reply with one word: the option I chose.',
  );
  await live.until((_, events) => turnsEnded(events) === 4);
  expect(live.events.filter((event) => event.type === 'question-asked')).toHaveLength(2);
  expect(lastAgentText(live.state).toLowerCase()).toContain('light');
  expect(live.state.model).toContain('haiku');
  expect(live.state.effort).toBe('low');

  // The gateway switches between turns, in a new Claude Code process that continues the session.
  await session.setGateway('plain');
  expect(live.state.gateway).toBe('plain');
  await session.send(
    'What was the one word you replied with first in this conversation? Reply with that word only.',
  );
  await live.until((_, events) => turnsEnded(events) === 5);
  expect(lastAgentText(live.state).toLowerCase()).toContain('ready');
  expect(live.events.some((event) => event.type === 'closed')).toBe(false);

  await session.close();
  await live.until((state) => state.closed);

  const history = await provider.listSessions(cwd, 10);
  expect(history.map((entry) => entry.id)).toContain(session.id);

  const replay = recorder();
  const resumed = await provider.resume({ cwd, sessionId: session.id }, (event) => {
    replay.onEvent(event);
  });
  await replay.until((state) => !state.loadingHistory);
  const userTexts = replay.events.flatMap((event) =>
    event.type === 'message' && event.role === 'user' ? [event.text] : [],
  );
  expect(userTexts[0]).toBe('Reply with exactly one word: ready');
  await resumed.close();
  await replay.until((state) => state.closed);
}, 300_000);
