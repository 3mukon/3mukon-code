import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { DroppedItem, PanelsBridge } from '../shared/panels';
import { itemDragType } from './item-drag';
import { PanelArea } from './panel-area';
import { usePanels } from './use-panels';

beforeAll(() => {
  initI18n(['en-US']);
});
// happy-dom lays nothing out, so the area and every panel in it measure 1000 by 600 pixels.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Area({
  bridge,
  clearsWindowButtons,
}: {
  bridge: PanelsBridge;
  clearsWindowButtons: boolean;
}) {
  return (
    <PanelArea panels={usePanels()} bridge={bridge} clearsWindowButtons={clearsWindowButtons} />
  );
}

function renderArea(found: DroppedItem[] = [], clearsWindowButtons = false) {
  const bridge = { itemsAt: vi.fn<PanelsBridge['itemsAt']>(() => Promise.resolve(found)) };
  const { container } = render(<Area bridge={bridge} clearsWindowButtons={clearsWindowButtons} />);
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

const panel = (name: string) => screen.getByRole('region', { name });
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
    drag('drop', panel('a.ts'), fromTree({ kind: 'file', path: '/Users/me/web/b.ts' }));
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
