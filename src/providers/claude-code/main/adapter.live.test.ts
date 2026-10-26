import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
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

it('streams turns in auto mode, writes, answers a question, switches to yolo and resumes', async () => {
  const provider = createClaudeCodeProvider();
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
      const question = event.request.questions[0];
      void session.answerQuestion(event.request.id, {
        decision: 'answer',
        answers: question === undefined ? {} : { [question.id]: { selected: ['Tabs'] } },
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
