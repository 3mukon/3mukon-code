---
id: DOC-mod-workspaces
type: doc
title: workspaces module
status: current
visibility: public
date: 2026-10-27
summary: The user's workspaces, folders on this Mac with the user's trust answer and one of them selected, kept in the app's own data, with the sidebar's Workspaces section and each workspace's folder tree
scope: ["src/workspaces/**"]
tags: []
---

## Responsibilities

- The list (`main/workspaces.ts`): `Workspaces` keeps the user's workspaces, folders on this Mac, in the order they were added, each with the user's answer to whether they trust its files, and one of them selected whenever there are any.
  - Adding: through the folder picker, or by dropping folders from the Finder, whose other items are skipped. The user is asked whether they trust the folder, one folder at a time, and the new workspace is selected. A folder already on the list, also when reached through a link, is selected instead of added again. A second click on Add workspace before the picker closes shows no second picker.
  - Changing: selecting, changing the trust answer, and removing, which selects the workspace after the removed one, or else the one before, and leaves the folder as it is. The trust answer changes nothing else yet: each provider applies its own trust rules.
- Storage (`main/storage.ts`): the list and the selection live in `workspaces.json` in the app's data folder (ADR-0004), written through electron-store and readable by the user alone. A file that is not JSON is cleared, and one that holds something else counts as no workspaces until the next change replaces it.
- Folder trees (`main/folders.ts`): a folder in a workspace, by its path relative to the workspace's folder, as its tree shows it: folders first, then files, each in the Finder's order, without `.git`. A link counts as what it points to, and a broken one as a file. A path that could leave the workspace's folder is refused.
- Questions and menu (`main/native.ts`): the folder picker as macOS's own sheet on the window that asked, and through the window's prompts (the ui module's `Prompts`, which the window draws in the app's own look, ADR-0013) the trust question, Trust being the default answer and Don't Trust Escape's, and a workspace's menu, with Open in Terminal, which the window does, Trusted, checked while it is, and Remove Workspace, at the pointer; all in the main process's language (DOC-mod-i18n).
- The window's part (`renderer/`):
  - `WorkspacesSection`: the sidebar's Workspaces section, with Add workspace just after its heading; folders dropped from the Finder anywhere on it are added. Without workspaces it shows its heading alone.
  - `WorkspaceTree`: the workspaces as a tree, each by its folder's name with its path in the tooltip and a mark when untrusted. Each expands into its folder tree, read folder by folder as folders open and again each time one opens; a folder that cannot be read says so and closes again. A click opens or closes a folder at once, and a workspace once no second press has followed it within the wait (`renderer/click-wait.ts`), which follows the user's own double clicks: 150ms before the first, then a margin longer than the slowest of the last five, measured from the first click to the second press, between 100ms and 400ms. A double click, known from its second press, selects a workspace without opening or closing it; should that press come after the wait, it puts the tree back. Return or Space selects a workspace too; a secondary click or VoiceOver's menu command opens its menu, whose Open in Terminal goes to the app module with the workspace's folder; the arrow keys, Home and End move as in macOS lists. A press on any row goes to the app module, as a folder or a file by its absolute path (`TreeItem`), which drags the row elsewhere with the pointer, and every row opens elsewhere with ⌘↓, as in the Finder, or with Return or Space on a file; the app module decides where. No row starts a drag of the system's.
  - `useWorkspaces`: the list as the main process keeps it, kept current through the bridge.
- The contract (`shared/workspaces.ts`): the list's types, and `WorkspacesBridge`, what the window asks of the workspaces through the preload bridge.

## Not responsible for

- Carrying calls between the window and the main process: the app module's preload bridge does (DOC-mod-app).
- Applying the trust answer to the providers' own trust mechanisms, which a later change does.
- Opening folders and files from the trees, which the panel area and the file editor do; and creating, renaming, moving or deleting files.
- Watching folders: an open folder shows what it held when it opened.

## Interface

- For the app module: `Workspaces` and `WorkspacesUi` from `main/workspaces.ts`, `fileStorage` from `main/storage.ts` and `windowWorkspacesUi` from `main/native.ts`; `WorkspacesSection`, which takes what to do with a press on a row, a row to open and a workspace's folder to open in a terminal, `useWorkspaces` and `TreeItem` from `renderer/`.
- For both processes: the types and `WorkspacesBridge` in `shared/workspaces.ts`.

## Dependencies

- Uses the ui and i18n modules, electron-store, zod, React and Node.js built-ins; `main/native.ts` also uses Electron. The rule `workspaces-only-to-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- Only the app module imports it.

## Invariants

- The trees read folders only inside workspaces: a listing takes a workspace's id and a path in it, never a path of its own.
- A workspace's path is absolute, with links resolved, and no two workspaces share a folder.
- The unit tests run on real folders in throwaway temporary folders, with answers standing in for the user's (`main/*.test.ts`), and render the section with a fake bridge (`renderer/*.test.tsx`); smoke tests add workspaces in the built app, with the dialogs answered in its main process, then open and select them with the pointer and choose one in the Sessions filter (`tests/smoke/workspaces.spec.ts`).
