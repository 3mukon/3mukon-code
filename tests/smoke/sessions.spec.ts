import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { channels } from '../../src/app/shared/bridge';
import {
  initialSessionState,
  type SessionState,
  type TimelineItem,
} from '../../src/sessions/shared/session-state';
import type { SessionSummary } from '../../src/sessions/shared/sessions';
import { answerQuestion, dataFolder, launch, withApp } from './app';

// A session that the main process lists and gives in place of the host's, so that no provider runs: a
// long timeline of messages and tool calls, each with text for VoiceOver alone.
const summary: SessionSummary = {
  id: 's1',
  provider: 'codex',
  sessionId: 'p1',
  cwd: '/Users/me/web',
  title: 'Long session',
  status: 'idle',
  activeAt: 0,
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
          [channels.sessions.list, { sessions: [summary], archived: 0, shown: [] }],
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
          [channels.sessions.list, { sessions: [waiting], archived: 0, shown: [] }],
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

test('a session the app started in an earlier run is listed, shows the settings it last had, and resumes with the next message', async () => {
  const data = dataFolder();
  // The app's own record of the session, as an earlier run left it.
  writeFileSync(
    join(data.path, 'sessions.json'),
    JSON.stringify({
      sessions: [
        {
          id: 'kept',
          provider: 'claude-code',
          sessionId: 'p9',
          cwd: '/Users/me/web',
          title: 'Earlier session',
          activeAt: 1,
          mode: 'yolo',
          gateway: null,
          model: null,
          effort: null,
          sandbox: 'read-only',
        },
      ],
    }),
  );
  const app = await launch(data.path);
  try {
    const window = await app.firstWindow();
    const row = window.getByRole('button', { name: /Earlier session/ });
    await expect(row).toBeVisible();
    // The main process's resume, which the test records and holds back, so that no provider runs.
    await app.evaluate(({ ipcMain }, channel) => {
      const resumed: unknown[][] = [];
      (globalThis as unknown as { resumed: unknown[][] }).resumed = resumed;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...values: unknown[]) => {
        resumed.push(values);
        return new Promise(() => undefined);
      });
    }, channels.sessions.resume);
    await row.click();
    const page = window.getByRole('main');
    // Showing it starts nothing; its settings are those it last had, yolo too.
    await expect(page.getByRole('combobox', { name: 'Permission mode' }).first()).toHaveValue(
      'yolo',
    );
    await expect(page.getByRole('combobox', { name: 'Sandbox' }).first()).toHaveValue('read-only');
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Continue');
    await composer.press('Enter');
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { resumed: unknown[][] }).resumed))
      .toEqual([
        [
          'kept',
          {
            mode: 'yolo',
            gateway: null,
            model: null,
            effort: null,
            sandbox: 'read-only',
            message: 'Continue',
            images: [],
          },
        ],
      ]);
    await expect(page.getByText('Continue')).toBeVisible();
  } finally {
    await app.close();
    data.remove();
  }
});

