import type { DroppedItem, PanelContent } from '../shared/panels';

// The main area's layout: a tree whose leaves are panels and whose other nodes split their space in
// two, side by side or stacked, so that panels nest in either direction.
export type Layout = Panel | Split;

export interface Panel {
  type: 'panel';
  id: string;
  content: PanelContent;
}

export interface Split {
  type: 'split';
  id: string;
  // A row puts its two parts side by side, a column stacks them.
  direction: 'row' | 'column';
  // The first part's share of the space, between 0 and 1.
  ratio: number;
  first: Layout;
  second: Layout;
}

// The side of a panel on which an item opens, splitting the panel in two.
export type Side = 'left' | 'right' | 'top' | 'bottom';

// Where a panel moves: beside another panel, splitting it, or into its place, the two swapping.
export type Move =
  { kind: 'beside'; panelId: string; side: Side } | { kind: 'swap'; panelId: string };

// Where items open: filling the empty area, beside a panel, or in a panel's place, as a panel of
// their own.
export type Target =
  | { kind: 'area' }
  | { kind: 'beside'; panelId: string; side: Side }
  | { kind: 'replace'; panelId: string };

export interface PanelsState {
  layout: Layout | null;
  focusedId: string | null;
  // Numbers the next panel or split, so that ids stay unique.
  next: number;
}

export type PanelsAction =
  // Without a target, items fill the empty area, or else open to the right of the focused panel.
  | { type: 'open'; contents: readonly PanelContent[]; at?: Target }
  // The panel goes on showing something else, as a session page does its session once it starts it.
  | { type: 'show'; panelId: string; content: PanelContent }
  | { type: 'close'; panelId: string }
  | { type: 'focus'; panelId: string }
  | { type: 'resize'; splitId: string; ratio: number }
  | { type: 'move'; panelId: string; to: Move };

export const emptyPanels: PanelsState = { layout: null, focusedId: null, next: 1 };

export function reducePanels(state: PanelsState, action: PanelsAction): PanelsState {
  switch (action.type) {
    case 'open':
      return open(state, action.contents, action.at);
    case 'show':
      return state.layout === null || findPanel(state.layout, action.panelId) === undefined
        ? state
        : {
            ...state,
            layout: mapPanel(state.layout, action.panelId, (panel) => ({
              ...panel,
              content: action.content,
            })),
            focusedId: action.panelId,
          };
    case 'close':
      return close(state, action.panelId);
    case 'focus':
      return state.focusedId !== action.panelId &&
        state.layout !== null &&
        findPanel(state.layout, action.panelId) !== undefined
        ? { ...state, focusedId: action.panelId }
        : state;
    case 'resize':
      return state.layout === null
        ? state
        : {
            ...state,
            layout: mapSplit(state.layout, action.splitId, (split) => ({
              ...split,
              ratio: Math.min(Math.max(action.ratio, 0), 1),
            })),
          };
    case 'move':
      return move(state, action.panelId, action.to);
  }
}

// What the app's lists drag into the panel area: a folder or file from a tree, by its absolute path, or
// a session from the Sessions list, by the app's id for it, with its folder.
export type DraggedItem = DroppedItem | { kind: 'session'; id: string; folder: string };

// What an item dropped or opened from the app's lists or the Finder shows: a session page for a
// folder, the file itself, or the session.
export function contentOf(item: DraggedItem): PanelContent {
  switch (item.kind) {
    case 'folder':
      return { kind: 'session-page', folder: item.path };
    case 'file':
      return { kind: 'file', path: item.path };
    case 'session':
      return { kind: 'session', id: item.id, folder: item.folder };
  }
}

// Whether two contents show the same: a session page for the same folder, the same session, the same
// file, the archived sessions or the settings.
export function sameContent(a: PanelContent, b: PanelContent): boolean {
  switch (a.kind) {
    case 'session-page':
      return b.kind === 'session-page' && b.folder === a.folder;
    case 'session':
      return b.kind === 'session' && b.id === a.id;
    case 'file':
      return b.kind === 'file' && b.path === a.path;
    case 'terminal':
      return b.kind === 'terminal' && b.id === a.id;
    case 'archived':
    case 'accounts':
    case 'settings':
      return b.kind === a.kind;
  }
}

// The folder a panel's content is in, where a session page or a terminal opened from it starts; none
// for the archived sessions, the accounts or the settings.
export function folderOf(content: PanelContent): string | null {
  switch (content.kind) {
    case 'session-page':
    case 'session':
      return content.folder;
    case 'file': {
      const parent = content.path.slice(0, content.path.lastIndexOf('/'));
      return parent === '' ? '/' : parent;
    }
    case 'terminal':
      return content.cwd;
    case 'archived':
    case 'accounts':
    case 'settings':
      return null;
  }
}

// The panels in reading order: a split's first part before its second.
export function panelsOf(layout: Layout | null): Panel[] {
  if (layout === null) return [];
  if (layout.type === 'panel') return [layout];
  return [...panelsOf(layout.first), ...panelsOf(layout.second)];
}

export function findPanel(layout: Layout, id: string): Panel | undefined {
  return panelsOf(layout).find((panel) => panel.id === id);
}

// The panels in the order they were opened, which a split or a close never changes.
export function inOpeningOrder(panels: readonly Panel[]): Panel[] {
  const number = (panel: Panel) => Number(panel.id.slice(panel.id.lastIndexOf('-') + 1));
  return [...panels].sort((a, b) => number(a) - number(b));
}

