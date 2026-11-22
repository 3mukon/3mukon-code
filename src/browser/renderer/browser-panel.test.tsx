import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { BrowserTabCommand, BrowserTabRef, BrowserTabState } from '../shared/browser';
import { BrowserPanel, NO_USE, type TabUse } from './browser-panel';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const ref: BrowserTabRef = { id: 'tab-1', kind: 'browser-tab', generation: 1 };

function tabState(fields: Partial<BrowserTabState>): BrowserTabState {
  return {
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
    canGoBack: true,
    canGoForward: false,
    control: 'agent',
    ...fields,
  };
}

function panel(
  state: BrowserTabState | null | undefined,
  props: {
    use?: Partial<TabUse>;
    onCommand?: (command: BrowserTabCommand) => Promise<boolean>;
    onStop?: () => Promise<boolean>;
    onShowQuestion?: () => void;
  } = {},
) {
  return render(
    <BrowserPanel
      state={state}
      session="Compare pricing pages"
      use={{ ...NO_USE, ...props.use }}
      onCommand={props.onCommand ?? (() => Promise.resolve(true))}
      onStop={props.onStop ?? (() => Promise.resolve(true))}
      onShowQuestion={props.onShowQuestion ?? (() => undefined)}
      page={() => <p>The page</p>}
    />,
  );
}

const settle = () => act(() => Promise.resolve());

describe('BrowserPanel', () => {
  it('shows the page in its frame under its address, with Back, Forward and Reload as the tab allows', () => {
    const onCommand = vi.fn(() => Promise.resolve(true));
    const { container } = panel(tabState({}), { onCommand });
    expect(screen.getByText('The page')).toBeDefined();
    const address = screen.getByText('example.com/pricing');
    expect(address.parentElement?.className).toContain('border-dashed');
    expect(address.parentElement?.querySelector('.lucide-lock')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Forward' }).hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('.lucide-chevron-left')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onCommand.mock.calls).toEqual([[{ kind: 'back' }], [{ kind: 'reload' }]]);
    // Nothing of the session's use, and no strip for it under the page.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(container.querySelector('.bg-accent')).toBeNull();
  });

  it('shows the paper while the page loads, with Stop Loading, and says why one cannot load, with Try Again', () => {
    const onCommand = vi.fn(() => Promise.resolve(true));
    panel(tabState({ loading: true }), { onCommand });
    expect(screen.getByText('Loading…').className).toContain('text-faint');
    expect(screen.getByText('Loading…').parentElement?.className).toContain('paper');
    // The page stays laid out under the paper, so that it keeps its place in its panel.
    expect(screen.getByText('The page')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Loading' }));
    cleanup();
    panel(tabState({ error: 'unreachable' }), { onCommand });
    expect(screen.getByText('Can’t reach example.com').className).toContain('font-semibold');
    expect(screen.getByText('The server didn’t respond.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(onCommand.mock.calls).toEqual([[{ kind: 'stop-loading' }], [{ kind: 'reload' }]]);
  });

  it('shows Open in Chrome for the selected preview and keeps opening behind the user control', () => {
    const onCommand = vi.fn(() => Promise.resolve(true));
    panel(tabState({ browser: 'chrome', sharing: 'global' }), { onCommand });
    expect(screen.getByText('The page')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Chrome' }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({ kind: 'open-external' });
  });

  it('says a Chrome tab is a preview that takes no input, with its frame’s age, and names the browser while the agent acts', () => {
    const shown = vi.fn();
    render(
      <BrowserPanel
        state={tabState({ browser: 'chrome', sharing: 'global' })}
        session="Read my invoices"
        use={{ ...NO_USE, held: true, acting: true }}
        onCommand={() => Promise.resolve(true)}
        onStop={() => Promise.resolve(true)}
        onShowQuestion={() => undefined}
        page={(onFrame) => {
          shown(onFrame);
          return <p>The page</p>;
        }}
      />,
    );
    expect(screen.getByText('Preview · not interactive')).toBeDefined();
    // No address field: the header names the page.
    expect(screen.queryByText('example.com/pricing')).toBeNull();
    const [report] = shown.mock.calls.at(-1) as [(capturedAt: number | null) => void];
    act(() => {
      report(Date.now() - 4_000);
    });
    expect(screen.getByText('Preview · not interactive · 4 s ago')).toBeDefined();
    act(() => {
      report(Date.now() - 180_000);
    });
    expect(screen.getByText('Preview · not interactive · 3 min ago')).toBeDefined();
    expect(screen.getByText('Read my invoices is acting in Chrome')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open in Chrome' })).toBeDefined();
  });

  it('names the session while the agent acts, with a line along the page’s top and Stop, and the user’s control, with Hand Back', async () => {
    const onStop = vi.fn(() => Promise.resolve(true));
    const onCommand = vi.fn(() => Promise.resolve(true));
    const acting = panel(tabState({}), { use: { held: true, acting: true }, onStop });
    expect(screen.getByText('Compare pricing pages is acting')).toBeDefined();
    expect(acting.container.querySelector('.bg-accent.h-0\\.5')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(onStop).toHaveBeenCalledOnce();
    cleanup();
    panel(tabState({}), { use: { held: true, acting: true, stopping: true } });
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(true);
    cleanup();
    const taken = panel(tabState({ control: 'user' }), {
      use: { held: true, acting: true },
      onCommand,
    });
    expect(screen.getByText('You have control')).toBeDefined();
    expect(taken.container.querySelector('.lucide-mouse-pointer-2')).not.toBeNull();
    expect(taken.container.querySelector('.bg-accent.h-0\\.5')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hand Back' }));
    expect(onCommand).toHaveBeenCalledWith({ kind: 'hand-back' });
  });

  it('keeps the chip’s strip while the session holds the tab, so that the page keeps its size', () => {
    const { container, rerender } = panel(tabState({}), { use: { held: true, acting: true } });
    const frame = container.querySelector('.rounded-md.border-line')?.parentElement;
    expect(frame?.className).not.toContain('mb-3');
    rerender(
      <BrowserPanel
        state={tabState({})}
        session="Compare pricing pages"
        use={{ ...NO_USE, held: true }}
        onCommand={() => Promise.resolve(true)}
        onStop={() => Promise.resolve(true)}
        onShowQuestion={() => undefined}
        page={() => <p>The page</p>}
      />,
    );
    expect(screen.queryByText('Compare pricing pages is acting')).toBeNull();
    expect(container.querySelector('.h-11')).not.toBeNull();
  });

  it('says while the agent waits for the user’s answer, with Show, the page still showing', () => {
    const onShowQuestion = vi.fn();
    panel(tabState({}), { use: { waiting: true }, onShowQuestion });
    expect(screen.getByText('Waiting for your answer in Compare pricing pages')).toBeDefined();
    expect(screen.getByText('The page')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(onShowQuestion).toHaveBeenCalledOnce();
  });

  it('says when the tab is blank or has closed, and when a control did not go', async () => {
    panel(tabState({ address: null, title: '' }));
    expect(screen.getAllByText('A blank tab')).toHaveLength(2);
    expect(screen.queryByText('The page')).toBeNull();
    cleanup();
    panel(null);
    expect(screen.getByText('This tab has closed.')).toBeDefined();
    cleanup();
    panel(tabState({}), { onCommand: () => Promise.resolve(false) });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('That didn’t work.');
  });
});
