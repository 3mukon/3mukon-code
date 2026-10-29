import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../shared/events';
import type { SessionsBridge } from '../shared/sessions';
import { useOffers } from './use-offers';

afterEach(cleanup);

const opus: ModelOption[] = [{ id: 'opus', label: 'Opus', efforts: [] }];

// The parts of the bridge the hook uses.
function fakeBridge() {
  const calls = {
    providers: vi.fn<SessionsBridge['providers']>(() => Promise.resolve(['claude-code'])),
    gateways: vi.fn<SessionsBridge['gateways']>(() => Promise.resolve(['work'])),
    models: vi.fn<SessionsBridge['models']>(() => Promise.resolve(opus)),
  };
  return { bridge: calls as unknown as SessionsBridge, calls };
}

const settle = () => act(() => Promise.resolve());

describe('useOffers', () => {
  it('keeps the models found, and asks for the gateways again whenever a page needs them', async () => {
    const { bridge, calls } = fakeBridge();
    const first = renderHook(() => useOffers(bridge, 'claude-code', null));
    await settle();
    expect(first.result.current).toEqual({
      providers: ['claude-code'],
      gateways: ['work'],
      models: opus,
    });
    first.unmount();
    calls.gateways.mockResolvedValue(['work', 'home']);
    const second = renderHook(() => useOffers(bridge, 'claude-code', null));
    // What came before is there at once, and the gateways follow anew.
    expect(second.result.current.models).toEqual(opus);
    await settle();
    expect(second.result.current.gateways).toEqual(['work', 'home']);
    expect(calls.providers).toHaveBeenCalledOnce();
    expect(calls.models.mock.calls).toEqual([['claude-code', null]]);
  });

  it('shows a list that failed as empty, and asks for it again when a page next needs it', async () => {
    const { bridge, calls } = fakeBridge();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    calls.models.mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useOffers(bridge, 'claude-code', null));
    await settle();
    expect(first.result.current.models).toEqual([]);
    first.unmount();
    const second = renderHook(() => useOffers(bridge, 'claude-code', null));
    await settle();
    expect(second.result.current.models).toEqual(opus);
    expect(calls.models).toHaveBeenCalledTimes(2);
  });

  it('asks for each list once at a time, and for a gateway’s models when a page needs them', async () => {
    const { bridge, calls } = fakeBridge();
    renderHook(() => useOffers(bridge, 'claude-code', null));
    const page = renderHook(({ gateway }) => useOffers(bridge, 'claude-code', gateway), {
      initialProps: { gateway: null as string | null },
    });
    expect(page.result.current.models).toBeUndefined();
    await settle();
    page.rerender({ gateway: 'work' });
    expect(page.result.current.models).toBeUndefined();
    await settle();
    expect(page.result.current.models).toEqual(opus);
    expect(calls.providers).toHaveBeenCalledOnce();
    expect(calls.gateways).toHaveBeenCalledOnce();
    expect(calls.models.mock.calls).toEqual([
      ['claude-code', null],
      ['claude-code', 'work'],
    ]);
  });
});
