import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { DroppedItem, PanelsBridge } from '../shared/panels';
import { itemDragType } from './item-drag';
import type { Panel } from './layout';
import { PanelArea, type PanelView } from './panel-area';
import { usePanels } from './use-panels';

beforeAll(() => {
  initI18n(['en-US']);
});
// happy-dom lays nothing out, so the area measures 1000 by 600 pixels and each panel in it takes the
// part its place in the layout gives it.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const placed = this.closest<HTMLElement>('[data-panel]')?.style;
    const share = (value: string | undefined, whole: number, fallback: number) =>
      value === undefined || value === '' ? fallback : (parseFloat(value) / 100) * whole;
    const left = share(placed?.left, 1000, 0);
    const top = share(placed?.top, 600, 0);
    const width = share(placed?.width, 1000, 1000);
    const height = share(placed?.height, 600, 600);
    return {
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Area({
  bridge,
  clearsWindowButtons,
  view,
}: {
  bridge: PanelsBridge;
  clearsWindowButtons: boolean;
  view?: (panel: Panel) => PanelView;
}) {
  return (
    <PanelArea
      panels={usePanels()}
      bridge={bridge}
      clearsWindowButtons={clearsWindowButtons}
      {...(view === undefined ? {} : { view })}
    />
  );
}

function renderArea(
  found: DroppedItem[] = [],
  clearsWindowButtons = false,
  view?: (panel: Panel) => PanelView,
) {
  const bridge = { itemsAt: vi.fn<PanelsBridge['itemsAt']>(() => Promise.resolve(found)) };
  const { container } = render(
    <Area
      bridge={bridge}
      clearsWindowButtons={clearsWindowButtons}
      {...(view === undefined ? {} : { view })}
    />,
  );
  return { bridge, area: container.firstElementChild as HTMLElement };
}

// What a drag carries: a folder or file from one of the app's trees, Finder items or something else.
interface Carried {
  types: string[];
  files?: File[];
  item?: DroppedItem;
}

const fromTree = (item: DroppedItem): Carried => ({ types: [itemDragType], item });

// A drag event of this type at a point on the element; happy-dom's own drag events carry no point.
function drag(
  type: 'dragover' | 'drop',
  element: Element,
  carried: Carried,
  clientX = 500,
  clientY = 300,
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: carried.types,
      dropEffect: 'none',
      files: carried.files ?? [],
      getData: (format: string) =>
        format === itemDragType && carried.item !== undefined ? JSON.stringify(carried.item) : '',
    },
  });
  return fireEvent(element, event);
}

// Drops the panel being moved on an element, at a point on it.
function dropPanel(element: Element, panelId: string, clientX: number, clientY: number) {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['application/x-3mukon-code-panel'],
      files: [],
      getData: (format: string) => (format === 'application/x-3mukon-code-panel' ? panelId : ''),
    },
  });
  return fireEvent(element, event);
}

const panel = (name: string) => screen.getByRole('region', { name });
// Where a panel sits in the area: its box's place, as the layout gave it.
const place = (name: string) => shown(panel(name).parentElement).style;

function shown<T>(element: T | null): T {
  if (element === null) throw new Error('The element is not shown.');
  return element;
}
const settle = () => act(() => Promise.resolve());

