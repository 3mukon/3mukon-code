import { describe, expect, it, vi } from 'vitest';
import type { ResumeRequest } from '../../sessions/shared/sessions';
import type { AppSettings } from '../../settings/shared/settings';
import { createBridge, type Ipc } from './bridge';

function fakeIpc() {
  const listeners = new Map<string, Set<(event: unknown, ...values: unknown[]) => void>>();
  const ipc = {
    invoke: vi.fn<Ipc['invoke']>(() => Promise.resolve('answer')),
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  } satisfies Ipc;
  const send = (channel: string, value: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({ sender: 'main' }, value);
  };
  return { ipc, send };
}

// The settings the window opened with.
const opening: AppSettings = {
  language: 'zh-Hans',
  appearance: 'dark',
  tooltips: false,
  sidebarHidden: false,
};

describe('createBridge', () => {
  it('scopes automation events to the subscription and owner, including cleanup before acceptance', async () => {
    const { ipc, send } = fakeIpc();
    let resolve!: () => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const bridge = createBridge(ipc, () => '', opening);
    const listener = vi.fn();
    const stop = bridge.automation.subscribe('a', listener);
    const subscriptionId = ipc.invoke.mock.calls[0]?.[2];
    const event = {
      epoch: 'epoch',
      sequence: 1,
      sessionId: 'a',
      value: { kind: 'presentation-notices', notices: [] },
    };
    send('automation:event', { subscriptionId: 'other', event });
    send('automation:event', { subscriptionId, event: { ...event, sessionId: 'b' } });
    expect(listener).not.toHaveBeenCalled();
    send('automation:event', { subscriptionId, event });
    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
    stop();
    stop();
    send('automation:event', { subscriptionId, event });
    expect(listener).toHaveBeenCalledOnce();
    resolve();
    await vi.waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('automation:unsubscribe', subscriptionId);
    });
    expect(
      ipc.invoke.mock.calls.filter(([name]) => name === 'automation:unsubscribe'),
    ).toHaveLength(1);
    await bridge.automation.snapshot('a');
    await bridge.automation.capabilities('a');
    await bridge.automation.callRecord('a', 'call');
    await bridge.automation.callFrames('a', 'call');
    await bridge.automation.icon('a', 'icon');
    await bridge.automation.answer('a', 'request', { decision: 'allow-once' });
    await bridge.automation.stop('a');
    await bridge.automation.endOperation('a', 'operation');
    await bridge.automation.endGrant('a', 'grant');
    expect(ipc.invoke.mock.calls.slice(2)).toEqual([
      ['automation:snapshot', 'a'],
      ['automation:capabilities', 'a'],
      ['automation:call-record', 'a', 'call'],
      ['automation:call-frames', 'a', 'call'],
      ['automation:icon', 'a', 'icon'],
      ['automation:answer', 'a', 'request', { decision: 'allow-once' }],
      ['automation:stop', 'a'],
      ['automation:end-operation', 'a', 'operation'],
      ['automation:end-grant', 'a', 'grant'],
    ]);
  });
  it('carries presentation commands without Electron objects and removes its subscription', async () => {
    const { ipc, send } = fakeIpc();
    const bridge = createBridge(ipc, () => '', opening);
    const listener = vi.fn();
    const stop = bridge.presentations.onMessage(listener);
    const command = {
      kind: 'close',
      commandId: 'c',
      epoch: 'e',
      owner: 'a',
      presentationId: 'p',
      version: 1,
    };
    send('presentations:message', command);
    expect(listener).toHaveBeenCalledExactlyOnceWith(command);
    stop();
    send('presentations:message', command);
    expect(listener).toHaveBeenCalledOnce();
    bridge.presentations.send({ kind: 'cancelled', epoch: 'e', commandId: 'c' });
    await bridge.presentations.artifact('artifact');
    expect(ipc.invoke).toHaveBeenCalledWith('presentations:report', {
      kind: 'cancelled',
      epoch: 'e',
      commandId: 'c',
    });
    expect(ipc.invoke).toHaveBeenCalledWith('presentations:artifact', 'artifact');
  });
  it('invokes one channel for each call, with the call’s values, and returns the answer', async () => {
    const { ipc } = fakeIpc();
    const bridge = createBridge(ipc, () => '', opening);
    expect(await bridge.workspaces.get()).toBe('answer');
    await bridge.workspaces.add();
    await bridge.workspaces.select('w1');
    await bridge.workspaces.showMenu('w1', 'src');
    await bridge.workspaces.listFolder('w1', 'src/app');
    await bridge.sessions.list();
    await bridge.sessions.archived();
    await bridge.sessions.act('s2', 'unarchive');
    await bridge.sessions.search('build', true);
    await bridge.settings.get();
    await bridge.settings.set({ appearance: 'light' });
    const resumed: ResumeRequest = {
      mode: 'yolo',
      gateway: null,
      model: null,
      effort: null,
      sandbox: 'read-only',
      message: 'Go on',
      images: [],
    };
    await bridge.sessions.resume('s1', resumed);
    await bridge.sessions.showMenu('s1');
    await bridge.sessions.models('codex', null, '/Users/me/web', true);
    await bridge.sessions.choices();
    await bridge.sessions.rememberChoice('/Users/me/web', {
      provider: 'codex',
      gateway: null,
      model: 'gpt-6-astra',
      effort: 'medium',
      sandbox: 'read-only',
    });
    await bridge.sessions.start({
      provider: 'codex',
      cwd: '/Users/me/web',
      mode: 'auto',
      gateway: null,
      model: null,
      effort: null,
      sandbox: 'workspace-write',
      message: 'Hi',
      images: [],
    });
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    await bridge.sessions.send('s1', 'Look', [image]);
    await bridge.approvals.answerApproval('s1', 'r1', { decision: 'allow-once' });
    await bridge.approvals.answerQuestion('s1', 'q1', { decision: 'decline' });
    await bridge.sessions.setSandbox('s1', 'read-only');
    await bridge.sessions.snapshot('s1');
    await bridge.sessions.preload('s2');
    await bridge.sessions.copyText('Hi');
    await bridge.sessions.copyImage(image);
    await bridge.sessions.saveImage(image);
    await bridge.sessions.imageMenu();
    await bridge.files.open('/Users/me/web/a.ts');
    await bridge.files.save('/Users/me/web/a.ts', 'a');
    await bridge.files.watch(['/Users/me/web/a.ts']);
    await bridge.files.confirmClose('a.ts');
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspaces:get'],
      ['workspaces:add'],
      ['workspaces:select', 'w1'],
      ['workspaces:show-menu', 'w1', 'src'],
      ['workspaces:list-folder', 'w1', 'src/app'],
      ['sessions:list'],
      ['sessions:archived'],
      ['sessions:act', 's2', 'unarchive'],
      ['sessions:search', 'build', true],
      ['settings:get'],
      ['settings:set', { appearance: 'light' }],
      ['sessions:resume', 's1', resumed],
      ['sessions:show-menu', 's1'],
      ['sessions:models', 'codex', null, '/Users/me/web', true],
      ['sessions:choices'],
      [
        'sessions:remember-choice',
        '/Users/me/web',
        {
          provider: 'codex',
          gateway: null,
          model: 'gpt-6-astra',
          effort: 'medium',
          sandbox: 'read-only',
        },
      ],
      [
        'sessions:start',
        {
          provider: 'codex',
          cwd: '/Users/me/web',
          mode: 'auto',
          gateway: null,
          model: null,
          effort: null,
          sandbox: 'workspace-write',
          message: 'Hi',
          images: [],
        },
      ],
      ['sessions:send', 's1', 'Look', [image]],
      ['approvals:answer-approval', 's1', 'r1', { decision: 'allow-once' }],
      ['approvals:answer-question', 's1', 'q1', { decision: 'decline' }],
      ['sessions:set-sandbox', 's1', 'read-only'],
      ['sessions:snapshot', 's1'],
      ['sessions:preload', 's2'],
      ['sessions:copy-text', 'Hi'],
      ['sessions:copy-image', image],
      ['sessions:save-image', image],
      ['sessions:image-menu'],
      ['files:open', '/Users/me/web/a.ts'],
      ['files:save', '/Users/me/web/a.ts', 'a'],
      ['files:watch', ['/Users/me/web/a.ts']],
      ['files:confirm-close', 'a.ts'],
    ]);
  });

  it('sends dropped items as the paths of their files', async () => {
    const { ipc } = fakeIpc();
    const paths = new Map([['web', '/Users/me/web']]);
    const bridge = createBridge(ipc, (file) => paths.get(file.name) ?? '', opening);
    await bridge.workspaces.addDropped([new File([], 'web'), new File([], 'text')]);
    await bridge.panels.itemsAt([new File([], 'web')]);
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspaces:add-dropped', ['/Users/me/web', '']],
      ['panels:items-at', ['/Users/me/web']],
    ]);
  });

  it('passes on what the main process reports, without its event, until the page stops listening', () => {
    const { ipc, send } = fakeIpc();
    const bridge = createBridge(ipc, () => '', opening);
    const workspaces = vi.fn();
    const sessions = vi.fn();
    const events = vi.fn();
    const files = vi.fn();
    const settings = vi.fn();
    const stop = bridge.workspaces.onChange(workspaces);
    bridge.settings.onChange(settings);
    bridge.sessions.onChange(sessions);
    bridge.sessions.onEvent(events);
    bridge.files.onChange(files);
    send('workspaces:changed', { workspaces: [], selectedId: null });
    send('sessions:changed', { sessions: [], archived: 2, shown: [] });
    send('sessions:event', { id: 's1', seq: 1, event: { type: 'turn-started' } });
    send('files:changed', '/Users/me/web/a.ts');
    send('settings:changed', { language: 'en', appearance: 'system' });
    stop();
    send('workspaces:changed', { workspaces: [], selectedId: null });
    expect(workspaces.mock.calls).toEqual([[{ workspaces: [], selectedId: null }]]);
    expect(sessions.mock.calls).toEqual([[{ sessions: [], archived: 2, shown: [] }]]);
    expect(events.mock.calls).toEqual([['s1', 1, { type: 'turn-started' }]]);
    expect(files.mock.calls).toEqual([['/Users/me/web/a.ts']]);
    expect(settings.mock.calls).toEqual([[{ language: 'en', appearance: 'system' }]]);
    // The settings the window opened with need no call.
    expect(bridge.settings.initial).toEqual(opening);
  });
});
