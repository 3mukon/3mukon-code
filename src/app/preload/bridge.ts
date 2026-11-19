import type { AccountsList, ResetOutcome } from '../../accounts/shared/accounts';
import type { CloseAnswer, FileImage, OpenedFile, SaveResult } from '../../files/shared/files';
import type { DroppedItem } from '../../panels/shared/panels';
import type { ModelOption, ProviderId, SessionEvent } from '../../sessions/shared/events';
import type {
  FolderChoices,
  ImageAction,
  SessionAction,
  SessionList,
  SessionSearch,
  SessionSnapshot,
  SessionSummary,
} from '../../sessions/shared/sessions';
import type { AppSettings } from '../../settings/shared/settings';
import type { TerminalInfo } from '../../terminal/shared/terminal';
import type { Prompt } from '../../ui/shared/prompts';
import type {
  FolderListing,
  WorkspaceList,
  WorkspaceMenuChoice,
} from '../../workspaces/shared/workspaces';
import { channels, type Bridge } from '../shared/bridge';
import type { Artifact, PresentationHostMessage } from '../../panels/shared/presentation';
import type { AutomationBridge } from '../../toolset/shared/automation';
import type { AutomationEvent, Envelope } from '../../sessions/shared/automation';

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
export function createBridge(
  ipc: Ipc,
  pathForFile: (file: File) => string,
  initialSettings: AppSettings,
): Bridge {
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
    automation: {
      snapshot: (id) =>
        invoke(channels.automation.snapshot, id) as ReturnType<AutomationBridge['snapshot']>,
      capabilities: (id) =>
        invoke(channels.automation.capabilities, id) as ReturnType<
          AutomationBridge['capabilities']
        >,
      callRecord: (id, call) =>
        invoke(channels.automation.callRecord, id, call) as ReturnType<
          AutomationBridge['callRecord']
        >,
      callFrames: (id, call) =>
        invoke(channels.automation.callFrames, id, call) as ReturnType<
          AutomationBridge['callFrames']
        >,
      icon: (id, icon) =>
        invoke(channels.automation.icon, id, icon) as ReturnType<AutomationBridge['icon']>,
      answer: (id, request, answer) =>
        invoke(channels.automation.answer, id, request, answer) as ReturnType<
          AutomationBridge['answer']
        >,
      stop: (id) => invoke(channels.automation.stop, id) as ReturnType<AutomationBridge['stop']>,
      endOperation: (id, operation) =>
        invoke(channels.automation.endOperation, id, operation) as ReturnType<
          AutomationBridge['endOperation']
        >,
      endGrant: (id, grant) =>
        invoke(channels.automation.endGrant, id, grant) as ReturnType<AutomationBridge['endGrant']>,
      subscribe(id, listener) {
        const subscriptionId = globalThis.crypto.randomUUID();
        let stopped = false;
        const detach = subscribe(channels.automation.event, (value) => {
          const message = value as { subscriptionId: string; event: Envelope<AutomationEvent> };
          if (message.subscriptionId === subscriptionId && message.event.sessionId === id)
            listener(message.event);
        });
        const ready = invoke(channels.automation.subscribe, id, subscriptionId);
        void ready.catch(detach);
        return () => {
          if (stopped) return;
          stopped = true;
          detach();
          // A StrictMode cleanup may precede the main process accepting the subscription.
          void ready
            .then(() => invoke(channels.automation.unsubscribe, subscriptionId))
            .catch(() => undefined);
        };
      },
    },
    presentations: {
      onMessage: (listener) =>
        subscribe(channels.presentations.message, (value) => {
          listener(value as PresentationHostMessage);
        }),
      send: (message) => {
        void invoke(channels.presentations.report, message).catch(() => undefined);
      },
      artifact: (id) => invoke(channels.presentations.artifact, id) as Promise<Artifact | null>,
    },
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
      showMenu: (id, path) =>
        invoke(channels.workspaces.showMenu, id, path) as Promise<WorkspaceMenuChoice | null>,
      listFolder: (id, path) =>
        invoke(channels.workspaces.listFolder, id, path) as Promise<FolderListing>,
    },
    sessions: {
      list: () => invoke(channels.sessions.list) as Promise<SessionList>,
      onChange: (listener) =>
        subscribe(channels.sessions.changed, (value) => {
          listener(value as SessionList);
        }),
      archived: () => invoke(channels.sessions.archived) as Promise<SessionSummary[]>,
      resume: (id, request) => invoke(channels.sessions.resume, id, request) as Promise<void>,
      showMenu: (id) => invoke(channels.sessions.showMenu, id) as Promise<SessionAction | null>,
      act: (id, action) =>
        invoke(channels.sessions.act, id, action) as Promise<SessionAction | null>,
      search: (query, archived) =>
        invoke(channels.sessions.search, query, archived) as Promise<SessionSearch>,
      providers: () => invoke(channels.sessions.providers) as Promise<ProviderId[]>,
      dayFolder: () => invoke(channels.sessions.dayFolder) as Promise<string>,
      gateways: (provider) => invoke(channels.sessions.gateways, provider) as Promise<string[]>,
      models: (provider, gateway, folder, fresh) =>
        invoke(channels.sessions.models, provider, gateway, folder, fresh) as Promise<
          ModelOption[]
        >,
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
      preload: (id) => invoke(channels.sessions.preload, id) as Promise<void>,
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
      image: (path) => invoke(channels.files.image, path) as Promise<FileImage | null>,
    },
    approvals: {
      answerApproval: (sessionId, requestId, answer) =>
        invoke(channels.approvals.answerApproval, sessionId, requestId, answer) as Promise<void>,
      answerQuestion: (sessionId, requestId, answer) =>
        invoke(channels.approvals.answerQuestion, sessionId, requestId, answer) as Promise<void>,
    },
    settings: {
      initial: initialSettings,
      get: () => invoke(channels.settings.get) as Promise<AppSettings>,
      set: (change) => invoke(channels.settings.set, change) as Promise<void>,
      onChange: (listener) =>
        subscribe(channels.settings.changed, (value) => {
          listener(value as AppSettings);
        }),
    },
    terminal: {
      open: (cwd) => invoke(channels.terminal.open, cwd) as Promise<TerminalInfo>,
      write: (id, data) => invoke(channels.terminal.write, id, data) as Promise<void>,
      resize: (id, columns, rows) =>
        invoke(channels.terminal.resize, id, columns, rows) as Promise<void>,
      onOutput: (listener) =>
        subscribe(channels.terminal.output, (value) => {
          const { id, data } = value as { id: string; data: string };
          listener(id, data);
        }),
      onExit: (listener) =>
        subscribe(channels.terminal.exit, (value) => {
          const { id, code } = value as { id: string; code: number };
          listener(id, code);
        }),
      confirmClose: (id) => invoke(channels.terminal.confirmClose, id) as Promise<boolean>,
      close: (id) => invoke(channels.terminal.close, id) as Promise<void>,
      openLink: (url) => invoke(channels.terminal.openLink, url) as Promise<void>,
    },
    accounts: {
      list: () => invoke(channels.accounts.list) as Promise<AccountsList>,
      onChange: (listener) =>
        subscribe(channels.accounts.changed, (value) => {
          listener(value as AccountsList);
        }),
      setShown: (shown) => invoke(channels.accounts.setShown, shown) as Promise<void>,
      signIn: (provider) =>
        invoke(channels.accounts.signIn, provider) as Promise<{ id: string; cwd: string }>,
      reset: (provider) =>
        invoke(channels.accounts.reset, provider) as Promise<ResetOutcome | null>,
    },
    prompts: {
      onPrompt: (listener) =>
        subscribe(channels.prompts.show, (value) => {
          const { id, prompt } = value as { id: number; prompt: Prompt };
          listener(id, prompt);
        }),
      answer: (id, answer) => invoke(channels.prompts.answer, id, answer) as Promise<void>,
    },
  };
}
