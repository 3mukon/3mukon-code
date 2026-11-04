import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Divider } from '../../ui/renderer/divider';
import { Pane } from '../../ui/renderer/pane';
import type { Status } from '../../ui/renderer/status-dot';
import type { PanelContent, PanelsBridge } from '../shared/panels';
import { arrange, neighbour, zoneAt, type Box, type Direction, type Rect } from './geometry';
import {
  contentOf,
  folderOf,
  inOpeningOrder,
  panelsOf,
  sameContent,
  type DraggedItem,
  type Move,
  type Panel,
  type Side,
  type Target,
} from './layout';
import type { Panels } from './use-panels';

// What a panel shows, as whoever composes the area decides: its header's title, detail, the detail's
// tooltip and status, whether it holds unsaved changes, and its body. What is left out keeps the
// area's own: the panel's name and folder, and an empty body. A panel may also be asked before it
// closes or something else takes its place, and stays when the answer is no.
export interface PanelView {
  title?: string;
  detail?: string;
  detailTitle?: string;
  status?: Status;
  statusLabel?: string;
  unsaved?: boolean;
  confirmClose?: () => Promise<boolean>;
  body?: ReactNode;
}

interface PanelAreaProps {
  panels: Panels;
  bridge: PanelsBridge;
  view?: (panel: Panel) => PanelView;
  // macOS's window buttons lie over the area's top-left corner, as they do while the sidebar is
  // hidden.
  clearsWindowButtons: boolean;
  // Shown just after the window buttons while they lie over the area: in the header of the panel at
  // the top left, or in the empty strip while no panel is open.
  besideWindowButtons?: ReactNode;
  ref?: Ref<PanelAreaHandle>;
}

// A press that may begin a drag: its button, whether Control made it macOS's secondary click, its
// pointer, and where it was in the window.
export interface Press {
  button: number;
  ctrlKey: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
}

// What whoever composes the area may ask of it: to follow a press on an item of the app's lists,
// which drags the item into the area once the pointer has gone far enough, the ghost that follows the
// pointer saying the label.
export interface PanelAreaHandle {
  dragItem(item: DraggedItem, label: string, press: Press): void;
}

// What a drag with the pointer carries: a panel moved by its title, or an item from the app's lists,
// with its ghost's label.
type Carried =
  { kind: 'panel'; panelId: string } | { kind: 'item'; item: DraggedItem; label: string };

// Where a drag would drop: on the empty area, or on a panel, in the zone under the pointer.
interface PanelTarget {
  kind: 'panel';
  panelId: string;
  zone: Side | 'middle';
}
type DropTarget = { kind: 'area' } | PanelTarget;

// What a key press does in the panel area.
type Command =
  | { type: 'split'; side: Side }
  | { type: 'close' }
  | { type: 'focus-index'; index: number }
  | { type: 'focus-towards'; direction: Direction }
  | { type: 'swap-towards'; direction: Direction };

// How far the pointer goes from where it pressed, in pixels, before the press drags what it pressed,
// so that a click stays a click.
const DRAG_AFTER = 4;

