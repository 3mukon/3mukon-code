import type { Layout, Side, Split } from './layout';

// A part of the main area, in shares of its width and height.
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Where each panel and each split's divider go.
export interface Arrangement {
  panels: Map<string, Box>;
  // Each split with the box it divides.
  splits: { split: Split; box: Box }[];
}

// Places the layout's panels and splits in the main area: each split gives its first part its ratio
// of the split's width, side by side, or of its height, stacked.
export function arrange(layout: Layout | null): Arrangement {
  const arrangement: Arrangement = { panels: new Map(), splits: [] };
  const place = (node: Layout, box: Box) => {
    if (node.type === 'panel') {
      arrangement.panels.set(node.id, box);
      return;
    }
    arrangement.splits.push({ split: node, box });
    if (node.direction === 'row') {
      const width = box.width * node.ratio;
      place(node.first, { ...box, width });
      place(node.second, { ...box, x: box.x + width, width: box.width - width });
    } else {
      const height = box.height * node.ratio;
      place(node.first, { ...box, height });
      place(node.second, { ...box, y: box.y + height, height: box.height - height });
    }
  };
  if (layout !== null) place(layout, { x: 0, y: 0, width: 1, height: 1 });
  return arrangement;
}

// A rectangle on the page, in pixels.
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

// The share of a panel's width or height, from each edge, where a drop opens the item beside the
// panel rather than in its place.
const edgeShare = 0.25;

// The part of a panel a drop at this point falls on: near an edge, the side on which the item opens
// beside the panel; elsewhere, the middle, where the item takes the panel's place.
export function zoneAt(x: number, y: number, rect: Rect): Side | 'middle' {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) return 'middle';
  const edges: [Side, number][] = [
    ['left', (x - rect.left) / width],
    ['right', (rect.right - x) / width],
    ['top', (y - rect.top) / height],
    ['bottom', (rect.bottom - y) / height],
  ];
  const [side, distance] = edges.reduce((nearest, edge) => (edge[1] < nearest[1] ? edge : nearest));
  return distance < edgeShare ? side : 'middle';
}

// The panel next to this one in the direction: of the panels on that side, those level with it come
// first, then the nearest, then the one whose middle is closest to its middle.
export function neighbour(
  rects: ReadonlyMap<string, Rect>,
  fromId: string,
  direction: Direction,
): string | undefined {
  const from = rects.get(fromId);
  if (from === undefined) return undefined;
  const across = direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal';
  let best: { id: string; score: [number, number, number] } | undefined;
  for (const [id, rect] of rects) {
    if (id === fromId) continue;
    const gap = {
      left: from.left - rect.right,
      right: rect.left - from.right,
      up: from.top - rect.bottom,
      down: rect.top - from.bottom,
    }[direction];
    // A panel on that side starts where this one ends, give or take the divider between them.
    if (gap < -1) continue;
    const apart =
      across === 'vertical'
        ? Math.max(rect.top - from.bottom, from.top - rect.bottom, 0)
        : Math.max(rect.left - from.right, from.left - rect.right, 0);
    const offset =
      across === 'vertical'
        ? Math.abs(rect.top + rect.bottom - from.top - from.bottom)
        : Math.abs(rect.left + rect.right - from.left - from.right);
    const score: [number, number, number] = [apart > 0 ? 1 : 0, gap, offset];
    if (best === undefined || isBefore(score, best.score)) best = { id, score };
  }
  return best?.id;
}

function isBefore(a: readonly number[], b: readonly number[]): boolean {
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? 0;
    if (value !== other) return value < other;
  }
  return false;
}
