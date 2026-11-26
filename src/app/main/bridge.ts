import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';
import type { Accounts, AccountsUi } from '../../accounts/main/accounts';
import type { FileService } from '../../files/main/files';
import type { FilesUi } from '../../files/main/native';
import { MAX_EDITABLE_BYTES } from '../../files/shared/files';
import { droppedItems } from '../../panels/main/items';
import type { PresentationHost } from '../../panels/main/presentation-host';
import type { EmbeddedBrowser } from '../../browser/main/embedded';
import type { BrowserViewHost } from '../../browser/main/view-host';
import type { NativeComputer } from '../../computer/main/computer';
import type { ComputerBridge, ComputerCommand } from '../../computer/shared/computer';
import { presentationRendererSchema } from '../../panels/main/presentation-validation';
import type { RememberedChoices } from '../../sessions/main/choices';
import type { SessionHost } from '../../sessions/main/host';
import { dayFolder, makeDayFolder } from '../../sessions/main/folders';
import { copyImage, copyText, type SessionsUi } from '../../sessions/main/native';
import { MAX_IMAGE_BASE64, MAX_IMAGES, SENDABLE_IMAGE_TYPES } from '../../sessions/shared/images';
import type { Settings } from '../../settings/main/settings';
import type { AppSettings } from '../../settings/shared/settings';
import type { TerminalUi } from '../../terminal/main/native';
import type { TerminalViewer, Terminals } from '../../terminal/main/terminals';
import type { AutomationBridge } from '../../toolset/shared/automation';
import type { UserSetup } from './user-setup';
import { MAX_COLUMNS, MAX_ROWS } from '../../terminal/shared/terminal';
import type { Workspaces, WorkspacesUi } from '../../workspaces/main/workspaces';
import { channels } from '../shared/bridge';
import { isAppPage, isWebUrl } from './links';
import { answerPrompt } from './prompts';
import { AutomationSubscriptions } from './automation-ui';

interface BridgeServices {
  presentations: PresentationHost;
  browser: EmbeddedBrowser;
  browserViews: BrowserViewHost;
  computer: Pick<NativeComputer, 'preview'> & {
    command(
      owner: string,
      target: string,
      command: ComputerCommand,
    ): ReturnType<ComputerBridge['command']>;
  };
  automation: AutomationBridge;
  isAuxiliary?: (contents: WebContents) => boolean;
  setup: Pick<UserSetup, 'snapshot' | 'subscribe' | 'act'>;
  pickChromeFolder?: (window: BrowserWindow, directory: string) => Promise<string | undefined>;
  workspaces: Workspaces;
  sessions: SessionHost;
  // The settings each folder's sessions last used.
  choices: RememberedChoices;
  // The questions and menus the workspaces show, in the window that asked.
  workspacesUi: (window: BrowserWindow) => WorkspacesUi;
  // The confirmations and menus the sessions show, in the window that asked.
  sessionsUi: (window: BrowserWindow) => SessionsUi;
  // The files the editors read, write and watch.
  files: FileService;
  // The question the editors ask, attached to the window that asked.
  filesUi: (window: BrowserWindow) => FilesUi;
  // The app's settings, which the settings panel changes.
  settings: Settings;
  // The terminals the windows open, and the question they ask, in the window that asked.
  terminals: Terminals;
  terminalUi: (window: BrowserWindow) => TerminalUi;
  // The providers' sign-ins and usage limits, and the question they ask, in the window that asked.
  accounts: Accounts;
  accountsUi: (window: BrowserWindow) => AccountsUi;
  // The page the app's windows show.
  page: string;
}

