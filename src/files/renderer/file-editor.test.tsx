import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type { FilesBridge, OpenedFile, SaveResult } from '../shared/files';
import { FileEditor, type EditorHandle } from './file-editor';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const path = '/Users/me/web/src/a.ts';

function fakeBridge(file: OpenedFile) {
  let onDisk = file;
  const bridge = {
    open: vi.fn<FilesBridge['open']>(() => Promise.resolve(onDisk)),
    save: vi.fn<FilesBridge['save']>(() => Promise.resolve({ saved: true })),
    watch: vi.fn<FilesBridge['watch']>(() => Promise.resolve()),
    onChange: () => () => undefined,
    confirmClose: vi.fn<FilesBridge['confirmClose']>(() => Promise.resolve('cancel')),
  } satisfies FilesBridge;
  return {
    bridge,
    write: (next: OpenedFile) => {
      onDisk = next;
    },
  };
}

async function show(file: OpenedFile) {
  const { bridge, write } = fakeBridge(file);
  const onUnsavedChange = vi.fn<(unsaved: boolean) => void>();
  let handle: EditorHandle | null = null;
  const { container } = render(
    <FileEditor
      bridge={bridge}
      path={path}
      onUnsavedChange={onUnsavedChange}
      onHandle={(given) => {
        handle = given;
      }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const element = container.querySelector<HTMLElement>('.cm-editor');
  const view = element === null ? null : EditorView.findFromDOM(element);
  const reread = async () => {
    await act(async () => {
      handle?.reread();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { bridge, write, onUnsavedChange, view, reread, handle: () => handle, container };
}

const text = (value: string): OpenedFile => ({ kind: 'text', text: value, bom: false });

describe('FileEditor', () => {
  it('shows the file’s text in an editor named by the file’s name', async () => {
    const { view, bridge } = await show(text('export const a = 1;\n'));
    expect(bridge.open).toHaveBeenCalledWith(path);
    expect(view?.state.doc.toString()).toBe('export const a = 1;\n');
    screen.getByRole('textbox', { name: 'a.ts' });
  });

  it('saves with ⌘S from anywhere in the panel, and reports its unsaved changes', async () => {
    const { view, bridge, onUnsavedChange } = await show({
      kind: 'text',
      text: 'a\r\n',
      bom: true,
    });
    act(() => {
      view?.dispatch({ changes: { from: view.state.doc.length, insert: 'b\n' } });
    });
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'a.ts' }), {
        key: 's',
        metaKey: true,
      });
      await Promise.resolve();
    });
    expect(bridge.save).toHaveBeenCalledWith(path, '﻿a\r\nb\r\n');
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  });

  it('shows a change on disk at once while it holds no unsaved changes', async () => {
    const { view, write, reread } = await show(text('one'));
    write(text('two'));
    await reread();
    expect(view?.state.doc.toString()).toBe('two');
    expect(screen.queryByText('This file changed on disk.')).toBeNull();
  });

  it('offers to reload a file changed under unsaved changes, or to keep editing, after which saving overwrites it', async () => {
    // happy-dom reports a focused editor's selection while the editor still updates, which a browser
    // does afterwards.
    vi.spyOn(EditorView.prototype, 'focus').mockImplementation(() => undefined);
    const { view, write, reread, bridge, handle } = await show(text('one'));
    act(() => {
      view?.dispatch({ changes: { from: 3, insert: ' mine' } });
    });
    write(text('one theirs'));
    await reread();
    screen.getByText('This file changed on disk.');
    expect(view?.state.doc.toString()).toBe('one mine');
    fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
    expect(screen.queryByText('This file changed on disk.')).toBeNull();
    expect(handle()?.unsaved()).toBe(true);
    await act(async () => {
      await handle()?.save();
    });
    expect(bridge.save).toHaveBeenLastCalledWith(path, 'one mine');

    act(() => {
      view?.dispatch({ changes: { from: 0, insert: '> ' } });
    });
    write(text('three'));
    await reread();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(view?.state.doc.toString()).toBe('three');
    expect(handle()?.unsaved()).toBe(false);
  });

  it('says when the file was removed, and when saving fails', async () => {
    const { write, reread, bridge, handle } = await show(text('one'));
    write({ kind: 'notice', notice: 'missing' });
    await reread();
    screen.getByText('This file was removed from disk. Saving writes it again.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    bridge.save.mockResolvedValueOnce({ saved: false, reason: 'denied' } satisfies SaveResult);
    let saved: boolean | undefined;
    await act(async () => {
      saved = await handle()?.save();
    });
    expect(saved).toBe(false);
    screen.getByText('The file couldn’t be saved: you don’t have permission to write it.');
  });

  it('opens a file it cannot edit as a notice that names it', async () => {
    const { container, handle } = await show({ kind: 'notice', notice: 'too-large' });
    expect(container.textContent).toBe('a.ts is larger than 5 MB, too large to edit here.');
    expect(handle()).toBeNull();
    cleanup();
    const binary = await show({ kind: 'notice', notice: 'binary' });
    expect(binary.container.textContent).toBe(
      'a.ts isn’t a text file, so it can’t be edited here.',
    );
  });
});
