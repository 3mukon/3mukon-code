import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FilesBridge, OpenedFile } from '../shared/files';
import { useFileEditors, type FileEditors } from './use-file-editors';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

function fakeBridge(onDisk: Record<string, string>) {
  const listeners = new Set<(path: string) => void>();
  const bridge = {
    open: vi.fn<FilesBridge['open']>((path) =>
      Promise.resolve<OpenedFile>({ kind: 'text', text: onDisk[path] ?? '', bom: false }),
    ),
    save: vi.fn<FilesBridge['save']>(() => Promise.resolve({ saved: true })),
    watch: vi.fn<FilesBridge['watch']>(() => Promise.resolve()),
    onChange: (listener: (path: string) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    confirmClose: vi.fn<FilesBridge['confirmClose']>(() => Promise.resolve('cancel')),
    image: vi.fn<FilesBridge['image']>(() => Promise.resolve(null)),
  } satisfies FilesBridge;
  const change = async (path: string) => {
    await act(async () => {
      for (const listener of listeners) listener(path);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { bridge, change };
}

// Panels that show files, each a region named by its panel's id and marked while it holds unsaved
// changes.
function Panels({
  bridge,
  shown,
  onEditors,
}: {
  bridge: FilesBridge;
  shown: readonly (readonly [string, string])[];
  onEditors: (editors: FileEditors) => void;
}) {
  const editors = useFileEditors(bridge);
  onEditors(editors);
  return shown.map(([id, path]) => {
    const panel = editors.panel(id, path);
    return (
      <section key={id} aria-label={id} data-unsaved={panel.unsaved}>
        {panel.actions}
        {panel.body}
      </section>
    );
  });
}

async function showPanels(
  bridge: FilesBridge,
  shown: readonly (readonly [string, string])[],
): Promise<{ editors: () => FileEditors; rerender: (next: typeof shown) => Promise<void> }> {
  let latest: FileEditors | undefined;
  const onEditors = (editors: FileEditors) => {
    latest = editors;
  };
  const { rerender } = render(<Panels bridge={bridge} shown={shown} onEditors={onEditors} />);
  await act(async () => {
    await Promise.resolve();
  });
  return {
    editors: () => {
      if (latest === undefined) throw new Error('Not rendered');
      return latest;
    },
    rerender: async (next) => {
      rerender(<Panels bridge={bridge} shown={next} onEditors={onEditors} />);
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

function viewIn(panel: string): EditorView {
  const element = screen
    .getByRole('region', { name: panel })
    .querySelector<HTMLElement>('.cm-editor');
  const view = element === null ? null : EditorView.findFromDOM(element);
  if (view === null) throw new Error(`No editor in ${panel}`);
  return view;
}

describe('useFileEditors', () => {
  it('watches the files its editors show, and reads a file again when it changes on disk', async () => {
    const onDisk = { '/w/a.ts': 'a', '/w/b.ts': 'b' };
    const { bridge, change } = fakeBridge(onDisk);
    const { rerender } = await showPanels(bridge, [
      ['panel-1', '/w/a.ts'],
      ['panel-2', '/w/b.ts'],
    ]);
    expect(bridge.watch).toHaveBeenLastCalledWith(['/w/a.ts', '/w/b.ts']);
    onDisk['/w/a.ts'] = 'a2';
    await change('/w/a.ts');
    expect(viewIn('panel-1').state.doc.toString()).toBe('a2');
    expect(bridge.open.mock.calls.filter(([path]) => path === '/w/b.ts')).toHaveLength(1);
    await rerender([['panel-2', '/w/b.ts']]);
    expect(bridge.watch).toHaveBeenLastCalledWith(['/w/b.ts']);
  });

  it('lets a panel without unsaved changes close at once, and asks about unsaved ones', async () => {
    const { bridge } = fakeBridge({ '/w/a.ts': 'a' });
    const { editors } = await showPanels(bridge, [['panel-1', '/w/a.ts']]);
    expect(await editors().panel('panel-1', '/w/a.ts').confirmClose()).toBe(true);
    expect(bridge.confirmClose).not.toHaveBeenCalled();

    act(() => {
      viewIn('panel-1').dispatch({ changes: { from: 1, insert: '!' } });
    });
    expect(screen.getByRole('region', { name: 'panel-1' }).dataset.unsaved).toBe('true');
    const closable = () => editors().panel('panel-1', '/w/a.ts').confirmClose();
    expect(await closable()).toBe(false);
    expect(bridge.confirmClose).toHaveBeenCalledWith('a.ts');
    bridge.confirmClose.mockResolvedValueOnce('discard');
    expect(await closable()).toBe(true);
    expect(bridge.save).not.toHaveBeenCalled();
    bridge.confirmClose.mockResolvedValueOnce('save');
    let saved: boolean | undefined;
    await act(async () => {
      saved = await closable();
    });
    expect(saved).toBe(true);
    expect(bridge.save).toHaveBeenCalledWith('/w/a.ts', 'a!');
    expect(screen.getByRole('region', { name: 'panel-1' }).dataset.unsaved).toBe('false');
  });

  it('holds back the page’s unload while any editor holds unsaved changes', async () => {
    const { bridge } = fakeBridge({ '/w/a.ts': 'a' });
    await showPanels(bridge, [['panel-1', '/w/a.ts']]);
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    act(() => {
      viewIn('panel-1').dispatch({ changes: { from: 1, insert: '!' } });
    });
    expect(unload()).toBe(true);
    act(() => {
      viewIn('panel-1').dispatch({ changes: { from: 1, to: 2 } });
    });
    expect(unload()).toBe(false);
  });
});

describe('rendered files', () => {
  it('opens a file in a format that renders rendered, with a toggle to its raw text that keeps unsaved edits', async () => {
    const { bridge } = fakeBridge({ '/w/notes.md': '# Notes\n' });
    await showPanels(bridge, [['p1', '/w/notes.md']]);
    const panel = screen.getByRole('region', { name: 'p1' });
    expect(within(panel).getByRole('heading', { level: 1 }).textContent).toBe('Notes');
    const raw = within(panel).getByRole('button', { name: 'Raw' });
    fireEvent.click(raw);
    expect(within(panel).queryByRole('heading')).toBeNull();
    const element = panel.querySelector<HTMLElement>('.cm-editor');
    const view = element === null ? null : EditorView.findFromDOM(element);
    act(() => {
      view?.dispatch({ changes: { from: view.state.doc.length, insert: '\nMore *text*\n' } });
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Rendered' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    // The rendered view shows the unsaved text; the editor, hidden, keeps it.
    expect(panel.querySelector('article em')?.textContent).toBe('text');
    expect(panel.dataset.unsaved).toBe('true');
  });

  it('opens a file that does not parse raw, and a file in no such format without a toggle', async () => {
    const { bridge } = fakeBridge({ '/w/a.json': '{"a": }', '/w/main.ts': 'export {};\n' });
    await showPanels(bridge, [
      ['p1', '/w/a.json'],
      ['p2', '/w/main.ts'],
    ]);
    const json = screen.getByRole('region', { name: 'p1' });
    expect(within(json).getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(json.querySelector('.cm-editor')).not.toBeNull();
    expect(within(screen.getByRole('region', { name: 'p2' })).queryByRole('group')).toBeNull();
  });
});