test('a session has its history read ahead as the pointer rests on its row, and drags from the Sessions list into the panel area, into several panels too', async () => {
  const data = dataFolder();
  const record = (id: string, title: string, activeAt: number) => ({
    id,
    provider: 'claude-code',
    sessionId: `p-${id}`,
    cwd: '/Users/me/web',
    title,
    activeAt,
    mode: 'auto',
    gateway: null,
    model: null,
    effort: null,
    sandbox: 'workspace-write',
  });
  writeFileSync(
    join(data.path, 'sessions.json'),
    JSON.stringify({
      sessions: [record('first', 'Fix the build', 2), record('second', 'Write the docs', 1)],
    }),
  );
  const app = await launch(data.path);
  try {
    const window = await app.firstWindow();
    const list = window.getByRole('list', { name: 'Sessions' });
    const row = (name: RegExp) => list.getByRole('button', { name });
    await expect(row(/Fix the build/)).toBeVisible();
    // The main process's read ahead, which the test records instead, so that no provider runs.
    await app.evaluate(({ ipcMain }, channel) => {
      const read: unknown[] = [];
      (globalThis as unknown as { read: unknown[] }).read = read;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, id: unknown) => {
        read.push(id);
      });
    }, channels.sessions.preload);
    await row(/Fix the build/).hover();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { read: unknown[] }).read))
      .toEqual(['first']);

    // Dropped on the empty main area, a session fills it; near its panel's right edge, another
    // splits it. No drag of the system's starts, so that no copy badge shows (L-0003).
    const drags = () => window.evaluate(() => (globalThis as unknown as { drags: number }).drags);
    await window.evaluate(() => {
      const page = globalThis as unknown as {
        drags: number;
        document: {
          addEventListener: (type: string, listener: () => void, capture: boolean) => void;
        };
      };
      page.drags = 0;
      page.document.addEventListener('dragstart', () => (page.drags += 1), true);
    });
    const main = window.getByRole('main');
    await row(/Fix the build/).dragTo(main);
    const first = main.getByRole('region', { name: 'Fix the build' });
    await expect(first).toBeVisible();
    const firstBox = await first.boundingBox();
    if (firstBox === null) throw new Error('The panel is not shown.');
    await row(/Write the docs/).dragTo(first, {
      targetPosition: { x: firstBox.width - 10, y: firstBox.height / 2 },
    });
    const second = main.getByRole('region', { name: 'Write the docs' });
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect
      .poll(async () => {
        const [left, right] = [await first.boundingBox(), await second.boundingBox()];
        return left !== null && right !== null && left.x < right.x;
      })
      .toBe(true);
    // A session that shows already opens in another panel too, as a file does.
    const secondBox = await second.boundingBox();
    if (secondBox === null) throw new Error('The panel is not shown.');
    await row(/Fix the build/).dragTo(second, {
      targetPosition: { x: secondBox.width - 10, y: secondBox.height / 2 },
    });
    await expect(main.getByRole('region', { name: 'Fix the build' })).toHaveCount(2);
    await expect(main.getByRole('region', { name: 'Fix the build' }).last()).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(await drags()).toBe(0);
  } finally {
    await app.close();
    data.remove();
  }
});

test('the Sessions list renders only the rows in view, and the archived sessions load only as their list opens', async () => {
  const data = dataFolder();
  // The app's records of an earlier run: the 1,000 sessions the Sessions list keeps, the first the
  // most recently active, and three archived ones.
  const record = (id: string, title: string, activeAt: number, archived = false) => ({
    id,
    provider: 'claude-code',
    sessionId: `p-${id}`,
    cwd: '/Users/me/web',
    title,
    activeAt,
    ...(archived ? { archived: true } : {}),
    mode: 'auto',
    gateway: null,
    model: null,
    effort: null,
    sandbox: 'workspace-write',
  });
  writeFileSync(
    join(data.path, 'sessions.json'),
    JSON.stringify({
      sessions: [
        ...Array.from({ length: 1_000 }, (_, index) =>
          record(`s${String(index)}`, `Session ${String(index)}`, 10_000 - index),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          record(`a${String(index)}`, `Archived ${String(index)}`, 100 - index, true),
        ),
      ],
    }),
  );
  const app = await launch(data.path);
  try {
    const window = await app.firstWindow();
    const list = window.getByRole('list', { name: 'Sessions' });
    const rows = list.getByRole('listitem');
    await expect(list.getByRole('button', { name: /Session 0 / })).toBeInViewport();
    expect((await list.getByRole('button', { name: /Session 0 / }).boundingBox())?.height).toBe(28);
    // Of the thousand, only the rows in view and a few below them are rendered.
    expect(await rows.count()).toBeLessThan(60);
    // Scrolled to its end with the wheel, the list shows its last session, still rendering only a few
    // rows.
    const box = await list.boundingBox();
    if (box === null) throw new Error('The list is not shown.');
    await window.mouse.move(box.x + box.width / 2, box.y + 14);
    await window.mouse.wheel(0, 40_000);
    await expect(list.getByRole('button', { name: /Session 999 / })).toBeInViewport();
    expect(await rows.count()).toBeLessThan(60);
    const overflow = await window.evaluate(() => {
      const root = (
        globalThis as unknown as {
          document: { documentElement: { scrollHeight: number; clientHeight: number } };
        }
      ).document.documentElement;
      return root.scrollHeight - root.clientHeight;
    });
    expect(overflow).toBe(0);
    // The archived sessions are not in the window until their list opens.
    await expect(window.getByText('Archived 0')).toHaveCount(0);
    await window.getByRole('button', { name: 'Archived sessions' }).click();
    const dropdown = window.getByRole('group', { name: 'Archived sessions' });
    await expect(dropdown.getByRole('button', { name: /Archived 0 / })).toBeInViewport();
    await expect(dropdown.getByRole('listitem')).toHaveCount(3);
    // One shown from there opens in a panel titled by it, as the dropdown closes.
    await dropdown.getByRole('button', { name: /Archived 1 / }).click();
    await expect(
      window.getByRole('main').getByRole('region', { name: 'Archived 1' }),
    ).toBeVisible();
    await expect(dropdown).toBeHidden();
  } finally {
    await app.close();
    data.remove();
  }
});

