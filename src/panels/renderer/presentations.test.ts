import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRESENTATION_HOLD_MS,
  type PresentationBridge,
  type PresentationCommand,
  type PresentationHostMessage,
  type PresentationRendererMessage,
  type PresentedContent,
} from '../shared/presentation';
import {
  emptyPanels,
  panelsOf,
  reducePanels,
  type Panel,
  type PanelsAction,
  type PanelsState,
} from './layout';
import { hasRoom, PresentationPage, SETTLE_MS } from './presentations';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const result = (artifactId: string): PresentedContent => ({ kind: 'artifact', artifactId });
const right = { side: 'right', direction: 'row' } as const;

// A page over a layout that applies each change at once, as the panel area's store does, with main's
// side of the bridge played by the test: what it delivers, and what the page sends back.
function harness(size = { width: 1200, height: 800 }) {
  let state: PanelsState = emptyPanels;
  const listeners = new Set<() => void>();
  const dispatch = (action: PanelsAction) => {
    const next = reducePanels(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  let deliver: ((message: PresentationHostMessage) => void) | undefined;
  const sent: PresentationRendererMessage[] = [];
  const bridge: PresentationBridge = {
    onMessage: (listener) => {
      deliver = listener;
      return () => {
        deliver = undefined;
      };
    },
    send: (message) => {
      sent.push(structuredClone(message));
    },
    artifact: () => Promise.resolve(null),
  };
  const unsaved = new Set<string>();
  const opened: { owner: string; title: string }[] = [];
  const page = new PresentationPage(
    bridge,
    {
      latest: () => state,
      present: (presentationId, change) => {
        dispatch({ type: 'present', presentationId, change });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    {
      unsaved: (panel) => unsaved.has(panel.id),
      size: () => size,
      opened: (owner, title) => {
        opened.push({ owner, title });
      },
    },
    'page-1',
  );
  const stop = page.start();
  let serial = 0;
  const send = (
    fields: Partial<PresentationCommand> & Pick<PresentationCommand, 'kind'>,
  ): PresentationRendererMessage | undefined => {
    const message = {
      commandId: `c${String(++serial)}`,
      epoch: 'page-1',
      owner: 's1',
      presentationId: 'p',
      version: 0,
      ...(fields.kind === 'present'
        ? { title: 'Results', items: [result('a')], placement: right }
        : fields.kind === 'update'
          ? { title: 'Results', items: [result('a')] }
          : fields.kind === 'arrange'
            ? { placement: right }
            : {}),
      ...fields,
    } as PresentationCommand;
    const before = sent.length;
    deliver?.(message);
    return sent.length > before ? sent.at(-1) : undefined;
  };
  const presented = (presentationId = 'p'): Panel[] =>
    panelsOf(state.layout).filter((panel) => panel.presented?.presentationId === presentationId);
  return { page, stop, sent, opened, unsaved, dispatch, send, presented, state: () => state };
}

describe('PresentationPage', () => {
  it('listens before its first snapshot, and sends another once the sessions’ panels have changed and stayed still', () => {
    const page = harness();
    expect(page.sent).toEqual([
      { kind: 'snapshot', epoch: 'page-1', sessionPanels: [], presentations: [] },
    ]);
    expect(page.send({ kind: 'close' })).toMatchObject({ code: 'presentation-unknown' });
    page.dispatch({ type: 'open', contents: [{ kind: 'session', id: 's1', folder: '/web' }] });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(page.sent.at(-1)).toEqual({
      kind: 'snapshot',
      epoch: 'page-1',
      sessionPanels: [{ owner: 's1', box: { x: 0, y: 0, width: 1, height: 1 } }],
      presentations: [],
    });
    page.stop();
  });

  it('opens a presentation beside its session’s panel, answering where it lies, announcing it and leaving the focus', () => {
    const page = harness();
    page.dispatch({ type: 'open', contents: [{ kind: 'session', id: 's1', folder: '/web' }] });
    expect(page.send({ kind: 'present' })).toEqual({
      kind: 'applied',
      commandId: 'c1',
      epoch: 'page-1',
      state: {
        presentationId: 'p',
        owner: 's1',
        version: 1,
        boxes: [{ x: 0.5, y: 0, width: 0.5, height: 1 }],
      },
    });
    expect(page.opened).toEqual([{ owner: 's1', title: 'Results' }]);
    expect(page.state().focusedId).toBe('panel-1');
  });

  it('takes the place of its session’s latest presentation where there is no room, unless that one holds unsaved changes', () => {
    const page = harness({ width: 700, height: 800 });
    page.dispatch({ type: 'open', contents: [{ kind: 'session', id: 's1', folder: '/web' }] });
    page.send({ kind: 'present', presentationId: 'first' });
    expect(page.send({ kind: 'present', presentationId: 'second' })).toMatchObject({
      kind: 'changed',
      state: { presentationId: 'first', version: 2, boxes: [null] },
    });
    expect(page.sent.at(-2)).toMatchObject({
      kind: 'applied',
      state: { presentationId: 'second', boxes: [{ x: 0.5, width: 0.5 }] },
    });
    expect(page.presented('first')).toEqual([]);
    page.unsaved.add(page.presented('second')[0]?.id ?? '');
    expect(page.send({ kind: 'present', presentationId: 'third' })).toMatchObject({
      kind: 'applied',
    });
    expect(page.presented('second')).toHaveLength(1);
    expect(page.presented('third')).toHaveLength(1);
  });

  it('reports the user’s close at once, and an update keeps the closed panel closed while a present opens it again', () => {
    const page = harness();
    page.send({ kind: 'present' });
    page.dispatch({ type: 'close', panelId: page.presented()[0]?.id ?? '' });
    expect(page.sent.at(-1)).toMatchObject({
      kind: 'changed',
      state: { presentationId: 'p', version: 2, boxes: [null] },
    });
    expect(page.send({ kind: 'update', version: 2, items: [result('b')] })).toMatchObject({
      kind: 'applied',
      state: { version: 3, boxes: [null] },
    });
    expect(page.presented()).toEqual([]);
    expect(page.send({ kind: 'present', version: 3, items: [result('b')] })).toMatchObject({
      kind: 'applied',
      state: { version: 4, boxes: [{ x: 0, y: 0, width: 1, height: 1 }] },
    });
  });

  it('reports a presented panel that a drop took the place of as closed', () => {
    const page = harness();
    page.send({ kind: 'present' });
    page.dispatch({
      type: 'open',
      contents: [{ kind: 'file', path: '/a.md' }],
      at: { kind: 'replace', panelId: page.presented()[0]?.id ?? '' },
    });
    expect(page.sent.at(-1)).toMatchObject({ kind: 'changed', state: { boxes: [null] } });
  });

  it('reports where a presentation’s panels lie once the layout has stayed still, once however many steps it took', () => {
    const page = harness();
    page.dispatch({ type: 'open', contents: [{ kind: 'session', id: 's1', folder: '/web' }] });
    vi.advanceTimersByTime(SETTLE_MS);
    page.send({ kind: 'present' });
    const split = page.state().layout;
    const splitId = split?.type === 'split' ? split.id : '';
    const before = page.sent.length;
    for (const ratio of [0.45, 0.4, 0.3]) page.dispatch({ type: 'resize', splitId, ratio });
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(page.sent).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(page.sent.slice(before)).toMatchObject([
      { kind: 'changed', state: { version: 2, boxes: [{ x: 0.3, width: 0.7 }] } },
      { kind: 'snapshot', sessionPanels: [{ owner: 's1', box: { width: 0.3 } }] },
    ]);
  });

  it('holds a command that places panels during a drag until the drop, and refuses it as busy after the hold, while an update goes ahead', () => {
    const page = harness();
    page.page.setDragging(true);
    expect(page.send({ kind: 'present' })).toBeUndefined();
    page.page.setDragging(false);
    expect(page.sent.at(-1)).toMatchObject({ kind: 'applied', state: { version: 1 } });
    page.page.setDragging(true);
    expect(page.send({ kind: 'update', version: 1, items: [result('b')] })).toMatchObject({
      kind: 'applied',
      state: { version: 2 },
    });
    expect(page.send({ kind: 'arrange', version: 2 })).toBeUndefined();
    vi.advanceTimersByTime(PRESENTATION_HOLD_MS);
    expect(page.sent.at(-1)).toMatchObject({ kind: 'refused', code: 'busy' });
    page.page.setDragging(false);
    expect(page.sent.at(-1)).toMatchObject({ kind: 'refused', code: 'busy' });
  });

  it('refuses to close or show something else in a panel with unsaved changes', () => {
    const page = harness();
    page.send({ kind: 'present', items: [{ kind: 'file', path: '/a.md' }] });
    page.unsaved.add(page.presented()[0]?.id ?? '');
    expect(page.send({ kind: 'close', version: 1 })).toMatchObject({ code: 'unsaved-changes' });
    expect(page.send({ kind: 'update', version: 1, items: [result('b')] })).toMatchObject({
      code: 'unsaved-changes',
    });
    expect(
      page.send({
        kind: 'update',
        version: 1,
        title: 'Renamed',
        items: [{ kind: 'file', path: '/a.md' }],
      }),
    ).toMatchObject({
      kind: 'applied',
    });
  });

  it('refuses another page’s commands and answers a repeated command ID with its first answer', () => {
    const page = harness();
    expect(page.send({ kind: 'present', epoch: 'page-0' })).toMatchObject({
      code: 'stale-epoch',
      epoch: 'page-1',
    });
    const first = page.send({ kind: 'present', commandId: 'same' });
    expect(page.send({ kind: 'present', commandId: 'same' })).toEqual(first);
    expect(page.presented()).toHaveLength(1);
  });
});

describe('hasRoom', () => {
  const session = reducePanels(emptyPanels, {
    type: 'open',
    contents: [{ kind: 'session', id: 's1', folder: '/web' }],
  }).layout;

  it('measures half the session’s panel, shared among the items in their direction', () => {
    const size = { width: 1200, height: 800 };
    expect(hasRoom(session, 's1', { items: [1, 2], placement: right }, size)).toBe(true);
    expect(hasRoom(session, 's1', { items: [1, 2, 3], placement: right }, size)).toBe(false);
    expect(
      hasRoom(
        session,
        's1',
        { items: [1, 2, 3], placement: { side: 'right', direction: 'column' } },
        size,
      ),
    ).toBe(true);
    expect(
      hasRoom(
        session,
        's1',
        { items: [1, 2, 3], placement: { side: 'bottom', direction: 'column' } },
        size,
      ),
    ).toBe(false);
    expect(hasRoom(null, 's1', { items: [1], placement: right }, { width: 500, height: 800 })).toBe(
      false,
    );
  });
});
