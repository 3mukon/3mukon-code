import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  Probes,
  toolsetErrorMessage,
  toolsetError,
  type ProbeProcess,
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
import type { Availability } from '../../../sessions/shared/automation';
import { registeredTool, toolsetReceipt } from '../../../sessions/shared/toolset-result';
import {
  presentationContext,
  selectPresentationNotices,
} from '../../../sessions/shared/host-context';
import { inboxContext, INBOX_CONTEXT_TITLE } from '../../../sessions/shared/inbox';
import type {
  ApprovalAnswer,
  MessageImage,
  ModelOption,
  PermissionMode,
  QuestionAnswer,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../../../sessions/shared/events';
import type { SendableImageType } from '../../../sessions/shared/images';
import type { AccountNews, AccountSource } from '../../../accounts/main/source';
import { eventWindows, experimentalWindows, readClaudeSignIn } from './account';
import { bundledClaudeBinary } from './binary';
import { defaultGatewaysDir, existingGatewayPath, gatewayPath, listGateways } from './gateways';
import { approvalResult, questionResult, toRequest, type ClaudeRequest } from './requests';
import { sandboxFolders, sandboxSettings, type SandboxFolders } from './sandbox';
import { Translator } from './translate';

// Claude Code's own mode behind each of the app's two permission modes: in auto, Claude Code's
// classifier approves or denies each action and asks through canUseTool only when it cannot decide.
export const nativeModes: Record<PermissionMode, ClaudePermissionMode> = {
  auto: 'auto',
  yolo: 'bypassPermissions',
};

const EFFORT_LEVELS = new Set<string>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] satisfies EffortLevel[]);

// How long a probe gives Claude Code to start before the list of models fails.
const PROBE_TIMEOUT_MS = 30_000;
// How long a title may take to be written, from the start of its Claude Code, before it fails.
const TITLE_TIMEOUT_MS = 120_000;
// The system prompt a title is written with, in place of Claude Code's own, which is for a coding
// agent.
const TITLE_SYSTEM_PROMPT =
  'You write short titles for conversations, and reply with the title alone.';
// How long Claude Code's own count of the context may take before it is left out.
const COUNT_TIMEOUT_MS = 5_000;
// How long a gateway switch waits for the switches already sent to the process it ends.
const SENT_TIMEOUT_MS = 10_000;

// The folders of the probes still listing models, removed as the app's process exits, should it quit
// during a probe, so that quitting leaves none behind.
const probeFolders = new Set<string>();
process.on('exit', () => {
  for (const folder of probeFolders) rmSync(folder, { recursive: true, force: true });
});

// Claude Code's effort level for the app's choice; throws for a level Claude Code does not have.
function effortLevel(effort: ReasoningEffort | null): EffortLevel | null {
  if (effort === null || EFFORT_LEVELS.has(effort)) return effort as EffortLevel | null;
  throw new Error(`Claude Code has no reasoning effort "${effort}".`);
}

export interface ClaudeCodeProviderOptions {
  // The folder of gateway files; Claude Code's own gateways folder when left out.
  gatewaysDir?: string;
}

// How the sessions take part in Claude Code's account (ADR-0017): those running on Claude Code's own
// sign-in lend their queries to the account's usage call, and pass on what Claude Code reports of the
// account.
interface AccountLink {
  readonly sessions: Set<ClaudeCodeSession>;
  hear(news: AccountNews): void;
}

