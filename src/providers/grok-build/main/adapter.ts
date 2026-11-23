import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  client,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionRequest,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk';
import {
  Probes,
  toolsetError,
  type Provider,
  type ProviderSession,
  type SessionEventListener,
  type StartOptions,
  type TitleRequest,
  type Toolset,
  type ToolsetAccess,
  type HostTurnContext,
  type HostContextDelivery,
} from '../../../sessions/main/provider';
import { registeredTool, toolsetReceipt } from '../../../sessions/shared/toolset-result';
import {
  presentationContext,
  selectPresentationNotices,
  PRESENTATION_CONTEXT_URI,
} from '../../../sessions/shared/host-context';
import { inboxContext, INBOX_CONTEXT_URI } from '../../../sessions/shared/inbox';
import { appCall, type McpCall } from '../../../sessions/shared/tools';
import type {
  ApprovalAnswer,
  HistoryEntry,
  MessageImage,
  ModelOption,
  PermissionMode,
  QuestionAnswer,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../../../sessions/shared/events';
import type { AccountNews, AccountSource } from '../../../accounts/main/source';
import { isSignInError, readGrokAccount } from './account';
import { bundledGrokBinary } from './binary';
import { spawnGrok, type GrokProcess, type StartGrok } from './process';
import {
  ASK_USER_QUESTION,
  approvalResult,
  cancelledPermission,
  cancelledQuestion,
  parseAskUserQuestion,
  permissionApproval,
  questionResult,
  userQuestion,
  type AskUserQuestionParams,
  type AskUserQuestionResult,
} from './requests';
import { currentChoices, grokServerName, modeIds, toolArguments, Translator } from './translate';
import {
  completedTurn,
  INTERJECT,
  interjectionText,
  parseQueueChanged,
  parseSessionNotice,
  QUEUE_CHANGED,
  retryOf,
  SESSION_NOTICE,
  type InterjectParams,
  type QueueChanged,
  type SessionNotice,
} from './turns';

// Grok Build's sandbox profile behind each of the app's sandbox levels. Grok applies a profile to its
// whole process as the process starts, so each level needs a process of its own.
const profiles: Record<SandboxLevel, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace',
  'full-access': 'off',
};

// `grok agent stdio` at the level's profile, never through a shared leader process, and with Grok's own
// plan mode off: the app's modes are auto and yolo (ADR-0006), and Grok asks to leave its plan mode
// through an undocumented extension request.

// A server name Grok admits, which an allow rule may also name.
const GROK_SERVER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function launchArgs(sandbox: SandboxLevel, hostTools: readonly string[] = []): string[] {
  return [
    '--no-plan',
    '--sandbox',
    profiles[sandbox],
    ...hostTools.flatMap((name) => ['--allow', `MCPTool(${name})`]),
    'agent',
    '--no-leader',
    'stdio',
  ];
}

// Tells Grok Build that the app shows the questions of its own question tool.
const SESSION_META = { askUserQuestion: true };

// Grok's undocumented requests that give a session a title and delete one from its history, each
// answering { success: true }: rename takes { sessionId, title } and delete { sessionId }.
const SESSION_RENAME = '_x.ai/session/rename';
const SESSION_DELETE = '_x.ai/session/delete';
// How long a title may take to be written, from its session's start, before it fails.
const TITLE_TIMEOUT_MS = 120_000;

const NO_GATEWAYS = 'Grok Build has no gateways; its custom models are among its models.';

// The folders of the probes still listing models, removed as the app's process exits, should it quit
// during a probe, so that quitting leaves none behind.
const probeFolders = new Set<string>();
process.on('exit', () => {
  for (const folder of probeFolders) rmSync(folder, { recursive: true, force: true });
});

export type GrokBuildProviderOptions = {
  // The app's version, which Grok records as its client's.
  clientVersion?: string;
} & (
  | {
      // The folder the bundled binary is unpacked into, which the app keeps for it.
      binaryFolder: string;
    }
  | {
      // Starts a Grok Build process; tests put a fake in place of the bundled one.
      startGrok: StartGrok;
    }
);

// What a Grok Build process passes on while the session uses it.
interface Handlers {
  update(notification: SessionNotification): void;
  permission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  question(params: AskUserQuestionParams, signal: AbortSignal): Promise<AskUserQuestionResult>;
  queueChanged(params: QueueChanged): void;
  notice(params: SessionNotice): void;
  // Grok's catalog changed, as when its first fetch lands: the model state it now holds.
  models(modelState: unknown): void;
}

// A Grok Build process with ACP started on it, at a sandbox level.
interface Agent {
  process: GrokProcess;
  connection: ClientConnection;
  initialize: InitializeResponse;
  sandbox: SandboxLevel;
}

type Connect = (
  cwd: string,
  sandbox: SandboxLevel,
  handlers: Handlers,
  hostTools?: readonly string[],
) => Promise<Agent>;

// How the sessions take part in Grok's account (ADR-0017): those running lend their processes to the
// account's calls, and pass on that a turn failed for want of a sign-in.
interface AccountLink {
  readonly sessions: Set<GrokSession>;
  hear(news: AccountNews): void;
}

