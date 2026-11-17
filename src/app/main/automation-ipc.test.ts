import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAutomationBridge } from '../../toolset/shared/automation-fake';
import { serveBridge } from './bridge';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...values: unknown[]) => unknown>(),
  fromWebContents: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...values: unknown[]) => unknown) =>
      electron.handlers.set(name, handler),
  },
  BrowserWindow: { fromWebContents: electron.fromWebContents },
}));
const page = 'file:///synthetic/app/index.html';
function windowFixture(id: number) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { parent: null, url: page },
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = { webContents: contents };
  return { window, contents, event: { sender: contents, senderFrame: contents.mainFrame } };
}
function invoke(name: string, event: unknown, ...args: unknown[]) {
  const handler = electron.handlers.get(`automation:${name}`);
  if (!handler) throw Error('No handler');
  return handler(event, ...args);
}
let automation: FakeAutomationBridge;
beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset();
  automation = new FakeAutomationBridge();
  // Only registration and the automation channels run. Unrelated feature methods are never called.
  const changes = { onChange: () => undefined };
  serveBridge({
    page,
    automation,
    workspaces: changes,
    sessions: { ...changes, onEvent: () => undefined },
    files: changes,
    settings: changes,
    accounts: changes,
  } as unknown as Parameters<typeof serveBridge>[0]);
});

it('rejects subframes, departed app frames, external pages, malformed answers and non-app contents', async () => {
  const f = windowFixture(1);
  electron.fromWebContents.mockReturnValue(f.window);
  const read = vi.spyOn(automation, 'snapshot');
  const answer = vi.spyOn(automation, 'answer');
  expect(() =>
    invoke(
      'snapshot',
      { ...f.event, senderFrame: { parent: f.contents.mainFrame, url: page } },
      'a',
    ),
  ).toThrow('own page');
  expect(() =>
    invoke('snapshot', { ...f.event, senderFrame: { parent: null, url: page } }, 'a'),
  ).toThrow('own page');
  f.contents.mainFrame.url = 'https://example.test/';
  expect(() => invoke('snapshot', f.event, 'a')).toThrow('own page');
  f.contents.mainFrame.url = page;
  expect(() =>
    invoke('answer', f.event, 'a', 'request', { decision: 'allow-once', owner: 'b' }),
  ).toThrow();
  electron.fromWebContents.mockReturnValue(null);
  expect(() => invoke('snapshot', f.event, 'a')).toThrow('own page');
  expect(read).not.toHaveBeenCalled();
  expect(answer).not.toHaveBeenCalled();
  electron.fromWebContents.mockReturnValue(f.window);
  await invoke('answer', f.event, 'a', 'request', { decision: 'allow-once' });
  expect(answer).toHaveBeenCalledExactlyOnceWith('a', 'request', { decision: 'allow-once' });
});

it.each(['navigation', 'renderer-loss', 'destruction'])(
  'releases only the affected page’s listeners on %s',
  (loss) => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    electron.fromWebContents.mockImplementation((contents) =>
      contents === first.contents ? first.window : second.window,
    );
    const stops = [vi.fn(), vi.fn()];
    const subscribe = vi
      .spyOn(automation, 'subscribe')
      .mockImplementationOnce(() => stops[0] ?? (() => undefined))
      .mockImplementationOnce(() => stops[1] ?? (() => undefined));
    invoke('subscribe', first.event, 'a', 'first');
    invoke('subscribe', second.event, 'b', 'second');
    first.contents.emit('did-start-navigation', {}, page, true, true);
    first.contents.emit('did-start-navigation', {}, page, false, false);
    expect(stops[0]).not.toHaveBeenCalled();
    const event = {
      epoch: 'epoch',
      sequence: 1,
      sessionId: 'a',
      value: { kind: 'presentation-notices' as const, notices: [] },
    };
    subscribe.mock.calls[0]?.[1](event);
    expect(first.contents.send).toHaveBeenCalledExactlyOnceWith('automation:event', {
      subscriptionId: 'first',
      event,
    });
    expect(second.contents.send).not.toHaveBeenCalled();
    if (loss === 'navigation') first.contents.emit('did-start-navigation', {}, page, false, true);
    else first.contents.emit(loss === 'renderer-loss' ? 'render-process-gone' : 'destroyed');
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).not.toHaveBeenCalled();
    invoke('unsubscribe', first.event, 'second');
    expect(stops[1]).not.toHaveBeenCalled();
    invoke('unsubscribe', second.event, 'second');
    expect(stops[1]).toHaveBeenCalledOnce();
  },
);
