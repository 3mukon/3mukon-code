import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { ProviderSession } from '../../../sessions/main/provider';
import type { SessionEvent } from '../../../sessions/shared/events';
import {
  applyEvent,
  initialSessionState,
  type SessionState,
} from '../../../sessions/shared/session-state';
import { pinnedInstall } from '../../../../tests/provider-copies';
import { createAntigravityProvider } from './adapter';

// Drives a real Antigravity session on the signed-in account, on Gemini 3.8 Flash at low thinking, in
// four short turns. Only `corepack pnpm run test:live` runs it, never the check command: it needs
// Antigravity signed in on an account Google serves, and it uses a little of the account's quota. It
// runs the pinned build, which it downloads from Google's address once per version into node_modules'
// cache. Antigravity's terminal sandbox lets commands write in temporary folders, so the session's
// folder lies outside them, among the user's caches, and is removed afterwards.

const cwd = realpathSync(
  mkdtempSync(join(homedir(), 'Library', 'Caches', '3mukon-code-antigravity-live-')),
);
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

function messages(state: SessionState, role: 'user' | 'agent'): string[] {
  return state.timeline.flatMap((item) =>
    item.type === 'message' && item.role === role ? [item.text] : [],
  );
}

const FIRST =
  'Use your question tool to ask me exactly one question, "Which color?", with the options Red and Blue. Then reply with one word: the color I chose.';

it('asks its own question in yolo, refuses an edit at read-only in yolo, edits at workspace-write, resumes in a new process at full access, and replays', async () => {
  const provider = createAntigravityProvider({ install: pinnedInstall('antigravity') });
  expect(await provider.listGateways()).toEqual([]);
  expect((await provider.listModels(null)).length).toBeGreaterThan(0);

  const live = recorder();
  const session: ProviderSession = await provider.start(
    { cwd, mode: 'yolo', model: 'gemini-3.8-flash', effort: 'low', sandbox: 'read-only' },
    (event) => {
      live.onEvent(event);
      // Anything that reaches the user is allowed only for the file this test asks for.
      if (event.type === 'approval-requested') {
        const wanted = event.request.paths?.some((path) => path.endsWith('notes.txt')) === true;
        void session.answerApproval(event.request.id, {
          decision: wanted ? 'allow-once' : 'deny',
        });
      }
      // Chooses Blue where a question offers it, and declines anything else.
      if (event.type === 'question-asked') {
        const question = event.request.questions[0];
        const choice = question?.options.find((option) => option.label === 'Blue');
        void session.answerQuestion(
          event.request.id,
          question === undefined || choice === undefined
            ? { decision: 'decline' }
            : { decision: 'answer', answers: { [question.id]: { selected: [choice.label] } } },
        );
      }
    },
  );
  expect(live.state.mode).toBe('yolo');
  expect(live.state.sandbox).toBe('read-only');

  // Antigravity's question tool asks in yolo, and its answer reaches the agent.
  await session.send(FIRST);
  await live.until((_, events) => turnsEnded(events) === 1);
  expect(live.events.filter((event) => event.type === 'question-asked')).toHaveLength(1);
  expect(messages(live.state, 'agent').at(-1)?.toLowerCase()).toContain('blue');

  // At read-only an edit is beyond the level, which yolo denies without asking (ADR-0040); Antigravity
  // then ends the turn.
  await session.send(
    'Use your file tools to create a file named blocked.txt that contains exactly: blocked. Do not try any other way.',
  );
  await live.until((_, events) => turnsEnded(events) === 2);
  expect(
    live.events.some(
      (event) => event.type === 'tool' && event.kind === 'edit' && event.status === 'failed',
    ),
  ).toBe(true);
  expect(live.events.some((event) => event.type === 'approval-requested')).toBe(false);
  expect(existsSync(join(cwd, 'blocked.txt'))).toBe(false);

  // Workspace-write keeps the process, and in auto the edit goes through: Antigravity's auto mode
  // approves it where the account has it, and otherwise the user, who allows it here.
  await session.setSandbox('workspace-write');
  await session.setMode('auto');
  expect(live.state.sandbox).toBe('workspace-write');
  await session.send(
    'Use your file editing tool, not the shell, to create a file named notes.txt that contains exactly: ok. Then reply with one word: done',
  );
  await live.until((_, events) => turnsEnded(events) === 3);
  expect(readFileSync(join(cwd, 'notes.txt'), 'utf8').trim()).toBe('ok');

  // Full access moves the session to a new process, which resumes it with its conversation.
  await session.setSandbox('full-access');
  await session.send('What one word did you reply with last? Answer with that word alone.');
  await live.until((_, events) => turnsEnded(events) === 4);
  expect(messages(live.state, 'agent').at(-1)?.toLowerCase()).toContain('done');
  expect(live.events.some((event) => event.type === 'closed' || event.type === 'error')).toBe(
    false,
  );

  await session.close();
  await live.until((state) => state.closed);

  const history = await provider.listSessions(cwd, 10);
  expect(history.map((entry) => entry.id)).toContain(session.id);

  const replay = recorder();
  const resumed = await provider.resume(
    { cwd, sessionId: session.id, sandbox: 'workspace-write' },
    (event) => {
      replay.onEvent(event);
    },
  );
  await replay.until((state) => state.sandbox !== undefined);
  expect(messages(replay.state, 'user')[0]).toBe(FIRST);
  await resumed.close();
  await replay.until((state) => state.closed);
  await provider.close();
}, 600_000);
