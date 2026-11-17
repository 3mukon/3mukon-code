import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PresentationHost } from '../../src/panels/main/presentation-host';
import { PresentationPage, SETTLE_MS } from '../../src/panels/renderer/presentations';
import {
  emptyPanels,
  panelsOf,
  reducePanels,
  type PanelsAction,
  type PanelsState,
} from '../../src/panels/renderer/layout';
import {
  DEFAULT_PLACEMENT,
  PRESENTATION_HOLD_MS,
  type PresentationBridge,
  type PresentationHostMessage,
} from '../../src/panels/shared/presentation';
import type { PanelRequest, PanelResult } from '../../src/panels/shared/presentation-host';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// Both real endpoints, over serialized messages and the actual layout reducer. This has no
// Electron window, filesystem access, browser, provider, model or native helper.
function joined() {
  let state: PanelsState = emptyPanels;
  const listeners = new Set<() => void>();
  const unsaved = new Set<string>();
  const file = vi.fn((_owner: string, path: string) =>
    Promise.resolve(path.startsWith('/synthetic/') ? path : null),
  );
  let deliver: ((message: PresentationHostMessage) => void) | undefined;
  let serial = 0;
  const dispatch = (action: PanelsAction) => {
    state = reducePanels(state, action);
    for (const listener of [...listeners]) listener();
  };
  const host = new PresentationHost({
    hasOwner: (owner) => owner === 'a',
    file,
    resource: () => null,
    notice: () => ({ status: 'verified', value: null }),
  });
  const bridge: PresentationBridge = {
    onMessage(listener) {
      deliver = listener;
      return () => {
        deliver = undefined;
      };
    },
    send: (message) => {
      host.receive(structuredClone(message));
    },
    artifact: (id) => Promise.resolve(host.artifact(id)),
  };
  const openPage = () => {
    host.connect((message) => {
      deliver?.(structuredClone(message));
    });
    const page = new PresentationPage(
      bridge,
      {
        latest: () => state,
        present: (presentationId, change) => {
          dispatch({ type: 'present', presentationId, change });
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      {
        size: () => ({ width: 1400, height: 1000 }),
        unsaved: (panel) => unsaved.has(panel.id),
        opened: () => undefined,
      },
      `page-${String(++serial)}`,
    );
    const stop = page.start();
    dispatch({ type: 'open', contents: [{ kind: 'session', id: 'a', folder: '/synthetic' }] });
    return { page, stop };
  };
  let current = openPage();
  return {
    host,
    file,
    bridge,
    dispatch,
    unsaved,
    page: () => current.page,
    state: () => state,
    panels: (id: string) =>
      panelsOf(state.layout).filter((panel) => panel.presented?.presentationId === id),
    run: (request: PanelRequest, signal = new AbortController().signal) =>
      host.execute('a', `call-${String(++serial)}`, request, signal),
    reload() {
      current.stop();
      state = emptyPanels;
      current = openPage();
    },
    stop() {
      current.stop();
      host.disconnect();
    },
  };
}
const present = (version = 0): Extract<PanelRequest, { kind: 'present' }> => ({
  kind: 'present',
  reuseKey: 'result',
  version,
  title: 'Synthetic result',
  items: [{ kind: 'file', path: '/synthetic/result.md' }],
  placement: DEFAULT_PLACEMENT,
});
const shown = (result: PanelResult) => {
  expect(result.outcome.status).toBe('verified');
  const value = result.presentations?.[0];
  if (!value) throw Error('No presentation');
  return value;
};

it('joins presentation, artifacts, human dismissal, update and Show without moving keyboard focus', async () => {
  const f = joined();
  try {
    const focus = f.state().focusedId;
    const artifact = { format: 'markdown' as const, title: 'Synthetic', text: '# Result' };
    const p = shown(
      await f.run({
        ...present(),
        items: [
          { kind: 'file', path: '/synthetic/result.md' },
          { kind: 'artifact', artifact },
        ],
      }),
    );
    expect(f.panels(p.id)).toHaveLength(2);
    expect(f.state().focusedId).toBe(focus);
    const content = p.items[1]?.content;
    if (content?.kind !== 'artifact') throw Error('Missing artifact');
    expect(await f.bridge.artifact(content.artifactId)).toEqual(artifact);
    f.dispatch({ type: 'close', panelId: f.panels(p.id)[0]?.id ?? '' });
    const updated = shown(
      await f.run({
        kind: 'update',
        presentationId: p.id,
        version: p.version + 1,
        title: 'Updated',
        items: p.items.map((item) => item.content),
      }),
    );
    expect(updated.items[0]?.box).toBeNull();
    expect(f.panels(p.id)).toHaveLength(1);
    expect((await f.run(present(p.version))).outcome).toMatchObject({ code: 'layout-conflict' });
    const show = f.page().show('a', { presentationId: p.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(await show).toBe('shown');
    expect(f.panels(p.id)).toHaveLength(2);
    expect(f.state().focusedId).toBe(focus);
  } finally {
    f.stop();
  }
});

it('honors the real page’s dirty-file guard, drag deadline and cancellation before application', async () => {
  const f = joined();
  try {
    const p = shown(await f.run(present()));
    f.unsaved.add(f.panels(p.id)[0]?.id ?? '');
    expect(
      (await f.run({ kind: 'close', presentationId: p.id, version: p.version })).outcome,
    ).toMatchObject({
      code: 'needs-user-action',
      detail: { reason: 'unsaved-changes' },
    });
    f.unsaved.clear();
    f.page().setDragging(true);
    const held = f.run({
      kind: 'arrange',
      presentationId: p.id,
      version: p.version,
      placement: DEFAULT_PLACEMENT,
    });
    await vi.advanceTimersByTimeAsync(PRESENTATION_HOLD_MS + 1);
    expect((await held).outcome).toMatchObject({ code: 'busy' });
    const controller = new AbortController();
    const cancelled = f.run(present(p.version), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await cancelled).outcome.status).toBe('cancelled-before-dispatch');
    f.page().setDragging(false);
    expect(f.panels(p.id)).toHaveLength(1);
  } finally {
    f.stop();
  }
});

it('reconciles a fresh renderer page at the host’s current version after reload', async () => {
  const f = joined();
  try {
    const p = shown(await f.run(present()));
    f.reload();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.panels(p.id)).toEqual([]);
    expect((await f.run({ kind: 'list' })).outcome).toMatchObject({
      value: { presentations: [{ id: p.id, version: p.version + 1, items: [{ box: null }] }] },
    });
    const reopened = shown(await f.run(present(p.version + 1)));
    expect(reopened.id).toBe(p.id);
    expect(f.panels(p.id)).toHaveLength(1);
  } finally {
    f.stop();
  }
});

it('settles a departing page’s Show and prevents its late validation from affecting the new page', async () => {
  const f = joined();
  try {
    const p = shown(await f.run(present()));
    f.dispatch({ type: 'close', panelId: f.panels(p.id)[0]?.id ?? '' });
    let release!: (path: string) => void;
    f.file.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = f.page().show('a', { presentationId: p.id });
    f.reload();
    expect(await old).toBe('unavailable');
    const current = f.page().show('a', { presentationId: p.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(await current).toBe('shown');
    release('/synthetic/result.md');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(f.panels(p.id)).toHaveLength(1);
    expect((await f.run({ kind: 'list' })).outcome).toMatchObject({
      value: { presentations: [{ id: p.id, version: p.version + 2 }] },
    });
  } finally {
    f.stop();
  }
});
