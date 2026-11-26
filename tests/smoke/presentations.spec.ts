import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { channels } from '../../src/app/shared/bridge';
import type { Artifact, PresentationRendererMessage } from '../../src/panels/shared/presentation';
import { initialSessionState } from '../../src/sessions/shared/session-state';
import { AutomationBroker } from '../../src/toolset/main/broker';
import { withApp } from './app';

// A real window and preload over synthetic session/presentation IPC. The Node contract suite joins
// the real host and renderer; here the window's focus, activity and visible Show answers are tested
// without starting a model session. Startup probes still use withApp's empty provider settings.
test('presents an artifact without taking focus and shows the result of the activity’s Show', async () => {
  const owner = 'synthetic-session';
  const presentation = {
    id: 'synthetic-presentation',
    title: 'Synthetic result',
    version: 1,
    items: [
      { content: { kind: 'artifact' as const, artifactId: 'synthetic-artifact' }, box: null },
    ],
  };
  const broker = new AutomationBroker([
    {
      name: 'panel_present',
      family: 'panel',
      description: 'Synthetic presentation',
      inputSchema: z.object({}),
      availability: { tools: 'ready', images: 'unknown' },
      plan: () => ({
        operation: null,
        effect: 'present',
        delivery: 'background',
        mayActivate: false,
      }),
      execute: () =>
        Promise.resolve({
          outcome: { status: 'verified', value: null },
          presentations: [presentation],
        }),
    },
  ]);
  try {
    await test.step('Bind the synthetic session', () =>
      broker.bind(owner, process.cwd(), { mode: 'auto', sandbox: 'read-only' }));
    const access = broker.openAccess(owner);
    broker.beginTurn(owner);
    const result = await test.step('Record a synthetic presentation', () =>
      broker.dispatch(access, 'panel_present', {}, { actionId: 'synthetic-present' }));
    broker.providerResult(access, 'panel_present', 'native-tool', result.automation);
    const automation = broker.snapshot(owner);
    const state = {
      ...initialSessionState(),
      title: 'Synthetic session',
      timeline: [
        {
          type: 'tool' as const,
          id: 'native-tool',
          kind: 'other' as const,
          title: 'panel_present',
          status: 'completed' as const,
          output: '',
          changes: [],
        },
      ],
    };
    const artifact: Artifact = {
      format: 'markdown',
      title: presentation.title,
      text: '# Synthetic artifact\n\nFixture content.',
    };
    await withApp(async (app) => {
      const window = await test.step('Read the isolated window', () => app.firstWindow());
      await test.step('Wait for the app page', () =>
        window.getByRole('heading', { name: 'Sessions' }).waitFor());
      await app.evaluate(
        ({ ipcMain, BrowserWindow }, data) => {
          const automation: unknown = JSON.parse(data.automation);
          const answers = [
            [
              data.channels.sessions.list,
              {
                sessions: [
                  {
                    id: data.owner,
                    provider: 'codex-cli',
                    sessionId: 'native-session',
                    cwd: '/synthetic',
                    title: 'Synthetic session',
                    status: 'idle',
                    activeAt: 0,
                  },
                ],
                archived: 0,
                shown: [],
              },
            ],
            [data.channels.sessions.snapshot, { seq: 0, state: data.state }],
            [data.channels.automation.snapshot, automation],
            [data.channels.automation.subscribe, undefined],
            [data.channels.automation.unsubscribe, undefined],
            [data.channels.presentations.artifact, data.artifact],
          ] as const;
          for (const [channel, answer] of answers) {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, () => answer);
          }
          let epoch = '';
          let version = 0;
          let serial = 0;
          let pending: string | null = null;
          const send = (message: unknown) => {
            BrowserWindow.getAllWindows()[0]?.webContents.send(
              data.channels.presentations.message,
              message,
            );
          };
          const fixture = {
            expired: false,
            ready: () => epoch !== '',
            present() {
              send({
                kind: 'present',
                epoch,
                commandId: `fixture-${String(++serial)}`,
                owner: data.owner,
                presentationId: data.presentation.id,
                version,
                title: data.presentation.title,
                items: data.presentation.items.map((item) => item.content),
                placement: { side: 'right', direction: 'row' },
              });
            },
          };
          (globalThis as unknown as { presentationFixture: typeof fixture }).presentationFixture =
            fixture;
          ipcMain.removeHandler(data.channels.presentations.report);
          ipcMain.handle(
            data.channels.presentations.report,
            (_event, message: PresentationRendererMessage) => {
              if (message.kind === 'snapshot') epoch = message.epoch;
              else if (message.kind === 'changed' || message.kind === 'applied') {
                version = message.state.version;
                if (message.kind === 'applied' && pending) {
                  send({ kind: 'show-answer', epoch, requestId: pending, outcome: 'shown' });
                  pending = null;
                }
              } else if (message.kind === 'show') {
                if (fixture.expired)
                  send({
                    kind: 'show-answer',
                    epoch,
                    requestId: message.requestId,
                    outcome: 'expired',
                  });
                else {
                  pending = message.requestId;
                  fixture.present();
                }
              }
              return true;
            },
          );
        },
        { channels, owner, presentation, artifact, state, automation: JSON.stringify(automation) },
      );
      await window.reload();
      await window.getByRole('button', { name: /Synthetic session/ }).click();
      const session = window.getByRole('region', { name: 'Synthetic session', exact: true });
      await expect(session.getByText('Showed Synthetic result beside this session')).toBeVisible();
      const message = session.getByRole('textbox', { name: 'Message' });
      await message.fill('Unsent draft');
      await expect
        .poll(() =>
          app.evaluate(() =>
            (
              globalThis as unknown as { presentationFixture: { ready(): boolean } }
            ).presentationFixture.ready(),
          ),
        )
        .toBe(true);
      await app.evaluate(() => {
        (
          globalThis as unknown as { presentationFixture: { present(): void } }
        ).presentationFixture.present();
      });
      const shown = window.getByRole('region', { name: 'Synthetic result', exact: true });
      await expect(shown.getByRole('heading', { name: 'Synthetic artifact' })).toBeVisible();
      await expect(message).toBeFocused();
      await expect(message).toHaveValue('Unsent draft');
      await shown.getByRole('button', { name: 'Close panel', exact: true }).click();
      await session.getByRole('button', { name: 'Show', exact: true }).click();
      await expect(shown.getByRole('heading', { name: 'Synthetic artifact' })).toBeVisible();
      await shown.getByRole('button', { name: 'Close panel', exact: true }).click();
      await app.evaluate(() => {
        (
          globalThis as unknown as { presentationFixture: { expired: boolean } }
        ).presentationFixture.expired = true;
      });
      await session.getByRole('button', { name: 'Show', exact: true }).click();
      await expect(session.getByText('It’s no longer available.')).toBeVisible();
      await expect(shown).toHaveCount(0);
      await expect(message).toHaveValue('Unsent draft');
    }, '--lang=en-US');
  } finally {
    await broker.close();
  }
});
