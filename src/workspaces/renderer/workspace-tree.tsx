import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ShieldOff } from '../../ui/renderer/icons';
import type {
  FolderListing,
  Workspace,
  WorkspaceList,
  WorkspacesBridge,
} from '../shared/workspaces';
import { clickWait, withGap } from './click-wait';

// One row of the tree: a workspace, or a folder or file in one.
interface Item {
  // Unique in the tree: the workspace's id, then the path in it.
  key: string;
  workspace: Workspace;
  // Relative to the workspace's folder, with / between names; '' for the workspace itself.
  path: string;
  name: string;
  kind: 'workspace' | 'folder' | 'file';
  level: number;
  parent: Item | null;
}

// The tree's open rows and their listings just before a click opened or closed the row of this key.
interface Before {
  key: string;
  open: ReadonlySet<string>;
  listings: ReadonlyMap<string, FolderListing>;
}

// A click on the workspace of this key, waiting to see whether a second press follows it, and what it
// does if none does.
interface Waiting {
  key: string;
  timer: ReturnType<typeof setTimeout>;
  run: () => void;
}

interface WorkspaceTreeProps {
  bridge: WorkspacesBridge;
  list: WorkspaceList;
  // The id of the heading that names the tree.
  labelledBy: string;
}

// The workspaces as a tree, each expanding into its folder tree, which is read folder by folder as
// folders open; a folder read again each time it opens shows what it holds then. A click opens or
// closes a folder at once, and a workspace once no second press has followed it within the wait
// (click-wait.ts); a double click selects a workspace without opening or closing it, and Return or
// Space selects it too; a workspace's menu opens with a secondary click or VoiceOver's menu command.
// The keyboard moves as in macOS lists: up and down, right to open or go in, left to close or go out,
// Home and End.
export function WorkspaceTree({ bridge, list, labelledBy }: WorkspaceTreeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [listings, setListings] = useState<ReadonlyMap<string, FolderListing>>(new Map());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLLIElement>());
  // A double click is two clicks, so a click on a workspace waits for a second press before acting.
  const waiting = useRef<Waiting | null>(null);
  // The last click on a workspace that could begin a double click, and when it came.
  const firstClick = useRef<{ key: string; at: number } | null>(null);
  // How long after their first clicks the second presses of the latest double clicks came.
  const gaps = useRef<number[]>([]);
  // The tree before that click opened or closed its workspace: a double click slower than the wait,
  // which macOS still counts as one, finds its first click acted on, and puts the tree back.
  const before = useRef<Before | null>(null);

  // A click still waiting when the tree goes away does nothing.
  useEffect(
    () => () => {
      if (waiting.current !== null) clearTimeout(waiting.current.timer);
    },
    [],
  );

  const roots = list.workspaces.map((workspace): Item => ({
    key: keyOf(workspace.id, ''),
    workspace,
    path: '',
    name: workspace.name,
    kind: 'workspace',
    level: 1,
    parent: null,
  }));

  const childrenOf = (item: Item): Item[] => {
    const listing = listings.get(item.key);
    if (!open.has(item.key) || listing === undefined || 'error' in listing) return [];
    return listing.entries.map((entry) => {
      const path = item.path === '' ? entry.name : `${item.path}/${entry.name}`;
      return {
        key: keyOf(item.workspace.id, path),
        workspace: item.workspace,
        path,
        name: entry.name,
        kind: entry.kind,
        level: item.level + 1,
        parent: item,
      };
    });
  };

  // The rows as they are shown, top to bottom.
  const shown: Item[] = [];
  const walk = (items: Item[]) => {
    for (const item of items) {
      shown.push(item);
      walk(childrenOf(item));
    }
  };
  walk(roots);

  // The one row Tab reaches: the focused one, or else the selected workspace, or else the first.
  const tabStop =
    shown.find((item) => item.key === focusKey)?.key ??
    roots.find((item) => item.workspace.id === list.selectedId)?.key ??
    roots[0]?.key;

  const focus = (item: Item | undefined) => {
    if (item === undefined) return;
    setFocusKey(item.key);
    elements.current.get(item.key)?.focus();
  };

  const expand = (item: Item) => {
    setOpen((keys) => new Set(keys).add(item.key));
    setListings((map) => without(map, item.key));
    const done = (listing: FolderListing) => {
      setListings((map) => new Map(map).set(item.key, listing));
      // A folder that cannot be read closes again, and says so.
      if ('error' in listing) setOpen((keys) => closed(keys, item.key));
    };
    bridge.listFolder(item.workspace.id, item.path).then(done, () => {
      done({ error: 'unreadable' });
    });
  };

  // The folders open inside a folder close with it, so that it opens again showing its own entries.
  const collapse = (item: Item) => {
    const inside = (key: string) =>
      key === item.key || key.startsWith(item.path === '' ? item.key : `${item.key}/`);
    setOpen((keys) => new Set([...keys].filter((key) => !inside(key))));
    setListings((map) => new Map([...map].filter(([key]) => !inside(key))));
  };

  const toggle = (item: Item) => {
    if (open.has(item.key)) collapse(item);
    else expand(item);
  };

  const select = (item: Item) => {
    bridge.select(item.workspace.id).catch(report);
  };

  // A click opens or closes a folder at once; a workspace waits for a possible second press first.
  const click = (item: Item, at: number) => {
    if (item.kind !== 'workspace') {
      toggle(item);
      return;
    }
    const earlier = waiting.current;
    if (earlier !== null) {
      clearTimeout(earlier.timer);
      waiting.current = null;
      // Two clicks on a workspace that macOS does not count as a double click would open and close
      // it, so it stays as it is. A click on another workspace acts at once.
      if (earlier.key === item.key) return;
      earlier.run();
    }
    firstClick.current = { key: item.key, at };
    before.current = null;
    const tree = { key: item.key, open, listings };
    const change = open.has(item.key) ? collapse : expand;
    const run = () => {
      before.current = tree;
      change(item);
    };
    const timer = setTimeout(() => {
      waiting.current = null;
      run();
    }, clickWait(gaps.current));
    waiting.current = { key: item.key, timer, run };
  };

  // The second press of a double click on a workspace, which comes before the double click itself:
  // the click before it now does not open or close the workspace, and how long after that click the
  // press came tells the wait how fast the user double-clicks.
  const pressAgain = (item: Item, at: number) => {
    const first = firstClick.current;
    if (item.kind !== 'workspace' || first?.key !== item.key) return;
    gaps.current = withGap(gaps.current, at - first.at);
    const earlier = waiting.current;
    if (earlier?.key === item.key) {
      clearTimeout(earlier.timer);
      waiting.current = null;
    }
  };

  // A double click selects a workspace and leaves it open or closed as it was: when its first click
  // acted before the second press came, the tree goes back as it was.
  const doubleClick = (item: Item) => {
    if (item.kind !== 'workspace') return;
    select(item);
    const earlier = waiting.current;
    const tree = before.current;
    if (earlier?.key === item.key) {
      clearTimeout(earlier.timer);
      waiting.current = null;
    } else if (tree?.key === item.key) {
      setOpen(tree.open);
      setListings(tree.listings);
    }
    before.current = null;
  };

  // What Return or Space on the row does: a workspace is selected, a folder opens or closes.
  const activate = (item: Item) => {
    if (item.kind === 'workspace') select(item);
    else if (item.kind === 'folder') toggle(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = (event.target as HTMLElement)
      .closest('[role="treeitem"]')
      ?.getAttribute('data-key');
    const index = shown.findIndex((item) => item.key === key);
    const item = shown[index];
    if (item === undefined) return;
    const expandable = item.kind !== 'file';
    switch (event.key) {
      case 'ArrowDown':
        focus(shown[index + 1]);
        break;
      case 'ArrowUp':
        focus(shown[index - 1]);
        break;
      case 'Home':
        focus(shown[0]);
        break;
      case 'End':
        focus(shown.at(-1));
        break;
      case 'ArrowRight':
        if (expandable && !open.has(item.key)) expand(item);
        else if (shown[index + 1]?.parent === item) focus(shown[index + 1]);
        break;
      case 'ArrowLeft':
        if (expandable && open.has(item.key)) collapse(item);
        else focus(item.parent ?? undefined);
        break;
      case 'Enter':
      case ' ':
        activate(item);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const render = (items: Item[]): ReactNode =>
    items.map((item, index) => {
      const expanded = item.kind !== 'file' && open.has(item.key);
      const listing = listings.get(item.key);
      const unreadable = listing !== undefined && 'error' in listing;
      const untrusted = item.kind === 'workspace' && !item.workspace.trusted;
      const selected = item.kind === 'workspace' && item.workspace.id === list.selectedId;
      const children = childrenOf(item);
      // The row's name for VoiceOver, with what its marks show.
      const label = [
        item.name,
        ...(untrusted ? [t('workspaces.untrusted')] : []),
        ...(unreadable ? [t('workspaces.unreadable')] : []),
      ].join(', ');
      return (
        <li
          key={item.key}
          ref={(element) => {
            if (element) elements.current.set(item.key, element);
            return () => {
              elements.current.delete(item.key);
            };
          }}
          role="treeitem"
          data-key={item.key}
          tabIndex={item.key === tabStop ? 0 : -1}
          aria-label={label}
          aria-level={item.level}
          aria-setsize={items.length}
          aria-posinset={index + 1}
          aria-expanded={item.kind === 'file' ? undefined : expanded}
          aria-selected={item.kind === 'workspace' ? selected : undefined}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocusKey(item.key);
          }}
          onContextMenu={(event) => {
            if (item.kind !== 'workspace' || !isOwnRow(event)) return;
            event.preventDefault();
            bridge.showMenu(item.workspace.id).catch(report);
          }}
          className="focus-visible:outline-none [&:focus-visible>div]:outline-2 [&:focus-visible>div]:-outline-offset-2 [&:focus-visible>div]:outline-accent"
        >
          <div
            title={item.kind === 'workspace' ? item.workspace.path : undefined}
            onMouseDown={(event) => {
              // A press that macOS counts as the second of a double click.
              if (event.detail === 2) pressAgain(item, event.timeStamp);
            }}
            onClick={(event) => {
              // The second click of a double click is the double click's.
              if (event.detail > 1 || item.kind === 'file') return;
              click(item, event.timeStamp);
            }}
            onDoubleClick={() => {
              doubleClick(item);
            }}
            style={{ paddingLeft: `${String(4 + (item.level - 1) * 12)}px` }}
            className={`flex h-6 items-center gap-1 rounded-md pr-2 ${selected ? 'bg-selected' : 'hover:bg-hover'}`}
          >
            {item.kind === 'file' ? (
              <span className="size-4 shrink-0" />
            ) : (
              <span
                aria-hidden="true"
                className="grid size-4 shrink-0 place-items-center text-faint"
              >
                <ChevronRight
                  className={`size-3.5 motion-safe:transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
              </span>
            )}
            <span className={`min-w-0 truncate ${item.kind === 'workspace' ? '' : 'text-muted'}`}>
              {item.name}
            </span>
            {unreadable && (
              <span className="min-w-0 shrink truncate text-[11px] text-faint">
                {t('workspaces.unreadable')}
              </span>
            )}
            {untrusted && (
              <span title={t('workspaces.untrusted')} className="ml-auto shrink-0 text-faint">
                <ShieldOff className="size-3.5" />
              </span>
            )}
          </div>
          {children.length > 0 && <ul role="group">{render(children)}</ul>}
        </li>
      );
    });

  return (
    <ul
      role="tree"
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      className="min-h-0 overflow-y-auto"
    >
      {render(roots)}
    </ul>
  );
}

function keyOf(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`;
}

function without<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

// The open rows' keys, with the row of this key closed.
function closed(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  next.delete(key);
  return next;
}

// Whether the event happened on this row and not on a row of a folder inside it.
function isOwnRow(event: SyntheticEvent<HTMLLIElement>): boolean {
  return (event.target as Element).closest('[role="treeitem"]') === event.currentTarget;
}

function report(error: unknown): void {
  console.error('The workspace could not be changed:', error);
}
