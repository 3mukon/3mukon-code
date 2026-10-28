import type { DroppedItem } from '../../panels/shared/panels';
import type { SessionSummary } from '../../sessions/shared/sessions';
import type { FolderListing, WorkspaceList } from '../../workspaces/shared/workspaces';
import { channels, type Bridge } from '../shared/bridge';

type Listener = (event: unknown, ...values: unknown[]) => void;

// The part of Electron's ipcRenderer the bridge uses, so that tests can stand in for it.
export interface Ipc {
  invoke(channel: string, ...values: unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
}

// The bridge the page gets: a function for each call the main process answers, and subscriptions to
// what it reports. The page never holds Electron's own objects, and a dropped item reaches the main
// process only as the path of a file the page was given, never as a path the page names.
export function createBridge(ipc: Ipc, pathForFile: (file: File) => string): Bridge {
  // What the main process answers and reports has the shape the call's interface gives.
  const invoke = (channel: string, ...values: unknown[]) => ipc.invoke(channel, ...values);
  function subscribe(channel: string, listener: (value: unknown) => void): () => void {
    // The page hears what was reported, without Electron's event.
    const handler: Listener = (_event, value) => {
      listener(value);
    };
    ipc.on(channel, handler);
    return () => {
      ipc.removeListener(channel, handler);
    };
  }
  return {
    workspaces: {
      get: () => invoke(channels.workspaces.get) as Promise<WorkspaceList>,
      onChange: (listener) =>
        subscribe(channels.workspaces.changed, (value) => {
          listener(value as WorkspaceList);
        }),
      add: () => invoke(channels.workspaces.add) as Promise<void>,
      addDropped: (items) =>
        invoke(
          channels.workspaces.addDropped,
          items.map((item) => pathForFile(item)),
        ) as Promise<void>,
      select: (id) => invoke(channels.workspaces.select, id) as Promise<void>,
      showMenu: (id) => invoke(channels.workspaces.showMenu, id) as Promise<void>,
      listFolder: (id, path) =>
        invoke(channels.workspaces.listFolder, id, path) as Promise<FolderListing>,
    },
    sessions: {
      list: () => invoke(channels.sessions.list) as Promise<SessionSummary[]>,
      onChange: (listener) =>
        subscribe(channels.sessions.changed, (value) => {
          listener(value as SessionSummary[]);
        }),
    },
    panels: {
      itemsAt: (items) =>
        invoke(
          channels.panels.itemsAt,
          items.map((item) => pathForFile(item)),
        ) as Promise<DroppedItem[]>,
    },
  };
}
