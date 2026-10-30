import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../shared/events';
import type { RememberedChoice, SessionsBridge } from '../shared/sessions';
import { preloadOffers, rememberChoice, useOffers, useRemembered } from './use-offers';

afterEach(cleanup);

const opus: ModelOption[] = [{ id: 'opus', label: 'Opus', efforts: [] }];

// The parts of the bridge the hook uses.
function fakeBridge() {
  const calls = {
    providers: vi.fn<SessionsBridge['providers']>(() => Promise.resolve(['claude-code'])),
    gateways: vi.fn<SessionsBridge['gateways']>(() => Promise.resolve(['work'])),
    models: vi.fn<SessionsBridge['models']>(() => Promise.resolve(opus)),
    choices: vi.fn<SessionsBridge['choices']>(() =>
      Promise.resolve({ folders: {}, dayRoot: '/Users/me/3mukon-code' }),
    ),
    rememberChoice: vi.fn<SessionsBridge['rememberChoice']>(() => Promise.resolve()),
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

  it('gives a folder’s remembered settings, or the day folders’, without a provider or a gateway that is gone', async () => {
    const { bridge, calls } = fakeBridge();
    const codex: RememberedChoice = {
      provider: 'codex',
      gateway: null,
      model: 'gpt-6-astra',
      effort: 'high',
      sandbox: 'read-only',
    };
    calls.providers.mockResolvedValue(['claude-code', 'codex']);
    calls.choices.mockResolvedValue({
      folders: {
        '/a': codex,
        '/b': { ...codex, provider: 'grok-build' },
        '/c': { ...codex, provider: 'claude-code', gateway: 'gone', model: 'opus' },
      },
      dayRoot: '/Users/me/3mukon-code',
    });
    preloadOffers(bridge);
    const { result } = renderHook(() => ({
      a: useRemembered(bridge, '/a'),
      b: useRemembered(bridge, '/b'),
      c: useRemembered(bridge, '/c'),
      d: useRemembered(bridge, '/d'),
      today: useRemembered(bridge, '/Users/me/3mukon-code/2026-10-29'),
    }));
    await settle();
    expect(result.current).toEqual({
      a: codex,
      b: undefined,
      c: { ...codex, provider: 'claude-code', gateway: null, model: null, effort: null },
      d: undefined,
      today: undefined,
    });
    // A session's settings count for the window's pages at once, and go to the app's data; those of
    // a day folder's session count for every day folder.
    act(() => {
      rememberChoice(bridge, '/d', codex);
      rememberChoice(bridge, '/Users/me/3mukon-code/2026-10-28', { ...codex, effort: 'low' });
    });
    expect(result.current.d).toEqual(codex);
    expect(result.current.today).toEqual({ ...codex, effort: 'low' });
    expect(calls.rememberChoice.mock.calls).toEqual([
      ['/d', codex],
      ['/Users/me/3mukon-code/2026-10-28', { ...codex, effort: 'low' }],
    ]);
    expect(calls.choices).toHaveBeenCalledOnce();
  });
});
