import { describe, expect, it, vi } from 'vitest';
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

describe('createBridge', () => {
  it('invokes one channel for each call, with the call’s values, and returns the answer', async () => {
    const { ipc } = fakeIpc();
    const bridge = createBridge(ipc, () => '');
    expect(await bridge.workspaces.get()).toBe('answer');
    await bridge.workspaces.add();
    await bridge.workspaces.select('w1');
    await bridge.workspaces.showMenu('w1');
    await bridge.workspaces.listFolder('w1', 'src/app');
    await bridge.sessions.list();
    await bridge.sessions.models('codex', null);
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
    await bridge.sessions.setSandbox('s1', 'read-only');
    await bridge.sessions.snapshot('s1');
    await bridge.sessions.copyText('Hi');
    await bridge.sessions.copyImage(image);
    await bridge.sessions.saveImage(image);
    await bridge.sessions.imageMenu();
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspaces:get'],
      ['workspaces:add'],
      ['workspaces:select', 'w1'],
      ['workspaces:show-menu', 'w1'],
      ['workspaces:list-folder', 'w1', 'src/app'],
      ['sessions:list'],
      ['sessions:models', 'codex', null],
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
      ['sessions:set-sandbox', 's1', 'read-only'],
      ['sessions:snapshot', 's1'],
      ['sessions:copy-text', 'Hi'],
      ['sessions:copy-image', image],
      ['sessions:save-image', image],
      ['sessions:image-menu'],
    ]);
  });

  it('sends dropped items as the paths of their files', async () => {
    const { ipc } = fakeIpc();
    const paths = new Map([['web', '/Users/me/web']]);
    const bridge = createBridge(ipc, (file) => paths.get(file.name) ?? '');
    await bridge.workspaces.addDropped([new File([], 'web'), new File([], 'text')]);
    await bridge.panels.itemsAt([new File([], 'web')]);
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspaces:add-dropped', ['/Users/me/web', '']],
      ['panels:items-at', ['/Users/me/web']],
    ]);
  });

  it('passes on what the main process reports, without its event, until the page stops listening', () => {
    const { ipc, send } = fakeIpc();
    const bridge = createBridge(ipc, () => '');
    const workspaces = vi.fn();
    const sessions = vi.fn();
    const events = vi.fn();
    const stop = bridge.workspaces.onChange(workspaces);
    bridge.sessions.onChange(sessions);
    bridge.sessions.onEvent(events);
    send('workspaces:changed', { workspaces: [], selectedId: null });
    send('sessions:changed', []);
    send('sessions:event', { id: 's1', seq: 1, event: { type: 'turn-started' } });
    stop();
    send('workspaces:changed', { workspaces: [], selectedId: null });
    expect(workspaces.mock.calls).toEqual([[{ workspaces: [], selectedId: null }]]);
    expect(sessions.mock.calls).toEqual([[[]]]);
    expect(events.mock.calls).toEqual([['s1', 1, { type: 'turn-started' }]]);
  });
});
