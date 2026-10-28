import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { droppedItems } from '../../panels/main/items';
import type { SessionHost } from '../../sessions/main/host';
import type { Workspaces, WorkspacesUi } from '../../workspaces/main/workspaces';
import { channels } from '../shared/bridge';
import { isAppPage } from './links';

interface BridgeServices {
  workspaces: Workspaces;
  sessions: SessionHost;
  // The dialogs and menus the workspaces show, attached to the window that asked.
  workspacesUi: (window: BrowserWindow) => WorkspacesUi;
  // The page the app's windows show.
  page: string;
}

const id = z.string().min(1).max(100);
const path = z.string().max(4096);

// Answers the preload bridge's calls and sends it what changes. Every call must come from the main
// frame of an app window showing the app's own page, and its values must have the shapes the call
// takes; anything else is refused.
export function serveBridge({ workspaces, sessions, workspacesUi, page }: BridgeServices): void {
  function handle<Values extends unknown[]>(
    channel: string,
    values: z.ZodType<Values>,
    answer: (window: BrowserWindow, ...values: Values) => unknown,
  ): void {
    ipcMain.handle(channel, (event, ...given: unknown[]) =>
      answer(callerWindow(event, page), ...values.parse(given)),
    );
  }

  handle(channels.workspaces.get, z.tuple([]), () => workspaces.list());
  handle(channels.workspaces.add, z.tuple([]), (window) => workspaces.add(workspacesUi(window)));
  handle(channels.workspaces.addDropped, z.tuple([z.array(path).max(100)]), (window, paths) =>
    workspaces.addFolders(paths, workspacesUi(window)),
  );
  handle(channels.workspaces.select, z.tuple([id]), (_window, workspace) => {
    workspaces.select(workspace);
  });
  handle(channels.workspaces.showMenu, z.tuple([id]), (window, workspace) => {
    workspaces.showMenu(workspace, workspacesUi(window));
  });
  handle(channels.workspaces.listFolder, z.tuple([id, path]), (_window, workspace, folder) =>
    workspaces.listFolder(workspace, folder),
  );
  handle(channels.sessions.list, z.tuple([]), () => sessions.list());
  handle(channels.panels.itemsAt, z.tuple([z.array(path).max(100)]), (_window, paths) =>
    droppedItems(paths),
  );

  workspaces.onChange((list) => {
    broadcast(channels.workspaces.changed, list);
  });
  sessions.onChange((list) => {
    broadcast(channels.sessions.changed, list);
  });
}

// The window a call came from, provided the call came from its main frame showing the app's page.
function callerWindow(event: IpcMainInvokeEvent, page: string): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  // A frame without a parent is the page's main frame.
  const frame = event.senderFrame;
  if (window === null || frame?.parent !== null || !isAppPage(frame.url, page)) {
    throw new Error('The bridge answers only the app’s own page.');
  }
  return window;
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value);
}
