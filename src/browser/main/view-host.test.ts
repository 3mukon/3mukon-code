import type { BrowserWindow } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeBrowserTabs } from '../shared/browser-fake';
import type { BrowserTabState } from '../shared/browser';
import type { BrowserViewPlacement } from '../shared/view';
import type { BrowserPage, MountedBrowserPage, PageCapture } from './page';
import { BrowserViewHost } from './view-host';

const tab = { id: 'synthetic-tab', generation: 1, kind: 'browser-tab' } as const;
const initial: BrowserTabState = {
  ref: tab,
  owner: 'a',
  browser: 'embedded',
  sharing: 'none',
  profile: null,
  title: 'Fixture',
  address: 'https://fixture.test/',
  documentGeneration: 1,
  geometryGeneration: 1,
  loading: false,
  error: null,
  signIn: 'unknown',
  canGoBack: false,
  canGoForward: false,
  control: 'agent',
};
const box: BrowserViewPlacement = {
  bounds: { x: -10, y: 12, width: 400, height: 300 },
  covered: false,
  dim: null,
};
const frame: PageCapture = {
  image: { mediaType: 'image/png', data: 'ZmFrZQ==' },
  width: 250,
  height: 200,
  capturedAt: 100,
  viewport: { width: 250, height: 200 },
};
function windowFixture(id: number): BrowserWindow {
  return {
    webContents: { id, getZoomFactor: () => 2 },
    getContentSize: () => [250, 200],
  } as unknown as BrowserWindow;
}
function fixture() {
  const tabs = new FakeBrowserTabs();
  tabs.show(initial);
  const mount = { show: vi.fn(() => Promise.resolve(true)), hide: vi.fn(), release: vi.fn() };
  const page = {
    mount: vi.fn<(window: BrowserWindow, focus: () => void) => MountedBrowserPage>(() => mount),
    capture: vi.fn<BrowserPage['capture']>(() => Promise.resolve(frame)),
    navigate: vi.fn(),
    close: vi.fn(),
    observe: vi.fn(),
    action: vi.fn(),
    runScript: vi.fn(),
  } satisfies BrowserPage;
  let showing = true;
  const isShown = (owner: string, presentation: string) =>
    showing && owner === 'a' && (presentation === 'one' || presentation === 'two');
  const backend = {
    pageForView: (owner: string) => (owner === initial.owner ? page : null),
    subscribe: tabs.subscribe.bind(tabs),
  };
  const host = new BrowserViewHost(backend, isShown, () => undefined);
  const window = windowFixture(1);
  const focused = vi.fn();
  const bind = (presentation = 'one') => {
    const result = host.bind(window, 'a', presentation, tab, focused);
    if (result.status !== 'verified') throw Error('Binding refused');
    return result.value;
  };
  return {
    host,
    window,
    focused,
    bind,
    page,
    mount,
    tabs,
    setClosed: () => {
      showing = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

it('refreshes an external preview under a live operation and keeps only the last authorized frame', async () => {
  vi.useFakeTimers();
  const tabs = new FakeBrowserTabs();
  tabs.show({ ...initial, browser: 'chrome', sharing: 'global' });
  const page = {
    capture: vi.fn<BrowserPage['capture']>(() =>
      Promise.resolve({ ...frame, capturedAt: Date.now() }),
    ),
    openExternal: vi.fn(),
    navigate: vi.fn(),
    close: vi.fn(),
    observe: vi.fn(),
    action: vi.fn(),
    runScript: vi.fn(),
  } satisfies BrowserPage;
  let signal: AbortSignal | undefined;
  const host = new BrowserViewHost(
    { pageForView: () => page, subscribe: tabs.subscribe.bind(tabs) },
    () => true,
    () => signal,
  );
  const window = windowFixture(1);
  const handoff = vi.fn();
  const outcome = host.bind(window, 'a', 'one', tab, handoff);
  if (outcome.status !== 'verified') throw Error('Binding refused');
  const id = outcome.value;
  const cover = { ...box, covered: true };
  expect(await host.place(window, id, 1, cover)).toMatchObject({ value: { kind: 'paper' } });
  expect(await host.place(window, id, 2, box)).toMatchObject({ value: { kind: 'paper' } });
  expect(page.capture).not.toHaveBeenCalled();
  const operation = new AbortController();
  signal = operation.signal;
  const kept = { kind: 'frame', frame: frame.image, capturedAt: Date.now() };
  expect(await host.place(window, id, 3, box)).toMatchObject({ value: kept });
  expect(page.capture).toHaveBeenCalledExactlyOnceWith(operation.signal);
  expect(await host.place(window, id, 4, cover)).toMatchObject({ value: kept });
  await vi.advanceTimersByTimeAsync(1000);
  let finish!: (image: PageCapture) => void;
  page.capture.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = host.place(window, id, 5, box);
  expect(page.capture).toHaveBeenCalledTimes(2);
  operation.abort();
  signal = new AbortController().signal;
  finish({ ...frame, capturedAt: Date.now() });
  expect(await pending).toMatchObject({ value: kept });
  signal = undefined;
  expect(await host.place(window, id, 6, box)).toMatchObject({ value: kept });
  expect(await host.place(window, id, 7, { ...box, bounds: null })).toMatchObject({
    value: { kind: 'paper' },
  });
  host.release(1, id);
  expect(page.capture).toHaveBeenCalledTimes(2);
  expect(page.openExternal).not.toHaveBeenCalled();
  expect(page.close).not.toHaveBeenCalled();
  expect(handoff).not.toHaveBeenCalled();
});

it('clips the viewport, reuses the tab when hidden and moved, and focuses only on an input event', async () => {
  const { host, window, focused, bind, page, mount } = fixture();
  expect(host.bind(window, 'b', 'one', tab, focused)).toMatchObject({ code: 'not-found' });
  const id = bind();
  expect(await host.place(windowFixture(2), id, 1, box)).toMatchObject({ code: 'stale-target' });
  expect(await host.place(window, id, 1, box)).toMatchObject({ value: { kind: 'live' } });
  expect(mount.show).toHaveBeenCalledWith({ x: 0, y: 24, width: 250, height: 176 }, null);
  expect(focused).not.toHaveBeenCalled();
  page.mount.mock.calls[0]?.[1]();
  expect(focused).toHaveBeenCalledExactlyOnceWith(id);
  expect(await host.place(window, id, 2, { ...box, bounds: null })).toMatchObject({
    value: { kind: 'paper' },
  });
  expect(mount.hide).toHaveBeenCalledOnce();
  expect(await host.place(window, id, 1, box)).toMatchObject({ code: 'request-conflict' });
  const moved = bind('two');
  expect(moved).not.toBe(id);
  expect(mount.release).toHaveBeenCalledOnce();
  expect(await host.place(window, id, 3, box)).toMatchObject({ code: 'stale-target' });
  page.mount.mock.calls[0]?.[1]();
  expect(focused).toHaveBeenCalledOnce();
  expect(await host.place(window, moved, 1, { ...box, dim: '#efece4' })).toMatchObject({
    value: { kind: 'live' },
  });
  expect(mount.show).toHaveBeenLastCalledWith(expect.anything(), '#efece4');
  host.release(2, moved);
  expect(mount.release).toHaveBeenCalledOnce();
  host.release(1, moved);
  expect(mount.release).toHaveBeenCalledTimes(2);
  expect(page.navigate).not.toHaveBeenCalled();
  expect(page.close).not.toHaveBeenCalled();
});

it('parks for overlays immediately and uses a matching kept frame within 100 ms', async () => {
  vi.useFakeTimers();
  const { host, window, bind, page, mount, tabs } = fixture();
  const id = bind();
  const cover = { ...box, covered: true };
  expect(await host.place(window, id, 1, cover)).toMatchObject({ value: { kind: 'paper' } });
  expect(page.capture).not.toHaveBeenCalled();
  await host.place(window, id, 2, box);
  await vi.advanceTimersByTimeAsync(200);
  let finish!: (frame: PageCapture | null) => void;
  page.capture.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const result = host.place(window, id, 3, cover);
  expect(mount.hide).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({
    value: { kind: 'frame', frame: frame.image, capturedAt: frame.capturedAt },
  });
  tabs.show({ ...initial, documentGeneration: 2 });
  const next = host.place(window, id, 4, cover);
  expect(page.capture).toHaveBeenCalledTimes(2);
  finish(frame);
  expect(await next).toMatchObject({ value: { kind: 'paper' } });
  host.disconnect(1);
  expect(mount.release).toHaveBeenCalledOnce();
});

it('discards an in-flight response when the presentation closes and releases on tab end', async () => {
  vi.useFakeTimers();
  const { host, window, bind, page, mount, setClosed } = fixture();
  const id = bind();
  await host.place(window, id, 1, box);
  page.capture.mockReturnValue(new Promise(() => undefined));
  const cover = host.place(window, id, 2, { ...box, covered: true });
  setClosed();
  host.reconcile(1);
  expect(mount.release).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100);
  expect(await cover).toMatchObject({ code: 'request-conflict' });

  const ended = fixture();
  const endingId = ended.bind();
  ended.tabs.show(null);
  expect(ended.mount.release).toHaveBeenCalledOnce();
  expect(await ended.host.place(ended.window, endingId, 1, box)).toMatchObject({
    code: 'stale-target',
  });
});

it('lays the page again where its panel last asked once its tab has loaded, never over the paper', async () => {
  vi.useFakeTimers();
  const { host, window, bind, page, mount, tabs } = fixture();
  const id = bind();
  const laid = { x: 0, y: 24, width: 250, height: 176 };
  expect(await host.place(window, id, 1, box)).toMatchObject({ value: { kind: 'live' } });
  expect(mount.show).toHaveBeenCalledOnce();
  // A navigation takes the page off while it loads, under the panel's paper, also when the panel
  // asks again meanwhile, and lays it again as the panel last asked once it has loaded.
  tabs.show({ ...initial, loading: true, documentGeneration: 2 });
  expect(mount.hide).toHaveBeenCalledOnce();
  expect(await host.place(window, id, 2, { ...box, dim: '#efece4' })).toMatchObject({
    value: { kind: 'paper' },
  });
  expect(mount.show).toHaveBeenCalledOnce();
  tabs.show({ ...initial, documentGeneration: 2 });
  await vi.advanceTimersByTimeAsync(0);
  expect(mount.show).toHaveBeenCalledTimes(2);
  expect(mount.show).toHaveBeenLastCalledWith(laid, '#efece4');
  await vi.advanceTimersByTimeAsync(200);
  expect(page.capture).toHaveBeenCalled();
  // A page that failed stays off until a reload has loaded.
  tabs.show({ ...initial, documentGeneration: 3, error: 'unreachable' });
  expect(await host.place(window, id, 3, box)).toMatchObject({ value: { kind: 'paper' } });
  tabs.show({ ...initial, documentGeneration: 3, loading: true });
  expect(mount.show).toHaveBeenCalledTimes(2);
  tabs.show({ ...initial, documentGeneration: 3 });
  await vi.advanceTimersByTimeAsync(0);
  expect(mount.show).toHaveBeenCalledTimes(3);
  expect(mount.show).toHaveBeenLastCalledWith(laid, null);
  // Under a cover, or parked, a page that loads stays off until the panel asks again.
  await host.place(window, id, 4, { ...box, covered: true });
  tabs.show({ ...initial, documentGeneration: 4, loading: true });
  tabs.show({ ...initial, documentGeneration: 4 });
  await host.place(window, id, 5, { ...box, bounds: null });
  tabs.show({ ...initial, documentGeneration: 5, loading: true });
  tabs.show({ ...initial, documentGeneration: 5 });
  await vi.advanceTimersByTimeAsync(0);
  expect(mount.show).toHaveBeenCalledTimes(3);
  expect(await host.place(window, id, 6, box)).toMatchObject({ value: { kind: 'live' } });
  expect(mount.show).toHaveBeenCalledTimes(4);
});
