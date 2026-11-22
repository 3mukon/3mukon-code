import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Outcome } from '../../sessions/shared/automation';
import { addCover } from '../../ui/renderer/cover';
import type { BrowserTabRef } from '../shared/browser';
import type { BrowserViewDisplay, BrowserViewPlacement, BrowserViews } from '../shared/view';
import { BrowserPageView } from './browser-page-view';

afterEach(cleanup);

const ref: BrowserTabRef = { id: 'tab-1', kind: 'browser-tab', generation: 1 };
const settle = () => act(() => Promise.resolve());

// Main's side of the view port, as a test plays it: each binding asked for, each placement, what
// each placement shows, and the focusing clicks it reports.
function views(binds: Outcome<string>[] = [{ status: 'verified', value: 'b1' }]) {
  const placements: { binding: string; revision: number; placement: BrowserViewPlacement }[] = [];
  const released: string[] = [];
  const focusListeners = new Set<(binding: string) => void>();
  const dragListeners = new Set<(binding: string) => void>();
  const live: Outcome<BrowserViewDisplay> = { status: 'verified', value: { kind: 'live' } };
  let display: Outcome<BrowserViewDisplay> = live;
  const once: Outcome<BrowserViewDisplay>[] = [];
  const bind = vi.fn((): Promise<Outcome<string>> =>
    Promise.resolve(binds.shift() ?? { status: 'verified', value: 'b-late' }),
  );
  const port: BrowserViews = {
    bind,
    place: (binding, revision, placement) => {
      placements.push({ binding, revision, placement });
      return Promise.resolve(once.shift() ?? display);
    },
    release: (binding) => {
      released.push(binding);
      return Promise.resolve();
    },
    onFocus: (listener) => {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    onFileDrag: (listener) => {
      dragListeners.add(listener);
      return () => {
        dragListeners.delete(listener);
      };
    },
  };
  return {
    port,
    bind,
    placements,
    released,
    showNext: (next: Outcome<BrowserViewDisplay>) => {
      display = next;
    },
    showOnce: (next: Outcome<BrowserViewDisplay>) => {
      once.push(next);
    },
    focus: (binding: string) => {
      for (const listener of focusListeners) listener(binding);
    },
    drag: (binding: string) => {
      for (const listener of dragListeners) listener(binding);
    },
  };
}

function page(port: BrowserViews, props: { focused?: boolean; onFocus?: () => void } = {}) {
  return (
    <BrowserPageView
      views={port}
      owner="s1"
      presentation="p1"
      tab={ref}
      title="Pricing · Example"
      address="example.com/pricing"
      focused={props.focused ?? true}
      onFocus={props.onFocus ?? (() => undefined)}
    />
  );
}

// Gives every element a place in the window, as the panel's box has.
function placeBoxes(left: number, top: number, width: number, height: number) {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(left, top, width, height));
}

