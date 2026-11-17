import { describe, expect, it } from 'vitest';
import type { PanelContent } from '../shared/panels';
import type { Placement, PresentedContent } from '../shared/presentation';
import {
  contentOf,
  emptyPanels,
  folderOf,
  inOpeningOrder,
  panelsOf,
  presentedPanels,
  reducePanels,
  sameContent,
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
    const { content } = layout;
    if (content.kind === 'file') return content.path;
    return content.kind === 'session-page' || content.kind === 'session'
      ? `page ${content.folder}`
      : content.kind;
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

  it('puts an item in a panel’s place as a panel of its own, and focuses it', () => {
    const state = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/web/a.ts')], at: { kind: 'replace', panelId: 'panel-1' } },
    );
    expect(shape(state.layout)).toBe('/web/a.ts');
    expect(panelsOf(state.layout).map((panel) => panel.id)).toEqual(['panel-2']);
    expect(state.focusedId).toBe('panel-2');
  });

  it('shows something else in the same panel, as a session page goes on as its session, and focuses it', () => {
    const opened = run(
      { type: 'open', contents: [page('/web')] },
      { type: 'open', contents: [file('/web/a.ts')] },
    );
    const session: PanelContent = { kind: 'session', id: 's1', folder: '/web' };
    const shown = reducePanels(opened, { type: 'show', panelId: 'panel-1', content: session });
    expect(panelsOf(shown.layout)).toEqual([
      { type: 'panel', id: 'panel-1', content: session },
      { type: 'panel', id: 'panel-2', content: file('/web/a.ts') },
    ]);
    expect(shown.focusedId).toBe('panel-1');
    expect(reducePanels(opened, { type: 'show', panelId: 'panel-9', content: session })).toBe(
      opened,
    );
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
  it('opens a folder as a session page, a file as itself and a session as itself', () => {
    expect(contentOf({ kind: 'folder', path: '/web' })).toEqual(page('/web'));
    expect(contentOf({ kind: 'file', path: '/web/a.ts' })).toEqual(file('/web/a.ts'));
    expect(contentOf({ kind: 'session', id: 's1', folder: '/web' })).toEqual({
      kind: 'session',
      id: 's1',
      folder: '/web',
    });
  });

  it('tells contents that show the same', () => {
    const session = (id: string): PanelContent => ({ kind: 'session', id, folder: '/web' });
    expect(sameContent(page('/web'), page('/web'))).toBe(true);
    expect(sameContent(file('/web/a.ts'), file('/web/a.ts'))).toBe(true);
    expect(sameContent(session('s1'), session('s1'))).toBe(true);
    expect(sameContent(page('/web'), page('/api'))).toBe(false);
    expect(sameContent(session('s1'), session('s2'))).toBe(false);
    expect(sameContent(file('/web'), page('/web'))).toBe(false);
    expect(sameContent({ kind: 'settings' }, { kind: 'settings' })).toBe(true);
    expect(sameContent({ kind: 'archived' }, { kind: 'settings' })).toBe(false);
  });

  it('finds the folder a panel’s content is in, which the archived sessions and the settings lack', () => {
    expect(folderOf(page('/web'))).toBe('/web');
    expect(folderOf(file('/web/src/a.ts'))).toBe('/web/src');
    expect(folderOf(file('/a.ts'))).toBe('/');
    expect(folderOf({ kind: 'archived' })).toBeNull();
    expect(folderOf({ kind: 'settings' })).toBeNull();
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

describe('reducePanels with presentations', () => {
  const session = (id: string): PanelContent => ({ kind: 'session', id, folder: '/web' });
  const result = (artifactId: string): PresentedContent => ({ kind: 'artifact', artifactId });
  const doc = (path: string): PresentedContent => ({ kind: 'file', path });
  const open = (
    presentationId: string,
    items: PresentedContent[],
    placement: Placement = { side: 'right', direction: 'row' },
    replacing: string | null = null,
  ): PanelsAction => ({
    type: 'present',
    presentationId,
    change: { kind: 'open', owner: 's1', title: 'Results', items, placement, replacing },
  });
  // What each panel shows, in reading order, with the presentation and place of a presented one.
  const shown = (state: PanelsState) =>
    panelsOf(state.layout).map(({ content, presented }) => {
      const what =
        content.kind === 'artifact'
          ? content.artifactId
          : content.kind === 'file'
            ? content.path
            : content.kind;
      return presented === undefined
        ? what
        : `${what}@${presented.presentationId}#${String(presented.item)}`;
    });

  it('opens a presentation beside its session’s panel, its items in a row or a column, leaving the focus where it was', () => {
    const state = run(
      { type: 'open', contents: [session('s1')] },
      {
        type: 'open',
        contents: [file('/notes.md')],
        at: { kind: 'beside', panelId: 'panel-1', side: 'bottom' },
      },
      open('p', [result('a'), result('b')], { side: 'left', direction: 'column' }),
    );
    expect(shape(state.layout)).toBe(
      'column(row(column(artifact, artifact), page /web), /notes.md)',
    );
    expect(shown(state)).toEqual(['a@p#0', 'b@p#1', 'session', '/notes.md']);
    expect(state.focusedId).toBe('panel-2');
    expect(panelsOf(state.layout)[0]?.presented).toEqual({
      presentationId: 'p',
      item: 0,
      owner: 's1',
      title: 'Results',
    });
  });

  it('opens at that side of the area while the session has no panel, and fills an empty area without focusing', () => {
    const beside = run(
      { type: 'open', contents: [file('/a.md')] },
      open('p', [result('a')], { side: 'top', direction: 'row' }),
    );
    expect(shape(beside.layout)).toBe('column(artifact, /a.md)');
    expect(beside.focusedId).toBe('panel-1');
    const alone = run(open('p', [result('a')]));
    expect(shape(alone.layout)).toBe('artifact');
    expect(alone.focusedId).toBeNull();
  });

  it('opens in place of another presentation’s panels, a focus one of them had going back to the session', () => {
    const state = run(
      { type: 'open', contents: [session('s1')] },
      open('old', [result('a'), result('b')]),
      { type: 'focus', panelId: 'panel-3' },
      open('new', [result('c')], { side: 'right', direction: 'row' }, 'old'),
    );
    expect(shown(state)).toEqual(['session', 'c@new#0']);
    expect(state.focusedId).toBe('panel-1');
  });

  it('changes what a presentation shows in place, giving a changed item a panel of its own, opening and closing panels to match', () => {
    const before = run(
      { type: 'open', contents: [session('s1')] },
      open('p', [result('a'), result('b')]),
    );
    const ids = panelsOf(before.layout).map((panel) => panel.id);
    const changed = reducePanels(before, {
      type: 'present',
      presentationId: 'p',
      change: {
        kind: 'change',
        owner: 's1',
        title: 'Renamed',
        items: [
          { content: result('a'), open: true },
          { content: doc('/b.md'), open: true },
          { content: result('c'), open: true },
        ],
        direction: 'row',
      },
    });
    expect(shown(changed)).toEqual(['session', 'a@p#0', '/b.md@p#1', 'c@p#2']);
    const after = panelsOf(changed.layout);
    expect(after[1]?.id).toBe(ids[1]);
    expect(after[1]?.presented?.title).toBe('Renamed');
    expect(after[2]?.id).not.toBe(ids[2]);
    const fewer = reducePanels(changed, {
      type: 'present',
      presentationId: 'p',
      change: {
        kind: 'change',
        owner: 's1',
        title: 'Renamed',
        items: [
          { content: result('a'), open: false },
          { content: doc('/b.md'), open: true },
        ],
        direction: 'row',
      },
    });
    expect(shown(fewer)).toEqual(['session', '/b.md@p#1']);
  });

  it('arranges a presentation’s panels again, keeping them, and closes them, the focus passing on as a close passes it', () => {
    const state = run(
      { type: 'open', contents: [session('s1')] },
      open('p', [result('a'), result('b')]),
    );
    const ids = panelsOf(state.layout)
      .slice(1)
      .map((panel) => panel.id);
    const arranged = reducePanels(state, {
      type: 'present',
      presentationId: 'p',
      change: { kind: 'arrange', owner: 's1', placement: { side: 'bottom', direction: 'column' } },
    });
    expect(shape(arranged.layout)).toBe('column(page /web, column(artifact, artifact))');
    expect(
      panelsOf(arranged.layout)
        .slice(1)
        .map((panel) => panel.id),
    ).toEqual(ids);
    const focused = reducePanels(arranged, { type: 'focus', panelId: ids[0] ?? '' });
    const closed = reducePanels(focused, {
      type: 'present',
      presentationId: 'p',
      change: { kind: 'close' },
    });
    expect(shown(closed)).toEqual(['session']);
    expect(closed.focusedId).toBe('panel-1');
  });

  it('tells presented content apart and gives it no folder', () => {
    expect(sameContent(result('a'), result('a'))).toBe(true);
    expect(sameContent(result('a'), result('b'))).toBe(false);
    expect(sameContent({ kind: 'browser', tabId: 't' }, { kind: 'computer', targetId: 't' })).toBe(
      false,
    );
    expect(folderOf(result('a'))).toBeNull();
    expect(presentedPanels(run(open('p', [result('a')])).layout, 'p')).toHaveLength(1);
  });
});