// Opens each item in a panel of its own: the first at the target, and each next one beside the
// panel opened before it, on the same side, or to its right when the target was not beside a panel.
// An item in a panel's place takes it as a new panel, so that nothing the old one showed goes on in
// it. The last one opened is focused.
function open(
  state: PanelsState,
  contents: readonly PanelContent[],
  at: Target | undefined,
): PanelsState {
  let { layout, next } = state;
  let target = at ?? defaultTarget(state);
  let focusedId = state.focusedId;
  for (const content of contents) {
    if (layout === null) {
      const panel: Panel = { type: 'panel', id: `panel-${String(next++)}`, content };
      layout = panel;
      focusedId = panel.id;
    } else if (target.kind === 'replace' && findPanel(layout, target.panelId) !== undefined) {
      const panel: Panel = { type: 'panel', id: `panel-${String(next++)}`, content };
      layout = mapPanel(layout, target.panelId, () => panel);
      focusedId = panel.id;
    } else {
      const beside =
        target.kind !== 'area' && findPanel(layout, target.panelId) !== undefined
          ? target.panelId
          : (focusedId ?? panelsOf(layout)[0]?.id);
      const side = target.kind === 'beside' ? target.side : 'right';
      const panel: Panel = { type: 'panel', id: `panel-${String(next++)}`, content };
      const splitId = `split-${String(next++)}`;
      layout = beside === undefined ? panel : besidePanel(layout, beside, side, panel, splitId);
      focusedId = panel.id;
    }
    // The next item opens beside this one.
    target = {
      kind: 'beside',
      panelId: focusedId,
      side: target.kind === 'beside' ? target.side : 'right',
    };
  }
  return { layout, focusedId, next };
}

function defaultTarget(state: PanelsState): Target {
  return state.layout === null || state.focusedId === null
    ? { kind: 'area' }
    : { kind: 'beside', panelId: state.focusedId, side: 'right' };
}

// The layout with the panel split in two: the new panel on the given side, the old one on the other.
function besidePanel(
  layout: Layout,
  id: string,
  side: Side,
  panel: Panel,
  splitId: string,
): Layout {
  return mapPanel(layout, id, (old) => {
    const before = side === 'left' || side === 'top';
    return {
      type: 'split',
      id: splitId,
      direction: side === 'left' || side === 'right' ? 'row' : 'column',
      ratio: 0.5,
      first: before ? panel : old,
      second: before ? old : panel,
    };
  });
}

// Moves a panel, keeping its id and what it shows, and focuses it. Beside another panel, it leaves its
// place as a close does and splits the other one; swapping, the two exchange places.
function move(state: PanelsState, id: string, to: Move): PanelsState {
  const { layout } = state;
  if (layout === null || id === to.panelId) return state;
  const panel = findPanel(layout, id);
  const other = findPanel(layout, to.panelId);
  if (panel === undefined || other === undefined) return state;
  if (to.kind === 'swap') return { ...state, layout: swap(layout, panel, other), focusedId: id };
  const rest = remove(layout, id)?.layout;
  if (rest === undefined || rest === null) return state;
  return {
    layout: besidePanel(rest, other.id, to.side, panel, `split-${String(state.next)}`),
    focusedId: id,
    next: state.next + 1,
  };
}

function swap(layout: Layout, a: Panel, b: Panel): Layout {
  if (layout.type === 'panel') {
    if (layout.id === a.id) return b;
    return layout.id === b.id ? a : layout;
  }
  const first = swap(layout.first, a, b);
  const second = swap(layout.second, a, b);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

// Closes the panel. The other part of its split takes the split's place, and when the closed panel
// had focus, the panel of that part nearest to it takes the focus.
function close(state: PanelsState, id: string): PanelsState {
  if (state.layout === null) return state;
  const removal = remove(state.layout, id);
  if (removal === undefined) return state;
  return {
    ...state,
    layout: removal.layout,
    focusedId: state.focusedId === id ? removal.heir : state.focusedId,
  };
}

interface Removal {
  layout: Layout | null;
  // The panel nearest to the removed one, in the part that took its place.
  heir: string | null;
}

function remove(layout: Layout, id: string): Removal | undefined {
  if (layout.type === 'panel') return layout.id === id ? { layout: null, heir: null } : undefined;
  const inFirst = remove(layout.first, id);
  if (inFirst !== undefined) {
    if (inFirst.layout === null) {
      return { layout: layout.second, heir: inFirst.heir ?? edgePanel(layout.second, 'first') };
    }
    return { layout: { ...layout, first: inFirst.layout }, heir: inFirst.heir };
  }
  const inSecond = remove(layout.second, id);
  if (inSecond !== undefined) {
    if (inSecond.layout === null) {
      return { layout: layout.first, heir: inSecond.heir ?? edgePanel(layout.first, 'last') };
    }
    return { layout: { ...layout, second: inSecond.layout }, heir: inSecond.heir };
  }
  return undefined;
}

function edgePanel(layout: Layout, edge: 'first' | 'last'): string {
  if (layout.type === 'panel') return layout.id;
  return edgePanel(edge === 'first' ? layout.first : layout.second, edge);
}

function mapPanel(layout: Layout, id: string, change: (panel: Panel) => Layout): Layout {
  if (layout.type === 'panel') return layout.id === id ? change(layout) : layout;
  const first = mapPanel(layout.first, id, change);
  const second = mapPanel(layout.second, id, change);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

function mapSplit(layout: Layout, id: string, change: (split: Split) => Split): Layout {
  if (layout.type === 'panel') return layout;
  if (layout.id === id) return change(layout);
  const first = mapSplit(layout.first, id, change);
  const second = mapSplit(layout.second, id, change);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}
