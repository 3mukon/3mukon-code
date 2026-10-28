import { describe, expect, it } from 'vitest';
import { arrange, neighbour, zoneAt, type Rect } from './geometry';
import type { Layout } from './layout';

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
});

describe('zoneAt', () => {
  const panel = rect(0, 0, 400, 200);

  it('finds the edge a drop is near, within a quarter of the panel', () => {
    expect(zoneAt(20, 100, panel)).toBe('left');
    expect(zoneAt(390, 100, panel)).toBe('right');
    expect(zoneAt(200, 10, panel)).toBe('top');
    expect(zoneAt(200, 190, panel)).toBe('bottom');
  });

  it('counts the rest as the middle', () => {
    expect(zoneAt(200, 100, panel)).toBe('middle');
    expect(zoneAt(120, 60, panel)).toBe('middle');
    expect(zoneAt(5, 5, rect(0, 0, 0, 0))).toBe('middle');
  });
});

describe('arrange', () => {
  it('gives each part of a split its share, side by side or stacked', () => {
    const layout: Layout = {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.25,
      first: { type: 'panel', id: 'a', content: { kind: 'file', path: '/a' } },
      second: {
        type: 'split',
        id: 'split-2',
        direction: 'column',
        ratio: 0.5,
        first: { type: 'panel', id: 'b', content: { kind: 'file', path: '/b' } },
        second: { type: 'panel', id: 'c', content: { kind: 'file', path: '/c' } },
      },
    };
    const arrangement = arrange(layout);
    expect(Object.fromEntries(arrangement.panels)).toEqual({
      a: { x: 0, y: 0, width: 0.25, height: 1 },
      b: { x: 0.25, y: 0, width: 0.75, height: 0.5 },
      c: { x: 0.25, y: 0.5, width: 0.75, height: 0.5 },
    });
    expect(arrangement.splits.map(({ split, box }) => [split.id, box])).toEqual([
      ['split-1', { x: 0, y: 0, width: 1, height: 1 }],
      ['split-2', { x: 0.25, y: 0, width: 0.75, height: 1 }],
    ]);
    expect(arrange(null)).toEqual({ panels: new Map(), splits: [] });
  });
});

describe('neighbour', () => {
  // a | b over c, with a 1-pixel divider between them:
  //   a  b
  //   a  c
  const rects = new Map([
    ['a', rect(0, 0, 300, 600)],
    ['b', rect(301, 0, 800, 300)],
    ['c', rect(301, 301, 800, 600)],
  ]);

  it('finds the panel next to one in each direction', () => {
    expect(neighbour(rects, 'a', 'right')).toBe('b');
    expect(neighbour(rects, 'c', 'left')).toBe('a');
    expect(neighbour(rects, 'b', 'down')).toBe('c');
    expect(neighbour(rects, 'c', 'up')).toBe('b');
  });

  it('finds nothing past the area’s edge', () => {
    expect(neighbour(rects, 'a', 'left')).toBeUndefined();
    expect(neighbour(rects, 'b', 'up')).toBeUndefined();
    expect(neighbour(rects, 'missing', 'up')).toBeUndefined();
  });

  it('prefers a panel level with the one it starts from over a nearer one that is not', () => {
    const offset = new Map([
      ['a', rect(0, 0, 300, 300)],
      ['far', rect(500, 0, 800, 300)],
      ['near', rect(301, 301, 400, 600)],
    ]);
    expect(neighbour(offset, 'a', 'right')).toBe('far');
  });
});