// The main area's panels, laid out as the panel layout says, from the window's top edge. Each panel
// takes its box in the area, and the panels stay in the order they were opened, so that a split or a
// close moves no panel's content elsewhere in the page; a divider stands between the two parts of each
// split. The headers of the panels at the top lie in the title bar, which they move the window by,
// the one under the window buttons leaving room for them; while no panel is open, an empty strip
// there moves the window instead.
//
// A folder or file dragged from a tree or the Finder, or a session from the Sessions list, fills the
// empty area; near a panel's edge it splits that panel and opens on that side, and in a panel's middle
// it takes the panel's place, as a panel of its own; a file or session may show in several panels,
// and an item dropped in the middle of the panel that shows it focuses that panel. A panel pressed by
// its title and dragged onto another panel goes beside it near its edge, and in its middle the two
// swap places. The app's own items and panels drag with the pointer's own events rather than a drag
// of the system's, whose copy badge Chromium shows on macOS as such a drag enters the page (L-0003): a
// ghost of what is dragged follows the pointer over a layer that holds it, and let go anywhere else,
// a panel on itself too, or given Escape, nothing moves; Finder items come as the system's drag. A
// panel that asks before it closes is asked first, also before a drop takes its place.
//
// The keyboard, from anywhere in the window: ⌘D splits the focused panel to the right and ⇧⌘D
// downwards, opening a session page in its folder; ⌘W closes the focused panel; ⌘1 to ⌘9 focus the
// panels in reading order; ⌥⌘ and an arrow focus the next panel that way, and ⇧⌥⌘ and an arrow swap
// the focused panel with it. Dividers take focus with Tab and move with the arrow keys.
export function PanelArea({
  panels,
  bridge,
  view,
  clearsWindowButtons,
  besideWindowButtons,
  ref,
}: PanelAreaProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  // Set by what changes the focused panel from the keyboard, or takes the place of the panel with the
  // keyboard focus, so that the keyboard focus follows it.
  const followFocus = useRef(false);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  // What is being dragged with the pointer, once the pointer has gone far enough, and by which
  // pointer; and the ghost that follows the pointer, from where the pointer last was.
  const [dragging, setDragging] = useState<{ carried: Carried; pointerId: number } | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const ordered = panelsOf(panels.layout);
  const arrangement = arrange(panels.layout);
  const focused = ordered.find((panel) => panel.id === panels.focusedId);
  const holdsFocus = (id: string) =>
    elements.current.get(id)?.contains(document.activeElement) === true;

  // Runs what closes a panel, or puts something else in its place, once the panel lets it.
  const whenClosable = (panel: Panel | undefined, then: () => void) => {
    const confirmClose = panel === undefined ? undefined : view?.(panel).confirmClose;
    if (confirmClose === undefined) {
      then();
      return;
    }
    confirmClose().then((closable) => {
      if (closable) then();
    }, reportClose);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = commandFor(event);
      if (command === null || focused === undefined) return;
      let nextFocus: string | undefined;
      switch (command.type) {
        case 'split':
          panels.open([{ kind: 'session-page', folder: folderOf(focused.content) }], {
            kind: 'beside',
            panelId: focused.id,
            side: command.side,
          });
          break;
        case 'close':
          whenClosable(focused, () => {
            panels.close(focused.id);
          });
          break;
        case 'focus-index':
          nextFocus = ordered[command.index]?.id;
          if (nextFocus === undefined) return;
          panels.focus(nextFocus);
          break;
        case 'focus-towards':
          nextFocus = neighbour(rectsOf(elements.current), focused.id, command.direction);
          if (nextFocus === undefined) return;
          panels.focus(nextFocus);
          break;
        case 'swap-towards': {
          const other = neighbour(rectsOf(elements.current), focused.id, command.direction);
          if (other === undefined) return;
          panels.move(focused.id, { kind: 'swap', panelId: other });
          break;
        }
      }
      event.preventDefault();
      followFocus.current = true;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  useEffect(() => {
    if (!followFocus.current) return;
    followFocus.current = false;
    if (panels.focusedId !== null) elements.current.get(panels.focusedId)?.focus();
  });

  // Opens items where a drag drops them. An item dropped in the middle of the panel that shows it
  // already focuses that panel, and one that takes the place of the panel with the keyboard focus
  // takes the focus.
  const openAt = (target: DropTarget, contents: PanelContent[]) => {
    const at = openingAt(target);
    const replaced =
      at.kind === 'replace' ? ordered.find((panel) => panel.id === at.panelId) : undefined;
    const [only, ...others] = contents;
    const shownThere =
      replaced !== undefined &&
      only !== undefined &&
      others.length === 0 &&
      sameContent(replaced.content, only);
    if (shownThere) {
      panels.focus(replaced.id);
      return;
    }
    whenClosable(replaced, () => {
      if (replaced !== undefined && holdsFocus(replaced.id)) followFocus.current = true;
      panels.open(contents, at);
    });
  };
  // As the latest render has it, for a drag that began in an earlier one.
  const latestOpenAt = useRef(openAt);
  useLayoutEffect(() => {
    latestOpenAt.current = openAt;
  });

  // Where a drag would drop at a point in the window: on the empty area, or on the panel under the
  // point, in the zone there. A panel being moved goes nowhere over itself or on the empty area.
  const dropTargetAt = (x: number, y: number, movingPanel?: string): DropTarget | null => {
    if (elements.current.size === 0) {
      const area = root.current?.getBoundingClientRect();
      const inArea = area !== undefined && contains(area, x, y);
      return movingPanel === undefined && inArea ? { kind: 'area' } : null;
    }
    for (const [panelId, rect] of rectsOf(elements.current)) {
      if (!contains(rect, x, y)) continue;
      return panelId === movingPanel ? null : { kind: 'panel', panelId, zone: zoneAt(x, y, rect) };
    }
    return null;
  };

  // Follows a press with the primary button, which drags what it carries once the pointer has gone
  // far enough from it, and drops it as the button goes up; Escape, the window losing the focus or
  // the button going up where the window did not hear it drop nothing. The click that follows a drag
  // is not the pressed element's.
  const follow = (carried: Carried, press: Press) => {
    if (press.button !== 0 || press.ctrlKey) return;
    const { pointerId } = press;
    const from = { x: press.clientX, y: press.clientY };
    const movingPanel = carried.kind === 'panel' ? carried.panelId : undefined;
    let started = false;
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (next.buttons === 0) {
        end(null);
        return;
      }
      pointer.current = { x: next.clientX, y: next.clientY };
      if (!started) {
        if (Math.hypot(next.clientX - from.x, next.clientY - from.y) < DRAG_AFTER) return;
        started = true;
        setDragging({ carried, pointerId });
      }
      placeGhost(ghost.current, pointer.current);
      const target = dropTargetAt(next.clientX, next.clientY, movingPanel);
      setDrop((shown) => (target !== null && sameTarget(shown, target) ? shown : target));
    };
    const end = (target: DropTarget | null) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
      if (!started) return;
      setDragging(null);
      setDrop(null);
      swallowClick();
      if (target === null) return;
      if (carried.kind === 'item') latestOpenAt.current(target, [contentOf(carried.item)]);
      else if (target.kind === 'panel') panels.move(carried.panelId, movingTo(target));
    };
    const release = (released: globalThis.PointerEvent) => {
      if (released.pointerId !== pointerId) return;
      end(started ? dropTargetAt(released.clientX, released.clientY, movingPanel) : null);
    };
    const cancel = () => {
      end(null);
    };
    const escape = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || !started) return;
      key.preventDefault();
      key.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
  };

  // What the ghost of a drag says: a panel's title, or the label of an item from the lists.
  const ghostLabel = (carried: Carried) => {
    if (carried.kind === 'item') return carried.label;
    const panel = ordered.find((each) => each.id === carried.panelId);
    if (panel === undefined) return '';
    return view?.(panel).title ?? describe(panel.content, t('panels.sessionPage')).title;
  };

  useImperativeHandle(ref, () => ({
    dragItem: (item, label, press) => {
      follow({ kind: 'item', item, label }, press);
    },
  }));

  // Finder items, which come as a drag of the system's.
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    const target = dropTargetAt(event.clientX, event.clientY);
    if (target === null) {
      setDrop(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!sameTarget(drop, target)) setDrop(target);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const target = dropTargetAt(event.clientX, event.clientY);
    setDrop(null);
    const files = [...event.dataTransfer.files];
    if (target === null || files.length === 0) return;
    bridge.itemsAt(files).then((items) => {
      if (items.length > 0) openAt(target, items.map(contentOf));
    }, report);
  };

  const boundsOf = (box: Box) => () => {
    const rect = root.current?.getBoundingClientRect();
    if (rect === undefined) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: rect.left + box.x * rect.width,
      top: rect.top + box.y * rect.height,
      width: box.width * rect.width,
      height: box.height * rect.height,
    };
  };

  return (
    <div
      ref={root}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={onDrop}
      className="relative h-full min-h-0 w-full"
    >
      {inOpeningOrder(ordered).map((panel) => {
        const box = arrangement.panels.get(panel.id);
        if (box === undefined) return null;
        const own = describe(panel.content, t('panels.sessionPage'));
        const shown = view?.(panel) ?? {};
        return (
          <div
            key={panel.id}
            data-panel={panel.id}
            style={placed(box)}
            className="absolute grid min-h-0 min-w-0"
          >
            <Pane
              ref={(element) => {
                if (element) elements.current.set(panel.id, element);
                return () => {
                  elements.current.delete(panel.id);
                };
              }}
              title={shown.title ?? own.title}
              detail={shown.detail ?? own.detail}
              detailTitle={shown.detailTitle ?? own.path}
              {...(shown.status === undefined ? {} : { status: shown.status })}
              {...(shown.statusLabel === undefined ? {} : { statusLabel: shown.statusLabel })}
              unsaved={shown.unsaved ?? false}
              unsavedLabel={t('panels.unsaved')}
              focused={panel.id === panels.focusedId}
              inTitleBar={box.y === 0}
              clearsWindowButtons={clearsWindowButtons && box.x === 0 && box.y === 0}
              {...(clearsWindowButtons && box.x === 0 && box.y === 0
                ? { start: besideWindowButtons }
                : {})}
              onFocus={() => {
                panels.focus(panel.id);
              }}
              onClose={() => {
                whenClosable(panel, () => {
                  panels.close(panel.id);
                });
              }}
              onHandlePointerDown={(event) => {
                follow({ kind: 'panel', panelId: panel.id }, event);
              }}
              closeLabel={t('panels.close')}
            >
              {shown.body}
            </Pane>
            {drop?.kind === 'panel' && drop.panelId === panel.id && <DropZone zone={drop.zone} />}
          </div>
        );
      })}
      {arrangement.splits.map(({ split, box }) => (
        <Divider
          key={split.id}
          direction={split.direction}
          ratio={split.ratio}
          onRatioChange={(ratio) => {
            panels.resize(split.id, ratio);
          }}
          bounds={boundsOf(box)}
          label={t('panels.resize')}
          style={dividerPlace(split.direction, split.ratio, box)}
        />
      ))}
      {panels.layout === null && (
        <div
          className={`absolute inset-x-0 top-0 flex h-10 items-center [-webkit-app-region:drag] ${clearsWindowButtons ? 'pl-[84px]' : ''}`}
        >
          {clearsWindowButtons && besideWindowButtons}
        </div>
      )}
      {drop?.kind === 'area' && <DropZone zone="middle" />}
      {dragging !== null && (
        <>
          {/* Over the whole window while a drag goes on, holding the pointer, so that its events come
              here wherever it goes and it keeps the grabbing cursor. */}
          <div
            ref={(element) => {
              holdPointer(element, dragging.pointerId);
            }}
            aria-hidden="true"
            className="fixed inset-0 z-40 cursor-grabbing"
          />
          <div
            ref={(element) => {
              ghost.current = element;
              placeGhost(element, pointer.current);
            }}
            aria-hidden="true"
            className="pointer-events-none fixed top-0 left-0 z-50 max-w-60 truncate rounded-md border border-dashed border-menu-line paper px-2 text-[13px] leading-6 font-medium text-ink"
          >
            {ghostLabel(dragging.carried)}
          </div>
        </>
      )}
    </div>
  );
}

