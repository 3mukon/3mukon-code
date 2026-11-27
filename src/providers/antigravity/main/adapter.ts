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
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type NewSessionRequest,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type StopReason,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { AccountNews, AccountSource } from '../../../accounts/main/source';
import type { Binary, ProviderInstall } from '../../../installs/main/install';
import {
  Probes,
  toolsetError,
  type HostContextDelivery,
  type HostTurnContext,
  type Provider,
  type ProviderSession,
  type SessionEventListener,
  type StartOptions,
  type Toolset,
  type ToolsetAccess,
} from '../../../sessions/main/provider';
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
import {
  presentationContext,
  PRESENTATION_CONTEXT_URI,
  selectPresentationNotices,
} from '../../../sessions/shared/host-context';
import { inboxContext, INBOX_CONTEXT_URI } from '../../../sessions/shared/inbox';
import { registeredTool } from '../../../sessions/shared/toolset-result';
import { isSignInError, readAntigravityAccount } from './account';
import { spawnAgy, type AgyProcess, type StartAgy } from './process';
import {
  approvalResult,
  beyondLevel,
  cancelledForm,
  cancelledPermission,
  formQuestion,
  formResult,
  permissionApproval,
  type FormField,
} from './requests';
import {
  currentChoices,
  EFFORT_OPTION,
  MODEL_OPTION,
  record,
  toolNameOf,
  Translator,
} from './translate';

// A session's process at each of the app's sandbox levels (ADR-0040): `agy acp`, serving the session
// from a worker of its own, the only form in which it takes the app's toolset over HTTP, with its
// terminal sandbox at read-only and workspace-write. The sandbox holds for the whole process, so a
// switch to or from full access needs a new one.
function sessionArgs(sandbox: SandboxLevel): string[] {
  return ['acp', '--process-per-session', ...(sandboxed(sandbox) ? ['--sandbox'] : [])];
}

function sandboxed(sandbox: SandboxLevel): boolean {
  return sandbox !== 'full-access';
}

// A probe's process, which starts no turn: `agy acp` alone.
const PROBE_ARGS = ['acp'];

// The app's copy runs with Antigravity's own updater off, which would otherwise replace the copy with
// a newer build than the app pins (ADR-0039); the user's CLI runs as the user keeps it. The switch is
// the binary's own, undocumented.
export function launchEnv(binary: Binary): Record<string, string> {
  return binary.source === 'app' ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {};
}

// Antigravity's own modes behind the app's (ADR-0040): in auto, its auto mode where the session's modes
// offer it, except at read-only, where it would edit without asking; otherwise its default mode, which
// asks before edits and commands.
const AUTO = 'auto';
const DEFAULT = 'default';

function agyMode(mode: PermissionMode, sandbox: SandboxLevel, offered: readonly string[]): string {
  return mode === 'auto' && sandbox !== 'read-only' && offered.includes(AUTO) ? AUTO : DEFAULT;
}

const NO_GATEWAYS = 'Antigravity has no gateways; its models are those of its own sign-in.';

// The effort levels the app knows, from the least to the most, in the order a model's are listed.
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// The folders of the probes still running, removed as the app's process exits, should it quit during a
// probe, so that quitting leaves none behind.
const probeFolders = new Set<string>();
process.on('exit', () => {
  for (const folder of probeFolders) rmSync(folder, { recursive: true, force: true });
});

export type AntigravityProviderOptions = {
  // The app's version, which Antigravity records as its client's.
  clientVersion?: string;
} & (
  | {
      // Where Antigravity's processes come from: the user's CLI or the app's own copy (ADR-0039).
      install: ProviderInstall;
    }
  | {
      // Starts an Antigravity process; tests put a fake in place of Antigravity.
      startAgy: StartAgy;
    }
);