// Grok Build through its ACP agent mode (ADR-0003), on whatever sign-in Grok itself has, and that
// sign-in's account with its plan's current period (ADR-0017). Grok asks its questions through its own
// question tool; the app's automation tools use the session-bound HTTP toolset.
export function createGrokBuildProvider(
  options: GrokBuildProviderOptions,
): Provider & AccountSource {
  const startGrok =
    'startGrok' in options ? options.startGrok : startBundledGrok(options.binaryFolder);
  const binaryFolder = 'binaryFolder' in options ? options.binaryFolder : undefined;
  const clientVersion = options.clientVersion ?? '0.0.0';
  const connect: Connect = (cwd, sandbox, handlers, hostTools) =>
    connectGrok(startGrok, cwd, sandbox, handlers, clientVersion, hostTools);
  // The probes' processes, each kept from the moment it starts, before Grok answers it, so that closing
  // ends one still starting.
  const probes = new Probes();
  const probeConnect: Connect = (cwd, sandbox, handlers) =>
    connectGrok(
      (folder, args) => probes.start(() => startGrok(folder, args)),
      cwd,
      sandbox,
      handlers,
      clientVersion,
    );
  const listeners = new Set<(news: AccountNews) => void>();
  const link: AccountLink = {
    sessions: new Set(),
    hear(news) {
      for (const listener of listeners) listener(news);
    },
  };
  return {
    id: 'grok-build',
    start(options, onEvent) {
      return GrokSession.open(options, null, connect, link, onEvent);
    },
    resume(options, onEvent) {
      return GrokSession.open(options, options.sessionId, connect, link, onEvent);
    },
    // Grok replays a session to the process that loads it, so a short-lived process in the read-only
    // profile loads it and ends; nothing is sent to the session. The replay leaves out the title Grok
    // keeps for the session, which its list of sessions gives, as a running session reports it.
    history(sessionId, cwd) {
      const translator = new Translator(cwd);
      const events: SessionEvent[] = [];
      return withGrok(
        probeConnect,
        cwd,
        async ({ connection }) => {
          await connection.agent.request('session/load', {
            cwd,
            mcpServers: [],
            _meta: SESSION_META,
            sessionId,
          });
          translator.endMessage();
          const listed = (await grokSessions(connection, cwd)).find(
            (session) => session.sessionId === sessionId,
          );
          const title = listed?.title;
          return title == null || title === '' ? events : [...events, { type: 'title', title }];
        },
        ({ sessionId: loaded, update }) => {
          if (loaded === sessionId) events.push(...translator.update(update));
        },
      );
    },
    listSessions(cwd, limit) {
      return withGrok(probeConnect, cwd, async ({ connection }): Promise<HistoryEntry[]> => {
        const sessions = await grokSessions(connection, cwd);
        return sessions
          .map((session) => ({
            id: session.sessionId,
            title: session.title ?? '',
            cwd: session.cwd,
            updatedAt: time(session.updatedAt),
          }))
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, limit);
      });
    },
    listGateways() {
      return Promise.resolve([]);
    },
    async listModels(gateway) {
      if (gateway !== null) throw new Error(NO_GATEWAYS);
      const cwd = await mkdtemp(join(tmpdir(), 'grok-models-'));
      probeFolders.add(cwd);
      try {
        return await withGrok(
          probeConnect,
          cwd,
          async (agent) =>
            catalogOf(
              (await listedModelState(agent.connection)) ?? agent.initialize._meta?.modelState,
            ).models,
        );
      } finally {
        probeFolders.delete(cwd);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    // A title from a session of a short-lived process in a throwaway folder (ADR-0035), read-only,
    // which is deleted from Grok's history once it has answered.
    async writeTitle(request) {
      const cwd = await mkdtemp(join(tmpdir(), 'grok-title-'));
      probeFolders.add(cwd);
      try {
        return await writeTitle(probeConnect, cwd, request);
      } finally {
        probeFolders.delete(cwd);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    // Through a running session's process, or else a short-lived one in a throwaway folder.
    async readAccount(withUsage) {
      for (const session of link.sessions) {
        const connection = session.accountConnection();
        if (connection !== null) return readGrokAccount(connection, withUsage);
      }
      const cwd = await mkdtemp(join(tmpdir(), 'grok-account-'));
      probeFolders.add(cwd);
      try {
        return await withGrok(probeConnect, cwd, ({ connection }) =>
          readGrokAccount(connection, withUsage),
        );
      } finally {
        probeFolders.delete(cwd);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    async signInCommand() {
      if (binaryFolder === undefined) throw new Error('This Grok Build has no binary of its own.');
      return { file: await bundledGrokBinary(binaryFolder), args: ['login'] };
    },
    onAccountNews(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      return probes.close();
    },
  };
}

function startBundledGrok(folder: string): StartGrok {
  return async (cwd, args) => spawnGrok(await bundledGrokBinary(folder), cwd, args);
}

async function connectGrok(
  startGrok: StartGrok,
  cwd: string,
  sandbox: SandboxLevel,
  handlers: Handlers,
  clientVersion: string,
  hostTools?: readonly string[],
): Promise<Agent> {
  const process = await startGrok(cwd, launchArgs(sandbox, hostTools));
  const connection = client({ name: '3mukon-code' })
    .onNotification('session/update', ({ params }) => {
      handlers.update(params);
    })
    .onRequest('session/request_permission', ({ params, signal }) =>
      handlers.permission(params, signal),
    )
    .onRequest(ASK_USER_QUESTION, parseAskUserQuestion, ({ params, signal }) =>
      handlers.question(params, signal),
    )
    .onNotification(QUEUE_CHANGED, parseQueueChanged, ({ params }) => {
      handlers.queueChanged(params);
    })
    .onNotification(SESSION_NOTICE, parseSessionNotice, ({ params }) => {
      handlers.notice(params);
    })
    .onNotification(
      MODELS_UPDATE,
      (params: unknown) => params,
      ({ params }) => {
        handlers.models(params);
      },
    )
    .connect(process.stream);
  try {
    // The app reads and writes no files and runs no terminals for Grok, which uses its own tools.
    const initialize = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: '3mukon-code', title: '3mukon-code', version: clientVersion },
    });
    return { process, connection, initialize, sandbox };
  } catch (error) {
    await stopAgent({ process, connection });
    throw error;
  }
}

async function stopAgent({ process, connection }: Pick<Agent, 'process' | 'connection'>) {
  connection.close();
  await process.stop();
}

// Every session Grok lists for the folder, page by page.
async function grokSessions(connection: ClientConnection, cwd: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await connection.agent.request('session/list', {
      cwd,
      ...(cursor == null ? {} : { cursor }),
    });
    sessions.push(...page.sessions);
    cursor = page.nextCursor;
  } while (cursor != null);
  return sessions;
}

// One exchange with a short-lived process, a probe, that starts no session; it runs read-only. The
// answer comes as soon as the exchange ends, without waiting for the process to stop, which takes Grok
// about four seconds and which the probes wait for as the provider closes; it leaves nothing behind in
// its folder.
async function withGrok<Result>(
  connect: Connect,
  cwd: string,
  use: (agent: Agent) => Promise<Result>,
  update: Handlers['update'] = () => undefined,
): Promise<Result> {
  const agent = await connect(cwd, 'read-only', {
    update,
    permission: () => Promise.resolve(cancelledPermission),
    question: () => Promise.resolve(cancelledQuestion),
    queueChanged: () => undefined,
    notice: () => undefined,
    models: () => undefined,
  });
  try {
    return await use(agent);
  } finally {
    stopAgent(agent).catch(() => undefined);
  }
}

// The reply to a title's prompt from a new session of a short-lived, read-only process in the
// folder given, with the model and effort given; the session is deleted from Grok's history once it
// has answered or failed. Grok's agent mode keeps its built-in tools, so a title whose agent starts
// a tool call is cancelled and fails, and the permissions Grok asks for are refused.
async function writeTitle(
  connect: Connect,
  cwd: string,
  { model, effort, prompt }: TitleRequest,
): Promise<string> {
  let sessionId: string | undefined;
  let reply = '';
  let tooled = false;
  let cancel: (() => void) | undefined;
  return withGrok(
    connect,
    cwd,
    async ({ connection }) => {
      cancel = () => {
        if (sessionId !== undefined) {
          connection.agent.notify('session/cancel', { sessionId }).catch(() => undefined);
        }
      };
      const created = await connection.agent.request('session/new', {
        cwd,
        mcpServers: [],
        _meta: SESSION_META,
      });
      const id = created.sessionId;
      sessionId = id;
      try {
        const option = (configId: string, value: string) =>
          connection.agent.request('session/set_config_option', { sessionId: id, configId, value });
        if (model !== null) await option('model', model);
        if (effort !== null) await option('reasoning_effort', effort);
        const answered = await withinTime(
          connection.agent.request('session/prompt', {
            sessionId: id,
            prompt: [{ type: 'text', text: prompt }],
          }),
          TITLE_TIMEOUT_MS,
          'Grok did not write the title in time.',
        );
        if (tooled) throw new Error('Grok started a tool instead of writing the title.');
        if (answered.stopReason !== 'end_turn') {
          throw new Error(`Grok stopped before it wrote the title: ${answered.stopReason}.`);
        }
        return reply;
      } finally {
        await connection.agent.request(SESSION_DELETE, { sessionId: id }).catch(() => undefined);
      }
    },
    ({ sessionId: from, update }) => {
      if (from !== sessionId) return;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        reply += update.content.text;
      } else if (update.sessionUpdate === 'tool_call' && !tooled) {
        tooled = true;
        cancel?.();
      }
    },
  );
}