describe('BrowserPageView', () => {
  it('borrows the tab’s page for its panel and tells main where it goes, each placement newer than the last', async () => {
    const boxes = placeBoxes(240, 80, 600, 400);
    const main = views();
    const { rerender } = render(page(main.port));
    await settle();
    expect(main.bind).toHaveBeenCalledWith('s1', 'p1', ref);
    expect(main.placements.at(-1)).toEqual({
      binding: 'b1',
      revision: 1,
      placement: { bounds: { x: 240, y: 80, width: 600, height: 400 }, covered: false, dim: null },
    });
    rerender(page(main.port));
    await settle();
    expect(main.placements).toHaveLength(1);
    boxes.mockReturnValue(new DOMRect(10, 80, 600, 400));
    rerender(page(main.port));
    await settle();
    expect(main.placements.at(-1)).toMatchObject({ revision: 2, placement: { bounds: { x: 10 } } });
    boxes.mockRestore();
  });

  it('asks again while main has not heard of its panel, and lets the page go when it goes', async () => {
    vi.useFakeTimers();
    try {
      const main = views([
        { status: 'refused', code: 'not-found', dispatched: false },
        { status: 'refused', code: 'background-unavailable', dispatched: false },
        { status: 'verified', value: 'b3' },
      ]);
      const view = render(page(main.port));
      await act(() => vi.advanceTimersByTimeAsync(400));
      expect(main.bind).toHaveBeenCalledTimes(3);
      view.unmount();
      expect(main.released).toEqual(['b3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes way while something lies over it, showing a still frame of itself or the paper with its title and address', async () => {
    const boxes = placeBoxes(240, 80, 600, 400);
    const main = views();
    render(page(main.port));
    await settle();
    main.showNext({
      status: 'verified',
      value: {
        kind: 'frame',
        frame: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
        capturedAt: 1,
      },
    });
    let uncover: () => void = () => undefined;
    act(() => {
      uncover = addCover('window');
    });
    await settle();
    expect(main.placements.at(-1)?.placement.covered).toBe(true);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    main.showNext({ status: 'verified', value: { kind: 'paper' } });
    act(() => {
      uncover();
    });
    await settle();
    expect(main.placements.at(-1)?.placement.covered).toBe(false);
    expect(screen.getByText('Pricing · Example')).toBeDefined();
    expect(screen.getByText('example.com/pricing')).toBeDefined();
    boxes.mockRestore();
  });

  it('dims while its panel has no focus, and focuses the panel at the click main reports', async () => {
    const boxes = placeBoxes(240, 80, 600, 400);
    const main = views();
    const onFocus = vi.fn();
    const { rerender } = render(page(main.port, { focused: false, onFocus }));
    await settle();
    expect(main.placements.at(-1)?.placement.dim).not.toBeNull();
    main.focus('another');
    expect(onFocus).not.toHaveBeenCalled();
    main.focus('b1');
    expect(onFocus).toHaveBeenCalledOnce();
    rerender(page(main.port, { focused: true, onFocus }));
    await settle();
    expect(main.placements.at(-1)?.placement.dim).toBeNull();
    boxes.mockRestore();
  });

  it('parks the bound page until the panel handles an external file drag or the drag leaves', async () => {
    const boxes = placeBoxes(240, 80, 600, 400);
    vi.useFakeTimers();
    try {
      const main = views();
      render(page(main.port));
      await settle();
      act(() => {
        main.drag('another');
      });
      expect(main.placements.at(-1)?.placement.covered).toBe(false);
      act(() => {
        main.drag('b1');
      });
      await settle();
      expect(main.placements.at(-1)?.placement.covered).toBe(true);
      let endDrop: (() => void) | undefined;
      act(() => {
        endDrop = addCover('window');
      });
      try {
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(main.placements.at(-1)?.placement.covered).toBe(true);
      } finally {
        act(() => {
          endDrop?.();
        });
      }
      await settle();
      expect(main.placements.at(-1)?.placement.covered).toBe(false);
      act(() => {
        main.drag('b1');
      });
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(main.placements.at(-1)?.placement.covered).toBe(false);
    } finally {
      vi.useRealTimers();
      boxes.mockRestore();
    }
  });

  it('borrows the page again once main has let it go', async () => {
    const boxes = placeBoxes(240, 80, 600, 400);
    const main = views([
      { status: 'verified', value: 'b1' },
      { status: 'verified', value: 'b2' },
    ]);
    main.showOnce({ status: 'refused', code: 'stale-target', dispatched: false });
    render(page(main.port));
    await settle();
    await settle();
    expect(main.bind).toHaveBeenCalledTimes(2);
    expect(main.placements.at(-1)?.binding).toBe('b2');
    boxes.mockRestore();
  });

  it('leaves the page at the paper after main has let it go a few times in a row', async () => {
    const boxes = placeBoxes(240, 80, 600, 400);
    const main = views();
    main.showNext({ status: 'refused', code: 'stale-target', dispatched: false });
    render(page(main.port));
    for (let step = 0; step < 10; step++) await settle();
    expect(main.bind).toHaveBeenCalledTimes(4);
    expect(screen.getByText('Pricing · Example')).toBeDefined();
    boxes.mockRestore();
  });
});
