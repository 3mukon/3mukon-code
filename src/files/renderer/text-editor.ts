import { Compartment, EditorState, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorSetup, languageFor } from './editor-setup';

// What a change on disk did to an editor: nothing, as the file holds what the editor last read or
// wrote, or what it shows now; a reload, as the editor held no unsaved changes; or nothing yet, as
// unsaved changes stand against it.
export type DiskChange = 'same' | 'reloaded' | 'conflict';

interface TextEditorOptions {
  // The file's name, which picks its language.
  name: string;
  // The editor's name for VoiceOver.
  label: string;
  // CodeMirror's words in the window's language.
  phrases: Readonly<Record<string, string>>;
  onUnsavedChange(unsaved: boolean): void;
  // Hears every change of the text, the user's and those from disk alike.
  onTextChange?(): void;
}

// A file's text in CodeMirror. The editor knows the text on disk as it last read or wrote it, so that
// it tells unsaved changes from none, and keeps the file's line breaks and byte order mark for saving,
// while CodeMirror itself breaks lines at any of them.
export class TextEditor {
  private readonly view: EditorView;
  private readonly language = new Compartment();
  private readonly lineBreak: string;
  private readonly bom: boolean;
  private onDisk: Text;
  private wasUnsaved = false;
  // Set while the editor changes its own text, which notes unsaved changes itself afterwards.
  private reloading = false;
  private destroyed = false;

  constructor(
    parent: HTMLElement,
    file: { text: string; bom: boolean },
    private readonly options: TextEditorOptions,
  ) {
    this.lineBreak = /\r\n|\r|\n/.exec(file.text)?.[0] ?? '\n';
    this.bom = file.bom;
    const state = EditorState.create({
      doc: file.text,
      extensions: [
        editorSetup(options.phrases, options.label),
        this.language.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (!this.reloading) this.noteUnsaved();
          options.onTextChange?.();
        }),
      ],
    });
    this.onDisk = state.doc;
    this.view = new EditorView({ state, parent });
    languageFor(options.name).then(
      (support) => {
        if (support !== null && !this.destroyed) {
          this.view.dispatch({ effects: this.language.reconfigure(support) });
        }
      },
      // A language that does not load leaves the text plain.
      () => undefined,
    );
  }

  get unsaved(): boolean {
    return !this.view.state.doc.eq(this.onDisk);
  }

  // The text to save, with the file's own line breaks and byte order mark, and the document it holds.
  contents(): { text: string; doc: Text } {
    const doc = this.view.state.doc;
    return { text: (this.bom ? '﻿' : '') + doc.sliceString(0, doc.length, this.lineBreak), doc };
  }

  // The file now holds this document, as it was saved.
  saved(doc: Text): void {
    this.onDisk = doc;
    this.noteUnsaved();
  }

  // The file changed on disk to this text: an editor without unsaved changes shows it, keeping the
  // selection where the text around it stayed.
  diskChanged(text: string): DiskChange {
    const next = this.view.state.toText(text);
    if (next.eq(this.onDisk)) return 'same';
    if (next.eq(this.view.state.doc)) {
      this.saved(this.view.state.doc);
      return 'same';
    }
    if (this.unsaved) return 'conflict';
    this.reload(text);
    return 'reloaded';
  }

  // Shows the text now on disk, giving up unsaved changes; Undo brings them back.
  reload(text: string): void {
    const current = this.view.state.doc.toString();
    const next = this.view.state.toText(text).toString();
    this.reloading = true;
    try {
      this.view.dispatch({ changes: difference(current, next), userEvent: 'reload' });
    } finally {
      this.reloading = false;
    }
    this.saved(this.view.state.doc);
  }

  // Keeps the unsaved changes against the text now on disk, which saving overwrites.
  keep(text: string): void {
    this.onDisk = this.view.state.toText(text);
    this.noteUnsaved();
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.destroyed = true;
    this.view.destroy();
  }

  private noteUnsaved(): void {
    const unsaved = this.unsaved;
    if (unsaved === this.wasUnsaved) return;
    this.wasUnsaved = unsaved;
    this.options.onUnsavedChange(unsaved);
  }
}

// The one change that turns a text into another: what lies between their common start and end.
function difference(from: string, to: string): { from: number; to: number; insert: string } {
  const shorter = Math.min(from.length, to.length);
  let start = 0;
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < shorter - start &&
    from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)
  ) {
    end++;
  }
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}