const id = z.string().min(1).max(100);
const path = z.string().max(4096);
const provider = z.enum(['claude-code', 'codex-cli', 'grok-build', 'antigravity']);
const mode = z.enum(['auto', 'yolo']);
const sandbox = z.enum(['read-only', 'workspace-write', 'full-access']);
// A gateway's or a model's name, as the provider gave it.
const name = z.string().min(1).max(200);
const effort = z.string().min(1).max(50);
const text = z.string().max(200_000);
// A file's name, and the text an editor saves, which may have grown from what the editor opens.
const fileName = z.string().min(1).max(1024);
const fileText = z.string().max(2 * MAX_EDITABLE_BYTES);
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
// An image the user sends with a message, of a type and size every provider takes.
const sentImage = z
  .object({ mediaType: z.enum(SENDABLE_IMAGE_TYPES), data: base64.min(1).max(MAX_IMAGE_BASE64) })
  .strict();
const sentImages = z.array(sentImage).max(MAX_IMAGES);
// An image the timeline shows, which may have come from a provider, to save, or as a PNG to copy.
const shownImage = z
  .object({ mediaType: z.string().regex(/^image\/[\w.+-]+$/), data: base64.min(1).max(64_000_000) })
  .strict();
const pngImage = shownImage.extend({ mediaType: z.literal('image/png') });
// A message has text, images or both.
const hasContent = (message: string, images: unknown[]) =>
  message.trim() !== '' || images.length > 0;
const startRequest = z
  .object({
    provider,
    cwd: path.startsWith('/'),
    mode,
    gateway: name.nullable(),
    model: name.nullable(),
    effort: effort.nullable(),
    sandbox,
    message: text,
    images: sentImages,
  })
  .strict()
  .refine((request) => hasContent(request.message, request.images));
const resumeRequest = z
  .object({
    mode,
    gateway: name.nullable(),
    model: name.nullable(),
    effort: effort.nullable(),
    sandbox,
    message: text,
    images: sentImages,
  })
  .strict()
  .refine((request) => hasContent(request.message, request.images));
// An approval's or question's id, as the provider gave it.
const requestId = z.string().min(1).max(200);
const approvalAnswer = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow-once') }).strict(),
  z.object({ decision: z.literal('allow-for-session') }).strict(),
  z.object({ decision: z.literal('deny'), message: text.optional() }).strict(),
]);
// The answers by question id: the labels of the options chosen and any text typed, which a question
// that asks for a secret masks; it passes to the provider and is never logged.
const questionAnswer = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('answer'),
      answers: z.record(
        z.string().min(1).max(200),
        z
          .object({ selected: z.array(z.string().max(2_000)).max(100), text: text.optional() })
          .strict(),
      ),
    })
    .strict(),
  z.object({ decision: z.literal('decline') }).strict(),
]);
// What a session's menu does, and a search's query.
const sessionAction = z.enum(['archive', 'unarchive', 'remove']);
const searchQuery = z.string().max(1_000);
// A change to the settings: any of them, each one of its choices.
const settingsChange = z
  .object({
    language: z.enum(['system', 'en', 'zh-Hans']).optional(),
    appearance: z.enum(['system', 'light', 'dark']).optional(),
    tooltips: z.boolean().optional(),
    sidebarHidden: z.boolean().optional(),
  })
  .strict();
const choice = z
  .object({
    provider,
    gateway: name.nullable(),
    model: name.nullable(),
    effort: effort.nullable(),
    sandbox,
  })
  .strict();
// What the user types or pastes into a terminal, and a terminal's size in characters.
const typed = z.string().max(4_000_000);
const columns = z.number().int().min(1).max(MAX_COLUMNS);
const rows = z.number().int().min(1).max(MAX_ROWS);
const url = z.string().max(8_192);
// A step of browser or computer use's setup, which the user's own click asks for.
const chrome = z.literal('chrome');
const setupAction = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('connect-browser'),
      browser: chrome,
      profileId: id,
    })
    .strict(),
  z.strictObject({
    kind: z.literal('disconnect-browser'),
    browser: chrome,
    profileId: id,
  }),
  z
    .object({
      kind: z.literal('open-permission'),
      permission: z.enum(['accessibility', 'screen-recording', 'input-monitoring']),
    })
    .strict(),
  z
    .object({ kind: z.enum(['clear-app-sign-ins', 'restart-helper', 'allow-chrome-profiles']) })
    .strict(),
]);

