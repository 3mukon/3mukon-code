// The largest file the editor opens, in bytes; a larger one opens as a notice.
export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

// Why a file opens as a notice instead of in the editor: it is no UTF-8 text, it is larger than
// MAX_EDITABLE_BYTES, it does not exist, it cannot be read, or it lies in no workspace and was not
// dropped on the window.
export type FileNotice = 'binary' | 'too-large' | 'missing' | 'unreadable' | 'outside';

// A file as the editor opens it: its text, without the byte order mark it may start with, which `bom`
// notes, and with its line breaks as they are; or why it opens as a notice.
export type OpenedFile =
  { kind: 'text'; text: string; bom: boolean } | { kind: 'notice'; notice: FileNotice };

// Whether a save wrote the file, and if not why: the user may not write it, it lies in no workspace
// and was not dropped on the window, or writing failed otherwise.
export type SaveResult =
  { saved: true } | { saved: false; reason: 'denied' | 'outside' | 'failed' };

// The user's answer when a panel with unsaved changes closes.
export type CloseAnswer = 'save' | 'discard' | 'cancel';

// What the window asks of the files module's main-process side through the preload bridge. Paths are
// absolute, and only files inside a workspace or dropped on the window are read or written.
export interface FilesBridge {
  open(path: string): Promise<OpenedFile>;
  // Writes the text as UTF-8, over what the file holds.
  save(path: string, text: string): Promise<SaveResult>;
  // The files the window's editors show, whose changes on disk it hears of; each call replaces the
  // last one's list.
  watch(paths: readonly string[]): Promise<void>;
  // A watched file changed on disk, was replaced or was removed.
  onChange(listener: (path: string) => void): () => void;
  // Asks whether to save a file's changes before its panel closes.
  confirmClose(name: string): Promise<CloseAnswer>;
}