test('a session’s menu and the question before removing it are drawn in the window, in the app’s own look', async () => {
  const data = dataFolder();
  const record = (id: string, title: string, activeAt: number) => ({
    id,
    provider: 'claude-code',
    sessionId: `p-${id}`,
    cwd: '/Users/me/web',
    title,
    activeAt,
    mode: 'auto',
    gateway: null,
    model: null,
    effort: null,
    sandbox: 'workspace-write',
  });
  writeFileSync(
    join(data.path, 'sessions.json'),
    JSON.stringify({
      sessions: [record('kept', 'Earlier session', 2), record('other', 'Other session', 1)],
    }),
  );
  const app = await launch(data.path);
  try {
    const window = await app.firstWindow();
    const row = window.getByRole('button', { name: /Earlier session/ });
    // A secondary click opens the menu at the pointer, a sheet of the window's paper, with the focus
    // on its first item. As a person clicks, the menu shows while the button is still down, and stays
    // as it comes up; Escape closes it without a choice.
    const rowBox = await row.boundingBox();
    if (rowBox === null) throw new Error('The session is not listed.');
    await window.mouse.move(rowBox.x + 30, rowBox.y + 10);
    await window.mouse.down({ button: 'right' });
    const menu = window.getByRole('menu');
    await expect(menu).toBeVisible();
    await window.mouse.up({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Archive', 'Remove from List']);
    await expect(menu).toHaveClass(/\bpaper\b/);
    await expect(menu.getByRole('menuitem', { name: 'Archive' })).toBeFocused();
    // At the pointer, which lies on whole pixels.
    const menuBox = await menu.boundingBox();
    expect(menuBox?.x).toBeCloseTo(rowBox.x + 30, 0);
    expect(menuBox?.y).toBeCloseTo(rowBox.y + 10, 0);
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // Removing asks first, in the window, with the focus on Cancel, the default answer.
    await row.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Remove from List' }).click();
    const question = window.getByRole('alertdialog', {
      name: 'Remove “Earlier session” from the list?',
    });
    await expect(question).toHaveClass(/\bpaper\b/);
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(question).toHaveCount(0);
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Remove from List' }).click();
    await answerQuestion(window, 'Remove');
    await expect(row).toHaveCount(0);
    // A session that is not working is archived without a question.
    const other = window.getByRole('button', { name: /Other session/ });
    await other.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Archive' }).click();
    await expect(other).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Archived sessions' })).toBeEnabled();
  } finally {
    await app.close();
    data.remove();
  }
});
