import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserViewHost } from '../../browser/main/view-host';
import type { BrowserTabs } from '../../browser/shared/browser';
import type { ComputerBridge } from '../../computer/shared/computer';
import { FakeAutomationBridge } from '../../toolset/shared/automation-fake';
import type { UserSetupBridge } from '../../toolset/shared/automation';
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
function invoke(channel: string, event: unknown, ...args: unknown[]) {
  const handler = electron.handlers.get(channel);
  if (!handler) throw Error('No handler');
  return handler(event, ...args);
}
let automation: FakeAutomationBridge;
const setupSnapshot = vi.fn<UserSetupBridge['snapshot']>();
const setupAct = vi.fn<UserSetupBridge['act']>(() =>
  Promise.resolve({ status: 'verified', value: null }),
);
const browserSubscribe = vi.fn<BrowserTabs['subscribe']>();
const browserBind = vi.fn<BrowserViewHost['bind']>();
const browserPlace = vi.fn();
const disconnectBrowser = vi.fn();
const reconcileBrowser = vi.fn();
const previewComputer = vi.fn<ComputerBridge['preview']>();
const commandComputer =
  vi.fn<
    (
      owner: string,
      target: string,
      command: 'reveal' | 'take-over' | 'hand-back',
    ) => ReturnType<ComputerBridge['command']>
  >();
const showsComputer = vi.fn();
beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset();
  setupSnapshot.mockClear();
  setupAct.mockClear();
  browserSubscribe.mockReset();
  browserBind.mockReset();
  browserPlace.mockReset();
  disconnectBrowser.mockClear();
  reconcileBrowser.mockClear();
  previewComputer.mockReset();
  commandComputer.mockReset();
  showsComputer.mockReset();
  automation = new FakeAutomationBridge();
  // Supply only the methods used by bridge registration and the automation/setup channels.
  const changes = { onChange: () => undefined };
  serveBridge({
    page,
    automation,
    workspaces: changes,
    sessions: { ...changes, onEvent: () => undefined },
    files: changes,
    settings: changes,
    accounts: changes,
    setup: { subscribe: () => () => undefined, snapshot: setupSnapshot, act: setupAct },
    browser: { subscribe: browserSubscribe },
    computer: { preview: previewComputer, command: commandComputer },
    browserViews: {
      bind: browserBind,
      place: browserPlace,
      disconnect: disconnectBrowser,
      reconcile: reconcileBrowser,
    },
    presentations: { connect: vi.fn(), receive: () => true, disconnect: vi.fn(), showsComputer },
  } as unknown as Parameters<typeof serveBridge>[0]);
});

it('requires an acknowledged computer presentation and rechecks it after reading the frame', async () => {
  const page = windowFixture(1);
  electron.fromWebContents.mockReturnValue(page.window);
  const target = '84017e87-c16a-42fc-a1b2-b88cbcc0b3a8';
  const read = () => invoke('computer:preview', page.event, 'a', 'shown', target);
  const reveal = () => invoke('computer:command', page.event, 'a', 'shown', target, 'reveal');
  await expect(read()).resolves.toMatchObject({ code: 'not-found' });
  expect(reveal()).toMatchObject({ code: 'not-found' });
  invoke('presentations:report', page.event, {
    kind: 'snapshot',
    epoch: 'e',
    presentations: [],
    sessionPanels: [],
  });
  showsComputer.mockReturnValue(false);
  await expect(read()).resolves.toMatchObject({ code: 'not-found' });
  expect(previewComputer).not.toHaveBeenCalled();
  showsComputer.mockReturnValue(true);
  const reply = {
    status: 'verified',
    value: { status: 'unavailable', reason: 'permission-required' },
  } as const;
  previewComputer.mockResolvedValueOnce(reply);
  await expect(read()).resolves.toEqual(reply);
  expect(showsComputer).toHaveBeenCalledWith('a', 'shown', target);
  expect(previewComputer).toHaveBeenCalledExactlyOnceWith('a', target);
  commandComputer.mockResolvedValueOnce({ status: 'verified', value: null });
  await expect(reveal()).resolves.toMatchObject({ status: 'verified' });
  expect(commandComputer).toHaveBeenCalledExactlyOnceWith('a', target, 'reveal');

  const delayed = Promise.withResolvers<Awaited<ReturnType<ComputerBridge['preview']>>>();
  previewComputer.mockReturnValueOnce(delayed.promise);
  const pending = read();
  showsComputer.mockReturnValue(false);
  delayed.resolve(reply);
  await expect(pending).resolves.toMatchObject({ code: 'not-found' });
  expect(reveal()).toMatchObject({ code: 'not-found' });
});