describe('PanelArea', () => {
  it('shows nothing until something opens, and fills the empty area with a dropped folder', () => {
    const { area } = renderArea();
    expect(area.textContent).toBe('');
    const web = fromTree({ kind: 'folder', path: '/Users/me/web' });
    expect(drag('dragover', area, web)).toBe(false);
    expect(area.querySelector('.outline-accent')).not.toBeNull();
    drag('drop', area, web);
    expect(area.querySelector('.outline-accent')).toBeNull();
    // A folder opens as a session page, named by its folder, with the path as the tooltip.
    const page = panel('New session');
    expect(within(page).getByText('web').title).toBe('/Users/me/web');
    expect(page.getAttribute('aria-current')).toBe('true');
  });

  it('splits a panel when a drop lands near its edge, and takes its place in its middle', () => {
    const { area } = renderArea();
    drag('drop', area, fromTree({ kind: 'folder', path: '/Users/me/web' }));
    drag(
      'drop',
      panel('New session'),
      fromTree({ kind: 'file', path: '/Users/me/web/a.ts' }),
      990,
      300,
    );
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')),
    ).toEqual(['New session', 'a.ts']);
    expect(
      screen.getByRole('separator', { name: 'Resize panels' }).getAttribute('aria-orientation'),
    ).toBe('vertical');
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
    expect(panel('New session').getAttribute('aria-current')).toBeNull();
    drag('drop', panel('a.ts'), fromTree({ kind: 'file', path: '/Users/me/web/b.ts' }), 750, 300);
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')),
    ).toEqual(['New session', 'b.ts']);
  });

  it('opens folders and files dropped from the Finder through the bridge', async () => {
    const { area, bridge } = renderArea([{ kind: 'file', path: '/Users/me/notes.txt' }]);
    const files = [new File([], 'notes.txt')];
    const finder: Carried = { types: ['Files'], files };
    expect(drag('dragover', area, finder)).toBe(false);
    drag('drop', area, finder);
    await settle();
    expect(bridge.itemsAt.mock.calls).toEqual([[files]]);
    expect(within(panel('notes.txt')).getByText('me').title).toBe('/Users/me/notes.txt');
  });

  it('leaves other drags alone', () => {
    const { area } = renderArea();
    expect(drag('dragover', area, { types: ['text/plain'] })).toBe(true);
  });

  it('closes a panel from its header, passing the focus to the panel that takes its space', () => {
    const { area } = renderArea();
    drag('drop', area, fromTree({ kind: 'folder', path: '/Users/me/web' }));
    drag(
      'drop',
      panel('New session'),
      fromTree({ kind: 'file', path: '/Users/me/a.ts' }),
      500,
      590,
    );
    fireEvent.click(within(panel('a.ts')).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('region', { name: 'a.ts' })).toBeNull();
    expect(panel('New session').getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('marks a panel’s unsaved changes, and asks it before it closes or a drop takes its place', async () => {
    const confirmClose = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
    const { area } = renderArea([], false, (shown) =>
      shown.content.kind === 'file' ? { unsaved: true, confirmClose } : {},
    );
    drag('drop', area, fromTree({ kind: 'file', path: '/Users/me/a.ts' }));
    within(panel('a.ts')).getByText('Unsaved changes');
    const close = within(panel('a.ts')).getByRole('button', { name: 'Close panel' });
    expect(close.querySelector('.rounded-full')).not.toBeNull();

    // While the panel says no, it stays: closed from its header or with ⌘W, or replaced by a drop.
    fireEvent.click(close);
    await settle();
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await settle();
    drag('drop', panel('a.ts'), fromTree({ kind: 'file', path: '/Users/me/b.ts' }), 500, 300);
    await settle();
    expect(confirmClose).toHaveBeenCalledTimes(3);
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label')),
    ).toEqual(['a.ts']);

    // Once it says yes, the drop takes its place, and the next close closes it.
    confirmClose.mockResolvedValue(true);
    drag('drop', panel('a.ts'), fromTree({ kind: 'file', path: '/Users/me/b.ts' }), 500, 300);
    await settle();
    fireEvent.click(within(panel('b.ts')).getByRole('button', { name: 'Close panel' }));
    await settle();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('splits, focuses and closes panels from the keyboard, and the keyboard focus follows', () => {
    const { area } = renderArea();
    drag('drop', area, fromTree({ kind: 'file', path: '/Users/me/web/a.ts' }));
    // ⌘D opens a session page in the focused panel's folder, to its right; ⇧⌘D below it.
    expect(fireEvent.keyDown(window, { key: 'd', metaKey: true })).toBe(false);
    expect(within(panel('New session')).getByText('web').title).toBe('/Users/me/web');
    expect(document.activeElement).toBe(panel('New session'));
    fireEvent.keyDown(window, { key: 'D', metaKey: true, shiftKey: true });
    expect(screen.getAllByRole('region')).toHaveLength(3);
    expect(
      screen.getAllByRole('separator').map((divider) => divider.getAttribute('aria-orientation')),
    ).toEqual(['vertical', 'horizontal']);
    // ⌘1 focuses the first panel in reading order.
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(panel('a.ts'));
    // ⌘W closes the focused panel.
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    expect(screen.queryByRole('region', { name: 'a.ts' })).toBeNull();
    expect(screen.getAllByRole('region')).toHaveLength(2);
  });

  it('leaves the keys to the window while no panel is open', () => {
    renderArea();
    expect(fireEvent.keyDown(window, { key: 'w', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: 'd', metaKey: true })).toBe(true);
  });

  it('shows what lies beside the window buttons in the empty strip while they lie over the area', () => {
    function Beside({ clears }: { clears: boolean }) {
      return (
        <PanelArea
          panels={usePanels()}
          bridge={{ itemsAt: () => Promise.resolve([]) }}
          clearsWindowButtons={clears}
          besideWindowButtons={<b>2 waiting</b>}
        />
      );
    }
    const { rerender } = render(<Beside clears={false} />);
    expect(screen.queryByText('2 waiting')).toBeNull();
    rerender(<Beside clears />);
    expect(screen.getByText('2 waiting').parentElement?.className).toContain('pl-[84px]');
  });

  it('puts the headers of the panels at the top in the title bar, clearing the window buttons when asked', () => {
    const { area } = renderArea([], true);
    // While no panel is open, an empty strip at the top moves the window.
    expect(area.querySelector('[class*="app-region:drag"]')).not.toBeNull();
    drag('drop', area, fromTree({ kind: 'file', path: '/Users/me/web/a.ts' }));
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    fireEvent.keyDown(window, { key: 'D', metaKey: true, shiftKey: true });
    const headers = screen
      .getAllByRole('region')
      .map((region) => region.querySelector('header')?.className ?? '');
    // a.ts on the left and the first page at the top right lie in the title bar; the page below does not.
    expect(headers.map((header) => header.includes('[-webkit-app-region:drag]'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(headers.map((header) => header.includes('pl-[84px]'))).toEqual([true, false, false]);
  });

  it('moves a panel dragged by its title beside another, or swaps the two in its middle', () => {
    const { area } = renderArea();
    drag('drop', area, fromTree({ kind: 'file', path: '/Users/me/web/a.ts' }));
    drag('drop', panel('a.ts'), fromTree({ kind: 'file', path: '/Users/me/web/b.ts' }), 990, 300);
    // a.ts on the left, b.ts on the right.
    expect([place('a.ts').left, place('b.ts').left]).toEqual(['0%', '50%']);
    const handle = shown(within(panel('a.ts')).getByText('a.ts').parentElement);
    const moved = { types: ['application/x-3mukon-code-panel'] };
    fireEvent.dragStart(handle, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    // A panel does not drop on itself.
    expect(drag('dragover', panel('a.ts'), moved, 250, 300)).toBe(true);
    expect(area.querySelector('.outline-accent')).toBeNull();
    // Near b.ts's bottom edge, a.ts moves below it.
    expect(drag('dragover', panel('b.ts'), moved, 750, 590)).toBe(false);
    dropPanel(panel('b.ts'), 'panel-1', 750, 590);
    expect([place('b.ts').top, place('a.ts').top]).toEqual(['0%', '50%']);
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal');
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
    // In b.ts's middle, the two swap places.
    dropPanel(panel('b.ts'), 'panel-1', 500, 150);
    expect([place('a.ts').top, place('b.ts').top]).toEqual(['0%', '50%']);
  });

  it('focuses the next panel that way with ⌥⌘ and an arrow, and swaps with it with ⇧⌥⌘', () => {
    const { area } = renderArea();
    drag('drop', area, fromTree({ kind: 'file', path: '/Users/me/web/a.ts' }));
    drag('drop', panel('a.ts'), fromTree({ kind: 'file', path: '/Users/me/web/b.ts' }), 990, 300);
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true, altKey: true });
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(panel('a.ts'));
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, altKey: true, shiftKey: true });
    expect([place('b.ts').left, place('a.ts').left]).toEqual(['0%', '50%']);
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
  });

  it('resizes the panels from a divider', () => {
    const { area } = renderArea();
    drag('drop', area, fromTree({ kind: 'folder', path: '/Users/me/web' }));
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    const divider = screen.getByRole('separator', { name: 'Resize panels' });
    expect(divider.style.left).toBe('50%');
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(divider.getAttribute('aria-valuenow')).toBe('60');
    expect(divider.style.left).toBe('60%');
  });
});
