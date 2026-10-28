import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Divider } from '../../ui/renderer/divider';
import { Pane } from '../../ui/renderer/pane';
import type { PanelContent, PanelsBridge } from '../shared/panels';
import { arrange, neighbour, zoneAt, type Box, type Direction, type Rect } from './geometry';
import { itemDragType, readItemDrag } from './item-drag';
import {
  contentOf,
  folderOf,
  inOpeningOrder,
  panelsOf,
  type Move,
  type Side,
  type Target,
} from './layout';
import type { Panels } from './use-panels';

interface PanelAreaProps {
  panels: Panels;
  bridge: PanelsBridge;
  // macOS's window buttons lie over the area's top-left corner, as they do while the sidebar is
  // hidden.
  clearsWindowButtons: boolean;
}

// Where a drag would drop: on the empty area, or on a panel, in the zone under the pointer.
type DropTarget = { kind: 'area' } | { kind: 'panel'; panelId: string; zone: Side | 'middle' };

// What a key press does in the panel area.
type Command =
  | { type: 'split'; side: Side }
  | { type: 'close' }
  | { type: 'focus-index'; index: number }
  | { type: 'focus-towards'; direction: Direction }
  | { type: 'swap-towards'; direction: Direction };

// The type under which a panel being moved travels, as its id.
const panelDragType = 'application/x-3mukon-code-panel';

// The main area's panels, laid out as the panel layout says, from the window's top edge. Each panel
// takes its box in the area, and the panels stay in the order they were opened, so that a split or a
// close moves no panel's content elsewhere in the page; a divider stands between the two parts of each
// split. The headers of the panels at the top lie in the title bar, which they move the window by,
// the one under the window buttons leaving room for them; while no panel is open, an empty strip
// there moves the window instead.
//
// A folder or file dropped from a tree or the Finder fills the empty area; near a panel's edge it
// splits that panel and opens on that side, and in a panel's middle it takes the panel's place. A
// panel dragged by its title onto another panel moves beside it near its edge, and in its middle the
// two swap places.
//
// The keyboard, from anywhere in the window: ⌘D splits the focused panel to the right and ⇧⌘D
// downwards, opening a session page in its folder; ⌘W closes the focused panel; ⌘1 to ⌘9 focus the
// panels in reading order; ⌥⌘ and an arrow focus the next panel that way, and ⇧⌥⌘ and an arrow swap
// the focused panel with it. Dividers take focus with Tab and move with the arrow keys.
export function PanelArea({ panels, bridge, clearsWindowButtons }: PanelAreaProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  // Set by a key press that changes the focused panel, so that the keyboard focus follows it.
  const followFocus = useRef(false);
  // The panel being dragged by its title, if any.
  const moving = useRef<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const ordered = panelsOf(panels.layout);
  const arrangement = arrange(panels.layout);
  const focused = ordered.find((panel) => panel.id === panels.focusedId);

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
          panels.close(focused.id);
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

  const targetAt = (event: DragEvent<HTMLElement>): DropTarget | null => {
    if (panels.layout === null) return { kind: 'area' };
    const element = (event.target as Element).closest('[data-panel]');
    const panelId = element?.getAttribute('data-panel');
    if (element === null || panelId === null || panelId === undefined) return null;
    return {
      kind: 'panel',
      panelId,
      zone: zoneAt(event.clientX, event.clientY, element.getBoundingClientRect()),
    };
  };

  // A panel being moved drops anywhere but on itself.
  const dropTargetAt = (event: DragEvent<HTMLElement>): DropTarget | null => {
    const target = targetAt(event);
    const movingHere =
      event.dataTransfer.types.includes(panelDragType) &&
      target?.kind === 'panel' &&
      target.panelId === moving.current;
    return movingHere ? null : target;
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!accepts(event.dataTransfer.types)) return;
    const target = dropTargetAt(event);
    if (target === null) {
      setDrop(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(panelDragType)
      ? 'move'
      : 'copy';
    if (!sameTarget(drop, target)) setDrop(target);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!accepts(event.dataTransfer.types)) return;
    event.preventDefault();
    const target = dropTargetAt(event);
    setDrop(null);
    if (target === null) return;
    const movedId = event.dataTransfer.getData(panelDragType);
    if (movedId !== '') {
      moving.current = null;
      if (target.kind === 'panel') panels.move(movedId, movingTo(target));
      return;
    }
    const at = openingAt(target);
    const dragged = readItemDrag(event.dataTransfer);
    if (dragged !== null) {
      panels.open([contentOf(dragged)], at);
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    bridge.itemsAt(files).then((items) => {
      if (items.length > 0) panels.open(items.map(contentOf), at);
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
        const { title, detail, path } = describe(panel.content, t('panels.sessionPage'));
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
              title={title}
              detail={detail}
              detailTitle={path}
              focused={panel.id === panels.focusedId}
              inTitleBar={box.y === 0}
              clearsWindowButtons={clearsWindowButtons && box.x === 0 && box.y === 0}
              onFocus={() => {
                panels.focus(panel.id);
              }}
              onClose={() => {
                panels.close(panel.id);
              }}
              onDragStart={(event) => {
                moving.current = panel.id;
                event.dataTransfer.setData(panelDragType, panel.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                moving.current = null;
                setDrop(null);
              }}
              closeLabel={t('panels.close')}
            />
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
        <div className="absolute inset-x-0 top-0 h-10 [-webkit-app-region:drag]" />
      )}
      {drop?.kind === 'area' && <DropZone zone="middle" />}
    </div>
  );
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

// Whether a drag carries something the area opens: a folder or file from a tree, or Finder items.
function accepts(types: readonly string[]): boolean {
  return types.includes(panelDragType) || types.includes(itemDragType) || types.includes('Files');
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

// A panel's title, and its folder's name with the full path: a session page goes by the given title,
// a file by its name.
function describe(content: PanelContent, sessionPage: string) {
  const path = folderOf(content);
  const folder = nameOf(path);
  return content.kind === 'session-page'
    ? { title: sessionPage, detail: folder, path }
    : { title: nameOf(content.path), detail: folder, path: content.path };
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