it('binds browser views only for the trusted presentation page and cleans them up on reload', () => {
  const first = windowFixture(1);
  const second = windowFixture(2);
  electron.fromWebContents.mockImplementation((contents) =>
    contents === first.contents ? first.window : second.window,
  );
  const tab = {
    id: '84017e87-c16a-42fc-a1b2-b88cbcc0b3a8',
    generation: 2,
    kind: 'browser-tab',
  } as const;
  const binding = 'd48944f1-46ac-4d9f-b93e-46161f03ad1c';
  expect(invoke('browser:bind', first.event, 'a', 'shown', tab)).toMatchObject({
    code: 'not-found',
  });
  expect(() =>
    invoke(
      'browser:bind',
      { ...first.event, senderFrame: { parent: first.contents.mainFrame, url: page } },
      'a',
      'shown',
      tab,
    ),
  ).toThrow('own page');
  invoke('presentations:report', first.event, {
    kind: 'snapshot',
    epoch: 'e',
    presentations: [],
    sessionPanels: [],
  });
  expect(reconcileBrowser).toHaveBeenCalledWith(1);
  expect(invoke('browser:bind', second.event, 'a', 'shown', tab)).toMatchObject({
    code: 'not-found',
  });
  expect(() =>
    invoke('browser:bind', first.event, 'a', 'shown', { ...tab, generation: 0 }),
  ).toThrow();
  expect(browserBind).not.toHaveBeenCalled();
  invoke('browser:bind', first.event, 'a', 'shown', tab);
  expect(browserBind).toHaveBeenCalledExactlyOnceWith(
    first.window,
    'a',
    'shown',
    tab,
    expect.any(Function),
    expect.any(Function),
  );
  browserBind.mock.calls[0]?.[5]?.(binding);
  expect(first.contents.send).toHaveBeenCalledWith('browser:file-drag', binding);
  expect(second.contents.send).not.toHaveBeenCalled();
  expect(() =>
    invoke('browser:place', first.event, binding, 1, {
      bounds: null,
      covered: true,
      dim: 'url(foo)',
    }),
  ).toThrow();
  expect(browserPlace).not.toHaveBeenCalled();
  const stop = vi.fn();
  browserSubscribe.mockImplementation((_owner, _tab, listener) => {
    listener(null);
    return stop;
  });
  invoke('browser:subscribe', first.event, 'a', tab, binding);
  expect(first.contents.send).toHaveBeenCalledWith('browser:state', {
    subscription: binding,
    state: null,
  });
  invoke('browser:unsubscribe', second.event, binding);
  first.contents.emit(
    'did-start-navigation',
    { isMainFrame: true, isSameDocument: true },
    page,
    true,
    true,
  );
  expect(stop).not.toHaveBeenCalled();
  first.contents.emit(
    'did-start-navigation',
    { isMainFrame: true, isSameDocument: false },
    page,
    false,
    true,
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(disconnectBrowser).toHaveBeenCalledExactlyOnceWith(1);
  expect(invoke('browser:bind', first.event, 'a', 'shown', tab)).toMatchObject({
    code: 'not-found',
  });
});

it('rejects subframes, departed app frames, external pages, malformed answers and non-app contents', async () => {
  const f = windowFixture(1);
  electron.fromWebContents.mockReturnValue(f.window);
  const read = vi.spyOn(automation, 'snapshot');
  const answer = vi.spyOn(automation, 'answer');
  expect(() =>
    invoke(
      'automation:snapshot',
      { ...f.event, senderFrame: { parent: f.contents.mainFrame, url: page } },
      'a',
    ),
  ).toThrow('own page');
  expect(() =>
    invoke('automation:snapshot', { ...f.event, senderFrame: { parent: null, url: page } }, 'a'),
  ).toThrow('own page');
  f.contents.mainFrame.url = 'https://example.test/';
  expect(() => invoke('automation:snapshot', f.event, 'a')).toThrow('own page');
  f.contents.mainFrame.url = page;
  expect(() =>
    invoke('automation:answer', f.event, 'a', 'request', { decision: 'allow-once', owner: 'b' }),
  ).toThrow();
  electron.fromWebContents.mockReturnValue(null);
  expect(() => invoke('automation:snapshot', f.event, 'a')).toThrow('own page');
  expect(read).not.toHaveBeenCalled();
  expect(answer).not.toHaveBeenCalled();
  electron.fromWebContents.mockReturnValue(f.window);
  await invoke('automation:answer', f.event, 'a', 'request', { decision: 'allow-once' });
  expect(answer).toHaveBeenCalledExactlyOnceWith('a', 'request', { decision: 'allow-once' });
});

it('routes setup reads and actions only from the app frame with strict arguments', async () => {
  const f = windowFixture(1);
  electron.fromWebContents.mockReturnValue(f.window);
  const action = { kind: 'restart-helper' };
  const subframe = { ...f.event, senderFrame: { parent: f.contents.mainFrame, url: page } };
  expect(() => invoke('setup:snapshot', subframe)).toThrow('own page');
  expect(() => invoke('setup:act', subframe, action)).toThrow('own page');
  f.contents.mainFrame.url = 'https://fixture.example/';
  expect(() => invoke('setup:snapshot', f.event)).toThrow('own page');
  expect(() => invoke('setup:act', f.event, action)).toThrow('own page');
  f.contents.mainFrame.url = page;
  expect(() => invoke('setup:snapshot', f.event, action)).toThrow();
  expect(() =>
    invoke('setup:act', f.event, {
      kind: 'open-permission',
      permission: 'screen-recording',
      url: 'https://fixture.example/',
    }),
  ).toThrow();
  expect(() =>
    invoke('setup:act', f.event, { kind: 'open-permission', permission: 'other' }),
  ).toThrow();
  expect(setupAct).not.toHaveBeenCalled();
  expect(setupSnapshot).not.toHaveBeenCalled();
  await invoke('setup:snapshot', f.event);
  expect(setupSnapshot).toHaveBeenCalledExactlyOnceWith();
  await invoke('setup:act', f.event, action);
  expect(setupAct).toHaveBeenCalledExactlyOnceWith(action);
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
    invoke('automation:subscribe', first.event, 'a', 'first');
    invoke('automation:subscribe', second.event, 'b', 'second');
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
    invoke('automation:unsubscribe', first.event, 'second');
    expect(stops[1]).not.toHaveBeenCalled();
    invoke('automation:unsubscribe', second.event, 'second');
    expect(stops[1]).toHaveBeenCalledOnce();
  },
);