// Claude Code through the Claude Agent SDK, on whatever sign-in Claude Code itself has, and that
// sign-in's account with its plan's usage limits (ADR-0017).
export function createClaudeCodeProvider({
  gatewaysDir = defaultGatewaysDir(),
}: ClaudeCodeProviderOptions = {}): Provider & AccountSource {
  // The processes it starts outside its sessions: the models' and the usage's probes, and the status
  // command that says how Claude Code is signed in.
  const probes = new Probes();
  const listeners = new Set<(news: AccountNews) => void>();
  const link: AccountLink = {
    sessions: new Set(),
    hear(news) {
      for (const listener of listeners) listener(news);
    },
  };
  return {
    id: 'claude-code',
    async start(options, onEvent) {
      const settings = await sessionSettings(options, gatewaysDir, randomUUID(), false);
      return ClaudeCodeSession.open(settings, onEvent, new Translator(options.cwd), link);
    },
    async resume(options, onEvent) {
      const settings = await sessionSettings(options, gatewaysDir, options.sessionId, true);
      const translator = new Translator(options.cwd);
      for (const message of await getSessionMessages(options.sessionId, { dir: options.cwd })) {
        for (const event of translator.history(message)) onEvent(event);
      }
      onEvent({ type: 'replay-finished' });
      return ClaudeCodeSession.open(settings, onEvent, translator, link);
    },
    // Read from Claude Code's own transcript, without starting Claude Code, with the title Claude Code
    // keeps for the session where it keeps one, as a running session reports it.
    async history(sessionId, cwd) {
      const translator = new Translator(cwd);
      const [messages, info] = await Promise.all([
        getSessionMessages(sessionId, { dir: cwd }),
        getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined),
      ]);
      const events = messages.flatMap((message) => translator.history(message));
      const title = info?.customTitle;
      return title === undefined || title === '' ? events : [...events, { type: 'title', title }];
    },
    async listSessions(cwd, limit) {
      const sessions = await listSessions({ dir: cwd, limit });
      return sessions.map((session) => ({
        id: session.sessionId,
        // The user's title or Claude Code's own, or else the first prompt, which stays as the session
        // goes on, where the summary would be the latest prompt.
        title: session.customTitle ?? session.firstPrompt ?? session.summary,
        cwd: session.cwd ?? cwd,
        updatedAt: session.lastModified,
      }));
    },
    listGateways() {
      return listGateways(gatewaysDir);
    },
    async listModels(gateway) {
      return probeModels(
        probes,
        gateway === null ? null : await existingGatewayPath(gatewaysDir, gateway),
      );
    },
    // A title from a Claude Code of its own (ADR-0035).
    async writeTitle(request) {
      const gatewayFile =
        request.gateway === null ? null : await existingGatewayPath(gatewaysDir, request.gateway);
      return probeTitle(probes, gatewayFile, request);
    },
    // The sign-in from Claude Code's own status; the usage through a running session's query on
    // Claude Code's own sign-in, or else through a probe.
    async readAccount(withUsage) {
      const signIn = await readClaudeSignIn(bundledClaudeBinary(), probes);
      if (!withUsage || signIn.state !== 'signed-in' || signIn.method !== 'subscription') {
        return { signIn };
      }
      let query: Query | null = null;
      for (const session of link.sessions) query ??= session.accountQuery();
      let answer: SDKControlGetUsageResponse;
      try {
        answer = query === null ? await probeUsage(probes) : await usageOf(query);
      } catch (error) {
        console.error('Claude Code could not be asked for its usage:', error);
        return { signIn, usageProblem: 'unreachable' };
      }
      // Without windows, Claude Code could not fetch them for the sign-in it holds, as when its
      // usage endpoint refuses that sign-in.
      const windows = experimentalWindows(answer);
      return windows === undefined
        ? { signIn, usageProblem: 'refused' }
        : { signIn, usage: { windows } };
    },
    signInCommand() {
      return Promise.resolve({ file: bundledClaudeBinary(), args: ['auth', 'login'] });
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

// The plan's usage limits through the SDK's experimental call (ADR-0017), without the scan of the
// local transcripts that it otherwise makes.
function usageOf(query: Query): Promise<SDKControlGetUsageResponse> {
  return query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
}

// The plan's usage limits from a Claude Code that initializes and is closed before any message, as
// the models' probe does, on the user's own settings with their hooks off.
async function probeUsage(probes: Probes): Promise<SDKControlGetUsageResponse> {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-code-usage-'));
  probeFolders.add(cwd);
  let probe: ClaudeProbe | undefined;
  try {
    probe = await startProbe(probes, {
      pathToClaudeCodeExecutable: bundledClaudeBinary(),
      cwd,
      persistSession: false,
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      settingSources: ['user'],
      settings: { disableAllHooks: true },
    });
    await withinTime(
      probe.query.initializationResult(),
      PROBE_TIMEOUT_MS,
      'Claude Code did not start in time to read its usage.',
    );
    return await usageOf(probe.query);
  } finally {
    void probe?.stop();
    probeFolders.delete(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

// A Claude Code started outside a session, with no message to send, such as the models' probe.
interface ClaudeProbe extends ProbeProcess {
  readonly query: Query;
}

// Starts a probe on the options. The SDK runs Claude Code through the app's own spawn, as it would
// itself but without Claude Code's error output, so that the probe knows when the process has exited,
// which takes Claude Code about two seconds once closed; the probes keep it until then. The answer
// does not wait for it.
function startProbe(
  probes: Probes,
  options: Options,
  messages: readonly SDKUserMessage[] = [],
): Promise<ClaudeProbe> {
  return probes.start(() => {
    const input = new InputQueue();
    for (const message of messages) input.push(message);
    let spawned = false;
    let stopping = false;
    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const probe = query({
      prompt: input,
      options: {
        ...options,
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          spawned = true;
          const child = spawn(command, args, {
            cwd,
            env,
            signal,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          child.once('exit', markEnded);
          child.once('error', () => {
            // Only a process that never started ends with its error; any other exits too.
            if (child.pid === undefined) markEnded();
          });
          return child;
        },
      },
    });
    return {
      query: probe,
      ended,
      stop() {
        if (!stopping) {
          stopping = true;
          input.end();
          probe.close();
          if (!spawned) markEnded();
        }
        return ended;
      },
    };
  });
}

async function sessionSettings(
  options: StartOptions,
  gatewaysDir: string,
  sessionId: string,
  resume: boolean,
): Promise<SessionSettings> {
  if (options.gateway !== undefined) await existingGatewayPath(gatewaysDir, options.gateway);
  return {
    cwd: options.cwd,
    mode: options.mode ?? 'auto',
    sessionId,
    resume,
    gatewaysDir,
    gateway: options.gateway ?? null,
    model: options.model ?? null,
    effort: effortLevel(options.effort ?? null),
    sandbox: options.sandbox ?? 'workspace-write',
    folders: await sandboxFolders(options.cwd),
    ...(options.toolset ? { toolset: options.toolset } : {}),
  };
}

// The models a session would have, from a Claude Code that initializes and is closed before any message,
// so that no session is recorded, with the model it would use marked as the default. Its auto-memory is
// off, or Claude Code would leave a memory folder for the throwaway folder in its projects folder. Through a gateway
// it reads only the gateway's file; otherwise it reads the user's own settings, with their hooks off,
// so that the default is the model they set. It never reads a project's settings, whose hooks and
// servers could run from a folder no one trusted yet. The app opens none of these files itself. A
// Claude Code that has not started within the probe's time is closed, and the list fails.
async function probeModels(probes: Probes, gatewayFile: string | null): Promise<ModelOption[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-code-models-'));
  probeFolders.add(cwd);
  let probe: ClaudeProbe | undefined;
  try {
    probe = await startProbe(probes, {
      pathToClaudeCodeExecutable: bundledClaudeBinary(),
      cwd,
      persistSession: false,
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      ...(gatewayFile === null
        ? { settingSources: ['user'], settings: { disableAllHooks: true } }
        : { settingSources: [], settings: gatewayFile }),
    });
    const init = await withinTime(
      probe.query.initializationResult(),
      PROBE_TIMEOUT_MS,
      'Claude Code did not start in time to list its models.',
    );
    return modelOptions(init.models, (await countContext(probe.query))?.model);
  } finally {
    void probe?.stop();
    probeFolders.delete(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

// A title from a Claude Code that answers one message and is closed (ADR-0035): in a throwaway
// folder, with the session's model and effort, a system prompt of the app's own, no tools and no
// servers, one turn and no transcript kept, so that no session is recorded; through the gateway's
// file, or else on the user's own settings with their hooks off, as the models' probe reads them.
async function probeTitle(
  probes: Probes,
  gatewayFile: string | null,
  { model, effort, prompt }: TitleRequest,
): Promise<string> {
  const level = effortLevel(effort);
  const cwd = await mkdtemp(join(tmpdir(), 'claude-code-title-'));
  probeFolders.add(cwd);
  let probe: ClaudeProbe | undefined;
  try {
    probe = await startProbe(
      probes,
      {
        pathToClaudeCodeExecutable: bundledClaudeBinary(),
        cwd,
        persistSession: false,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        ...(gatewayFile === null
          ? { settingSources: ['user'], settings: { disableAllHooks: true } }
          : { settingSources: [], settings: gatewayFile }),
        systemPrompt: TITLE_SYSTEM_PROMPT,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        ...(model === null ? {} : { model }),
        ...(level === null ? {} : { effort: level }),
      },
      [
        {
          type: 'user',
          uuid: randomUUID(),
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        },
      ],
    );
    return await withinTime(
      replyOf(probe.query),
      TITLE_TIMEOUT_MS,
      'Claude Code did not write the title in time.',
    );
  } finally {
    void probe?.stop();
    probeFolders.delete(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

// The text of the turn's result, or its errors.
async function replyOf(messages: AsyncIterable<SDKMessage>): Promise<string> {
  for await (const message of messages) {
    if (message.type !== 'result') continue;
    if (message.subtype === 'success' && !message.is_error) return message.result;
    throw new Error(
      'errors' in message && message.errors.length > 0
        ? message.errors.join(' ')
        : 'Claude Code could not write the title.',
    );
  }
  throw new Error('Claude Code ended before it wrote the title.');
}

// The models a session can choose, with the one it uses when it chooses none, as Claude Code reports
// it, marked as the default. Claude Code's own default row stands for that model, so it goes unless no
// other row is that model.
function modelOptions(models: ModelInfo[], current: string | undefined): ModelOption[] {
  const isCurrent = (model: ModelInfo) =>
    current !== undefined && (model.value === current || model.resolvedModel === current);
  const own = models.find((model) => model.value !== 'default' && isCurrent(model));
  return models.flatMap((model) => {
    if (model.value === 'default' && own !== undefined) return [];
    const marked = model === own || (own === undefined && model.value === 'default');
    return [
      {
        id: model.value,
        label: model.displayName,
        ...(model.description === '' ? {} : { description: model.description }),
        efforts: model.supportedEffortLevels ?? [],
        ...(marked ? { default: true } : {}),
      },
    ];
  });
}

// Claude Code's own count of the context, from the last response's usage and local estimates without
// asking the API, which names the model in use; nothing when the count fails or takes too long.
function countContext(query: Query): Promise<SDKControlGetContextUsageResponse | undefined> {
  return withinTime(
    query.getContextUsage({ detail: 'summary' }),
    COUNT_TIMEOUT_MS,
    'Claude Code did not count the context in time.',
  ).catch(() => undefined);
}

// Whether the session's model takes images, which Claude Code does not say. Every Claude model does.
// What another model takes, or one a gateway gives a Claude model's name, the app cannot know.
function imageInput(gateway: string | null, model: string | undefined): Availability['images'] {
  return gateway === null && model?.includes('claude-') === true ? 'supported' : 'unknown';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SessionSettings {
  toolset?: Toolset;
  cwd: string;
  mode: PermissionMode;
  sessionId: string;
  // Whether Claude Code holds a transcript of the session to continue.
  resume: boolean;
  gatewaysDir: string;
  gateway: string | null;
  model: string | null;
  effort: EffortLevel | null;
  sandbox: SandboxLevel;
  folders: SandboxFolders;
}

// One Claude Code process serving the session; a gateway switch replaces it.
interface Connection {
  readonly deliveries: Map<string, HostContextDelivery>;
  // The message of a turn of the app's own, which carries host context alone and which Claude Code
  // may not echo, as it echoes a message with text: its delivery is accepted, too, as the turn's
  // first output comes.
  contextOnly?: string;
  readonly access?: ToolsetAccess;
  // What the toolset last heard of the model's image input.
  images?: Availability['images'];
  readonly toolNames: Map<string, string>;
  readonly input: InputQueue;
  readonly query: Query;
  // Settles once the process's messages have ended.
  done: Promise<void>;
}

class ClaudeCodeSession implements ProviderSession {
  readonly supportsHostContext = true;
  readonly id: string;
  private connection: Connection;
  // Connections that a gateway switch replaced; their end does not end the session.
  private readonly retired = new WeakSet<Connection>();
  private readonly pending = new Map<
    string,
    { request: ClaudeRequest; resolve: (result: PermissionResult) => void }
  >();
  private turnRunning = false;
  private interrupting = false;
  // Whether the last result left messages in Claude Code's queue, which it runs as the next turn.
  private followUp = false;
  private closing = false;
  private closed = false;
  // A gateway asked for during a turn, which takes over when the turn ends.
  private pendingGateway: string | null | undefined;
  // The gateway switch under way, which a message waits for; it never rejects.
  private switching: Promise<void> | null = null;
  // The switches sent to the running process and not yet answered, which a gateway switch lets
  // finish there first.
  private readonly sent = new Set<Promise<void>>();
  // The title last reported.
  private title: string | undefined;

  // Resolves once Claude Code has started and answered the SDK's initialization.
  static async open(
    settings: SessionSettings,
    onEvent: SessionEventListener,
    translator: Translator,
    link: AccountLink,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(settings, onEvent, translator, link);
    try {
      await session.initialize();
    } catch (error) {
      session.connection.access?.close();
      session.connection.query.close();
      throw toolsetError(error, session.connection.access);
    }
    link.sessions.add(session);
    return session;
  }

  private constructor(
    private readonly settings: SessionSettings,
    private readonly onEvent: SessionEventListener,
    private readonly translator: Translator,
    private readonly link: AccountLink,
  ) {
    this.id = settings.sessionId;
    onEvent({ type: 'mode', mode: settings.mode });
    onEvent({
      type: 'settings',
      gateway: settings.gateway,
      model: settings.model,
      effort: settings.effort,
      sandbox: settings.sandbox,
    });
    this.connection = this.connect();
  }

  async send(
    text: string,
    images: MessageImage[] = [],
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    // During a turn, Claude Code takes the message into it between tool calls, or else runs it as the
    // next turn once the running one ends.
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
    this.push(withImages(text, images), context, delivery);
  }

  // A turn of the app's own with the host context alone, as the notice of new messages (ADR-0036):
  // no message of the user's goes with it or shows.
  async deliverContext(context: HostTurnContext, delivery: HostContextDelivery): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    if (this.turnRunning) throw new Error('A turn is running.');
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
    this.connection.contextOnly = this.push([], context, delivery);
  }

  // Sends Claude Code a user message of the content given, after the host context's blocks, each a
  // document of its own: the presentation state, then the notices of new messages. Their delivery
  // is accepted once Claude Code has taken the message, as it says.
  private push(
    content: ReturnType<typeof withImages>,
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): string {
    // From its first message on, Claude Code keeps a transcript that a new process can continue.
    this.settings.resume = true;
    const notices = selectPresentationNotices(context?.presentationNotices ?? []);
    const host = presentationContext(notices);
    const inbox = inboxContext(context?.inboxNotices ?? []);
    const uuid = randomUUID();
    if (delivery && (host || inbox))
      this.connection.deliveries.set(uuid, {
        accepted: () => {
          delivery.accepted(notices);
        },
        failed: () => {
          delivery.failed();
        },
      });
    else delivery?.accepted([]);
    const blocks = [
      ...(host ? [documentBlock(host, 'App presentation state')] : []),
      ...(inbox ? [documentBlock(inbox, INBOX_CONTEXT_TITLE)] : []),
    ];
    const only = content.length === 1 ? content[0] : undefined;
    this.connection.input.push({
      type: 'user',
      uuid,
      message: {
        role: 'user',
        content: blocks.length === 0 && only?.type === 'text' ? only.text : [...blocks, ...content],
      },
      parent_tool_use_id: null,
    });
    return uuid;
  }

  async interrupt(): Promise<void> {
    for (const delivery of this.connection.deliveries.values()) delivery.failed();
    this.connection.deliveries.clear();
    if (!this.turnRunning) return;
    this.interrupting = true;
    await this.connection.query.interrupt();
  }

  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending?.request.kind !== 'approval') {
      return Promise.reject(new Error(`No approval ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(approvalResult(pending.request, answer, nativeModes[this.settings.mode]));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    if (pending.request.request.action === 'plan' && answer.decision !== 'deny') {
      this.onEvent({ type: 'mode', mode: this.settings.mode });
    }
    return Promise.resolve();
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending?.request.kind !== 'question') {
      return Promise.reject(new Error(`No question ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(questionResult(pending.request, answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.sendSwitch(async (query) => {
      await query.setPermissionMode(nativeModes[mode]);
      this.settings.mode = mode;
    });
    this.onEvent({ type: 'mode', mode });
  }

  async setModel(model: string | null): Promise<void> {
    await this.sendSwitch(async (query) => {
      await query.setModel(model ?? undefined);
      this.settings.model = model;
    });
    this.onEvent({ type: 'settings', model });
  }

  async setEffort(effort: ReasoningEffort | null): Promise<void> {
    const level = effortLevel(effort);
    await this.sendSwitch(async (query) => {
      await query.applyFlagSettings({ effortLevel: level });
      this.settings.effort = level;
    });
    this.onEvent({ type: 'settings', effort: level });
  }

  // Claude Code takes the new level at once, during a turn too.
  async setSandbox(sandbox: SandboxLevel): Promise<void> {
    await this.sendSwitch(async (query) => {
      const leavingReadOnly = this.settings.sandbox === 'read-only';
      await query.applyFlagSettings(
        sandboxSettings(sandbox, this.settings.folders, leavingReadOnly),
      );
      this.settings.sandbox = sandbox;
    });
    this.onEvent({ type: 'settings', sandbox });
  }

  // Claude Code keeps the title as the session's custom title, in its transcript, which its own
  // tools show; the transcript is there from the first message.
  async setTitle(title: string): Promise<void> {
    await renameSession(this.settings.sessionId, title, { dir: this.settings.cwd });
    this.title = title;
    this.onEvent({ type: 'title', title });
  }

  async setGateway(gateway: string | null): Promise<void> {
    if (this.closed) throw new Error('The session is closed.');
    if (gateway !== null) await existingGatewayPath(this.settings.gatewaysDir, gateway);
    if (this.turnRunning) {
      this.pendingGateway = gateway;
      return;
    }
    await this.switchGateway(gateway);
  }

  close(): Promise<void> {
    this.closing = true;
    this.connection.access?.close();
    this.connection.input.end();
    this.connection.query.close();
    return Promise.resolve();
  }

  // Starts a Claude Code process for the session, with the session's settings as they are now.
  private connect(): Connection {
    const { settings } = this;
    const input = new InputQueue();
    const access = settings.toolset?.open();
    const connection: Connection = {
      input,
      access,
      toolNames: new Map(),
      deliveries: new Map(),
      query: query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: bundledClaudeBinary(),
          cwd: settings.cwd,
          permissionMode: nativeModes[settings.mode],
          // Lets a session switch to yolo later; it starts in, and stays in, the mode chosen.
          allowDangerouslySkipPermissions: true,
          // Text and thinking arrive as they are written.
          includePartialMessages: true,
          // Claude's thinking as summaries, which recent models leave out unless asked for; where the
          // API refuses them, Claude Code falls back to none.
          extraArgs: { 'thinking-display': 'summarized' },
          // Claude Code's own system prompt, as in the CLI; its settings and CLAUDE.md files load as
          // they do there.
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          canUseTool: this.canUseTool,
          ...(access && settings.toolset
            ? {
                mcpServers: {
                  [settings.toolset.name]: {
                    type: 'http',
                    url: access.url,
                    headers: { Authorization: `Bearer ${access.credential}` },
                    alwaysLoad: true,
                    // As long as the toolset says a call may take, whatever MCP_TOOL_TIMEOUT the
                    // user's environment sets, so that no call ends while the user answers its
                    // approval.
                    timeout: settings.toolset.callTimeoutMs,
                  },
                },
                // Over Claude Code's standard input as it initializes, which the Claude Code bundled
                // with the SDK reads, rather than on its command line, where other users of the Mac
                // could read the credential in the headers.
                mcpServersDelivery: 'initialize',
                allowedTools: access.tools?.map(
                  (name) => `mcp__${settings.toolset?.name ?? ''}__${name}`,
                ),
              }
            : {}),
          // A gateway is a settings file that Claude Code reads itself; the app never opens it.
          ...(settings.gateway === null
            ? {}
            : { settings: gatewayPath(settings.gatewaysDir, settings.gateway) }),
          ...(settings.model === null ? {} : { model: settings.model }),
          ...(settings.effort === null ? {} : { effort: settings.effort }),
          ...(settings.resume ? { resume: settings.sessionId } : { sessionId: settings.sessionId }),
        },
      }),
      done: Promise.resolve(),
    };
    connection.done = this.pump(connection);
    return connection;
  }

  // The running Claude Code process, once a gateway switch under way has finished with it.
  private async process(): Promise<Query> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    return this.connection.query;
  }

  // Sends a switch to the running process, once a gateway switch under way has finished with it, and
  // keeps it among those sent until it is answered, together with the change it makes to the
  // session's settings, so that a gateway switch asked for meanwhile lets it finish and starts the new
  // process with the change. Whether to wait is decided in the same turn of the event loop as the
  // sending, so that no gateway switch can start in between.
  private sendSwitch(apply: (query: Query) => Promise<void>): Promise<void> {
    if (this.switching !== null) return this.switching.then(() => this.sendSwitch(apply));
    if (this.closed) return Promise.reject(new Error('The session is closed.'));
    const sent = apply(this.connection.query);
    this.sent.add(sent);
    const answered = () => {
      this.sent.delete(sent);
    };
    sent.then(answered, answered);
    return sent;
  }

  // Waits for Claude Code's initialization, which lists the models the session can use, and puts the
  // process on the session's sandbox level before any message. The level goes in as flag settings,
  // since the SDK's own sandbox option cannot go beside a gateway's settings file.
  private async initialize(): Promise<void> {
    const init = await this.connection.query.initializationResult();
    await this.connection.query.applyFlagSettings(
      sandboxSettings(this.settings.sandbox, this.settings.folders, false),
    );
    const usage = await countContext(this.connection.query);
    if (this.connection.access) {
      const servers = await this.connection.query.mcpServerStatus().catch(() => []);
      this.reportAvailability(this.connection, servers, usage?.model);
    }
    this.onEvent({ type: 'models', models: modelOptions(init.models, usage?.model) });
    if (usage !== undefined) {
      this.onEvent({ type: 'context', used: usage.totalTokens, size: usage.maxTokens });
    }
  }

  // After each turn, how much of the context window the conversation takes, from Claude Code's own
  // count without asking the API, and the title Claude Code keeps for the session, where it keeps
  // one: the one the user gave it or the one it wrote itself. Its summary is not taken, since without
  // such a title it is the latest prompt, which would retitle the session with every message, and
  // the host's first message stands in for the title instead.
  private async afterTurn(): Promise<void> {
    // Without a count, or once the session has closed, nothing is reported; the next turn tries again.
    const usage = await this.process().then(countContext, () => undefined);
    if (usage !== undefined) {
      this.onEvent({ type: 'context', used: usage.totalTokens, size: usage.maxTokens });
    }
    try {
      const info = await getSessionInfo(this.settings.sessionId, { dir: this.settings.cwd });
      const title = info?.customTitle;
      if (title !== undefined && title !== '' && title !== this.title) {
        this.title = title;
        this.onEvent({ type: 'title', title });
      }
    } catch {
      // The transcript is not there yet; the next turn tries again.
    }
  }

  // Tells the toolset whether its tools are connected and whether the session's model takes images.
  private reportAvailability(
    connection: Connection,
    servers: readonly { name: string; status: string }[],
    model: string | undefined,
  ): void {
    connection.images = imageInput(this.settings.gateway, model);
    connection.access?.availability?.({
      tools: servers.some(
        (entry) => entry.name === this.settings.toolset?.name && entry.status === 'connected',
      )
        ? 'ready'
        : 'unknown',
      images: connection.images,
    });
  }

  // Gateway switches run one after another, between turns.
  private switchGateway(gateway: string | null): Promise<void> {
    const switched = (this.switching ?? Promise.resolve()).then(() => this.reconnect(gateway));
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

  // Ends the Claude Code process and continues the session in a new one that reads the other
  // gateway's file, so the session keeps its id and its history. The switches already sent to the
  // process finish there first, for a while at most, so that the new process starts with them.
  private async reconnect(gateway: string | null): Promise<void> {
    if (this.closed) return;
    const previous = this.connection;
    this.retired.add(previous);
    await withinTime(
      Promise.allSettled(this.sent),
      SENT_TIMEOUT_MS,
      'Claude Code did not answer the switches sent before the gateway switch in time.',
    ).catch(() => undefined);
    previous.input.end();
    for (const delivery of previous.deliveries.values()) delivery.failed();
    previous.deliveries.clear();
    previous.access?.close();
    previous.query.close();
    await previous.done;
    // A close asked for before or during the switch ends the session here, as the retired process's
    // end did not.
    if (this.closing) {
      this.finish(undefined);
      return;
    }
    this.settings.gateway = gateway;
    this.connection = this.connect();
    try {
      await this.initialize();
    } catch (error) {
      this.connection.query.close();
      this.connection.access?.close();
      throw toolsetError(error, this.connection.access);
    }
    this.onEvent({ type: 'settings', gateway });
  }

  // Every canUseTool call waits here for the user's answer, or for the SDK to give up on it.
  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    if (
      this.settings.toolset &&
      registeredTool(
        toolName,
        `mcp__${this.settings.toolset.name}__`,
        this.connection.access?.tools,
      )
    ) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const request = toRequest(toolName, input, options, {
      cwd: this.settings.cwd,
      now: Date.now(),
    });
    const id = request.request.id;
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { request, resolve });
      options.signal.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          resolve({ behavior: 'deny', message: 'The turn was interrupted.' });
          this.onEvent({ type: 'request-resolved', requestId: id, outcome: 'cancelled' });
        },
        { once: true },
      );
      this.onEvent(
        request.kind === 'question'
          ? { type: 'question-asked', request: request.request }
          : { type: 'approval-requested', request: request.request },
      );
    });
  };

  // The session's query, for the account's usage call, while it runs on Claude Code's own sign-in;
  // null through a gateway, whose account is the gateway's, and once it has ended.
  accountQuery(): Query | null {
    return this.closed || this.settings.gateway !== null ? null : this.connection.query;
  }

  private async pump(connection: Connection): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of connection.query) {
        if (message.type === 'user' && message.uuid) {
          connection.deliveries.get(message.uuid)?.accepted();
          connection.deliveries.delete(message.uuid);
          if (connection.contextOnly === message.uuid) delete connection.contextOnly;
        }
        const taken = connection.contextOnly;
        if (taken !== undefined && (message.type === 'assistant' || message.type === 'result')) {
          delete connection.contextOnly;
          connection.deliveries.get(taken)?.accepted();
          connection.deliveries.delete(taken);
        }
        if (connection !== this.connection && this.retired.has(connection)) continue;
        // A turn's first message names the model it runs, which the user may have switched.
        if (
          message.type === 'system' &&
          message.subtype === 'init' &&
          imageInput(this.settings.gateway, message.model) !== connection.images
        )
          this.reportAvailability(connection, message.mcp_servers, message.model);
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type !== 'tool_use' || !this.settings.toolset) continue;
            const name = registeredTool(
              block.name,
              `mcp__${this.settings.toolset.name}__`,
              connection.access?.tools,
            );
            if (name) {
              if (connection.toolNames.size >= 256)
                connection.toolNames.delete(connection.toolNames.keys().next().value ?? '');
              connection.toolNames.set(block.id, name);
            }
          }
        }
        if (
          message.type === 'user' &&
          message.parent_tool_use_id === null &&
          Array.isArray(message.message.content)
        ) {
          const results = message.message.content.filter((block) => block.type === 'tool_result');
          for (const block of results) {
            if (block.type !== 'tool_result') continue;
            const name = connection.toolNames.get(block.tool_use_id);
            connection.toolNames.delete(block.tool_use_id);
            if (!name) continue;
            const receipt = toolsetReceipt(
              results.length === 1 ? message.tool_use_result : undefined,
              block.content,
            );
            if (receipt) connection.access?.result?.(name, block.tool_use_id, receipt);
          }
        }
        if (message.type === 'result') this.followUp = (message.queued_turn_count ?? 0) > 0;
        this.hearAccount(message);
        for (const event of this.translator.live(message)) this.emit(event);
      }
    } catch (caught) {
      error = toolsetErrorMessage(caught, connection.access);
    }
    if (!this.retired.has(connection)) this.finish(error);
  }

  // What a message says of the account on Claude Code's own sign-in: a window of the plan's limits as
  // it changes, or that a turn failed for want of a sign-in. A gateway's account is the gateway's.
  private hearAccount(message: SDKMessage): void {
    if (this.settings.gateway !== null) return;
    if (message.type === 'rate_limit_event') {
      const windows = eventWindows(message.rate_limit_info);
      if (windows.length > 0) this.link.hear({ type: 'usage', windows });
    } else if (message.type === 'assistant' && message.error === 'authentication_failed') {
      this.link.hear({ type: 'signed-out' });
    }
  }

  // The session has ended: what is still open is cancelled, and closed is reported once.
  private finish(error: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.access?.close();
    for (const delivery of this.connection.deliveries.values()) delivery.failed();
    this.connection.deliveries.clear();
    this.link.sessions.delete(this);
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: 'deny', message: 'The session ended.' });
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
    }
    this.pending.clear();
    this.onEvent(error === undefined ? { type: 'closed' } : { type: 'closed', error });
  }

  private emit(event: SessionEvent): void {
    if (event.type !== 'turn-ended') {
      this.onEvent(event);
      return;
    }
    this.turnRunning = false;
    if (this.interrupting) {
      this.interrupting = false;
      this.onEvent({ type: 'turn-ended', outcome: 'interrupted' });
    } else {
      this.onEvent(event);
    }
    void this.afterTurn();
    // Messages sent during the turn that it did not take make the next turn, which Claude Code starts
    // by itself; a gateway asked for meanwhile waits for its end.
    if (this.followUp) {
      this.followUp = false;
      this.turnRunning = true;
      this.onEvent({ type: 'turn-started' });
      return;
    }
    // A gateway asked for during the turn takes over before the next turn.
    if (this.pendingGateway !== undefined) {
      const gateway = this.pendingGateway;
      this.pendingGateway = undefined;
      this.switchGateway(gateway).catch((caught: unknown) => {
        this.onEvent({ type: 'error', message: errorMessage(caught) });
      });
    }
  }
}

// The session's input: the user's messages wait here until Claude Code reads them.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly waiting: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    this.waiting.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      }
    }
  }
}

// Text the app gives the model beside the user's, as a document of its own.
function documentBlock(data: string, title: string) {
  return {
    type: 'document' as const,
    source: { type: 'text' as const, media_type: 'text/plain' as const, data },
    title,
  };
}

// A message with images as Claude's content blocks: the images first, as Anthropic advises, then the
// text.
function withImages(text: string, images: readonly MessageImage[]) {
  return [
    ...images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType as SendableImageType,
        data: image.data,
      },
    })),
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
  ];
}
