import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type {
  FolderListing,
  Workspace,
  WorkspaceList,
  WorkspaceMenuChoice,
} from '../shared/workspaces';
import { listFolder } from './folders';
import type { StoredWorkspaces, WorkspaceStorage } from './storage';

// What the workspaces ask of the user, in the window the request came from. The app shows native
// dialogs and menus (main/native.ts); tests answer for the user.
export interface WorkspacesUi {
  // The folder the user chose in the folder picker; undefined when they cancelled it.
  pickFolder(): Promise<string | undefined>;
  // Whether the user trusts the files in the folder.
  askTrust(name: string, path: string): Promise<boolean>;
  // Shows the workspace's menu; choosing one of its items calls the matching action, and resolves
  // with what the window is to do, or null.
  showMenu(workspace: Workspace, actions: WorkspaceActions): Promise<WorkspaceMenuChoice | null>;
  // Shows the menu of a folder inside a workspace; resolves with what the window is to do, or null.
  showFolderMenu(): Promise<WorkspaceMenuChoice | null>;
}

export interface WorkspaceActions {
  setTrusted(trusted: boolean): void;
  remove(): void;
}

// The user's workspaces, kept in the app's data: folders with the user's trust answers, in the order
// they were added, and the one selected, which is always one of them while there are any. Additions
// wait for one another, so that one folder picker or trust question shows at a time.
export class Workspaces {
  private stored: StoredWorkspaces;
  private readonly listeners = new Set<(list: WorkspaceList) => void>();
  private adding = Promise.resolve();
  // The addition through the folder picker that is waiting or showing, if any.
  private picking: Promise<void> | null = null;

  constructor(private readonly storage: WorkspaceStorage) {
    this.stored = consistent(storage.load());
  }

  list(): WorkspaceList {
    return {
      workspaces: this.stored.workspaces.map((workspace) => ({
        ...workspace,
        name: nameOf(workspace.path),
      })),
      selectedId: this.stored.selectedId,
    };
  }

  // Calls the listener with the whole list after every change, and returns a function that stops it.
  onChange(listener: (list: WorkspaceList) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Adds the folder the user picks. Asked again before the picker has closed, as by a double click, it
  // shows no second picker.
  add(ui: WorkspacesUi): Promise<void> {
    this.picking ??= this.enqueue(async () => {
      const path = await ui.pickFolder();
      if (path !== undefined) await this.addFolder(path, ui);
    }).finally(() => {
      this.picking = null;
    });
    return this.picking;
  }

  // Adds the folders among the paths, one after another; other paths, such as files', are skipped.
  addFolders(paths: readonly string[], ui: WorkspacesUi): Promise<void> {
    return this.enqueue(async () => {
      for (const path of paths) await this.addFolder(path, ui);
    });
  }

  select(id: string): void {
    if (id === this.stored.selectedId || !this.has(id)) return;
    this.update({ ...this.stored, selectedId: id });
  }

  setTrusted(id: string, trusted: boolean): void {
    if (
      !this.stored.workspaces.some(
        (workspace) => workspace.id === id && workspace.trusted !== trusted,
      )
    ) {
      return;
    }
    this.update({
      ...this.stored,
      workspaces: this.stored.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, trusted } : workspace,
      ),
    });
  }

  // Takes the workspace off the list and leaves its folder as it is. When it was selected, the one
  // after it is selected, or else the one before.
  remove(id: string): void {
    const index = this.stored.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) return;
    const workspaces = this.stored.workspaces.filter((workspace) => workspace.id !== id);
    const selectedId =
      this.stored.selectedId === id
        ? (workspaces[Math.min(index, workspaces.length - 1)]?.id ?? null)
        : this.stored.selectedId;
    this.update({ workspaces, selectedId });
  }

  // The menu of a row of the workspace's tree: the workspace's own for '', and a folder's inside it
  // for its path, relative to the workspace's folder.
  showMenu(id: string, path: string, ui: WorkspacesUi): Promise<WorkspaceMenuChoice | null> {
    const workspace = this.list().workspaces.find((candidate) => candidate.id === id);
    if (workspace === undefined) return Promise.resolve(null);
    if (path !== '') return ui.showFolderMenu();
    return ui.showMenu(workspace, {
      setTrusted: (trusted) => {
        this.setTrusted(id, trusted);
      },
      remove: () => {
        this.remove(id);
      },
    });
  }

  // A folder in the workspace's tree; path is relative to the workspace's folder.
  listFolder(id: string, path: string): Promise<FolderListing> {
    const workspace = this.stored.workspaces.find((candidate) => candidate.id === id);
    if (workspace === undefined)
      return Promise.reject(new Error('The workspace is not on the list.'));
    return listFolder(workspace.path, path);
  }

  private async addFolder(path: string, ui: WorkspacesUi): Promise<void> {
    // A dropped item that is no file on this Mac, such as text from a page, has no path.
    if (!isAbsolute(path)) return;
    let folder: string;
    try {
      if (!(await stat(path)).isDirectory()) return;
      folder = await realpath(path);
    } catch {
      return;
    }
    const existing = this.stored.workspaces.find((workspace) => workspace.path === folder);
    if (existing !== undefined) {
      this.select(existing.id);
      return;
    }
    const trusted = await ui.askTrust(nameOf(folder), folder);
    const workspace = { id: randomUUID(), path: folder, trusted };
    this.update({ workspaces: [...this.stored.workspaces, workspace], selectedId: workspace.id });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const done = this.adding.then(task);
    this.adding = done.catch(() => undefined);
    return done;
  }

  private has(id: string): boolean {
    return this.stored.workspaces.some((workspace) => workspace.id === id);
  }

  private update(stored: StoredWorkspaces): void {
    this.stored = stored;
    this.storage.save(stored);
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }
}

// The folder's name; the startup disk's root, which has none, goes by its path.
function nameOf(path: string): string {
  return basename(path) || path;
}

// Stored workspaces without repeated ids or folders, and with a selection whenever there are any.
function consistent(stored: StoredWorkspaces): StoredWorkspaces {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const workspaces = stored.workspaces.filter((workspace) => {
    if (ids.has(workspace.id) || paths.has(workspace.path)) return false;
    ids.add(workspace.id);
    paths.add(workspace.path);
    return true;
  });
  const selectedId =
    stored.selectedId !== null && ids.has(stored.selectedId)
      ? stored.selectedId
      : (workspaces[0]?.id ?? null);
  return { workspaces, selectedId };
}
