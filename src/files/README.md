---
id: DOC-mod-files
type: doc
title: files module
status: current
visibility: public
date: 2026-10-29
summary: The file editor panel, which edits a workspace's or a dropped file in CodeMirror with highlighting, saves it with ⌘S, marks and guards unsaved changes and follows changes on disk, and the main process's reading, writing and watching of the files open to it
scope: ["src/files/**"]
tags: []
---

## Responsibilities

- Which files the editors may touch (`main/files.ts`): `FileService` opens, saves and watches only files inside a workspace's folder, files dropped on the window from the Finder (`grant`), and files an editor has opened, which stay open to it for the app's run should their workspace be removed meanwhile. A path must be absolute and in its plain form, without `.` or `..` parts or a trailing slash.
- Reading and writing (`main/text-files.ts`): a file of at most 5 MB (`MAX_EDITABLE_BYTES`), without a NUL byte and of valid UTF-8, opens as text, with a byte order mark left out and noted and its line breaks as they are. Anything else opens as a notice: a larger file, one of other bytes, a missing one, and one that cannot be read or is no file. Saving writes UTF-8 over the file itself, so that a link keeps pointing to it and the file keeps its permissions; a missing file is written again in its folder, and a write the user may not make is told apart from other failures.
- Watching (`main/watch.ts`): `FileWatcher` watches files through their folders, one watcher per folder, so that a file replaced through a rename, as many programs save, or removed and written again is still followed; a change is reported once its changes have settled, 50 ms. The service watches the files each window lists, by the window's web contents, until the window lists others or goes.
- Questions (`main/native.ts`), in the main process's language (DOC-mod-i18n): before a panel with unsaved changes closes, Save, the default, Cancel and Don't Save, through the window's prompts (the ui module's `Prompts`, which the window draws in the app's own look, ADR-0013); and while the page holds back its unload, whether to discard the changes before the window closes, the app quits or the page loads again, Cancel being the default, as macOS's own sheet, since a page cannot draw while it unloads.
- The window's part (`renderer/`):
  - `FileEditor`: a file's panel body, the file in CodeMirror (ADR-0011) or a notice that names a file it cannot edit. ⌘S saves it from anywhere in the panel. When the file changes on disk, an editor without unsaved changes shows the new text at once; one with unsaved changes says so in a bar above its text, with Reload and Keep Editing, after which saving overwrites the file. A removed file says so too, and saving writes it again; a save that fails says why.
  - The editor's setup (`renderer/editor-setup.ts`), assembled from CodeMirror's parts: line numbers, folding, history, bracket matching and closing, several selections, search and replace, Go to line, Tab to indent, Escape and then Tab moving the focus on, and long lines wrapped at the panel's width; ⌘D stays the panel area's. Its look and syntax colours are the ui module's tokens, so it follows both appearances; its fold markers show while the pointer is over the gutter, and the line with the cursor stands out while it has focus. A file's language comes from its name through CodeMirror's language data, loaded from the app's own files when a file needs it; other files stay plain text. CodeMirror's words come from the catalog.
  - `TextEditor` (`renderer/text-editor.ts`): the CodeMirror view with the text on disk as it last read or wrote it, which tells unsaved changes from none, also after Undo; it keeps the file's line breaks and byte order mark for saving, and shows text from disk as one change that keeps the selection where the text around it stayed, and that Undo takes back.
  - `useFileEditors`: the window's editors, one per panel that shows a file, each with its panel's body, unsaved mark and `confirmClose`, which asks whether to save before the panel closes. The files they show are watched, a change on disk reaches the editors that show the file, and while any editor holds unsaved changes the page holds back its unload.
- The contract (`shared/files.ts`): `OpenedFile`, `FileNotice`, `SaveResult`, `CloseAnswer`, `MAX_EDITABLE_BYTES` and `FilesBridge`, what the window asks of this module through the preload bridge.

## Not responsible for

- Where a file opens, its panel's header, and closing it: the panels module lays out the panels and asks one before it closes, and the app module composes the editors into them.
- Listing folders, and dragging or opening files from the trees: the workspaces module does. The app module tells the service the workspaces' folders and the files dropped on a window.
- Creating, renaming, moving or deleting files; searching across files, language servers and the other features of an IDE; tabs inside a panel.
- Highlighting the code in the activity's messages, which the sessions module does with highlight.js (ADR-0010).

## Interface

- For the app module: `FileService` from `main/files.ts`, `windowFilesUi` and `keepUnsavedChanges` from `main/native.ts`, and `useFileEditors` and `FilePanel` from `renderer/use-file-editors.tsx`.
- For both processes: the types, `MAX_EDITABLE_BYTES` and `FilesBridge` in `shared/files.ts`.

## Dependencies

- Uses the i18n module and the ui module's tokens, CodeMirror's packages and `@lezer/highlight` (ADR-0011), React and react-i18next, and in `main/` Node.js built-ins and Electron. The rule `files-only-to-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- Only the app module imports it.

## Invariants

- The editors read, write and watch only files inside a workspace, dropped on a window, or opened by an editor during the app's run, by their plain absolute paths.
- Saving writes over the file itself, never over a copy renamed into its place.
- The unit tests run on real files in throwaway folders, with the file system's real events (`main/*.test.ts`), run CodeMirror in happy-dom (`renderer/text-editor.test.ts`), and render the editor and its hook with a fake bridge (`renderer/*.test.tsx`). A smoke test, in the built app, opens a file from a workspace's tree, edits it and saves it with ⌘S, changes it on disk without and under unsaved changes, closes its panel with unsaved changes, opens a file that is not text, and closes the window while an editor holds unsaved changes (`tests/smoke/files.spec.ts`).
