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

// Where items open: filling the empty area, beside a panel, or in a panel's place.
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
  | { type: 'close'; panelId: string }
  | { type: 'focus'; panelId: string }
  | { type: 'resize'; splitId: string; ratio: number };

export const emptyPanels: PanelsState = { layout: null, focusedId: null, next: 1 };

export function reducePanels(state: PanelsState, action: PanelsAction): PanelsState {
  switch (action.type) {
    case 'open':
      return open(state, action.contents, action.at);
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
  }
}

// What a dropped or opened folder or file shows: a session page for a folder, the file itself.
export function contentOf(item: DroppedItem): PanelContent {
  return item.kind === 'folder'
    ? { kind: 'session-page', folder: item.path }
    : { kind: 'file', path: item.path };
}

// The folder a panel's content is in, where a session page opened from it starts.
export function folderOf(content: PanelContent): string {
  if (content.kind === 'session-page') return content.folder;
  const parent = content.path.slice(0, content.path.lastIndexOf('/'));
  return parent === '' ? '/' : parent;
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
// The last one opened is focused.
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
      layout = mapPanel(layout, target.panelId, (panel) => ({ ...panel, content }));
      focusedId = target.panelId;
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
