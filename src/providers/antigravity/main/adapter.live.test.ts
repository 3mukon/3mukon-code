import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
// cache. The session's folder lies in a folder of its own among the user's caches, outside the
// temporary folders, beside which yolo writes a file; both are removed afterwards.

const root = realpathSync(
  mkdtempSync(join(homedir(), 'Library', 'Caches', '3mukon-code-antigravity-live-')),
);
const cwd = join(root, 'work');
mkdirSync(cwd);
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
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

it('asks its own question in yolo, runs a command outside the folder there without asking, edits in auto in a new process, and replays (ADR-0043)', async () => {
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
  // Yolo counts as full access, whatever level was asked for.
  expect(live.state.mode).toBe('yolo');
  expect(live.state.sandbox).toBe('full-access');

  // Antigravity's question tool asks in yolo, and its answer reaches the agent.
  await session.send(FIRST);
  await live.until((_, events) => turnsEnded(events) === 1);
  expect(live.events.filter((event) => event.type === 'question-asked')).toHaveLength(1);
  expect(messages(live.state, 'agent').at(-1)?.toLowerCase()).toContain('blue');

  // Yolo runs a command that writes outside the session's folder, and asks nothing.
  await session.send(
    'Use your shell tool to run exactly `touch ../outside.txt`, then reply with one word: done',
  );
  await live.until((_, events) => turnsEnded(events) === 2);
  expect(existsSync(join(root, 'outside.txt'))).toBe(true);
  expect(live.events.some((event) => event.type === 'approval-requested')).toBe(false);

  // Auto moves the session to a new process, under the sandbox, and the edit goes through: Antigravity's
  // auto mode approves it where the account has it, and otherwise the user, who allows it here.
  await session.setMode('auto');
  expect(live.state.sandbox).toBe('workspace-write');
  await session.send(
    'Use your file editing tool, not the shell, to create a file named notes.txt that contains exactly: ok. Then reply with one word: done',
  );
  await live.until((_, events) => turnsEnded(events) === 3);
  expect(readFileSync(join(cwd, 'notes.txt'), 'utf8').trim()).toBe('ok');

  // The new process resumed the session with its conversation.
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