// What an Antigravity process passes on while the session uses it.
interface Handlers {
  update(notification: SessionNotification): void;
  permission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  question(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
}

// An Antigravity process with ACP started on it, and whether it runs the terminal sandbox.
interface Agent {
  process: AgyProcess;
  connection: ClientConnection;
  initialize: InitializeResponse;
  sandboxed: boolean;
}

type Connect = (cwd: string, sandbox: SandboxLevel, handlers: Handlers) => Promise<Agent>;
type ProbeConnect = (cwd: string, handlers: Handlers) => Promise<Agent>;

// How the sessions take part in Antigravity's account (ADR-0017): they pass on that a turn failed for
// want of a sign-in.
interface AccountLink {
  hear(news: AccountNews): void;
}

// Antigravity through `agy acp` (ADR-0040), on whatever sign-in Antigravity itself holds. Antigravity
// asks its questions through its own question tool, as ACP form elicitations; the app's automation
// tools use the session-bound HTTP toolset.
export function createAntigravityProvider(
  options: AntigravityProviderOptions,
): Provider & AccountSource {
  const clientVersion = options.clientVersion ?? '0.0.0';
  // A session's processes all run the binary it started with, which a session downloads first where the
  // app has to run its own copy and has none of the pinned version (ADR-0039).
  const sessionConnect = async (): Promise<Connect> => {
    const start =
      'startAgy' in options ? options.startAgy : fromBinary(await options.install.prepare());
    return (cwd, sandbox, handlers) =>
      connectAgy(start, cwd, sessionArgs(sandbox), sandboxed(sandbox), handlers, clientVersion);
  };
  // A probe runs the binary that runs now, kept from the moment it starts, so that closing ends one still
  // starting.
  const probeStart: StartAgy =
    'startAgy' in options
      ? options.startAgy
      : async (cwd, args) => fromBinary(await options.install.current())(cwd, args);
  const probes = new Probes();
  const probeConnect: ProbeConnect = (cwd, handlers) =>
    connectAgy(
      (folder, args) => probes.start(() => probeStart(folder, args)),
      cwd,
      PROBE_ARGS,
      false,
      handlers,
      clientVersion,
    );
  const listeners = new Set<(news: AccountNews) => void>();
  const link: AccountLink = {
    hear(news) {
      for (const listener of listeners) listener(news);
    },
  };
  return {
    id: 'antigravity',
    async start(options, onEvent) {
      return AntigravitySession.open(options, null, await sessionConnect(), link, onEvent);
    },
    async resume(options, onEvent) {
      return AntigravitySession.open(
        options,
        options.sessionId,
        await sessionConnect(),
        link,
        onEvent,
      );
    },
    // Antigravity replays a session to the process that loads it, its title last, so a short-lived
    // process loads it and ends; nothing is sent to the session.
    history(sessionId, cwd) {
      const translator = new Translator(cwd);
      const events: SessionEvent[] = [];
      return withAgy(
        probeConnect,
        cwd,
        async ({ connection }) => {
          await connection.agent.request('session/load', { cwd, mcpServers: [], sessionId });
          translator.endMessage();
          return events;
        },
        ({ sessionId: loaded, update }) => {
          if (loaded === sessionId) events.push(...translator.update(update));
        },
      );
    },
    // Antigravity lists the sessions of every folder whatever folder it is asked for, each with its own,
    // so the folder's are picked out here.
    listSessions(cwd, limit) {
      return withAgy(probeConnect, cwd, async ({ connection }): Promise<HistoryEntry[]> => {
        const sessions = await agySessions(connection, cwd);
        return sessions
          .filter((session) => session.cwd === cwd)
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
    // The models and thinking levels of a new session of a short-lived process in a throwaway folder,
    // which runs no turn and is closed once read.
    async listModels(gateway) {
      if (gateway !== null) throw new Error(NO_GATEWAYS);
      return withFolder('antigravity-models-', (cwd) =>
        withAgy(probeConnect, cwd, async ({ connection }) => {
          const created = await connection.agent.request('session/new', { cwd, mcpServers: [] });
          try {
            return catalogOf(created.configOptions ?? [], record(created)?.models).models;
          } finally {
            await connection.agent
              .request('session/close', { sessionId: created.sessionId })
              .catch(() => undefined);
          }
        }),
      );
    },
    // Through a short-lived process in a throwaway folder.
    readAccount(withUsage) {
      return withFolder('antigravity-account-', (cwd) =>
        withAgy(probeConnect, cwd, ({ connection }) =>
          readAntigravityAccount(connection, withUsage),
        ),
      );
    },
    // Antigravity's own sign-in in a terminal (ACP's terminal sign-in), which it offers as
    // `terminal-login` with these arguments.
    async signInCommand() {
      if (!('install' in options)) throw new Error('This Antigravity has no binary of its own.');
      return { file: (await options.install.prepare()).path, args: ['acp', '--login'] };
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

function fromBinary(binary: Binary): StartAgy {
  return (cwd, args) => Promise.resolve(spawnAgy(binary.path, cwd, args, launchEnv(binary)));
}

async function withFolder<Result>(
  prefix: string,
  use: (cwd: string) => Promise<Result>,
): Promise<Result> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  probeFolders.add(cwd);
  try {
    return await use(cwd);
  } finally {
    probeFolders.delete(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

async function connectAgy(
  start: StartAgy,
  cwd: string,
  args: string[],
  inSandbox: boolean,
  handlers: Handlers,
  clientVersion: string,
): Promise<Agent> {
  const process = await start(cwd, args);
  const connection = client({ name: '3mukon-code' })
    .onNotification('session/update', ({ params }) => {
      handlers.update(params);
    })
    .onRequest('session/request_permission', ({ params, signal }) =>
      handlers.permission(params, signal),
    )
    .onRequest('elicitation/create', ({ params, signal }) => handlers.question(params, signal))
    .connect(process.stream);
  try {
    // The app reads and writes no files and runs no terminals for Antigravity, which uses its own
    // tools, and shows the forms through which Antigravity's question tool asks.
    const initialize = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
      clientInfo: { name: '3mukon-code', title: '3mukon-code', version: clientVersion },
    });
    return { process, connection, initialize, sandboxed: inSandbox };
  } catch (error) {
    await stopAgent({ process, connection });
    throw error;
  }
}

async function stopAgent({ process, connection }: Pick<Agent, 'process' | 'connection'>) {
  connection.close();
  await process.stop();
}

// Every session Antigravity lists, page by page.
async function agySessions(connection: ClientConnection, cwd: string): Promise<SessionInfo[]> {
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

// One exchange with a short-lived process, a probe, without the terminal sandbox, since it runs no turn.
// The answer comes as soon as the exchange ends, without waiting for the process to stop, which the
// probes wait for as the provider closes.
async function withAgy<Result>(
  connect: ProbeConnect,
  cwd: string,
  use: (agent: Agent) => Promise<Result>,
  update: Handlers['update'] = () => undefined,
): Promise<Result> {
  const agent = await connect(cwd, {
    update,
    permission: () => Promise.resolve(cancelledPermission),
    question: () => Promise.resolve(cancelledForm),
  });
  try {
    return await use(agent);
  } finally {
    stopAgent(agent).catch(() => undefined);
  }
}

// The models a session can choose and their defaults.
interface Catalog {
  models: ModelOption[];
  defaultModel: string | undefined;
  defaultEfforts: Map<string, ReasoningEffort>;
}

// The models of a session's configuration options, each with its thinking levels: the session's model
// takes those its thinking-level option lists, and every other model those its variants in ACP's model
// list name, as Antigravity lists `gemini-3.8-flash-low` beside `gemini-3.8-flash`. The model the
// session runs is the default, with the thinking level it runs at.
function catalogOf(options: readonly SessionConfigOption[], listed: unknown): Catalog {
  const modelOption = options.find((option) => option.id === MODEL_OPTION);
  const effortOption = options.find((option) => option.id === EFFORT_OPTION);
  const current = currentChoices(options);
  const levels = effortOption === undefined ? [] : selectValues(effortOption).map((v) => v.value);
  const variants = Array.isArray(record(listed)?.availableModels)
    ? (record(listed)?.availableModels as unknown[]).flatMap((entry) => {
        const id = record(entry)?.modelId;
        return typeof id === 'string' ? [id] : [];
      })
    : [];
  const known = new Set([...LEVELS, ...levels]);
  const models = (modelOption === undefined ? [] : selectValues(modelOption)).map(
    ({ value, name }): ModelOption => {
      const efforts =
        value === current.model
          ? levels
          : variants.flatMap((id) => {
              const level = id.startsWith(`${value}-`) ? id.slice(value.length + 1) : '';
              return known.has(level) ? [level] : [];
            });
      const ordered = [...new Set(efforts)].sort(
        (left, right) => rank(left) - rank(right) || left.localeCompare(right),
      );
      return {
        id: value,
        label: name,
        efforts: ordered,
        ...(value === current.model ? { default: true } : {}),
        ...(value === current.model && current.effort !== undefined
          ? { defaultEffort: current.effort }
          : {}),
      };
    },
  );
  const defaultEfforts = new Map<string, ReasoningEffort>();
  if (current.model !== undefined && current.effort !== undefined) {
    defaultEfforts.set(current.model, current.effort);
  }
  return { models, defaultModel: current.model, defaultEfforts };
}

function rank(level: string): number {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// A select option's values, flat or in groups.
function selectValues(option: SessionConfigOption): { value: string; name: string }[] {
  if (option.type !== 'select') return [];
  return (option.options as unknown[]).flatMap((entry) => {
    const item = record(entry);
    if (item === undefined) return [];
    if (Array.isArray(item.options)) {
      return (item.options as unknown[]).flatMap((nested) => {
        const value = record(nested);
        return typeof value?.value === 'string'
          ? [
              {
                value: value.value,
                name: typeof value.name === 'string' ? value.name : value.value,
              },
            ]
          : [];
      });
    }
    return typeof item.value === 'string'
      ? [{ value: item.value, name: typeof item.name === 'string' ? item.name : item.value }]
      : [];
  });
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
      return { type: 'turn-ended', outcome: 'failed', error: 'Antigravity refused to go on.' };
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

// A process with the session created, loaded or resumed on it, not yet in use: its configuration
// options, the modes it offers and the one it runs, ACP's list of models, and the MCP servers it was
// given for the session.
interface Attached {
  agent: Agent;
  level: SandboxLevel;
  generation: number;
  sessionId: string;
  configOptions: SessionConfigOption[];
  modes: string[];
  currentMode: string | undefined;
  listed: unknown;
  mcpServers: NewSessionRequest['mcpServers'];
}

type Pending =
  | {
      kind: 'approval';
      options: PermissionOption[];
      beyond: boolean;
      resolve: (result: RequestPermissionResponse) => void;
    }
  | { kind: 'question'; fields: FormField[]; resolve: (result: CreateElicitationResponse) => void };

// A message of the user's, with its images.
// The presentation notices a prompt carries, as a delivery accepts them.
type PresentationNotices = ReturnType<typeof selectPresentationNotices>;

// The session updates that are the agent's output for a turn, the first of which shows that it took
// the prompt that opened the turn.
const OUTPUT: ReadonlySet<string> = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

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

function imageBlock(image: MessageImage): ContentBlock {
  return { type: 'image', mimeType: image.mediaType, data: image.data };
}

// The modes a session's answer offers, and the one it runs.
function modesOf(answer: unknown): { modes: string[]; currentMode: string | undefined } {
  const state = record(record(answer)?.modes);
  const available = Array.isArray(state?.availableModes) ? (state.availableModes as unknown[]) : [];
  const current = state?.currentModeId;
  return {
    modes: available.flatMap((mode) => {
      const id = record(mode)?.id;
      return typeof id === 'string' ? [id] : [];
    }),
    currentMode: typeof current === 'string' ? current : undefined,
  };
}

class AntigravitySession implements ProviderSession {
  private hostEnabled = false;
  get supportsHostContext(): true | undefined {
    return this.agent.initialize.agentCapabilities?.promptCapabilities?.embeddedContext === true
      ? true
      : undefined;
  }
  private readonly deliveries = new Set<HostContextDelivery>();
  // The messages of the prompt that opened the running turn, with the presentation notices it carried,
  // which Antigravity's first output for the turn accepts, so that the notices they gave show before
  // what the agent makes of them; a prompt that steers a running turn is accepted as it is answered.
  private opening: { messages: Message[]; notices: PresentationNotices } | null = null;
  private access?: ToolsetAccess;
  private agent!: Agent;
  private sessionId = '';
  private readonly translator: Translator;
  // Each process's handlers act only while it is the session's current one. The first process is
  // number 1, so 0 stands for none, as while the process is being replaced.
  private generation = 0;
  private generations = 0;
  private catalog: Catalog = { models: [], defaultModel: undefined, defaultEfforts: new Map() };
  private configOptions: SessionConfigOption[] = [];
  private modes: string[] = [];
  private currentMode: string | undefined;
  // ACP's list of models from the last answer that gave one, which a resume's answer leaves out.
  private listed: unknown;
  // The level the current process serves, to which a failed switch goes back.
  private servedLevel: SandboxLevel = 'workspace-write';
  private mcpServers: NewSessionRequest['mcpServers'] = [];
  private readonly pending = new Map<string, Pending>();
  // While Antigravity replays a session it loads, the user's own messages come from it; otherwise from
  // the session.
  private replaying = false;
  private turnRunning = false;
  // The prompts sent in the running turn that Antigravity has not answered. A prompt sent during a turn
  // steers it: Antigravity answers the one before at once and goes on under the new one, so the turn
  // ends with the answer to its last prompt.
  private prompts = 0;
  private closing = false;
  private closed = false;
  // A sandbox level asked for during a turn, which needs a new process once the turn ends.
  private sandboxPending = false;
  // The process switch under way, which a message waits for; it never rejects.
  private switching: Promise<void> | null = null;

  get id(): string {
    return this.sessionId;
  }

  // Creates the session, or loads it and replays its history, and resolves once Antigravity has it.
  static async open(
    options: StartOptions,
    resumeId: string | null,
    connect: Connect,
    link: AccountLink,
    onEvent: SessionEventListener,
  ): Promise<AntigravitySession> {
    const settings = sessionSettings(options);
    const session = new AntigravitySession(settings, connect, link, onEvent);
    const attached = await session.attach(resumeId === null ? null : { load: true, resumeId });
    session.use(attached);
    try {
      if (resumeId !== null) onEvent({ type: 'replay-finished' });
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

  async send(
    text: string,
    images: MessageImage[] = [],
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    this.translator.endMessage();
    if (!this.turnRunning) {
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
    if (delivery) this.deliveries.add(delivery);
    this.prompt([{ text, images, context, delivery }]);
  }

  // Sends a prompt: the context, the messages' text, then their images. ACP answers a prompt when its
  // turn ends, or, for a prompt that a later one steered, once that one takes over; the turn's progress
  // comes before as session updates. A connection that closes first is the session's end, which closed
  // reports.
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
    const { connection } = this.agent;
    if (this.prompts === 0) this.opening = { messages, notices };
    this.prompts += 1;
    connection.agent.request('session/prompt', { sessionId: this.sessionId, prompt }).then(
      (response) => {
        if (this.opening?.messages === messages) this.opening = null;
        this.accept(messages, notices);
        this.prompts = Math.max(0, this.prompts - 1);
        if (this.prompts === 0) this.endTurn(turnEndedBy(response.stopReason));
      },
      (error: unknown) => {
        if (this.opening?.messages === messages) this.opening = null;
        for (const message of messages) {
          if (message.delivery && this.deliveries.has(message.delivery)) {
            message.delivery.failed();
            this.deliveries.delete(message.delivery);
          }
        }
        this.prompts = Math.max(0, this.prompts - 1);
        if (connection.signal.aborted) return;
        if (isSignInError(error)) this.link.hear({ type: 'signed-out' });
        if (this.prompts === 0) {
          this.endTurn({ type: 'turn-ended', outcome: 'failed', error: errorMessage(error) });
        }
      },
    );
  }

  // Accepts the deliveries of the messages that are neither accepted nor failed yet.
  private accept(messages: Message[], notices: PresentationNotices): void {
    for (const message of messages) {
      if (message.delivery && this.deliveries.has(message.delivery)) {
        message.delivery.accepted(notices);
        this.deliveries.delete(message.delivery);
      }
    }
  }

  // ACP has the client answer what is still open as cancelled once it cancels the turn.
  async interrupt(): Promise<void> {
    this.opening = null;
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
    pending.resolve(formResult(pending.fields, answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  // The mode takes effect at once. Approvals already waiting when the session enters yolo are answered
  // as yolo answers them: allowed within the session's level, denied beyond it.
  async setMode(mode: PermissionMode): Promise<void> {
    await this.ready();
    this.settings.mode = mode;
    await this.applyMode();
    this.onEvent({ type: 'mode', mode });
    if (mode !== 'yolo') return;
    for (const [requestId, pending] of this.pending) {
      if (pending.kind !== 'approval') continue;
      this.pending.delete(requestId);
      pending.resolve(
        approvalResult(pending.options, { decision: pending.beyond ? 'deny' : 'allow-once' }),
      );
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    }
  }

  // Antigravity switches its model and its thinking level at once, through its configuration options.
  // Going back to the default sets the model the session started with, or the model's own level.
  async setModel(model: string | null): Promise<void> {
    await this.ready();
    const value = model ?? this.catalog.defaultModel;
    if (value !== undefined) await this.setOption(MODEL_OPTION, value);
    this.settings.model = model;
    this.onEvent({ type: 'settings', model });
  }

  async setEffort(effort: ReasoningEffort | null): Promise<void> {
    await this.ready();
    const model = this.choices().model;
    const value =
      effort ?? (model === undefined ? undefined : this.catalog.defaultEfforts.get(model));
    if (value !== undefined) await this.setOption(EFFORT_OPTION, value);
    this.settings.effort = effort;
    this.onEvent({ type: 'settings', effort });
  }

  // The terminal sandbox holds for a whole process, so a switch to or from full access moves the
  // session to a new process, between turns: at once when no turn runs, and otherwise once the turn
  // ends. A switch between read-only and workspace-write changes only Antigravity's mode and the
  // adapter's answers (ADR-0040), at once.
  async setSandbox(sandbox: SandboxLevel): Promise<void> {
    if (this.closed) throw new Error('The session is closed.');
    this.settings.sandbox = sandbox;
    this.onEvent({ type: 'settings', sandbox });
    if (sandboxed(sandbox) === this.agent.sandboxed) {
      await this.ready();
      await this.applyMode();
      this.servedLevel = sandbox;
      return;
    }
    if (this.turnRunning) {
      this.sandboxPending = true;
      return;
    }
    await this.switchSandbox();
  }

  setGateway(gateway: string | null): Promise<void> {
    return gateway === null ? Promise.resolve() : Promise.reject(new Error(NO_GATEWAYS));
  }

  // A turn of the app's own with the host context alone, as the notice of new messages (ADR-0036): no
  // message of the user's goes with it or shows.
  async deliverContext(context: HostTurnContext, delivery: HostContextDelivery): Promise<void> {
    await this.ready();
    if (this.turnRunning) throw new Error('A turn is running.');
    this.translator.endMessage();
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
    this.deliveries.add(delivery);
    this.prompt([{ text: '', images: [], context, delivery }]);
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
    if (existing !== null) this.sessionId = existing.resumeId;
    const agent = await this.connect(this.settings.cwd, sandbox, this.handlers(generation)).catch(
      (error: unknown) => {
        access?.close();
        throw error;
      },
    );
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
    // The toolset goes by its own name, which Antigravity takes as it is, naming its tools
    // `mcp_3mukon-code_<tool>`.
    const params: NewSessionRequest = {
      cwd: this.settings.cwd,
      mcpServers:
        http && access && this.settings.toolset
          ? [
              {
                type: 'http',
                name: this.settings.toolset.name,
                url: access.url,
                headers: [{ name: 'Authorization', value: `Bearer ${access.credential}` }],
              },
            ]
          : [],
    };
    const { mcpServers } = params;
    try {
      if (existing === null) {
        const response = await agent.connection.agent.request('session/new', params);
        return {
          agent,
          level: sandbox,
          generation,
          sessionId: response.sessionId,
          configOptions: response.configOptions ?? [],
          ...modesOf(response),
          listed: record(response)?.models,
          mcpServers,
        };
      }
      const { resumeId: sessionId } = existing;
      this.replaying = existing.load;
      const response = existing.load
        ? await agent.connection.agent.request('session/load', { ...params, sessionId })
        : await agent.connection.agent.request('session/resume', { ...params, sessionId });
      return {
        agent,
        level: sandbox,
        generation,
        sessionId,
        configOptions: response.configOptions ?? [],
        ...modesOf(response),
        listed: record(response)?.models,
        mcpServers,
      };
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
  private use(attached: Attached): void {
    const { agent, generation, sessionId, configOptions, modes, currentMode, listed } = attached;
    this.agent = agent;
    this.generation = generation;
    this.sessionId = sessionId;
    this.configOptions = configOptions;
    this.modes = modes;
    this.currentMode = currentMode;
    this.mcpServers = attached.mcpServers;
    this.servedLevel = attached.level;
    if (listed !== undefined) this.listed = listed;
    this.catalog = catalogOf(configOptions, this.listed);
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
        if (update.sessionUpdate === 'user_message_chunk' && !this.replaying) return;
        if (update.sessionUpdate === 'current_mode_update') {
          this.currentMode = update.currentModeId;
          return;
        }
        if (update.sessionUpdate === 'config_option_update') {
          this.configOptions = update.configOptions;
        }
        if (this.opening !== null && OUTPUT.has(update.sessionUpdate)) {
          const { messages, notices } = this.opening;
          this.opening = null;
          this.accept(messages, notices);
        }
        for (const event of this.translator.update(update)) this.onEvent(event);
      },
      permission: (params, signal) =>
        current() ? this.askApproval(params, signal) : Promise.resolve(cancelledPermission),
      question: (params, signal) =>
        current() ? this.askQuestion(params, signal) : Promise.resolve(cancelledForm),
    };
  }

  // The model and thinking level chosen for the session, and Antigravity's mode behind the app's, on its
  // current process. A level the model does not take is left to Antigravity.
  private async applySettings(): Promise<void> {
    const { model, effort } = this.settings;
    if (model !== null) await this.setOption(MODEL_OPTION, model);
    if (effort !== null && this.efforts().includes(effort)) {
      await this.setOption(EFFORT_OPTION, effort);
    }
    await this.applyMode();
  }

  // Antigravity's mode behind the session's mode and level (ADR-0040), set where it differs. Should
  // Antigravity refuse its auto mode after all, its default mode runs.
  private async applyMode(): Promise<void> {
    const wanted = agyMode(this.settings.mode, this.settings.sandbox, this.modes);
    if (wanted === this.currentMode) return;
    try {
      await this.setAgyMode(wanted);
    } catch (error) {
      if (wanted === DEFAULT) throw error;
      await this.setAgyMode(DEFAULT);
    }
  }

  private async setAgyMode(modeId: string): Promise<void> {
    await this.agent.connection.agent.request('session/set_mode', {
      sessionId: this.sessionId,
      modeId,
    });
    this.currentMode = modeId;
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

  // The thinking levels the session's model takes, as its option lists them.
  private efforts(): string[] {
    const option = this.configOptions.find((entry) => entry.id === EFFORT_OPTION);
    return option === undefined ? [] : selectValues(option).map((entry) => entry.value);
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
    if (this.closed || sandboxed(target) === previous.sandboxed) return;
    const existing = { load: false, resumeId: this.sessionId };
    this.generation = 0;
    await stopAgent(previous);
    let attached: Attached;
    try {
      attached = await this.attach(existing, target);
    } catch (error) {
      const earlier = this.servedLevel;
      this.settings.sandbox = earlier;
      this.onEvent({ type: 'settings', sandbox: earlier });
      try {
        this.use(await this.attach(existing, earlier));
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
    await this.applySettings();
    this.onEvent({ type: 'models', models: this.catalog.models });
  }

  // A call of one of the app's own tools is the broker's to authorize, which enforces its own grants
  // (ADR-0023), so it is allowed here; any other request waits for the user, or in yolo is answered
  // at once: allowed within the session's level, denied beyond it (ADR-0040).
  private askApproval(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (params.sessionId === this.sessionId && this.hostTool(params.toolCall) !== undefined) {
      return Promise.resolve(approvalResult(params.options, { decision: 'allow-once' }));
    }
    const known = this.translator.callOf(params.toolCall.toolCallId);
    const beyond = beyondLevel(params.toolCall, this.settings.sandbox, this.settings.cwd, known);
    const { request, options } = permissionApproval(
      randomUUID(),
      params,
      this.context(),
      known,
      beyond,
    );
    if (this.settings.mode === 'yolo') {
      return Promise.resolve(approvalResult(options, { decision: beyond ? 'deny' : 'allow-once' }));
    }
    return new Promise((resolve) => {
      this.pending.set(request.id, { kind: 'approval', options, beyond, resolve });
      this.whenAborted(signal, request.id);
      this.onEvent({ type: 'approval-requested', request });
    });
  }

  // One of the session's registered tools in this app's server, by the name Antigravity gives the call.
  private hostTool(call: ToolCallUpdate): string | undefined {
    if (!this.hostEnabled || this.settings.toolset === undefined) return undefined;
    const name = toolNameOf(call);
    return name === undefined
      ? undefined
      : registeredTool(name, `mcp_${this.settings.toolset.name}_`, this.access?.tools);
  }

  // A form from Antigravity's question tool waits for the user; any other kind of elicitation, such as a
  // link to open, is cancelled.
  private askQuestion(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const scope = record(params);
    if (scope?.sessionId !== undefined && scope.sessionId !== this.sessionId) {
      return Promise.resolve(cancelledForm);
    }
    const form = formQuestion(randomUUID(), params, this.context());
    if (form === undefined) return Promise.resolve(cancelledForm);
    const { request, fields } = form;
    return new Promise((resolve) => {
      this.pending.set(request.id, { kind: 'question', fields, resolve });
      this.whenAborted(signal, request.id);
      this.onEvent({ type: 'question-asked', request });
    });
  }

  private context(): { cwd: string; now: number } {
    return { cwd: this.settings.cwd, now: Date.now() };
  }

  // Antigravity gives a request up, as when its turn is cancelled, or the connection closes.
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
    else pending.resolve(cancelledForm);
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
  }

  private withdrawAll(): void {
    for (const requestId of [...this.pending.keys()]) this.withdraw(requestId);
  }

  // The turn has ended: what Antigravity left open is cancelled, and a level asked for during the turn
  // takes over.
  private endTurn(event: TurnEnded): void {
    if (this.closed || this.closing || !this.turnRunning) return;
    this.turnRunning = false;
    this.prompts = 0;
    this.withdrawAll();
    this.translator.endMessage();
    this.onEvent(event);
    if (this.sandboxPending) {
      this.sandboxPending = false;
      this.switchSandbox().catch((error: unknown) => {
        this.onEvent({ type: 'error', message: errorMessage(error) });
      });
    }
  }

  // The session has ended: what is still open is cancelled, and closed is reported once.
  private finish(error: string | undefined): void {
    if (this.closed) return;
    this.withdrawAll();
    this.closed = true;
    this.opening = null;
    for (const delivery of this.deliveries) delivery.failed();
    this.deliveries.clear();
    this.access?.close();
    this.turnRunning = false;
    this.prompts = 0;
    this.onEvent(error === undefined ? { type: 'closed' } : { type: 'closed', error });
  }
}