// Puts the ghost of what is dragged just below and to the right of the pointer.
function placeGhost(element: HTMLElement | null, at: { x: number; y: number }): void {
  if (element === null) return;
  element.style.transform = `translate(${String(at.x + 12)}px, ${String(at.y + 8)}px)`;
}

// Holds the pointer to the element, unless it has gone up already.
function holdPointer(element: HTMLElement | null, pointerId: number): void {
  try {
    element?.setPointerCapture(pointerId);
  } catch {
    // The pointer is no longer down; its release has been heard or will end the drag.
  }
}

// Keeps the click that follows a drag's release from the element that was pressed, which would
// otherwise take it as its own, such as a row that opens its item.
function swallowClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => {
    window.removeEventListener('click', swallow, { capture: true });
  });
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

// Shows where a drop opens its item: the half of the panel on that side, or the whole panel.
function DropZone({ zone }: { zone: Side | 'middle' }) {
  const insets: Record<Side | 'middle', string> = {
    left: '0 50% 0 0',
    right: '0 0 0 50%',
    top: '0 0 50% 0',
    bottom: '50% 0 0 0',
    middle: '0',
  };
  return (
    <div
      aria-hidden="true"
      style={{ inset: insets[zone] }}
      className="pointer-events-none absolute z-20 rounded-md bg-accent/10 outline-2 -outline-offset-2 outline-accent"
    />
  );
}

