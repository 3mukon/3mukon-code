import type { CloseAnswer, OpenedFile, SaveResult } from '../../files/shared/files';
import type { DroppedItem } from '../../panels/shared/panels';
import type { ModelOption, ProviderId, SessionEvent } from '../../sessions/shared/events';
import type {
  FolderChoices,
  ImageAction,
  SessionSnapshot,
  SessionSummary,
} from '../../sessions/shared/sessions';
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
      providers: () => invoke(channels.sessions.providers) as Promise<ProviderId[]>,
      dayFolder: () => invoke(channels.sessions.dayFolder) as Promise<string>,
      gateways: (provider) => invoke(channels.sessions.gateways, provider) as Promise<string[]>,
      models: (provider, gateway) =>
        invoke(channels.sessions.models, provider, gateway) as Promise<ModelOption[]>,
      choices: () => invoke(channels.sessions.choices) as Promise<FolderChoices>,
      rememberChoice: (folder, choice) =>
        invoke(channels.sessions.rememberChoice, folder, choice) as Promise<void>,
      confirmYolo: () => invoke(channels.sessions.confirmYolo) as Promise<boolean>,
      start: (request) => invoke(channels.sessions.start, request) as Promise<string>,
      send: (id, text, images) => invoke(channels.sessions.send, id, text, images) as Promise<void>,
      interrupt: (id) => invoke(channels.sessions.interrupt, id) as Promise<void>,
      setMode: (id, mode) => invoke(channels.sessions.setMode, id, mode) as Promise<boolean>,
      setGateway: (id, gateway) =>
        invoke(channels.sessions.setGateway, id, gateway) as Promise<void>,
      setModel: (id, model) => invoke(channels.sessions.setModel, id, model) as Promise<void>,
      setEffort: (id, effort) => invoke(channels.sessions.setEffort, id, effort) as Promise<void>,
      setSandbox: (id, sandbox) =>
        invoke(channels.sessions.setSandbox, id, sandbox) as Promise<void>,
      snapshot: (id) => invoke(channels.sessions.snapshot, id) as Promise<SessionSnapshot | null>,
      onEvent: (listener) =>
        subscribe(channels.sessions.event, (value) => {
          const { id, seq, event } = value as { id: string; seq: number; event: SessionEvent };
          listener(id, seq, event);
        }),
      copyText: (text) => invoke(channels.sessions.copyText, text) as Promise<void>,
      copyImage: (image) => invoke(channels.sessions.copyImage, image) as Promise<void>,
      saveImage: (image) => invoke(channels.sessions.saveImage, image) as Promise<boolean>,
      imageMenu: () => invoke(channels.sessions.imageMenu) as Promise<ImageAction | null>,
    },
    panels: {
      itemsAt: (items) =>
        invoke(
          channels.panels.itemsAt,
          items.map((item) => pathForFile(item)),
        ) as Promise<DroppedItem[]>,
    },
    files: {
      open: (path) => invoke(channels.files.open, path) as Promise<OpenedFile>,
      save: (path, text) => invoke(channels.files.save, path, text) as Promise<SaveResult>,
      watch: (paths) => invoke(channels.files.watch, paths) as Promise<void>,
      onChange: (listener) =>
        subscribe(channels.files.changed, (value) => {
          listener(value as string);
        }),
      confirmClose: (name) => invoke(channels.files.confirmClose, name) as Promise<CloseAnswer>,
    },
    approvals: {
      answerApproval: (sessionId, requestId, answer) =>
        invoke(channels.approvals.answerApproval, sessionId, requestId, answer) as Promise<void>,
      answerQuestion: (sessionId, requestId, answer) =>
        invoke(channels.approvals.answerQuestion, sessionId, requestId, answer) as Promise<void>,
    },
  };
}
