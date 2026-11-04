// Workspaces: folders on this Mac that the user added, each with the user's answer to whether they
// trust it, and one of them selected. Everything here is plain JSON-serializable data, except the
// dropped items the bridge takes, which the preload script turns into paths.

export interface Workspace {
  // The app's id for the workspace while it is on the list.
  id: string;
  // The folder's name, as the list shows it.
  name: string;
  // The folder's absolute path, with links resolved.
  path: string;
  // The user's answer when adding the workspace, or a later change of it. It changes nothing else yet:
  // each provider applies its own trust rules.
  trusted: boolean;
}

export interface WorkspaceList {
  // In the order they were added.
  workspaces: Workspace[];
  // The selected workspace; null only while the list is empty.
  selectedId: string | null;
}

export interface FolderEntry {
  name: string;
  kind: 'folder' | 'file';
}

// A folder's entries, folders first and then files, each in the Finder's order; or why it could not be
// read: it is gone, or this Mac does not let the app read it.
export type FolderListing = { entries: FolderEntry[] } | { error: 'missing' | 'unreadable' };

// What the window asks of the workspaces, through the preload bridge. A path in a workspace is relative
// to its folder, with / between names, and '' for the folder itself.
export interface WorkspacesBridge {
  get(): Promise<WorkspaceList>;
  // Calls the listener with the whole list whenever it changes, and returns a function that stops it.
  onChange(listener: (list: WorkspaceList) => void): () => void;
  // Adds the folder the user chooses in the folder picker, after asking whether they trust it.
  add(): Promise<void>;
  // Adds the folders among the dropped items, asking for each whether the user trusts it.
  addDropped(items: readonly File[]): Promise<void>;
  select(id: string): Promise<void>;
  // Shows the menu of a row of the workspace's tree, by its path relative to the workspace's folder:
  // the workspace's own for '', from which the user opens its folder in a terminal, changes their
  // trust answer or removes it, and a folder's inside it for its path, from which the user opens the
  // folder in a terminal; resolves with what the window is to do, opening the folder in a terminal,
  // or null.
  showMenu(id: string, path: string): Promise<WorkspaceMenuChoice | null>;
  listFolder(id: string, path: string): Promise<FolderListing>;
}

// What a workspace's menu leaves the window to do.
export type WorkspaceMenuChoice = 'open-in-terminal';
