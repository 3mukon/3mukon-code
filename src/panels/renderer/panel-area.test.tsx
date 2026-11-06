import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { DroppedItem, PanelsBridge } from '../shared/panels';
import type { DraggedItem, Panel } from './layout';
import { PanelArea, type PanelAreaHandle, type PanelView } from './panel-area';
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

const area = createRef<PanelAreaHandle>();

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
      ref={area}
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
  return { bridge, root: container.firstElementChild as HTMLElement };
}

// The primary button pressing an item in one of the app's lists, in the sidebar left of the area,
// with pointer 1, as the list hands the press to the area.
function pressItem(item: DraggedItem, label = 'Dragged', press: { button?: number } = {}) {
  act(() => {
    area.current?.dragItem(item, label, {
      button: press.button ?? 0,
      ctrlKey: false,
      pointerId: 1,
      clientX: -100,
      clientY: 20,
    });
  });
}

// The primary button pressing a panel's title with pointer 1.
function pressTitle(title: string, clientX: number, clientY: number) {
  const handle = shown(within(panel(title)).getByText(title).parentElement);
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX, clientY });
}

// The held pointer moving to a point in the window, and letting go there, with the click the
// browser gives the release.
function pointerTo(clientX: number, clientY: number) {
  fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX, clientY });
}
function release(clientX: number, clientY: number) {
  fireEvent.pointerUp(window, { pointerId: 1, clientX, clientY });
  fireEvent.click(document.body);
}

// The frame that ends a drag, after which what the drag dropped opens or moves.
const dropped = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(resolve);
        });
      }),
  );

// An item dragged from one of the app's lists to a point in the area, and let go there, until it has
// opened.
async function dragIn(item: DraggedItem, clientX = 500, clientY = 300) {
  pressItem(item);
  pointerTo(clientX, clientY);
  release(clientX, clientY);
  await dropped();
}
const folder = (path: string): DraggedItem => ({ kind: 'folder', path });
const file = (path: string): DraggedItem => ({ kind: 'file', path });
const session = (id: string): DraggedItem => ({ kind: 'session', id, folder: '/Users/me/web' });

// Sessions titled by their ids, as the app titles them by their own.
const sessionTitles = (shown: Panel): PanelView =>
  shown.content.kind === 'session' ? { title: `Session ${shown.content.id}` } : {};

// A drag of the system's at a point on the element, as items from the Finder or other apps come;
// happy-dom's own drag events carry no point.
function systemDrag(
  type: 'dragover' | 'drop',
  element: Element,
  carried: { types: string[]; files?: File[] },
  clientX = 500,
  clientY = 300,
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: carried.types, dropEffect: 'none', files: carried.files ?? [] },
  });
  return fireEvent(element, event);
}

// The ghost of what is dragged, if one follows the pointer, and the layer that holds the pointer.
const ghost = () => document.querySelector<HTMLElement>('.pointer-events-none.fixed');
const layer = () => document.querySelector<HTMLElement>('.cursor-grabbing');
const dropZone = (root: HTMLElement) => root.querySelector('.outline-accent');

const panel = (name: string) => screen.getByRole('region', { name });
const names = () =>
  screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
// Where a panel sits in the area: its box's place, as the layout gave it.
const place = (name: string) => shown(panel(name).parentElement).style;

function shown<T>(element: T | null): T {
  if (element === null) throw new Error('The element is not shown.');
  return element;
}
const settle = () => act(() => Promise.resolve());