const browserTab = z.strictObject({
  id: z.uuid(),
  generation: z.int().positive(),
  kind: z.literal('browser-tab'),
});
const browserCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigate'), url: z.string().max(4096) }),
  z.strictObject({
    kind: z.enum([
      'back',
      'forward',
      'reload',
      'stop-loading',
      'take-control',
      'hand-back',
      'open-external',
      'close',
    ]),
  }),
]);
const browserPlacement = z.strictObject({
  bounds: z
    .strictObject({
      x: z.number().min(-32768).max(32768),
      y: z.number().min(-32768).max(32768),
      width: z.number().positive().max(16384),
      height: z.number().positive().max(16384),
    })
    .nullable(),
  covered: z.boolean(),
  dim: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable(),
});

// Answers the preload bridge's calls and sends it what changes. Every call must come from the main
// frame of an app window showing the app's own page, and its values must have the shapes the call
// takes; anything else is refused.
export function serveBridge({
  presentations,
  browser,
  browserViews,
  computer,
  automation,
  isAuxiliary,
  setup,
  pickChromeFolder,
  workspaces,
  sessions,
  choices,
  workspacesUi,
  sessionsUi,
  files,
  filesUi,
  settings,
  terminals,
  terminalUi,
  accounts,
  accountsUi,
  page,
}: BridgeServices): void {
  function handle<Values extends unknown[]>(
    channel: string,
    values: z.ZodType<Values>,
    answer: (window: BrowserWindow, ...values: Values) => unknown,
  ): void {
    ipcMain.handle(channel, (event, ...given: unknown[]) => {
      if (isAuxiliary?.(event.sender)) throw Error('The bridge answers only the app’s own page.');
      return answer(callerWindow(event, page), ...values.parse(given));
    });
  }

  function broadcast(channel: string, value: unknown): void {
    for (const { webContents } of BrowserWindow.getAllWindows())
      if (!isAuxiliary?.(webContents)) webContents.send(channel, value);
  }

  const subscriptions = new AutomationSubscriptions(automation);
  const automationWindows = new Set<number>();
  handle(channels.automation.snapshot, z.tuple([id]), (_window, session) =>
    automation.snapshot(session),
  );
  handle(channels.automation.capabilities, z.tuple([id]), (_window, session) =>
    automation.capabilities(session),
  );
  handle(channels.automation.callRecord, z.tuple([id, id]), (_window, session, call) =>
    automation.callRecord(session, call),
  );
  handle(channels.automation.callFrames, z.tuple([id, id]), (_window, session, call) =>
    automation.callFrames(session, call),
  );
  handle(channels.automation.icon, z.tuple([id, id]), (_window, session, icon) =>
    automation.icon(session, icon),
  );
  handle(
    channels.automation.answer,
    z.tuple([id, id, approvalAnswer]),
    (_window, session, request, answer) => automation.answer(session, request, answer),
  );
  handle(channels.automation.stop, z.tuple([id]), (_window, session) => automation.stop(session));
  handle(channels.automation.endOperation, z.tuple([id, id]), (_window, session, operation) =>
    automation.endOperation(session, operation),
  );
  handle(channels.automation.endGrant, z.tuple([id, id]), (_window, session, grant) =>
    automation.endGrant(session, grant),
  );
  handle(channels.automation.subscribe, z.tuple([id, id]), (window, session, subscriptionId) => {
    const contents = window.webContents;
    subscriptions.add(contents.id, subscriptionId, session, (event) => {
      if (!contents.isDestroyed())
        contents.send(channels.automation.event, { subscriptionId, event });
    });
    if (!automationWindows.has(contents.id)) {
      automationWindows.add(contents.id);
      const lost = () => {
        subscriptions.release(contents.id);
      };
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) lost();
      });
      contents.on('render-process-gone', lost);
      contents.once('destroyed', () => {
        lost();
        automationWindows.delete(contents.id);
      });
    }
  });
  handle(channels.automation.unsubscribe, z.tuple([id]), (window, subscriptionId) => {
    subscriptions.remove(window.webContents.id, subscriptionId);
  });

  let presentationWindow: WebContents | undefined;
  const presentationWindows = new Set<number>();
  const browserPages = new Map<number, Map<string, () => void>>();
  function browserPage(contents: WebContents): Map<string, () => void> {
    const pageId = contents.id;
    const known = browserPages.get(pageId);
    if (known) return known;
    const stops = new Map<string, () => void>();
    const lost = () => {
      for (const stop of stops.values()) stop();
      stops.clear();
      browserViews.disconnect(pageId);
    };
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) lost();
    });
    contents.on('render-process-gone', lost);
    contents.once('destroyed', () => {
      browserPages.delete(pageId);
      lost();
    });
    browserPages.set(pageId, stops);
    return stops;
  }
  handle(channels.browser.tabRef, z.tuple([id, z.uuid()]), (_window, owner, tab) =>
    browser.tabRef(owner, tab),
  );
  handle(channels.browser.snapshot, z.tuple([id, browserTab]), (_window, owner, tab) =>
    browser.snapshot(owner, tab),
  );
  handle(
    channels.browser.command,
    z.tuple([id, browserTab, browserCommand]),
    (_window, owner, tab, command) => browser.command(owner, tab, command),
  );
  handle(
    channels.browser.subscribe,
    z.tuple([id, browserTab, z.uuid()]),
    (window, owner, tab, subscription) => {
      const contents = window.webContents;
      const stops = browserPage(contents);
      if (stops.has(subscription) || stops.size >= 128)
        throw new Error('Browser subscription unavailable.');
      stops.set(
        subscription,
        browser.subscribe(owner, tab, (state) => {
          if (!contents.isDestroyed())
            contents.send(channels.browser.state, { subscription, state });
        }),
      );
    },
  );
  handle(channels.browser.unsubscribe, z.tuple([z.uuid()]), (window, subscription) => {
    const stops = browserPages.get(window.webContents.id);
    stops?.get(subscription)?.();
    stops?.delete(subscription);
  });
  handle(
    channels.browser.bind,
    z.tuple([id, id, browserTab]),
    (window, owner, presentation, tab) => {
      const contents = window.webContents;
      if (contents !== presentationWindow)
        return { status: 'refused', code: 'not-found', dispatched: false };
      browserPage(contents);
      return browserViews.bind(
        window,
        owner,
        presentation,
        tab,
        (binding) => {
          if (!contents.isDestroyed()) contents.send(channels.browser.focus, binding);
        },
        (binding) => {
          if (!contents.isDestroyed()) contents.send(channels.browser.fileDrag, binding);
        },
      );
    },
  );
  handle(
    channels.browser.place,
    z.tuple([z.uuid(), z.int().positive(), browserPlacement]),
    (window, binding, revision, placement) =>
      browserViews.place(window, binding, revision, placement),
  );
  handle(channels.browser.release, z.tuple([z.uuid()]), (window, binding) => {
    browserViews.release(window.webContents.id, binding);
  });
  const showsComputer = (
    contents: WebContents,
    owner: string,
    presentation: string,
    target: string,
  ) => contents === presentationWindow && presentations.showsComputer(owner, presentation, target);
  handle(
    channels.computer.preview,
    z.tuple([id, id, z.uuid()]),
    async (window, owner, presentation, target) => {
      const contents = window.webContents;
      const allowed = () => showsComputer(contents, owner, presentation, target);
      if (allowed()) {
        const result = await computer.preview(owner, target);
        if (allowed()) return result;
      }
      return { status: 'refused', code: 'not-found', dispatched: false };
    },
  );
  handle(
    channels.computer.command,
    z.tuple([id, id, z.uuid(), z.enum(['reveal', 'take-over', 'hand-back'])]),
    (window, owner, presentation, target, command) =>
      showsComputer(window.webContents, owner, presentation, target)
        ? computer.command(owner, target, command)
        : { status: 'refused', code: 'not-found', dispatched: false },
  );

  handle(
    channels.presentations.report,
    z.tuple([presentationRendererSchema]),
    (window, message) => {
      const contents = window.webContents;
      if (presentationWindow && presentationWindow !== contents) return false;
      if (!presentationWindow) {
        if (message.kind !== 'snapshot') return false;
        presentationWindow = contents;
        presentations.connect((command) => {
          if (!contents.isDestroyed()) contents.send(channels.presentations.message, command);
        });
      }
      if (!presentationWindows.has(contents.id)) {
        presentationWindows.add(contents.id);
        const lost = () => {
          if (presentationWindow === contents) {
            presentationWindow = undefined;
            presentations.disconnect();
          }
        };
        contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) lost();
        });
        contents.on('render-process-gone', lost);
        contents.once('destroyed', () => {
          presentationWindows.delete(contents.id);
          lost();
        });
      }
      const applied = presentations.receive(message);
      if (applied) browserViews.reconcile(contents.id);
      return applied;
    },
  );
  handle(channels.presentations.artifact, z.tuple([path.min(1)]), (window, id) =>
    window.webContents === presentationWindow ? presentations.artifact(id) : null,
  );

  handle(channels.workspaces.get, z.tuple([]), () => workspaces.list());
  handle(channels.workspaces.add, z.tuple([]), (window) => workspaces.add(workspacesUi(window)));
  handle(channels.workspaces.addDropped, z.tuple([z.array(path).max(100)]), (window, paths) =>
    workspaces.addFolders(paths, workspacesUi(window)),
  );
  handle(channels.workspaces.select, z.tuple([id]), (_window, workspace) => {
    workspaces.select(workspace);
  });
  handle(channels.workspaces.showMenu, z.tuple([id, path]), (window, workspace, folder) =>
    workspaces.showMenu(workspace, folder, workspacesUi(window)),
  );
  handle(channels.workspaces.listFolder, z.tuple([id, path]), (_window, workspace, folder) =>
    workspaces.listFolder(workspace, folder),
  );
  handle(channels.sessions.list, z.tuple([]), () => sessions.list());
  handle(channels.sessions.archived, z.tuple([]), () => sessions.archived());
  // A page asks for yolo's confirmation when the user chooses it for a session that is not running;
  // one that ran in yolo before resumes in it, as the user chose it then (ADR-0006).
  handle(
    channels.sessions.resume,
    z.tuple([id, resumeRequest]),
    async (_window, session, request) => {
      const { message, images, ...settings } = request;
      await sessions.resume(session, settings);
      await sessions.send(session, message, images);
    },
  );
  handle(channels.sessions.showMenu, z.tuple([id]), (window, session) =>
    sessions.showMenu(session, sessionsUi(window)),
  );
  handle(channels.sessions.act, z.tuple([id, sessionAction]), (window, session, action) =>
    sessions.act(session, action, sessionsUi(window)),
  );
  handle(
    channels.sessions.search,
    z.tuple([searchQuery, z.boolean()]),
    (_window, query, archived) => sessions.search(query, archived),
  );
  handle(channels.sessions.providers, z.tuple([]), () => sessions.providerIds());
  handle(channels.sessions.dayFolder, z.tuple([]), () => dayFolder(homedir(), new Date()));
  handle(channels.sessions.gateways, z.tuple([provider]), (_window, chosen) =>
    sessions.gateways(chosen),
  );
  handle(
    channels.sessions.models,
    z.tuple([provider, name.nullable(), path.startsWith('/').nullable(), z.boolean()]),
    (_window, chosen, gateway, folder, fresh) => sessions.models(chosen, gateway, folder, fresh),
  );
  handle(channels.sessions.choices, z.tuple([]), () => choices.all(sessions.providerIds()));
  handle(
    channels.sessions.rememberChoice,
    z.tuple([path.startsWith('/'), choice]),
    (_window, folder, remembered) => {
      choices.remember(folder, remembered);
    },
  );
  handle(channels.sessions.confirmYolo, z.tuple([]), (window) => sessionsUi(window).confirmYolo());
  handle(channels.sessions.copyText, z.tuple([text]), (_window, value) => copyText(value));
  handle(channels.sessions.copyImage, z.tuple([pngImage]), (_window, image) => copyImage(image));
  handle(channels.sessions.saveImage, z.tuple([shownImage]), (window, image) =>
    sessionsUi(window).saveImage(image),
  );
  handle(channels.sessions.imageMenu, z.tuple([]), (window) => sessionsUi(window).imageMenu());
  // A page asks for yolo's confirmation when the user chooses it, before its session starts.
  handle(channels.sessions.start, z.tuple([startRequest]), async (_window, request) => {
    const {
      provider: chosen,
      message: first,
      images: attached,
      gateway,
      model,
      effort: level,
      ...options
    } = request;
    await makeDayFolder(homedir(), options.cwd);
    return sessions.start(
      chosen,
      {
        ...options,
        ...(gateway === null ? {} : { gateway }),
        ...(model === null ? {} : { model }),
        ...(level === null ? {} : { effort: level }),
      },
      { text: first, images: attached },
    );
  });
  handle(
    channels.sessions.send,
    z.tuple([id, text, sentImages]).refine(([, message, images]) => hasContent(message, images)),
    (_window, session, message, images) => sessions.send(session, message, images),
  );
  handle(
    channels.approvals.answerApproval,
    z.tuple([id, requestId, approvalAnswer]),
    (_window, session, request, answer) => sessions.answerApproval(session, request, answer),
  );
  handle(
    channels.approvals.answerQuestion,
    z.tuple([id, requestId, questionAnswer]),
    (_window, session, request, answer) => sessions.answerQuestion(session, request, answer),
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
  handle(channels.sessions.preload, z.tuple([id]), (_window, session) => {
    sessions.preload(session);
  });
  handle(channels.panels.itemsAt, z.tuple([z.array(path).max(100)]), async (_window, paths) => {
    const items = await droppedItems(paths);
    files.grant(items.filter((item) => item.kind === 'file').map((item) => item.path));
    return items;
  });
  handle(channels.files.open, z.tuple([path]), (_window, file) => files.open(file));
  handle(channels.files.save, z.tuple([path, fileText]), (_window, file, content) =>
    files.save(file, content),
  );
  // A window's files are watched until it lists others, or until it goes.
  const watching = new Set<number>();
  handle(channels.files.watch, z.tuple([z.array(path).max(500)]), (window, paths) => {
    const contents = window.webContents;
    const id = contents.id;
    if (!watching.has(id)) {
      watching.add(id);
      contents.once('destroyed', () => {
        watching.delete(id);
        files.forget(id);
      });
    }
    files.watch(id, paths);
  });
  handle(channels.files.confirmClose, z.tuple([fileName]), (window, file) =>
    filesUi(window).confirmClose(file),
  );
  handle(channels.files.image, z.tuple([path]), (_window, file) => files.image(file));
  handle(channels.setup.snapshot, z.tuple([]), () => setup.snapshot());
  handle(channels.setup.act, z.tuple([setupAction]), (window, action) =>
    action.kind === 'allow-chrome-profiles' && pickChromeFolder
      ? setup.act(action, (directory) => pickChromeFolder(window, directory))
      : setup.act(action),
  );
  handle(channels.settings.get, z.tuple([]), () => settings.get());
  handle(channels.settings.set, z.tuple([settingsChange]), (_window, given) => {
    const change: Partial<AppSettings> = {};
    if (given.language !== undefined) change.language = given.language;
    if (given.appearance !== undefined) change.appearance = given.appearance;
    if (given.tooltips !== undefined) change.tooltips = given.tooltips;
    if (given.sidebarHidden !== undefined) change.sidebarHidden = given.sidebarHidden;
    settings.set(change);
  });
  // The page's answer to a menu or question it was asked to draw.
  // Each window's terminals print to it alone, and end as it goes or loads its page anew; nothing of
  // what passes through is kept or logged (ADR-0016).
  const viewers = new Map<number, TerminalViewer>();
  const viewerOf = (window: BrowserWindow): TerminalViewer => {
    const contents = window.webContents;
    let viewer = viewers.get(contents.id);
    if (viewer === undefined) {
      viewer = windowViewer(contents);
      viewers.set(contents.id, viewer);
      const id = contents.id;
      const end = () => {
        terminals.closeViewer(id);
        accounts.setShown(id, false);
      };
      contents.once('destroyed', () => {
        viewers.delete(id);
        end();
      });
      contents.on('did-navigate', end);
    }
    return viewer;
  };
  handle(channels.terminal.open, z.tuple([path.startsWith('/').nullable()]), async (window, cwd) =>
    terminals.open(viewerOf(window), cwd !== null && (await isFolder(cwd)) ? cwd : null),
  );
  handle(channels.terminal.write, z.tuple([id, typed]), (window, terminal, data) => {
    terminals.write(viewerOf(window), terminal, data);
  });
  handle(channels.terminal.resize, z.tuple([id, columns, rows]), (window, terminal, wide, high) => {
    terminals.resize(viewerOf(window), terminal, wide, high);
  });
  // A terminal already gone closes at once.
  handle(channels.terminal.confirmClose, z.tuple([id]), (window, terminal) => {
    let program: string | null;
    try {
      program = terminals.busy(viewerOf(window), terminal);
    } catch {
      return true;
    }
    return program === null ? true : terminalUi(window).confirmEnd(program);
  });
  handle(channels.terminal.close, z.tuple([id]), (window, terminal) => {
    terminals.close(viewerOf(window), terminal);
  });
  handle(channels.terminal.openLink, z.tuple([url]), async (_window, link) => {
    if (isWebUrl(link)) await shell.openExternal(link);
  });
  handle(channels.accounts.list, z.tuple([]), () => accounts.list());
  handle(channels.accounts.setShown, z.tuple([z.boolean()]), (window, shown) => {
    viewerOf(window);
    accounts.setShown(window.webContents.id, shown);
  });
  // The provider's own sign-in command in a terminal of its own, after which the app reads the
  // sign-in again.
  handle(channels.accounts.signIn, z.tuple([provider]), async (window, chosen) => {
    const program = await accounts.signInCommand(chosen);
    const terminal = terminals.open(viewerOf(window), null, program);
    terminals.ended(terminal.id).then(
      () => accounts.readAgain(chosen),
      () => undefined,
    );
    return { id: terminal.id, cwd: terminal.cwd };
  });
  handle(channels.accounts.reset, z.tuple([provider]), (window, chosen) =>
    accounts.reset(chosen, accountsUi(window)),
  );
  handle(
    channels.prompts.answer,
    z.tuple([z.number().int().positive(), id.nullable()]),
    (window, prompt, answer) => {
      answerPrompt(window.webContents, prompt, answer);
    },
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
  files.onChange((file) => {
    broadcast(channels.files.changed, file);
  });
  settings.onChange((current) => {
    broadcast(channels.settings.changed, current);
  });
  setup.subscribe((snapshot) => {
    broadcast(channels.setup.changed, snapshot);
  });
  accounts.onChange((list) => {
    broadcast(channels.accounts.changed, list);
  });
}

// The window a terminal prints to, while it is there.
function windowViewer(contents: WebContents): TerminalViewer {
  return {
    id: contents.id,
    output(terminal, data) {
      if (!contents.isDestroyed()) contents.send(channels.terminal.output, { id: terminal, data });
    },
    exit(terminal, code) {
      if (!contents.isDestroyed()) contents.send(channels.terminal.exit, { id: terminal, code });
    },
  };
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// The window a call came from, provided the call came from its main frame showing the app's page.
function callerWindow(event: IpcMainInvokeEvent, page: string): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  // A frame without a parent is the page's main frame.
  const frame = event.senderFrame;
  if (
    window === null ||
    frame !== event.sender.mainFrame ||
    frame.parent !== null ||
    !isAppPage(frame.url, page)
  ) {
    throw new Error('The bridge answers only the app’s own page.');
  }
  return window;
}
