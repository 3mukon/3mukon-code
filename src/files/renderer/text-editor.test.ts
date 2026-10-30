// @vitest-environment happy-dom
import { undo } from '@codemirror/commands';
import { language } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextEditor } from './text-editor';

let editors: TextEditor[] = [];
afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
  document.body.innerHTML = '';
});

function open(text: string, { bom = false, name = 'notes.txt' } = {}) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const onUnsavedChange = vi.fn<(unsaved: boolean) => void>();
  const editor = new TextEditor(
    parent,
    { text, bom },
    { name, label: name, phrases: { Find: 'Suchen' }, onUnsavedChange },
  );
  editors.push(editor);
  const view = EditorView.findFromDOM(parent.querySelector<HTMLElement>('.cm-editor') ?? parent);
  if (view === null) throw new Error('No editor view');
  return { editor, view, onUnsavedChange, parent };
}

describe('TextEditor', () => {
  it('shows the text with long lines wrapped, named for VoiceOver, and in the words it was given', () => {
    const { view, parent } = open('first\nsecond');
    expect(view.state.doc.toString()).toBe('first\nsecond');
    const content = parent.querySelector('.cm-content');
    expect(content?.getAttribute('aria-label')).toBe('notes.txt');
    expect(content?.classList.contains('cm-lineWrapping')).toBe(true);
    expect(view.state.phrase('Find')).toBe('Suchen');
  });

  it('wraps a line at its own indentation, which its first row takes back', () => {
    const { parent } = open('top\n    nested line\n\tin a tab\n   \n', { name: 'notes.txt' });
    const lines = [...parent.querySelectorAll<HTMLElement>('.cm-line')];
    expect(lines.map((line) => line.style.paddingLeft)).toEqual([
      '',
      'calc(4ch + 6px)',
      'calc(4ch + 6px)',
      '',
      '',
    ]);
    expect(lines[1]?.style.textIndent).toBe('-4ch');
  });

  it('tells unsaved changes from none, also after undoing them', () => {
    const { editor, view, onUnsavedChange } = open('one');
    expect(editor.unsaved).toBe(false);
    view.dispatch({ changes: { from: 3, insert: ' two' } });
    expect(editor.unsaved).toBe(true);
    undo(view);
    expect(editor.unsaved).toBe(false);
    expect(onUnsavedChange.mock.calls).toEqual([[true], [false]]);
  });

  it('saves with the file’s own line breaks and byte order mark', () => {
    const { editor, view } = open('a\r\nb\r\n', { bom: true });
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'c\n' } });
    expect(editor.contents().text).toBe('﻿a\r\nb\r\nc\r\n');
    const { editor: plain } = open('a\nb');
    expect(plain.contents().text).toBe('a\nb');
  });

  it('is saved once the file holds what it shows', () => {
    const { editor, view, onUnsavedChange } = open('one');
    view.dispatch({ changes: { from: 3, insert: '!' } });
    const { doc } = editor.contents();
    view.dispatch({ changes: { from: 4, insert: '?' } });
    editor.saved(doc);
    expect(editor.unsaved).toBe(true);
    editor.saved(view.state.doc);
    expect(editor.unsaved).toBe(false);
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  });

  it('shows what changed on disk without unsaved changes, keeping the selection, and Undo brings back the old text', () => {
    const { editor, view } = open('alpha\nbeta\ngamma\n');
    view.dispatch({ selection: { anchor: 13 } });
    expect(editor.diskChanged('alpha\nbeta\ngamma\n')).toBe('same');
    expect(editor.diskChanged('ALPHA\nbeta\ngamma\n')).toBe('reloaded');
    expect(view.state.doc.toString()).toBe('ALPHA\nbeta\ngamma\n');
    expect(view.state.selection.main.head).toBe(13);
    expect(editor.unsaved).toBe(false);
    undo(view);
    expect(view.state.doc.toString()).toBe('alpha\nbeta\ngamma\n');
    expect(editor.unsaved).toBe(true);
  });

  it('leaves unsaved changes standing against a change on disk until the user chooses', () => {
    const { editor, view } = open('one');
    view.dispatch({ changes: { from: 3, insert: ' mine' } });
    expect(editor.diskChanged('one theirs')).toBe('conflict');
    expect(view.state.doc.toString()).toBe('one mine');
    editor.keep('one theirs');
    expect(editor.unsaved).toBe(true);
    expect(editor.diskChanged('one theirs')).toBe('same');
    expect(editor.diskChanged('one mine')).toBe('same');
    expect(editor.unsaved).toBe(false);

    view.dispatch({ changes: { from: 0, insert: '> ' } });
    expect(editor.diskChanged('two')).toBe('conflict');
    editor.reload('two');
    expect(view.state.doc.toString()).toBe('two');
    expect(editor.unsaved).toBe(false);
  });

  it('takes a file’s language from its name, and leaves an unknown one plain', async () => {
    const { view } = open('const a = 1;', { name: 'index.ts' });
    await vi.waitFor(() => {
      expect(view.state.facet(language)?.name).toBe('typescript');
    });
    const { view: plain } = open('text', { name: 'notes.unknown-kind' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(plain.state.facet(language)).toBeNull();
  });
});
