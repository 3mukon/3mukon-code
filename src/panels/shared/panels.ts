// What a panel shows: a session page for a folder, which becomes a session with its first message; a
// session the app has open, by the app's id, with its folder; a file; a terminal the main process
// runs, by its id, with the folder it started in; the archived sessions; the providers' accounts; or
// the settings. Paths are absolute.
export type PanelContent =
  | { kind: 'session-page'; folder: string }
  | { kind: 'session'; id: string; folder: string }
  | { kind: 'file'; path: string }
  | { kind: 'terminal'; id: string; cwd: string }
  | { kind: 'archived' }
  | { kind: 'accounts' }
  | { kind: 'settings' };

// A folder or file dropped on the main area or opened from a tree, by its absolute path.
export interface DroppedItem {
  kind: 'folder' | 'file';
  path: string;
}

// What the window asks of the panel area's main-process side through the preload bridge.
export interface PanelsBridge {
  // The folders and files among items dropped from the Finder, in their order; items that are
  // neither, or that cannot be read, are left out.
  itemsAt(items: readonly File[]): Promise<DroppedItem[]>;
}