const directions: Partial<Record<string, Direction>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function commandFor(event: KeyboardEvent): Command | null {
  if (!event.metaKey || event.ctrlKey) return null;
  if (event.altKey) {
    const direction = directions[event.key];
    if (direction === undefined) return null;
    return { type: event.shiftKey ? 'swap-towards' : 'focus-towards', direction };
  }
  const key = event.key.toLowerCase();
  if (key === 'd') return { type: 'split', side: event.shiftKey ? 'bottom' : 'right' };
  if (event.shiftKey) return null;
  if (key === 'w') return { type: 'close' };
  if (/^[1-9]$/.test(key)) return { type: 'focus-index', index: Number(key) - 1 };
  return null;
}

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  if (a?.kind === 'area') return b.kind === 'area';
  return a?.kind === 'panel' && b.kind === 'panel' && a.panelId === b.panelId && a.zone === b.zone;
}

function movingTo(target: { panelId: string; zone: Side | 'middle' }): Move {
  return target.zone === 'middle'
    ? { kind: 'swap', panelId: target.panelId }
    : { kind: 'beside', panelId: target.panelId, side: target.zone };
}

function openingAt(target: DropTarget): Target {
  if (target.kind === 'area') return { kind: 'area' };
  if (target.zone === 'middle') return { kind: 'replace', panelId: target.panelId };
  return { kind: 'beside', panelId: target.panelId, side: target.zone };
}