describe('PanelArea', () => {
  it('shows nothing until something opens, and fills the empty area with a folder dragged in from a list, with the pointer’s own events', async () => {
    const capture = vi.spyOn(Element.prototype, 'setPointerCapture');
    const { root } = renderArea();
    expect(root.textContent).toBe('');
    pressItem(folder('/Users/me/web'), 'web');
    // A press that goes nowhere much is a click, and drags nothing.
    pointerTo(-98, 21);
    expect(ghost()).toBeNull();
    // Further, a ghost follows the pointer over a layer that holds it, and the area shows where the
    // folder would open.
    pointerTo(500, 300);
    expect(ghost()?.textContent).toBe('web');
    expect(ghost()?.style.transform).toBe('translate(512px, 308px)');
    expect(capture.mock.contexts).toEqual([layer()]);
    expect(dropZone(root)).not.toBeNull();
    release(500, 300);
    expect(ghost()).toBeNull();
    expect(layer()).toBeNull();
    expect(dropZone(root)).toBeNull();
    // The drag ends at once, and the folder opens once the frame that ends it has been drawn, so that
    // the cursor leaves the grabbing hand before the drop's work begins.
    expect(screen.queryByRole('region')).toBeNull();
    await dropped();
    // A folder opens as a session page, named by its folder, with the path as the tooltip.
    const page = panel('New session');
    expect(within(page).getByText('web').title).toBe('/Users/me/web');
    expect(page.getAttribute('aria-current')).toBe('true');
  });

  it('splits a panel when a drop lands near its edge, and takes its place in its middle, as a panel of its own', async () => {
    renderArea();
    await dragIn(folder('/Users/me/web'));
    await dragIn(file('/Users/me/web/a.ts'), 990, 300);
    expect(names()).toEqual(['New session', 'a.ts']);
    expect(
      screen.getByRole('separator', { name: 'Resize panels' }).getAttribute('aria-orientation'),
    ).toBe('vertical');
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
    expect(panel('New session').getAttribute('aria-current')).toBeNull();
    const a = panel('a.ts');
    await dragIn(file('/Users/me/web/b.ts'), 750, 300);
    expect(names()).toEqual(['New session', 'b.ts']);
    expect(a.isConnected).toBe(false);
  });

  it('drops nothing let go outside the area, at Escape, or as the window loses the focus, and keeps the click that follows a drag from what was pressed', async () => {
    const { root } = renderArea();
    const clicked = vi.fn();
    document.body.addEventListener('click', clicked);
    try {
      pressItem(file('/Users/me/a.ts'));
      pointerTo(-200, 300);
      expect(ghost()).not.toBeNull();
      expect(dropZone(root)).toBeNull();
      // The release's click is the drag's, not the pressed element's.
      release(-200, 300);
      expect(clicked).not.toHaveBeenCalled();
      // A later click is the element's again, even before the drag's next task.
      fireEvent.click(document.body);
      expect(clicked).toHaveBeenCalledOnce();
      await act(() => new Promise((resolve) => setTimeout(resolve)));
      // The click of a press that dragged nothing was never the drag's.
      pressItem(file('/Users/me/a.ts'));
      release(-100, 20);
      expect(clicked).toHaveBeenCalledTimes(2);
    } finally {
      document.body.removeEventListener('click', clicked);
    }
    pressItem(file('/Users/me/a.ts'));
    pointerTo(500, 300);
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false);
    expect(ghost()).toBeNull();
    release(500, 300);
    pressItem(file('/Users/me/a.ts'));
    pointerTo(500, 300);
    fireEvent.blur(window);
    expect(ghost()).toBeNull();
    release(500, 300);
    // A button that went up where the window did not hear it lets go too.
    pressItem(file('/Users/me/a.ts'));
    pointerTo(500, 300);
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 510, clientY: 300 });
    expect(ghost()).toBeNull();
    // Only the primary button drags.
    pressItem(file('/Users/me/a.ts'), 'a.ts', { button: 2 });
    pointerTo(500, 300);
    expect(ghost()).toBeNull();
    release(500, 300);
    await dropped();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('opens folders and files dropped from the Finder through the bridge', async () => {
    const { root, bridge } = renderArea([{ kind: 'file', path: '/Users/me/notes.txt' }]);
    const files = [new File([], 'notes.txt')];
    const finder = { types: ['Files'], files };
    expect(systemDrag('dragover', root, finder)).toBe(false);
    expect(dropZone(root)).not.toBeNull();
    systemDrag('drop', root, finder);
    await settle();
    expect(bridge.itemsAt.mock.calls).toEqual([[files]]);
    expect(within(panel('notes.txt')).getByText('me').title).toBe('/Users/me/notes.txt');
  });

  it('leaves other drags of the system’s alone', () => {
    const { root } = renderArea();
    expect(systemDrag('dragover', root, { types: ['text/plain'] })).toBe(true);
  });

  it('opens a session from the Sessions list where it drops, also beside a panel that shows it already, as files do', async () => {
    renderArea([], false, sessionTitles);
    await dragIn(session('s1'));
    await dragIn(session('s1'), 990, 300);
    expect(names()).toEqual(['Session s1', 'Session s1']);
    const [first, second] = screen.getAllByRole('region', { name: 'Session s1' });
    expect(second?.getAttribute('aria-current')).toBe('true');
    // Dropped in the middle of a panel that shows it, it focuses that panel.
    await dragIn(session('s1'), 250, 300);
    expect(screen.getAllByRole('region')).toHaveLength(2);
    expect(first?.getAttribute('aria-current')).toBe('true');
    // Another session in a panel's middle takes its place.
    await dragIn(session('s2'), 750, 300);
    expect(names()).toEqual(['Session s1', 'Session s2']);
  });

  it('closes a panel from its header, passing the focus to the panel that takes its space', async () => {
    renderArea();
    await dragIn(folder('/Users/me/web'));
    await dragIn(file('/Users/me/a.ts'), 500, 590);
    fireEvent.click(within(panel('a.ts')).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('region', { name: 'a.ts' })).toBeNull();
    expect(panel('New session').getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('marks a panel’s unsaved changes, and asks it before it closes or a drop takes its place', async () => {
    const confirmClose = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
    renderArea([], false, (shown) =>
      shown.content.kind === 'file' ? { unsaved: true, confirmClose } : {},
    );
    await dragIn(file('/Users/me/a.ts'));
    within(panel('a.ts')).getByText('Unsaved changes');
    const close = within(panel('a.ts')).getByRole('button', { name: 'Close panel' });
    expect(close.querySelector('.rounded-full')).not.toBeNull();

    // While the panel says no, it stays: closed from its header or with ⌘W, or replaced by a drop.
    fireEvent.click(close);
    await settle();
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await settle();
    await dragIn(file('/Users/me/b.ts'));
    await settle();
    expect(confirmClose).toHaveBeenCalledTimes(3);
    expect(names()).toEqual(['a.ts']);

    // Once it says yes, the drop takes its place, and the next close closes it.
    confirmClose.mockResolvedValue(true);
    await dragIn(file('/Users/me/b.ts'));
    await settle();
    fireEvent.click(within(panel('b.ts')).getByRole('button', { name: 'Close panel' }));
    await settle();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('gives the keyboard focus to the panel that takes the place of the one that had it, and focuses the panel that shows a dropped item already', async () => {
    const confirmClose = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
    renderArea([], false, () => ({ confirmClose }));
    await dragIn(file('/Users/me/a.ts'));
    await dragIn(file('/Users/me/b.ts'), 990, 300);
    panel('a.ts').focus();
    await dragIn(file('/Users/me/c.ts'), 250, 300);
    await settle();
    expect(document.activeElement).toBe(panel('c.ts'));
    expect(confirmClose).toHaveBeenCalledOnce();

    // The same file dropped in the middle of its panel asks nothing, and focuses that panel.
    fireEvent.pointerDown(panel('b.ts'));
    expect(panel('b.ts').getAttribute('aria-current')).toBe('true');
    await dragIn(file('/Users/me/c.ts'), 250, 300);
    await settle();
    expect(confirmClose).toHaveBeenCalledOnce();
    expect(panel('c.ts').getAttribute('aria-current')).toBe('true');
    expect(screen.getAllByRole('region')).toHaveLength(2);
  });

  it('splits, focuses and closes panels from the keyboard, and the keyboard focus follows', async () => {
    renderArea();
    await dragIn(file('/Users/me/web/a.ts'));
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

  it('puts the headers of the panels at the top in the title bar, clearing the window buttons when asked', async () => {
    const { root } = renderArea([], true);
    // While no panel is open, an empty strip at the top moves the window.
    expect(root.querySelector('[class*="app-region:drag"]')).not.toBeNull();
    await dragIn(file('/Users/me/web/a.ts'));
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

  it('moves a panel pressed by its title beside another, or swaps the two in its middle, with the pointer’s own events', async () => {
    const { root } = renderArea();
    await dragIn(file('/Users/me/web/a.ts'));
    await dragIn(file('/Users/me/web/b.ts'), 990, 300);
    // a.ts on the left, b.ts on the right.
    expect([place('a.ts').left, place('b.ts').left]).toEqual(['0%', '50%']);

    // A press that goes nowhere much is a click, and moves nothing.
    pressTitle('a.ts', 100, 20);
    pointerTo(102, 21);
    expect(ghost()).toBeNull();
    release(102, 21);
    expect([place('a.ts').left, place('b.ts').left]).toEqual(['0%', '50%']);

    // Once it goes further, a ghost of the title follows the pointer; over itself, or outside the
    // panels, nothing shows where it would go, and let go there, it stays where it was.
    pressTitle('a.ts', 100, 20);
    pointerTo(250, 300);
    expect(ghost()?.textContent).toBe('a.ts');
    expect(dropZone(root)).toBeNull();
    pointerTo(1200, 300);
    release(1200, 300);
    expect(ghost()).toBeNull();
    await dropped();
    expect([place('a.ts').left, place('b.ts').left]).toEqual(['0%', '50%']);

    // Near b.ts's bottom edge, a.ts moves below it.
    pressTitle('a.ts', 100, 20);
    pointerTo(750, 590);
    expect(dropZone(root)).not.toBeNull();
    release(750, 590);
    expect(dropZone(root)).toBeNull();
    await dropped();
    expect([place('b.ts').top, place('a.ts').top]).toEqual(['0%', '50%']);
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal');
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');

    // In b.ts's middle, the two swap places.
    pressTitle('a.ts', 100, 320);
    pointerTo(500, 150);
    release(500, 150);
    await dropped();
    expect([place('a.ts').top, place('b.ts').top]).toEqual(['0%', '50%']);
  });

  it('leaves the panels’ bodies as they are while a drag goes over them and as it ends', async () => {
    const renders = vi.fn();
    function Body() {
      renders();
      return <p>Long session</p>;
    }
    renderArea([], false, () => ({ body: <Body /> }));
    await dragIn(file('/Users/me/web/a.ts'));
    await dragIn(file('/Users/me/web/b.ts'), 990, 300);
    const before = renders.mock.calls.length;
    // The drop zone moves from panel to panel, and the drag ends outside the area.
    pressItem(file('/Users/me/web/c.ts'));
    pointerTo(250, 300);
    pointerTo(750, 300);
    pointerTo(990, 300);
    release(-200, 300);
    await dropped();
    expect(renders.mock.calls.length).toBe(before);
  });

  it('focuses the next panel that way with ⌥⌘ and an arrow, and swaps with it with ⇧⌥⌘', async () => {
    renderArea();
    await dragIn(file('/Users/me/web/a.ts'));
    await dragIn(file('/Users/me/web/b.ts'), 990, 300);
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true, altKey: true });
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(panel('a.ts'));
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true, altKey: true, shiftKey: true });
    expect([place('b.ts').left, place('a.ts').left]).toEqual(['0%', '50%']);
    expect(panel('a.ts').getAttribute('aria-current')).toBe('true');
  });

  it('resizes the panels from a divider', async () => {
    renderArea();
    await dragIn(folder('/Users/me/web'));
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    const divider = screen.getByRole('separator', { name: 'Resize panels' });
    expect(divider.style.left).toBe('50%');
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(divider.getAttribute('aria-valuenow')).toBe('60');
    expect(divider.style.left).toBe('60%');
  });
});

describe('PanelArea panels without a folder', () => {
  it('shows the archived sessions and the settings by the titles given them, and leaves ⌘D to the window there', () => {
    function Own() {
      const panels = usePanels();
      return (
        <>
          <button
            type="button"
            onClick={() => {
              panels.open([{ kind: 'settings' }]);
            }}
          >
            Open the settings
          </button>
          <PanelArea
            panels={panels}
            bridge={{ itemsAt: () => Promise.resolve([]) }}
            clearsWindowButtons={false}
            view={(shown) => (shown.content.kind === 'settings' ? { title: 'Settings' } : {})}
          />
        </>
      );
    }
    render(<Own />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the settings' }));
    const settings = panel('Settings');
    expect(within(settings).queryByTitle(/\//)).toBeNull();
    expect(fireEvent.keyDown(window, { key: 'd', metaKey: true })).toBe(true);
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });
});
