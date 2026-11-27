import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../toolset/main/execution';
import { browserTools } from './browser-automation';

const TAB = {
  kind: 'browser-tab' as const,
  id: '00000000-0000-4000-8000-000000000001',
  generation: 1,
};

function fakeBrowser() {
  return {
    open: vi.fn(() => ({ status: 'verified' as const, value: TAB })),
    navigate: vi.fn(() => Promise.resolve({ status: 'verified' as const, value: null })),
    pageOf: vi.fn(() => ({ address: 'https://example.com/', title: 'Example' })),
    closeTab: vi.fn(() => Promise.resolve({ status: 'verified' as const, value: null })),
    isExternal: vi.fn(() => false),
  };
}

function context(): ExecutionContext {
  return {
    callId: 'call',
    signal: new AbortController().signal,
    owner: 'owner',
    turnId: 'turn',
    operationId: null,
    report: () => ({ status: 'verified', value: null }),
  } as unknown as ExecutionContext;
}

describe('browser_open with an address (ADR-0045)', () => {
  it('opens the tab, then hands the broker its navigation as the call’s second step, which gives back the page', async () => {
    const browser = fakeBrowser();
    const open = browserTools(browser as never).find((tool) => tool.name === 'browser_open');
    if (open === undefined) throw new Error('No browser_open.');
    const result = await open.execute({ url: 'https://example.com' }, context());
    expect(result.outcome).toEqual({ status: 'verified', value: TAB });
    expect(result.next?.plan).toMatchObject({ target: TAB, effect: 'navigate' });
    expect(browser.navigate).not.toHaveBeenCalled();
    const second = await result.next?.execute(context());
    expect(browser.navigate).toHaveBeenCalledWith(
      'owner',
      TAB,
      'https://example.com',
      expect.anything(),
      expect.anything(),
    );
    expect(second?.outcome).toEqual({
      status: 'verified',
      value: { ...TAB, address: 'https://example.com/', title: 'Example' },
    });
    await result.next?.undo();
    expect(browser.closeTab).toHaveBeenCalledWith('owner', TAB);
  });

  it('opens a tab with no page, and no second step, without an address', async () => {
    const browser = fakeBrowser();
    const open = browserTools(browser as never).find((tool) => tool.name === 'browser_open');
    const result = await open?.execute({}, context());
    expect(result?.outcome).toEqual({ status: 'verified', value: TAB });
    expect(result?.next).toBeUndefined();
  });
});