// A panel's own title, and its folder's name with the full path: a session page or session goes by
// the given title, a file by its name.
function describe(content: PanelContent, sessionPage: string) {
  const path = folderOf(content);
  const folder = nameOf(path);
  return content.kind === 'file'
    ? { title: nameOf(content.path), detail: folder, path: content.path }
    : { title: sessionPage, detail: folder, path };
}

// The last name in a path, or the path itself for the startup disk's root.
function nameOf(path: string): string {
  const name = path.replace(/\/+$/, '').split('/').at(-1);
  return name === undefined || name === '' ? path : name;
}

function rectsOf(elements: ReadonlyMap<string, HTMLElement>): Map<string, Rect> {
  return new Map([...elements].map(([id, element]) => [id, element.getBoundingClientRect()]));
}

const percent = (share: number) => `${String(share * 100)}%`;

function placed(box: Box): CSSProperties {
  return {
    left: percent(box.x),
    top: percent(box.y),
    width: percent(box.width),
    height: percent(box.height),
  };
}

// Where a split's divider goes: across the split at its ratio, centred on the line between its parts.
function dividerPlace(direction: 'row' | 'column', ratio: number, box: Box): CSSProperties {
  return direction === 'row'
    ? {
        left: percent(box.x + box.width * ratio),
        top: percent(box.y),
        height: percent(box.height),
        transform: 'translateX(-50%)',
      }
    : {
        top: percent(box.y + box.height * ratio),
        left: percent(box.x),
        width: percent(box.width),
        transform: 'translateY(-50%)',
      };
}

function report(error: unknown): void {
  console.error('The dropped items could not be opened:', error);
}

function reportClose(error: unknown): void {
  console.error('The panel could not be asked whether it may close:', error);
}
