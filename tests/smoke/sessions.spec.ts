import { expect, test } from '@playwright/test';
import { channels } from '../../src/app/shared/bridge';
import {
  initialSessionState,
  type SessionState,
  type TimelineItem,
} from '../../src/sessions/shared/session-state';
import type { SessionSummary } from '../../src/sessions/shared/sessions';
import { withApp } from './app';

// A session that the main process lists and gives in place of the host's, so that no provider runs: a
// long timeline of messages and tool calls, each with text for VoiceOver alone.
const summary: SessionSummary = {
  id: 's1',
  provider: 'codex',
  sessionId: 'p1',
  cwd: '/Users/me/web',
  title: 'Long session',
  status: 'idle',
  openedAt: 0,
};
const state: SessionState = {
  ...initialSessionState(),
  title: 'Long session',
  timeline: Array.from({ length: 40 }, (_, index): TimelineItem[] => [
    { type: 'message', id: `u${String(index)}`, role: 'user', text: `Step ${String(index)}` },
    {
      type: 'tool',
      id: `t${String(index)}`,
      kind: 'execute',
      title: `pnpm test ${String(index)}`,
      status: 'completed',
      output: 'ok',
      changes: [],
    },
  ]).flat(),
};

test('a long session scrolls within its page, and the window’s page itself never scrolls', async () => {
  await withApp(async (app) => {
    const window = await app.firstWindow();
    await window.getByRole('heading', { name: 'Sessions' }).waitFor();
    await app.evaluate(
      ({ ipcMain }, { answers }) => {
        for (const [channel, answer] of answers) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => answer);
        }
      },
      {
        answers: [
          [channels.sessions.list, [summary]],
          [channels.sessions.snapshot, { seq: 0, state }],
        ] as const,
      },
    );
    await window.reload();
    await window.getByRole('button', { name: /Long session/ }).click();
    const activity = window.getByRole('region', { name: 'Activity' });
    await expect(activity.getByText('Step 39', { exact: true })).toBeVisible();
    // How much taller than the window its page is, and how far the page has scrolled.
    const page = () =>
      window.evaluate(() => {
        const root = (
          globalThis as unknown as {
            document: {
              documentElement: { scrollHeight: number; clientHeight: number; scrollTop: number };
            };
          }
        ).document.documentElement;
        return { overflow: root.scrollHeight - root.clientHeight, scrolled: root.scrollTop };
      });
    expect((await page()).overflow).toBe(0);
    // The wheel scrolls the timeline to its start and past it, then to its end and past it.
    const box = await activity.boundingBox();
    if (box === null) throw new Error('The activity is not shown.');
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, -20_000);
    await window.mouse.wheel(0, 20_000);
    await expect.poll(async () => (await page()).scrolled).toBe(0);
    await expect(window.getByRole('textbox', { name: 'Message' })).toBeInViewport();
  });
});

test('a session waiting on the user shows beside the window buttons, and its approval is answered in place', async () => {
  const waiting: SessionSummary = {
    ...summary,
    title: 'Waiting session',
    status: 'waiting',
    waitingSince: 1,
  };
  const asking: SessionState = {
    ...initialSessionState(),
    title: 'Waiting session',
    turnRunning: true,
    timeline: [
      {
        type: 'approval',
        request: {
          id: 'r1',
          action: 'command',
          command: 'pnpm test',
          canAllowForSession: true,
          denyByDefault: false,
          requestedAt: 1,
        },
      },
    ],
  };
  await withApp(async (app) => {
    const window = await app.firstWindow();
    await window.getByRole('heading', { name: 'Sessions' }).waitFor();
    await app.evaluate(
      ({ ipcMain }, { answers, answerChannel }) => {
        for (const [channel, answer] of answers) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => answer);
        }
        // The answers the window sends, which the test reads back.
        const sent: unknown[][] = [];
        (globalThis as unknown as { sent: unknown[][] }).sent = sent;
        ipcMain.removeHandler(answerChannel);
        ipcMain.handle(answerChannel, (_event, ...values: unknown[]) => {
          sent.push(values);
        });
      },
      {
        answers: [
          [channels.sessions.list, [waiting]],
          [channels.sessions.snapshot, { seq: 0, state: asking }],
        ] as const,
        answerChannel: channels.approvals.answerApproval,
      },
    );
    await window.reload();
    await expect(
      window.getByRole('button', {
        name: 'Sessions waiting on you: 1. Show the one waiting longest (⇧⌘A).',
      }),
    ).toBeVisible();
    // ⇧⌘A shows the waiting session with the focus on its approval, which Return allows once.
    await window.keyboard.press('Shift+Meta+a');
    const approval = window
      .getByRole('main')
      .getByRole('region', { name: 'Waiting session' })
      .getByRole('region', { name: 'Run this command?' });
    await expect(approval.getByText('pnpm test')).toBeVisible();
    await expect(approval).toBeFocused();
    await window.keyboard.press('Enter');
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { sent: unknown[][] }).sent))
      .toEqual([['s1', 'r1', { decision: 'allow-once' }]]);
  });
});
