import { homedir } from 'node:os';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { FileService } from '../../files/main/files';
import type { FilesUi } from '../../files/main/native';
import { MAX_EDITABLE_BYTES } from '../../files/shared/files';
import { droppedItems } from '../../panels/main/items';
import type { RememberedChoices } from '../../sessions/main/choices';
import type { SessionHost } from '../../sessions/main/host';
import { dayFolder, makeDayFolder } from '../../sessions/main/folders';
import { copyImage, copyText, type SessionsUi } from '../../sessions/main/native';
import { MAX_IMAGE_BASE64, MAX_IMAGES, SENDABLE_IMAGE_TYPES } from '../../sessions/shared/images';
import type { Workspaces, WorkspacesUi } from '../../workspaces/main/workspaces';
import { channels } from '../shared/bridge';
import { isAppPage } from './links';
import { answerPrompt } from './prompts';

interface BridgeServices {
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
const choice = z
  .object({
    provider,
    gateway: name.nullable(),
    model: name.nullable(),
    effort: effort.nullable(),
    sandbox,
  })
  .strict();

// Answers the preload bridge's calls and sends it what changes. Every call must come from the main
// frame of an app window showing the app's own page, and its values must have the shapes the call
// takes; anything else is refused.
export function serveBridge({
  workspaces,
  sessions,
  choices,
  workspacesUi,
  sessionsUi,
  files,
  filesUi,
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
    const session = await sessions.start(chosen, {
      ...options,
      ...(gateway === null ? {} : { gateway }),
      ...(model === null ? {} : { model }),
      ...(level === null ? {} : { effort: level }),
    });
    await sessions.send(session, first, attached);
    return session;
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
  // The page's answer to a menu or question it was asked to draw.
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
