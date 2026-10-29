import { homedir } from 'node:os';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { droppedItems } from '../../panels/main/items';
import type { SessionHost } from '../../sessions/main/host';
import { dayFolder, makeDayFolder } from '../../sessions/main/folders';
import type { SessionsUi } from '../../sessions/main/native';
import type { Workspaces, WorkspacesUi } from '../../workspaces/main/workspaces';
import { channels } from '../shared/bridge';
import { isAppPage } from './links';

interface BridgeServices {
  workspaces: Workspaces;
  sessions: SessionHost;
  // The dialogs and menus the workspaces show, attached to the window that asked.
  workspacesUi: (window: BrowserWindow) => WorkspacesUi;
  // The confirmations the sessions ask for, attached to the window that asked.
  sessionsUi: (window: BrowserWindow) => SessionsUi;
  // The page the app's windows show.
  page: string;
}

const id = z.string().min(1).max(100);
const path = z.string().max(4096);
const provider = z.enum(['claude-code', 'codex', 'grok-build']);
const mode = z.enum(['auto', 'yolo']);
const sandbox = z.enum(['read-only', 'workspace-write', 'full-access']);
// A gateway's or a model's name, as the provider gave it.
const name = z.string().min(1).max(200);
const effort = z.string().min(1).max(50);
const message = z.string().min(1).max(200_000);
const startRequest = z
  .object({
    provider,
    cwd: path.startsWith('/'),
    mode,
    gateway: name.nullable(),
    model: name.nullable(),
    effort: effort.nullable(),
    sandbox,
    message,
  })
  .strict();

// Answers the preload bridge's calls and sends it what changes. Every call must come from the main
// frame of an app window showing the app's own page, and its values must have the shapes the call
// takes; anything else is refused.
export function serveBridge({
  workspaces,
  sessions,
  workspacesUi,
  sessionsUi,
  page,
}: BridgeServices): void {
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
  handle(channels.sessions.providers, z.tuple([]), () => sessions.providerIds());
  handle(channels.sessions.dayFolder, z.tuple([]), () => dayFolder(homedir(), new Date()));
  handle(channels.sessions.gateways, z.tuple([provider]), (_window, chosen) =>
    sessions.gateways(chosen),
  );
  handle(
    channels.sessions.models,
    z.tuple([provider, name.nullable()]),
    (_window, chosen, gateway) => sessions.models(chosen, gateway),
  );
  handle(channels.sessions.confirmYolo, z.tuple([]), (window) => sessionsUi(window).confirmYolo());
  // A page asks for yolo's confirmation when the user chooses it, before its session starts.
  handle(channels.sessions.start, z.tuple([startRequest]), async (_window, request) => {
    const { provider: chosen, message: first, gateway, model, effort: level, ...options } = request;
    await makeDayFolder(homedir(), options.cwd);
    const session = await sessions.start(chosen, {
      ...options,
      ...(gateway === null ? {} : { gateway }),
      ...(model === null ? {} : { model }),
      ...(level === null ? {} : { effort: level }),
    });
    await sessions.send(session, first);
    return session;
  });
  handle(channels.sessions.send, z.tuple([id, message]), (_window, session, text) =>
    sessions.send(session, text),
  );
  handle(channels.sessions.interrupt, z.tuple([id]), (_window, session) =>
    sessions.interrupt(session),
  );
  handle(channels.sessions.setMode, z.tuple([id, mode]), async (window, session, next) => {
    if (next === 'yolo' && !(await sessionsUi(window).confirmYolo())) return false;
    await sessions.setMode(session, next);
    return true;
  });
  handle(channels.sessions.setGateway, z.tuple([id, name.nullable()]), (_window, session, next) =>
    sessions.setGateway(session, next),
  );
  handle(channels.sessions.setModel, z.tuple([id, name.nullable()]), (_window, session, next) =>
    sessions.setModel(session, next),
  );
  handle(channels.sessions.setEffort, z.tuple([id, effort.nullable()]), (_window, session, next) =>
    sessions.setEffort(session, next),
  );
  handle(channels.sessions.setSandbox, z.tuple([id, sandbox]), (_window, session, next) =>
    sessions.setSandbox(session, next),
  );
  handle(channels.sessions.snapshot, z.tuple([id]), (_window, session) =>
    sessions.snapshot(session),
  );
  handle(channels.panels.itemsAt, z.tuple([z.array(path).max(100)]), (_window, paths) =>
    droppedItems(paths),
  );

  workspaces.onChange((list) => {
    broadcast(channels.workspaces.changed, list);
  });
  sessions.onChange((list) => {
    broadcast(channels.sessions.changed, list);
  });
  sessions.onEvent((session, seq, event) => {
    broadcast(channels.sessions.event, { id: session, seq, event });
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
