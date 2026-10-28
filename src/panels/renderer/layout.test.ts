import { describe, expect, it } from 'vitest';
import type { PanelContent } from '../shared/panels';
import {
  contentOf,
  emptyPanels,
  folderOf,
  inOpeningOrder,
  panelsOf,
  reducePanels,
  type Layout,
  type PanelsAction,
  type PanelsState,
} from './layout';

const page = (folder: string): PanelContent => ({ kind: 'session-page', folder });
const file = (path: string): PanelContent => ({ kind: 'file', path });

function run(...actions: PanelsAction[]): PanelsState {
  return actions.reduce(reducePanels, emptyPanels);
}

// The layout as text: a panel by what it shows, a split by its direction and parts.
function shape(layout: Layout | null): string {
  if (layout === null) return 'empty';
  if (layout.type === 'panel') {
    return layout.content.kind === 'file' ? layout.content.path : `page ${layout.content.folder}`;
  }
  return `${layout.direction}(${shape(layout.first)}, ${shape(layout.second)})`;
}

describe('reducePanels', () => {
  it('fills the empty area with the first item, and focuses it', () => {
    const state = run({ type: 'open', contents: [page('/web')], at: { kind: 'area' } });
    expect(shape(state.layout)).toBe('page /web');
    expect(state.focusedId).toBe('panel-1');
  });

  it('splits a panel on the side an item opens, side by side or stacked', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      {
        type: 'open',
        contents: [file('/web/a.ts')],
        at: { kind: 'beside', panelId: 'panel-1', side: 'right' },
      },
      {
        type: 'open',
        contents: [file('/web/b.ts')],
        at: { kind: 'beside', panelId: 'panel-1', side: 'top' },
      },
    );
    expect(shape(state.layout)).toBe('row(column(/web/b.ts, page /web), /web/a.ts)');
    expect(state.focusedId).toBe('panel-4');
  });

  it('opens items to the right of the focused panel when no target is given', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/web/a.ts')] },
      { type: 'focus', panelId: 'panel-1' },
      { type: 'open', contents: [file('/web/b.ts')] },
    );
    expect(shape(state.layout)).toBe('row(row(page /web, /web/b.ts), /web/a.ts)');
  });

  it('puts an item in a panel’s place, keeping the panel', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/web/a.ts')], at: { kind: 'replace', panelId: 'panel-1' } },
    );
    expect(shape(state.layout)).toBe('/web/a.ts');
    expect(panelsOf(state.layout).map((panel) => panel.id)).toEqual(['panel-1']);
  });

  it('opens several items one beside the other, and focuses the last', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      {
        type: 'open',
        contents: [file('/a'), file('/b')],
        at: { kind: 'beside', panelId: 'panel-1', side: 'bottom' },
      },
    );
    expect(shape(state.layout)).toBe('column(page /web, column(/a, /b))');
    expect(state.focusedId).toBe(panelsOf(state.layout).at(-1)?.id);
  });

  it('falls back to the focused panel when the target panel has gone', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/a')], at: { kind: 'replace', panelId: 'panel-9' } },
    );
    expect(shape(state.layout)).toBe('row(page /web, /a)');
  });

  it('closes a panel, gives its space to the rest of its split, and passes the focus to its nearest panel', () => {
    const opened = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/a')] },
      {
        type: 'open',
        contents: [file('/b')],
        at: { kind: 'beside', panelId: 'panel-2', side: 'bottom' },
      },
    );
    expect(shape(opened.layout)).toBe('row(page /web, column(/a, /b))');
    const closed = reducePanels(opened, { type: 'close', panelId: 'panel-4' });
    expect(shape(closed.layout)).toBe('row(page /web, /a)');
    expect(closed.focusedId).toBe('panel-2');
    // Closing an unfocused panel leaves the focus where it is.
    const again = reducePanels(closed, { type: 'close', panelId: 'panel-1' });
    expect(shape(again.layout)).toBe('/a');
    expect(again.focusedId).toBe('panel-2');
    expect(reducePanels(again, { type: 'close', panelId: 'panel-2' })).toMatchObject({
      layout: null,
      focusedId: null,
    });
  });

  it('focuses only a panel that exists, and resizes a split within 0 and 1', () => {
    const opened = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/a')] },
    );
    expect(reducePanels(opened, { type: 'focus', panelId: 'panel-9' })).toBe(opened);
    const resized = reducePanels(opened, { type: 'resize', splitId: 'split-3', ratio: 1.5 });
    expect(resized.layout).toMatchObject({ type: 'split', ratio: 1 });
  });
});

describe('moving panels', () => {
  // page | a, then b below a: row(page, column(a, b)).
  const opened = run(
    { type: 'open', contents: [page('/web')] },
    { type: 'open', contents: [file('/a')] },
    {
      type: 'open',
      contents: [file('/b')],
      at: { kind: 'beside', panelId: 'panel-2', side: 'bottom' },
    },
  );

  it('moves a panel beside another, keeping its id, and focuses it', () => {
    const moved = reducePanels(opened, {
      type: 'move',
      panelId: 'panel-1',
      to: { kind: 'beside', panelId: 'panel-4', side: 'bottom' },
    });
    expect(shape(moved.layout)).toBe('column(/a, column(/b, page /web))');
    expect(moved.focusedId).toBe('panel-1');
    expect(
      panelsOf(moved.layout)
        .map((panel) => panel.id)
        .sort(),
    ).toEqual(['panel-1', 'panel-2', 'panel-4']);
  });

  it('swaps two panels’ places', () => {
    const swapped = reducePanels(opened, {
      type: 'move',
      panelId: 'panel-1',
      to: { kind: 'swap', panelId: 'panel-4' },
    });
    expect(shape(swapped.layout)).toBe('row(/b, column(/a, page /web))');
    expect(swapped.focusedId).toBe('panel-1');
  });

  it('leaves the layout alone for a move onto itself or a panel that has gone', () => {
    for (const to of [
      { kind: 'swap', panelId: 'panel-1' },
      { kind: 'beside', panelId: 'panel-9', side: 'left' },
    ] as const) {
      expect(reducePanels(opened, { type: 'move', panelId: 'panel-1', to })).toBe(opened);
    }
    expect(
      reducePanels(opened, {
        type: 'move',
        panelId: 'panel-9',
        to: { kind: 'swap', panelId: 'panel-1' },
      }),
    ).toBe(opened);
  });
});

describe('helpers', () => {
  it('opens a folder as a session page and a file as itself', () => {
    expect(contentOf({ kind: 'folder', path: '/web' })).toEqual(page('/web'));
    expect(contentOf({ kind: 'file', path: '/web/a.ts' })).toEqual(file('/web/a.ts'));
  });

  it('finds the folder a panel’s content is in', () => {
    expect(folderOf(page('/web'))).toBe('/web');
    expect(folderOf(file('/web/src/a.ts'))).toBe('/web/src');
    expect(folderOf(file('/a.ts'))).toBe('/');
  });

  it('keeps the panels in the order they were opened', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      {
        type: 'open',
        contents: [file('/a')],
        at: { kind: 'beside', panelId: 'panel-1', side: 'left' },
      },
    );
    expect(panelsOf(state.layout).map((panel) => panel.id)).toEqual(['panel-2', 'panel-1']);
    expect(inOpeningOrder(panelsOf(state.layout)).map((panel) => panel.id)).toEqual([
      'panel-1',
      'panel-2',
    ]);
  });
});