// The promise's value, or a rejection with the message once ms have passed without one.
function withinTime<Value>(promise: Promise<Value>, ms: number, message: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => {
    clearTimeout(timer);
  });
}

// The models the account can choose and their defaults, which Grok lists as it starts.
interface Catalog {
  models: ModelOption[];
  defaultModel: string | undefined;
  defaultEfforts: Map<string, ReasoningEffort>;
}

// Grok's catalog for one-shot consumers, and its announcement of a changed catalog, both carrying
// the model state initialize gives: the current model and the available ones.
const MODELS_LIST = '_x.ai/models/list';
const MODELS_UPDATE = '_x.ai/models/update';
// Grok bounds its own wait for its first catalog; this bounds the app's wait for its answer.
const MODELS_LIST_TIMEOUT_MS = 20_000;

// Grok answers initialize at once with the catalog it holds: its cached one while the cache is
// fresh, or else only its built-in models until its first fetch lands, which it then announces with
// x.ai/models/update. x.ai/models/list waits, as session/new does, a bounded time for that first
// catalog, so a short-lived process can list the models a session will have. A Grok without it, an
// error or no answer in time leaves the catalog initialize gave.
async function listedModelState(connection: ClientConnection): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = record(
      await Promise.race([
        connection.agent.request(MODELS_LIST, {}),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            resolve(undefined);
          }, MODELS_LIST_TIMEOUT_MS);
        }),
      ]),
    );
    return answer?.error === undefined || answer.error === null
      ? record(answer?.result)
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// A model state, as initialize, x.ai/models/list and x.ai/models/update give it.
function catalogOf(modelState: unknown): Catalog {
  const state = record(modelState);
  const models: ModelOption[] = [];
  const defaultEfforts = new Map<string, ReasoningEffort>();
  for (const entry of Array.isArray(state?.availableModels) ? state.availableModels : []) {
    const model = record(entry);
    const id = text(model?.modelId);
    if (model === undefined || id === undefined) continue;
    const efforts = effortsOf(model);
    const preset = efforts.find((effort) => effort.default === true);
    const defaultEffort = text(preset?.value) ?? text(preset?.id);
    if (defaultEffort !== undefined) defaultEfforts.set(id, defaultEffort);
    const description = text(model.description);
    models.push({
      id,
      label: text(model.name) ?? id,
      ...(description === undefined ? {} : { description }),
      efforts: efforts.flatMap((effort) => text(effort.value) ?? text(effort.id) ?? []),
    });
  }
  // The model Grok uses when a session chooses none, and each model's own effort, marked on the list.
  const defaultModel = text(state?.currentModelId);
  const marked = models.map((model) => {
    const defaultEffort = defaultEfforts.get(model.id);
    return {
      ...model,
      ...(model.id === defaultModel ? { default: true } : {}),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    };
  });
  return { models: marked, defaultModel, defaultEfforts };
}

