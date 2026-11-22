import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabRef, BrowserTabState } from '../shared/browser';
import { FakeBrowserTabs } from '../shared/browser-fake';
import { useBrowserTabs } from './use-browser-tabs';

afterEach(cleanup);

const ref: BrowserTabRef = { id: 'tab-1', kind: 'browser-tab', generation: 1 };
const state: BrowserTabState = {
  ref,
  owner: 's1',
  browser: 'embedded',
  sharing: 'none',
  profile: null,
  title: 'Pricing · Example',
  address: 'https://example.com/pricing',
  documentGeneration: 1,
  geometryGeneration: 1,
  loading: false,
  error: null,
  signIn: 'unknown',
  canGoBack: false,
  canGoForward: false,
  control: 'agent',
};
const settle = () => act(() => Promise.resolve());

function port(tabs: FakeBrowserTabs) {
  return {
    tabRef: vi.fn((owner: string, id: string) =>
      Promise.resolve(owner === 's1' && id === 'tab-1' ? ref : null),
    ),
    subscribe: vi.fn(tabs.subscribe.bind(tabs)),
  };
}

describe('useBrowserTabs', () => {
  it('resolves each tab a panel shows and follows its state, until no panel shows it', async () => {
    const tabs = new FakeBrowserTabs();
    tabs.show(state);
    const main = port(tabs);
    const { result, rerender } = renderHook(({ wanted }) => useBrowserTabs(main, wanted), {
      initialProps: { wanted: [{ owner: 's1', tabId: 'tab-1' }] },
    });
    expect(result.current('s1', 'tab-1')).toEqual({ ref: null, state: undefined });
    await settle();
    expect(result.current('s1', 'tab-1')).toEqual({ ref, state });
    act(() => {
      tabs.show({ ...state, loading: true });
    });
    expect(result.current('s1', 'tab-1').state?.loading).toBe(true);
    rerender({
      wanted: [
        { owner: 's1', tabId: 'tab-1' },
        { owner: 's1', tabId: 'tab-1' },
      ],
    });
    expect(main.tabRef).toHaveBeenCalledOnce();
    rerender({ wanted: [] });
    expect(result.current('s1', 'tab-1')).toEqual({ ref: null, state: undefined });
    act(() => {
      tabs.show(state);
    });
    expect(result.current('s1', 'tab-1')).toEqual({ ref: null, state: undefined });
  });

  it('says a tab main does not know has ended', async () => {
    const main = port(new FakeBrowserTabs());
    const { result } = renderHook(() => useBrowserTabs(main, [{ owner: 's2', tabId: 'tab-9' }]));
    await settle();
    expect(result.current('s2', 'tab-9')).toEqual({ ref: null, state: null });
    expect(main.subscribe).not.toHaveBeenCalled();
  });
});