// A model's effort levels, which Grok lists in the model's metadata.
function effortsOf(model: Record<string, unknown>): Record<string, unknown>[] {
  const listed = record(model._meta)?.reasoningEfforts;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((effort: unknown) => {
    const entry = record(effort);
    return entry === undefined ? [] : [entry];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function time(value: string | null | undefined): number {
  const parsed = value == null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type TurnEnded = Extract<SessionEvent, { type: 'turn-ended' }>;

function turnEndedBy(stopReason: StopReason): TurnEnded {
  switch (stopReason) {
    case 'end_turn':
      return { type: 'turn-ended', outcome: 'completed' };
    case 'cancelled':
      return { type: 'turn-ended', outcome: 'interrupted' };
    case 'refusal':
      return { type: 'turn-ended', outcome: 'failed', error: 'Grok Build refused to go on.' };
    case 'max_tokens':
      return {
        type: 'turn-ended',
        outcome: 'failed',
        error: 'The reply reached its length limit.',
      };
    case 'max_turn_requests':
      return {
        type: 'turn-ended',
        outcome: 'failed',
        error: 'The turn reached its limit of model requests.',
      };
  }
}

interface SessionSettings {
  toolset?: Toolset;
  cwd: string;
  mode: PermissionMode;
  model: string | null;
  effort: ReasoningEffort | null;
  sandbox: SandboxLevel;
}

function sessionSettings(options: StartOptions): SessionSettings {
  if (options.gateway !== undefined) throw new Error(NO_GATEWAYS);
  return {
    cwd: options.cwd,
    mode: options.mode ?? 'auto',
    model: options.model ?? null,
    effort: options.effort ?? null,
    sandbox: options.sandbox ?? 'workspace-write',
    ...(options.toolset ? { toolset: options.toolset } : {}),
  };
}

// A process with the session created, loaded or resumed on it, not yet in use.
interface Attached {
  agent: Agent;
  generation: number;
  sessionId: string;
  configOptions: SessionConfigOption[];
}

type Pending =
  | {
      kind: 'approval';
      options: PermissionOption[];
      resolve: (result: RequestPermissionResponse) => void;
    }
  | { kind: 'question'; texts: string[]; resolve: (result: AskUserQuestionResult) => void };

// A message of the user's, with its images.
interface Message {
  text: string;
  images: MessageImage[];
  context?: HostTurnContext;
  delivery?: HostContextDelivery;
}
function contextBlocks(context?: HostTurnContext): ContentBlock[] {
  const text = presentationContext(context?.presentationNotices ?? []);
  const inbox = inboxContext(context?.inboxNotices ?? []);
  return [
    ...(text
      ? [
          {
            type: 'resource' as const,
            resource: { uri: PRESENTATION_CONTEXT_URI, mimeType: 'text/plain', text },
          },
        ]
      : []),
    ...(inbox
      ? [
          {
            type: 'resource' as const,
            resource: { uri: INBOX_CONTEXT_URI, mimeType: 'text/plain', text: inbox },
          },
        ]
      : []),
  ];
}

// An image as Grok takes it, in a prompt or an interjection.
function imageBlock(image: MessageImage): ContentBlock {
  return { type: 'image', mimeType: image.mediaType, data: image.data };
}

class GrokSession implements ProviderSession {
  private hostEnabled = false;
  get supportsHostContext(): true | undefined {
    return this.agent.initialize.agentCapabilities?.promptCapabilities?.embeddedContext === true
      ? true
      : undefined;
  }
  private readonly deliveries = new Set<HostContextDelivery>();
  private access?: ToolsetAccess;
  private readonly toolNames = new Map<string, string>();
  private readonly resultNames = new Map<string, string>();
  private agent!: Agent;
  private sessionId = '';
  private readonly translator: Translator;
  // Each process's handlers act only while it is the session's current one. The first process is
  // number 1, so 0 stands for none, as while the process is being replaced.
  private generation = 0;
  private generations = 0;
  private catalog: Catalog = { models: [], defaultModel: undefined, defaultEfforts: new Map() };
  private configOptions: SessionConfigOption[] = [];
  private readonly pending = new Map<string, Pending>();
  // While Grok replays a session it loads, the user's own messages come from it; otherwise from the
  // session.
  private replaying = false;
  private turnRunning = false;
  private closing = false;
  private closed = false;
  // A sandbox level asked for during a turn, which takes over when the turn ends.
  private sandboxPending = false;
  // The user's messages that no turn took, which start the next one together.
  private queued: Message[] = [];
  // The prompt that Grok says it runs, from the notices of its queue, and a turn that Grok runs by
  // itself, such as for an interjection that came after its turn, which Grok's notice ends.
  private runningPrompt: string | null = null;
  private grokTurn: string | null = null;
  // The process switch under way, which a message waits for; it never rejects.
  private switching: Promise<void> | null = null;

  get id(): string {
    return this.sessionId;
  }

  // Creates the session, or loads it and replays its history, and resolves once Grok has it.
  static async open(
    options: StartOptions,
    resumeId: string | null,
    connect: Connect,
    link: AccountLink,
    onEvent: SessionEventListener,
  ): Promise<GrokSession> {
    const settings = sessionSettings(options);
    const session = new GrokSession(settings, connect, link, onEvent);
    const attached = await session.attach(resumeId === null ? null : { load: true, resumeId });
    session.use(attached);
    try {
      if (resumeId !== null) onEvent({ type: 'replay-finished' });
      await session.settleCatalog();
      await session.applySettings();
      const current = session.choices();
      onEvent({ type: 'mode', mode: settings.mode });
      onEvent({
        type: 'settings',
        gateway: null,
        model: current.model ?? null,
        effort: current.effort ?? null,
        sandbox: settings.sandbox,
      });
      onEvent({ type: 'models', models: session.catalog.models });
    } catch (error) {
      session.generation = 0;
      session.access?.close();
      await stopAgent(attached.agent);
      throw error;
    }
    link.sessions.add(session);
    return session;
  }

  private constructor(
    private readonly settings: SessionSettings,
    private readonly connect: Connect,
    private readonly link: AccountLink,
    private readonly onEvent: SessionEventListener,
  ) {
    this.translator = new Translator(settings.cwd);
  }

  // The session's process, for the account's calls, while it runs; null while it is being replaced
  // and once the session has ended.
  accountConnection(): ClientConnection | null {
    return this.closed || this.generation === 0 ? null : this.agent.connection;
  }

  async send(
    text: string,
    images: MessageImage[] = [],
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    const running = this.turnRunning;
    this.translator.endMessage();
    if (!running) {
      this.turnRunning = true;
      this.onEvent({ type: 'turn-started' });
    }
    this.onEvent({
      type: 'message',
      id: randomUUID(),
      role: 'user',
      text,
      ...(images.length === 0 ? {} : { images }),
    });
    const message = { text, images, context, delivery };
    if (delivery) this.deliveries.add(delivery);
    if (!running) {
      this.prompt([...this.queued.splice(0), message]);
      return;
    }
    // During a turn, a message joins it through Grok's interjection, its images with it, at the turn's
    // next safe point; Grok stops answering its client after an interjection without text, so images
    // sent alone go with a text of the app's. One that Grok refuses waits for the turn's end and starts
    // the next turn: a prompt sent to Grok during a turn would wait in Grok's own queue, which Grok
    // holds after a cancel until the next prompt.
    if (await this.interjected(message)) return;
    if (this.turnRunning) {
      this.queued.push(message);
      return;
    }
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
    this.prompt([...this.queued.splice(0), message]);
  }

  private interjected({ text, images, context, delivery }: Message): Promise<boolean> {
    const content = [...contextBlocks(context), ...images.map(imageBlock)];
    const params: InterjectParams = {
      sessionId: this.sessionId,
      text: interjectionText(text, images.length),
      interjectionId: randomUUID(),
      ...(content.length === 0 ? {} : { content }),
    };
    return this.agent.connection.agent.request(INTERJECT, params).then(
      // This extension acknowledges a queue, not the model-facing turn record. Keep notices pending
      // for a result receipt or a full prompt response rather than claiming delivery from queueing.
      () => {
        if (delivery) {
          delivery.failed();
          this.deliveries.delete(delivery);
        }
        return true;
      },
      () => false,
    );
  }

  // Sends a turn's prompt: the messages' text, then their images, which Grok takes in prompts, as its
  // answer to initialize says.
  private prompt(messages: Message[]): void {
    const notices = selectPresentationNotices(
      messages.flatMap((message) => message.context?.presentationNotices ?? []),
    );
    const seen = new Set<string>();
    const inboxNotices = messages
      .flatMap((message) => message.context?.inboxNotices ?? [])
      .filter((notice) => !seen.has(notice.id) && Boolean(seen.add(notice.id)));
    const text = messages
      .map((message) => message.text)
      .filter((part) => part !== '')
      .join('\n\n');
    const prompt: ContentBlock[] = [
      ...contextBlocks({ presentationNotices: notices, inboxNotices }),
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ...messages.flatMap((message) => message.images).map(imageBlock),
    ];
    // ACP answers a prompt when its turn ends; the turn's progress comes before as session updates. A
    // connection that closes first is the session's end, which closed reports.
    const { connection } = this.agent;
    connection.agent.request('session/prompt', { sessionId: this.sessionId, prompt }).then(
      (response) => {
        for (const message of messages) {
          if (message.delivery) {
            message.delivery.accepted(notices);
            this.deliveries.delete(message.delivery);
          }
        }
        const promptId = response._meta?.promptId;
        this.endTurn(
          turnEndedBy(response.stopReason),
          typeof promptId === 'string' ? promptId : undefined,
        );
      },
      (error: unknown) => {
        for (const message of messages) {
          if (message.delivery) {
            message.delivery.failed();
            this.deliveries.delete(message.delivery);
          }
        }
        if (connection.signal.aborted) return;
        if (isSignInError(error)) this.link.hear({ type: 'signed-out' });
        this.endTurn({ type: 'turn-ended', outcome: 'failed', error: errorMessage(error) });
      },
    );
  }

  // ACP has the client answer what is still open as cancelled once it cancels the turn.
  async interrupt(): Promise<void> {
    for (const delivery of this.deliveries) delivery.failed();
    this.deliveries.clear();
    if (!this.turnRunning) return;
    this.withdrawAll();
    await this.agent.connection.agent.notify('session/cancel', { sessionId: this.sessionId });
  }

  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending?.kind !== 'approval') {
      return Promise.reject(new Error(`No approval ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(approvalResult(pending.options, answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending?.kind !== 'question') {
      return Promise.reject(new Error(`No question ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(questionResult(pending.texts, answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  // Grok switches its mode at once. Approvals already waiting are allowed as soon as the session is in
  // yolo.
  async setMode(mode: PermissionMode): Promise<void> {
    await this.ready();
    await this.agent.connection.agent.request('session/set_mode', {
      sessionId: this.sessionId,
      modeId: modeIds[mode],
    });
    this.settings.mode = mode;
    this.onEvent({ type: 'mode', mode });
    if (mode !== 'yolo') return;
    for (const [requestId, pending] of this.pending) {
      if (pending.kind !== 'approval') continue;
      this.pending.delete(requestId);
      pending.resolve(approvalResult(pending.options, { decision: 'allow-once' }));
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    }
  }

  // Grok switches its model and its effort at once, through its configuration options. Going back to
  // the default sets the model the account starts with, or the model's own default effort.
  async setModel(model: string | null): Promise<void> {
    await this.ready();
    const value = model ?? this.catalog.defaultModel;
    if (value !== undefined) await this.setOption('model', value);
    this.settings.model = model;
    this.onEvent({ type: 'settings', model });
  }

  async setEffort(effort: ReasoningEffort | null): Promise<void> {
    await this.ready();
    const model = this.choices().model;
    const value =
      effort ?? (model === undefined ? undefined : this.catalog.defaultEfforts.get(model));
    if (value !== undefined) await this.setOption('reasoning_effort', value);
    this.settings.effort = effort;
    this.onEvent({ type: 'settings', effort });
  }

  // Grok fixes a process's sandbox as the process starts, so the session moves to a new process at the
  // new level, between turns: at once when no turn runs, and otherwise once the turn ends.
  async setSandbox(sandbox: SandboxLevel): Promise<void> {
    if (this.closed) throw new Error('The session is closed.');
    this.settings.sandbox = sandbox;
    this.onEvent({ type: 'settings', sandbox });
    if (this.turnRunning) {
      this.sandboxPending = true;
      return;
    }
    await this.switchSandbox();
  }

  setGateway(gateway: string | null): Promise<void> {
    return gateway === null ? Promise.resolve() : Promise.reject(new Error(NO_GATEWAYS));
  }

  // A turn of the app's own with the host context alone, as the notice of new messages (ADR-0036):
  // no message of the user's goes with it or shows.
  async deliverContext(context: HostTurnContext, delivery: HostContextDelivery): Promise<void> {
    await this.ready();
    if (this.turnRunning) throw new Error('A turn is running.');
    this.translator.endMessage();
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
    this.deliveries.add(delivery);
    this.prompt([{ text: '', images: [], context, delivery }]);
  }

  // Grok keeps the title with the session in its history, which its own tools show.
  async setTitle(title: string): Promise<void> {
    await this.ready();
    await this.agent.connection.agent.request(SESSION_RENAME, { sessionId: this.sessionId, title });
    this.onEvent({ type: 'title', title });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.access?.close();
    if (this.switching !== null) await this.switching;
    if (this.closed) return;
    await stopAgent(this.agent);
  }

  // Starts a process at the level and creates the session on it, or loads or resumes it there: loading
  // replays the session's history, resuming replays nothing. The process's handlers act from the start,
  // so that a replay reaches the session.
  private async attach(
    existing: { load: boolean; resumeId: string } | null,
    sandbox: SandboxLevel = this.settings.sandbox,
  ): Promise<Attached> {
    const generation = ++this.generations;
    this.generation = generation;
    this.access?.close();
    const access = this.settings.toolset?.open();
    this.access = access;
    this.hostEnabled = false;
    this.toolNames.clear();
    this.resultNames.clear();
    if (existing !== null) this.sessionId = existing.resumeId;
    // Grok's use_tool can display only the bare name. Its native MCPTool rules match server__tool,
    // whereas that ACP title cannot establish a server's identity. Allow only exact names in this
    // app's server; bare callbacks still follow normal provider approvals.
    const server = this.settings.toolset && grokServerName(this.settings.toolset.name);
    const hostTools =
      server && GROK_SERVER_NAME.test(server)
        ? (access?.tools ?? [])
            .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
            .map((name) => `${server}__${name}`)
        : [];
    const agent = await this.connect(
      this.settings.cwd,
      sandbox,
      this.handlers(generation),
      hostTools,
    ).catch((error: unknown) => {
      access?.close();
      throw error;
    });
    const http = agent.initialize.agentCapabilities?.mcpCapabilities?.http === true;
    this.hostEnabled = http && access !== undefined;
    access?.availability?.({
      tools: http ? 'unknown' : 'unavailable',
      images:
        agent.initialize.agentCapabilities?.promptCapabilities?.image === true
          ? 'supported'
          : 'unsupported',
      ...(!http
        ? {
            reason: {
              code: 'transport-unsupported' as const,
              transport: 'streamable-http' as const,
            },
          }
        : {}),
    });
    const params: NewSessionRequest = {
      cwd: this.settings.cwd,
      mcpServers:
        http && access && this.settings.toolset
          ? [
              {
                type: 'http',
                name: grokServerName(this.settings.toolset.name),
                url: access.url,
                headers: [{ name: 'Authorization', value: `Bearer ${access.credential}` }],
              },
            ]
          : [],
      _meta: SESSION_META,
    };
    try {
      if (existing === null) {
        const response = await agent.connection.agent.request('session/new', params);
        return {
          agent,
          generation,
          sessionId: response.sessionId,
          configOptions: response.configOptions ?? [],
        };
      }
      const { resumeId: sessionId } = existing;
      this.replaying = existing.load;
      const response = existing.load
        ? await agent.connection.agent.request('session/load', { ...params, sessionId })
        : await agent.connection.agent.request('session/resume', { ...params, sessionId });
      return { agent, generation, sessionId, configOptions: response.configOptions ?? [] };
    } catch (error) {
      if (this.generation === generation) this.generation = 0;
      access?.close();
      await stopAgent(agent);
      throw toolsetError(error, access);
    } finally {
      this.replaying = false;
      this.translator.endMessage();
    }
  }

  // Makes an attached process the session's current one; its end ends the session.
  private use({ agent, generation, sessionId, configOptions }: Attached): void {
    this.agent = agent;
    this.generation = generation;
    this.sessionId = sessionId;
    this.configOptions = configOptions;
    this.catalog = catalogOf(agent.initialize._meta?.modelState);
    void agent.process.ended.then((error) => {
      if (generation === this.generation) this.finish(error);
    });
  }

  private handlers(generation: number): Handlers {
    const current = () => generation === this.generation && !this.closed;
    return {
      update: ({ sessionId, update }) => {
        // Updates of other sessions, such as subagents', belong to those.
        if (!current() || sessionId !== this.sessionId) return;
        let appTool: { id: string; call: McpCall } | undefined;
        if (
          !this.replaying &&
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
        ) {
          const wrongKind = update.kind && update.kind !== 'other';
          if (wrongKind) {
            this.toolNames.delete(update.toolCallId);
            this.resultNames.delete(update.toolCallId);
          }
          const name = wrongKind
            ? undefined
            : this.resultTool(update.toolCallId, update.title, update._meta);
          // One of the app's tools that Grok titles by its name alone, as its use_tool does.
          if (name !== undefined && update.title === name) {
            appTool = {
              id: update.toolCallId,
              call: appCall(name, toolArguments(update.rawInput)),
            };
          }
          if (name && (update.status === 'completed' || update.status === 'failed')) {
            const content = update.content?.flatMap((part) =>
              part.type === 'content' ? [part.content] : [],
            );
            const receipt = this.resultReceipt(name, update.rawOutput, content);
            if (receipt) this.access?.result?.(name, update.toolCallId, receipt);
          }
          if (update.status === 'completed' || update.status === 'failed') {
            this.toolNames.delete(update.toolCallId);
            this.resultNames.delete(update.toolCallId);
          }
        }
        if (update.sessionUpdate === 'user_message_chunk' && !this.replaying) return;
        for (const event of this.translator.update(update)) {
          this.onEvent(
            appTool !== undefined &&
              event.type === 'tool' &&
              event.id === appTool.id &&
              event.mcp === undefined
              ? { ...event, mcp: appTool.call }
              : event,
          );
        }
      },
      permission: (params, signal) =>
        current() ? this.askApproval(params, signal) : Promise.resolve(cancelledPermission),
      question: (params, signal) =>
        current() ? this.askQuestion(params, signal) : Promise.resolve(cancelledQuestion),
      queueChanged: ({ sessionId, runningPromptId }) => {
        if (!current() || this.replaying || sessionId !== this.sessionId) return;
        this.runningPrompt = runningPromptId ?? null;
        if (!this.turnRunning && this.runningPrompt !== null)
          this.followGrokTurn(this.runningPrompt);
      },
      notice: (notice) => {
        if (!current() || notice.sessionId !== this.sessionId) return;
        const retry = retryOf(notice);
        if (retry !== undefined) {
          if (!this.replaying) this.onEvent(retry);
          return;
        }
        const completed = completedTurn(notice);
        if (completed?.promptId !== this.grokTurn) return;
        this.endTurn(turnEndedBy(completed.stopReason), completed.promptId);
      },
      // The process's catalog, not a session's: it names no session.
      models: (modelState) => {
        if (!current()) return;
        const catalog = catalogOf(modelState);
        if (catalog.models.length === 0) return;
        this.catalog = catalog;
        this.onEvent({ type: 'models', models: catalog.models });
      },
    };
  }

  // The session's mode, and the model and effort chosen for it, on its current process.
  private async applySettings(): Promise<void> {
    const { mode, model, effort } = this.settings;
    await this.agent.connection.agent.request('session/set_mode', {
      sessionId: this.sessionId,
      modeId: modeIds[mode],
    });
    if (model !== null) await this.setOption('model', model);
    if (effort !== null) await this.setOption('reasoning_effort', effort);
  }

  private async setOption(configId: string, value: string): Promise<void> {
    const { configOptions } = await this.agent.connection.agent.request(
      'session/set_config_option',
      { sessionId: this.sessionId, configId, value },
    );
    this.configOptions = configOptions;
  }

  private choices(): { model?: string; effort?: ReasoningEffort } {
    return currentChoices(this.configOptions);
  }

  private async ready(): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
  }

  // Sandbox switches run one after another, between turns.
  private switchSandbox(): Promise<void> {
    const switched = (this.switching ?? Promise.resolve()).then(() => this.restart());
    const settled = switched.then(
      () => undefined,
      () => undefined,
    );
    this.switching = settled;
    void settled.then(() => {
      if (this.switching === settled) this.switching = null;
    });
    return switched;
  }

  // Moves the session to a process at its level, which resumes it, so that the session keeps its id and
  // its history. The current process ends first, and its end does not end the session. Should the new
  // process fail, the session goes back to one at its earlier level. A close asked for during the switch
  // ends the session once the new process is up.
  private async restart(): Promise<void> {
    const target = this.settings.sandbox;
    const previous = this.agent;
    if (this.closed || previous.sandbox === target) return;
    const existing = { load: false, resumeId: this.sessionId };
    this.generation = 0;
    await stopAgent(previous);
    let attached: Attached;
    try {
      attached = await this.attach(existing, target);
    } catch (error) {
      this.settings.sandbox = previous.sandbox;
      this.onEvent({ type: 'settings', sandbox: previous.sandbox });
      try {
        this.use(await this.attach(existing, previous.sandbox));
        await this.settleCatalog();
        await this.applySettings();
        this.onEvent({ type: 'models', models: this.catalog.models });
      } catch (again) {
        this.finish(errorMessage(again));
      }
      throw error;
    }
    if (this.closing) {
      this.generation = 0;
      await stopAgent(attached.agent);
      this.finish(undefined);
      return;
    }
    this.use(attached);
    await this.settleCatalog();
    await this.applySettings();
    this.onEvent({ type: 'models', models: this.catalog.models });
  }

  // The catalog Grok settles on once its first fetch lands, which session/new, load and resume wait
  // for, in place of the one initialize gave; later changes come with x.ai/models/update.
  private async settleCatalog(): Promise<void> {
    const listed = await listedModelState(this.agent.connection);
    if (listed !== undefined) this.catalog = catalogOf(listed);
  }

  // An approval waits for the user; in yolo, Grok asks for none, and one it still asks for is allowed.
  private askApproval(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      params.sessionId === this.sessionId &&
      (params.toolCall.kind === 'other' ||
        (!params.toolCall.kind && this.toolNames.has(params.toolCall.toolCallId))) &&
      this.hostTool(params.toolCall.toolCallId, params.toolCall.title)
    ) {
      return Promise.resolve(approvalResult(params.options, { decision: 'allow-once' }));
    }
    const { request, options } = permissionApproval(
      randomUUID(),
      params,
      this.context(),
      this.translator.callOf(params.toolCall.toolCallId),
    );
    if (this.settings.mode === 'yolo') {
      return Promise.resolve(approvalResult(options, { decision: 'allow-once' }));
    }
    return new Promise((resolve) => {
      this.pending.set(request.id, { kind: 'approval', options, resolve });
      this.whenAborted(signal, request.id);
      this.onEvent({ type: 'approval-requested', request });
    });
  }

  // A qualified title can route an approval; a bare name cannot distinguish another MCP server.
  // Never match substrings in commands, prose or arguments.
  private hostTool(id: string, title: string | null | undefined): string | undefined {
    if (!this.hostEnabled) return undefined;
    const name =
      this.settings.toolset && typeof title === 'string'
        ? registeredTool(
            title,
            `${grokServerName(this.settings.toolset.name)}__`,
            this.access?.tools,
          )
        : undefined;
    if (name) {
      if (this.toolNames.size >= 256)
        this.toolNames.delete(this.toolNames.keys().next().value ?? '');
      this.toolNames.set(id, name);
    } else if (title) {
      this.toolNames.delete(id);
      return undefined;
    }
    return name ?? this.toolNames.get(id);
  }

  // Grok's native use_tool metadata identifies the dispatcher, not the MCP server. A bare name is
  // only a candidate for receipt correlation, never approval authority. The host must validate the
  // unguessable receipt against its retained call's owner, turn, access generation and tool name
  // before it links activity or retires notices. Foreign or invented receipts cannot do either.
  private resultTool(
    id: string,
    title: string | null | undefined,
    meta: Record<string, unknown> | null | undefined,
  ): string | undefined {
    const qualified = this.hostTool(id, title);
    if (qualified) return qualified;
    if (!this.hostEnabled) return undefined;
    const native = record(meta?.['x.ai/tool']);
    const useTool =
      native?.version === 1 &&
      native.namespace === 'grok_build' &&
      native.name === 'use_tool' &&
      native.kind === 'use_tool';
    if (title && useTool && this.access?.tools?.includes(title)) {
      if (this.resultNames.size >= 256)
        this.resultNames.delete(this.resultNames.keys().next().value ?? '');
      this.resultNames.set(id, title);
      return title;
    }
    if (title || (meta && !useTool)) {
      this.resultNames.delete(id);
      return undefined;
    }
    return this.resultNames.get(id);
  }

  // Grok's MCP completion has no title or text content. Its native wrapper names the server and
  // canonical tool, and holds the toolset's JSON as a string in one variant: OkayOutput for a
  // result, or Error with is_error for one the server marked isError, such as a refusal, which Grok
  // reports as failed; both carry the result's text the same way. Unwrap only that exact shape for
  // this connection and the tool identified by the preceding native updates. A foreign or malformed
  // wrapper must not fall back to another receipt in its content or outer fields.
  private resultReceipt(
    name: string,
    output: unknown,
    content: unknown,
  ): ReturnType<typeof toolsetReceipt> {
    const native = record(output);
    if (
      native &&
      ('type' in native || 'server_name' in native || 'tool_name' in native || 'output' in native)
    ) {
      if (
        native.type !== 'MCP' ||
        !this.settings.toolset ||
        native.server_name !== grokServerName(this.settings.toolset.name) ||
        native.tool_name !== name
      )
        return undefined;
      const details = record(native.output);
      const variant = native.is_error === true ? 'Error' : 'OkayOutput';
      const value = details && Object.keys(details).length === 1 ? details[variant] : undefined;
      return typeof value === 'string' ? toolsetReceipt(value, undefined) : undefined;
    }
    return toolsetReceipt(output, content);
  }

  private askQuestion(
    params: AskUserQuestionParams,
    signal: AbortSignal,
  ): Promise<AskUserQuestionResult> {
    const { request, texts } = userQuestion(randomUUID(), params, this.context());
    return new Promise((resolve) => {
      this.pending.set(request.id, { kind: 'question', texts, resolve });
      this.whenAborted(signal, request.id);
      this.onEvent({ type: 'question-asked', request });
    });
  }

  private context(): { cwd: string; now: number } {
    return { cwd: this.settings.cwd, now: Date.now() };
  }

  // Grok gives a request up, as when its turn ends, or the connection closes.
  private whenAborted(signal: AbortSignal, requestId: string): void {
    signal.addEventListener(
      'abort',
      () => {
        this.withdraw(requestId);
      },
      { once: true },
    );
  }

  // What the user has not answered ends as cancelled.
  private withdraw(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    if (pending.kind === 'approval') pending.resolve(cancelledPermission);
    else pending.resolve(cancelledQuestion);
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
  }

  private withdrawAll(): void {
    for (const requestId of [...this.pending.keys()]) this.withdraw(requestId);
  }

  // The turn of the prompt has ended: what Grok left open is cancelled. Should Grok already run another
  // prompt, as for an interjection that came after the turn, the session follows that turn; otherwise a
  // level asked for during the turn takes over, and then the messages that no turn took start the next.
  private endTurn(event: TurnEnded, promptId?: string): void {
    if (this.closed || this.closing || !this.turnRunning) return;
    this.turnRunning = false;
    this.grokTurn = null;
    this.withdrawAll();
    this.translator.endMessage();
    this.onEvent(event);
    if (promptId !== undefined && this.runningPrompt !== null && this.runningPrompt !== promptId) {
      this.followGrokTurn(this.runningPrompt);
      return;
    }
    if (this.sandboxPending) {
      this.sandboxPending = false;
      this.switchSandbox().catch((error: unknown) => {
        this.onEvent({ type: 'error', message: errorMessage(error) });
      });
    }
    if (this.queued.length > 0) void this.sendQueued();
  }

  // Follows a turn that Grok runs by itself, until Grok's notice that it completed.
  private followGrokTurn(promptId: string): void {
    this.grokTurn = promptId;
    this.turnRunning = true;
    this.translator.endMessage();
    this.onEvent({ type: 'turn-started' });
  }

  private async sendQueued(): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed || this.closing || this.turnRunning || this.queued.length === 0) return;
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
    this.prompt(this.queued.splice(0));
  }

  // The session has ended: what is still open is cancelled, and closed is reported once.
  private finish(error: string | undefined): void {
    if (this.closed) return;
    this.withdrawAll();
    this.closed = true;
    for (const delivery of this.deliveries) delivery.failed();
    this.deliveries.clear();
    this.access?.close();
    this.link.sessions.delete(this);
    this.turnRunning = false;
    this.queued = [];
    this.onEvent(error === undefined ? { type: 'closed' } : { type: 'closed', error });
  }
}
