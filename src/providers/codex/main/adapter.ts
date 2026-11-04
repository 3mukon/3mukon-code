import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Provider,
  ProviderSession,
  SessionEventListener,
  StartOptions,
  Toolset,
  ToolsetAccess,
} from '../../../sessions/main/provider';
import type {
  ApprovalAnswer,
  HistoryEntry,
  MessageImage,
  ModelOption,
  PermissionMode,
  QuestionAnswer,
  QuestionRequest,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../../../sessions/shared/events';
import { imageUrl } from '../../../sessions/shared/images';
import type { AccountNews, AccountSource } from '../../../accounts/main/source';
import { isSignInError, readCodexAccount, resetCodexLimits, updatedWindows } from './account';
import { bundledCodexBinary } from './binary';
import { defaultGatewaysDir, listGateways, readGateway, redact } from './gateways';
import type { InitializeParams } from './protocol/InitializeParams';
import type { RequestId } from './protocol/RequestId';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification';
import type { Model } from './protocol/v2/Model';
import type { ModelListResponse } from './protocol/v2/ModelListResponse';
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams';
import type { SandboxMode } from './protocol/v2/SandboxMode';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy';
import type { ServerRequestResolvedNotification } from './protocol/v2/ServerRequestResolvedNotification';
import type { ThreadListResponse } from './protocol/v2/ThreadListResponse';
import type { ThreadResumeParams } from './protocol/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { ThreadTurnsListResponse } from './protocol/v2/ThreadTurnsListResponse';
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams';
import type { TurnStartParams } from './protocol/v2/TurnStartParams';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';
import type { TurnSteerParams } from './protocol/v2/TurnSteerParams';
import type { TurnSteerResponse } from './protocol/v2/TurnSteerResponse';
import type { UserInput } from './protocol/v2/UserInput';
import {
  approvalResult,
  asyncQuestion,
  asyncReply,
  commandApproval,
  fileChangeApproval,
  permissionsApproval,
  questionResult,
  userInputQuestion,
  type CodexRequest,
} from './requests';
import { CodexRpc, type Launch, type Rpc, type RpcHandlers, type StartRpc } from './rpc';
import { Translator } from './translate';

// Codex's approval settings behind each of the app's two permission modes (ADR-0006), for a thread
// and as overrides for a turn and the turns after it. In auto, Codex asks before it leaves its sandbox,
// and its automatic reviewer decides; in yolo, it never asks. The sandbox is a setting of its own.
function approvals(
  mode: PermissionMode,
): Pick<ThreadStartParams & TurnStartParams, 'approvalPolicy' | 'approvalsReviewer'> {
  return mode === 'yolo'
    ? { approvalPolicy: 'never', approvalsReviewer: 'user' }
    : { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
}

// Codex's sandbox behind each of the app's sandbox levels, as a thread starts or resumes in it.
const sandboxModes: Record<SandboxLevel, SandboxMode> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full-access': 'danger-full-access',
};

// The same as a turn's override, for a level Codex has not yet given the thread: Codex's defaults, in
// which workspace-write writes in the session's folder and the temporary folders, without network.
const defaultPolicies: Record<SandboxLevel, SandboxPolicy> = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  'full-access': { type: 'dangerFullAccess' },
};

// The level a policy stands for; none for a sandbox outside Codex.
function sandboxLevel(policy: SandboxPolicy): SandboxLevel | undefined {
  switch (policy.type) {
    case 'readOnly':
      return 'read-only';
    case 'workspaceWrite':
      return 'workspace-write';
    case 'dangerFullAccess':
      return 'full-access';
    case 'externalSandbox':
      return undefined;
  }
}

// The environment variable that carries a session's toolset credential to its app-server. Codex's
// default shell environment policy keeps variables whose names contain TOKEN out of the commands it
// runs, so the agent's commands do not see it.
const TOOLSET_VARIABLE = 'TOOLSET_3MUKON_CODE_TOKEN';

// The folders of the probes still listing models, removed as the app's process exits, should it quit
// during a probe, so that quitting leaves none behind.
const probeFolders = new Set<string>();
process.on('exit', () => {
  for (const folder of probeFolders) rmSync(folder, { recursive: true, force: true });
});

// The app-server's settings for the app's toolset (ADR-0012): its address, the variable that holds the
// session's credential, and its tools allowed without asking. Codex starts no thread while it cannot
// reach the toolset.
function toolsetLaunch(name: string, access: ToolsetAccess): Launch {
  const server = `mcp_servers.${name}`;
  const settings = [
    `${server}.url=${JSON.stringify(access.url)}`,
    `${server}.bearer_token_env_var=${JSON.stringify(TOOLSET_VARIABLE)}`,
    `${server}.default_tools_approval_mode="approve"`,
    `${server}.required=true`,
  ];
  return {
    args: settings.flatMap((setting) => ['-c', setting]),
    env: { [TOOLSET_VARIABLE]: access.credential },
  };
}

export interface CodexProviderOptions {
  // The app's toolset, which every session connects to, so that the tools it gains reach Codex
  // (ADR-0012).
  toolset: Toolset;
  // The folder of gateway files; the gateways folder in Codex's home when left out.
  gatewaysDir?: string;
  // Starts an app-server; tests put a fake in place of the bundled Codex.
  startRpc?: StartRpc;
  // The app's version, which Codex records as its client's.
  clientVersion?: string;
}

// Opens a connection to a new app-server and starts the protocol on it.
type Connect = (cwd: string, handlers: RpcHandlers, launch?: Launch) => Promise<Rpc>;

// How the sessions take part in Codex's account (ADR-0017): those running on Codex's own sign-in lend
// their app-servers to the account's calls, and pass on what Codex reports of the account.
interface AccountLink {
  readonly sessions: Set<CodexSession>;
  hear(news: AccountNews): void;
}

const startBundledCodex: StartRpc = (cwd, handlers, launch) =>
  CodexRpc.start(bundledCodexBinary(), cwd, handlers, launch);

// Codex through its app-server (ADR-0003), on whatever sign-in Codex itself has, and that sign-in's
// account, with its usage limits and their resets (ADR-0017).
export function createCodexProvider({
  toolset,
  gatewaysDir = defaultGatewaysDir(),
  startRpc = startBundledCodex,
  clientVersion = '0.0.0',
}: CodexProviderOptions): Provider & AccountSource {
  const connect: Connect = (cwd, handlers, launch) =>
    initialize(startRpc(cwd, handlers, launch), clientVersion);
  const listeners = new Set<(news: AccountNews) => void>();
  const link: AccountLink = {
    sessions: new Set(),
    hear(news) {
      for (const listener of listeners) listener(news);
    },
  };
  // An account call through a running session's app-server on Codex's own sign-in, or else through a
  // short-lived one in a throwaway folder.
  const withAccount = async <Result>(use: (rpc: Rpc) => Promise<Result>): Promise<Result> => {
    for (const session of link.sessions) {
      const rpc = session.accountRpc();
      if (rpc !== null) return use(rpc);
    }
    const cwd = await mkdtemp(join(tmpdir(), 'codex-account-'));
    probeFolders.add(cwd);
    try {
      return await withCodex(connect, cwd, use);
    } finally {
      probeFolders.delete(cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  };
  return {
    id: 'codex',
    start(options, onEvent) {
      const settings = sessionSettings(options, gatewaysDir);
      return CodexSession.open(settings, null, connect, toolset, link, onEvent);
    },
    resume(options, onEvent) {
      const settings = sessionSettings(options, gatewaysDir);
      return CodexSession.open(settings, options.sessionId, connect, toolset, link, onEvent);
    },
    // Read through a short-lived app-server, which lists the thread's turns without loading it.
    history(sessionId, cwd) {
      return withCodex(connect, cwd, (rpc) => pastEvents(rpc, sessionId, new Translator(cwd)));
    },
    listSessions(cwd, limit) {
      return withCodex(connect, cwd, async (rpc): Promise<HistoryEntry[]> => {
        const { data } = await rpc.request<ThreadListResponse>('thread/list', {
          cwd,
          limit,
          sortKey: 'updated_at',
          sortDirection: 'desc',
        });
        // Subagents' threads belong to the session that started them.
        return data
          .filter((thread) => thread.parentThreadId === null)
          .map((thread) => ({
            id: thread.id,
            title: thread.name ?? thread.preview,
            cwd: thread.cwd,
            updatedAt: thread.updatedAt * 1000,
          }));
      });
    },
    listGateways() {
      return listGateways(gatewaysDir);
    },
    async listModels(gateway) {
      const own = gateway === null ? undefined : (await readGateway(gatewaysDir, gateway)).model;
      const cwd = await mkdtemp(join(tmpdir(), 'codex-models-'));
      probeFolders.add(cwd);
      try {
        return withGatewayModel(modelOptions(await withCodex(connect, cwd, allModels)), own);
      } finally {
        probeFolders.delete(cwd);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    readAccount(withUsage) {
      return withAccount((rpc) => readCodexAccount(rpc, withUsage));
    },
    signInCommand() {
      return Promise.resolve({ file: bundledCodexBinary(), args: ['login'] });
    },
    resetLimits() {
      return withAccount(resetCodexLimits);
    },
    onAccountNews(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function initialize(rpc: Rpc, clientVersion: string): Promise<Rpc> {
  const params: InitializeParams = {
    clientInfo: { name: '3mukon-code', title: '3mukon-code', version: clientVersion },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
  try {
    await rpc.request('initialize', params);
  } catch (error) {
    void rpc.close();
    throw error;
  }
  rpc.notify('initialized');
  return rpc;
}

// A thread's past turns, page by page, as events. Codex lists the turns of a stored thread that no
// app-server has loaded without loading it.
async function pastEvents(
  rpc: Rpc,
  threadId: string,
  translator: Translator,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let cursor: string | null = null;
  do {
    const page: ThreadTurnsListResponse = await rpc.request<ThreadTurnsListResponse>(
      'thread/turns/list',
      {
        threadId,
        itemsView: 'full',
        sortDirection: 'asc',
        ...(cursor === null ? {} : { cursor }),
      },
    );
    for (const turn of page.data) {
      for (const item of turn.items) events.push(...translator.history(item));
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return events;
}

// One exchange with a short-lived app-server that starts no thread.
async function withCodex<Result>(
  connect: Connect,
  cwd: string,
  use: (rpc: Rpc) => Promise<Result>,
): Promise<Result> {
  const rpc = await connect(cwd, {
    notification: () => undefined,
    request: (method) => Promise.reject(new Error(`3mukon-code does not answer ${method} here.`)),
    exit: () => undefined,
  });
  try {
    return await use(rpc);
  } finally {
    await rpc.close();
  }
}

// The models the account can choose, page by page.
async function allModels(rpc: Rpc): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const page: ModelListResponse = await rpc.request<ModelListResponse>(
      'model/list',
      cursor === null ? {} : { cursor },
    );
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return models.filter((model) => !model.hidden);
}

// The models, with the one Codex uses when a thread chooses none marked, and each one's own effort.
function modelOptions(models: Model[]): ModelOption[] {
  return models.map((model) => ({
    id: model.model,
    label: model.displayName,
    ...(model.description === '' ? {} : { description: model.description }),
    efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    ...(model.isDefault ? { default: true } : {}),
    defaultEffort: model.defaultReasoningEffort,
  }));
}

// A gateway's own model, from its file, leads the list when Codex does not offer it.
function withGatewayModel(models: ModelOption[], own: string | undefined): ModelOption[] {
  return own === undefined || models.some((model) => model.id === own)
    ? models
    : [{ id: own, label: own, efforts: [] }, ...models];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SessionSettings {
  cwd: string;
  mode: PermissionMode;
  gatewaysDir: string;
  // The gateway's name. Its file is read whenever a thread starts or resumes, and never kept.
  gateway: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  sandbox: SandboxLevel;
}

function sessionSettings(options: StartOptions, gatewaysDir: string): SessionSettings {
  return {
    cwd: options.cwd,
    mode: options.mode ?? 'auto',
    gatewaysDir,
    gateway: options.gateway ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
    sandbox: options.sandbox ?? 'workspace-write',
  };
}

// An app-server with the session's thread started or resumed on it, not yet in use.
interface Attached {
  rpc: Rpc;
  generation: number;
  // The sandbox level the thread was started or resumed in.
  sandbox: SandboxLevel;
  response: ThreadStartResponse | ThreadResumeResponse;
  // From the gateway's file, as it was read for this connection.
  gatewayModel: string | undefined;
  gatewayProvider: string | undefined;
}

class CodexSession implements ProviderSession {
  private rpc!: Rpc;
  private threadId = '';
  private readonly translator: Translator;
  // The session's access to the app's toolset, and what its app-servers start with to use it.
  private readonly access: ToolsetAccess;
  private readonly launch: Launch;
  // Codex's async questions waiting for the user's reply, by request id.
  private readonly asyncQuestions = new Map<string, QuestionRequest>();
  // The user's messages that Codex took into no turn, which start the next one together.
  private queued: Message[] = [];
  // Each connection's handlers act only while their connection is the session's current one. The
  // first connection is number 1, so 0 stands for none, as during a gateway switch.
  private generation = 0;
  private generations = 0;
  private models: Model[] = [];
  // The policy Codex gave the thread for each level it started or resumed in, as Codex's own settings
  // shape it, such as the network access of its workspace-write.
  private readonly sandboxPolicies: Partial<Record<SandboxLevel, SandboxPolicy>> = {};
  private readonly pending = new Map<
    string,
    { request: CodexRequest; resolve: (result: unknown) => void }
  >();
  private turnRunning = false;
  private turnId: string | null = null;
  // The turn/start under way, which a message during the turn waits for to learn the turn's id.
  private starting: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  // What changed since the last turn started, which the next turn carries.
  private modeChanged = false;
  private modelChanged = false;
  private effortChanged: boolean;
  private sandboxChanged = false;
  // A gateway asked for during a turn, which takes over when the turn ends.
  private pendingGateway: string | null | undefined;
  // The gateway switch under way, which a message waits for; it never rejects.
  private switching: Promise<void> | null = null;

  get id(): string {
    return this.threadId;
  }

  // Starts a thread, or resumes one and replays its history, and resolves once Codex has it.
  static async open(
    settings: SessionSettings,
    resumeId: string | null,
    connect: Connect,
    toolset: Toolset,
    link: AccountLink,
    onEvent: SessionEventListener,
  ): Promise<CodexSession> {
    const session = new CodexSession(settings, connect, toolset, link, onEvent);
    let attached: Attached;
    try {
      attached = await session.attach(resumeId);
    } catch (error) {
      session.access.close();
      throw error;
    }
    session.use(attached);
    try {
      if (resumeId !== null) await session.replay();
      onEvent({ type: 'mode', mode: settings.mode });
      onEvent({
        type: 'settings',
        gateway: settings.gateway,
        model: attached.response.model,
        effort: settings.effort ?? attached.response.reasoningEffort,
        sandbox: settings.sandbox,
      });
      await session.refreshModels(attached.gatewayModel);
    } catch (error) {
      void attached.rpc.close();
      session.access.close();
      throw error;
    }
    link.sessions.add(session);
    return session;
  }

  private constructor(
    private readonly settings: SessionSettings,
    private readonly connect: Connect,
    toolset: Toolset,
    private readonly link: AccountLink,
    private readonly onEvent: SessionEventListener,
  ) {
    this.translator = new Translator(settings.cwd);
    this.access = toolset.open();
    this.launch = toolsetLaunch(toolset.name, this.access);
    // A thread takes no effort of its own; a chosen one goes with the first turn.
    this.effortChanged = settings.effort !== null;
  }

  async send(text: string, images: MessageImage[] = []): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    // A message of the user's own is their reply to Codex's async questions still open.
    this.resolveAsyncQuestions('answered');
    await this.deliver({ text, images });
  }

  async interrupt(): Promise<void> {
    if (!this.turnRunning || this.turnId === null) return;
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending === undefined || pending.request.kind === 'question') {
      return Promise.reject(new Error(`No approval ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(approvalResult(pending.request, answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void> {
    const asynchronous = this.asyncQuestions.get(requestId);
    if (asynchronous !== undefined) {
      this.asyncQuestions.delete(requestId);
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
      const reply = asyncReply(asynchronous, answer);
      if (reply !== undefined) void this.reply(reply);
      return Promise.resolve();
    }
    const pending = this.pending.get(requestId);
    if (pending?.request.kind !== 'question') {
      return Promise.reject(new Error(`No question ${requestId} is waiting.`));
    }
    this.pending.delete(requestId);
    pending.resolve(questionResult(answer));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
    return Promise.resolve();
  }

  // Codex takes the mode from the next turn on. Approvals already waiting are allowed as soon as the
  // session is in yolo, and so is any that Codex asks for before the next turn.
  setMode(mode: PermissionMode): Promise<void> {
    this.settings.mode = mode;
    this.modeChanged = true;
    this.onEvent({ type: 'mode', mode });
    if (mode === 'yolo') {
      for (const [requestId, pending] of this.pending) {
        if (pending.request.kind === 'question') continue;
        this.pending.delete(requestId);
        pending.resolve(approvalResult(pending.request, { decision: 'allow-once' }));
        this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
      }
    }
    return Promise.resolve();
  }

  setModel(model: string | null): Promise<void> {
    this.settings.model = model;
    this.modelChanged = true;
    this.onEvent({ type: 'settings', model });
    return Promise.resolve();
  }

  setEffort(effort: ReasoningEffort | null): Promise<void> {
    this.settings.effort = effort;
    this.effortChanged = true;
    this.onEvent({ type: 'settings', effort });
    return Promise.resolve();
  }

  // Codex 0.164.0 takes a sandbox only for the turns that follow, in its stable and its experimental
  // API alike, so a switch during a turn applies from the next one.
  setSandbox(sandbox: SandboxLevel): Promise<void> {
    this.settings.sandbox = sandbox;
    this.sandboxChanged = true;
    this.onEvent({ type: 'settings', sandbox });
    return Promise.resolve();
  }

  async setGateway(gateway: string | null): Promise<void> {
    if (this.closed) throw new Error('The session is closed.');
    // Reading the file now makes a missing or broken gateway fail here rather than later.
    if (gateway !== null) await readGateway(this.settings.gatewaysDir, gateway);
    if (this.turnRunning) {
      this.pendingGateway = gateway;
      return;
    }
    await this.switchGateway(gateway);
  }

  close(): Promise<void> {
    this.closing = true;
    return this.rpc.close();
  }

  // Starts an app-server and starts the thread on it, or resumes the thread there, with the session's
  // settings and the gateway's file as they are now. Codex's errors are told without the file's text.
  private async attach(resumeId: string | null): Promise<Attached> {
    const { cwd, mode, model, sandbox, gatewaysDir, gateway: name } = this.settings;
    const gateway = name === null ? null : await readGateway(gatewaysDir, name);
    const generation = ++this.generations;
    const rpc = await this.connect(cwd, this.handlers(generation), this.launch);
    const params: Pick<
      ThreadResumeParams,
      | 'cwd'
      | 'approvalPolicy'
      | 'approvalsReviewer'
      | 'sandbox'
      | 'model'
      | 'modelProvider'
      | 'config'
    > = {
      cwd,
      ...approvals(mode),
      sandbox: sandboxModes[sandbox],
      ...(model === null ? {} : { model }),
      ...(gateway === null ? {} : { config: gateway.config }),
      ...(gateway?.modelProvider === undefined ? {} : { modelProvider: gateway.modelProvider }),
    };
    try {
      const response =
        resumeId === null
          ? await rpc.request<ThreadStartResponse>('thread/start', params)
          : await rpc.request<ThreadResumeResponse>('thread/resume', {
              ...params,
              threadId: resumeId,
              excludeTurns: true,
            });
      return {
        rpc,
        generation,
        sandbox,
        response,
        gatewayModel: gateway?.model,
        gatewayProvider: gateway?.modelProvider,
      };
    } catch (error) {
      void rpc.close();
      // eslint-disable-next-line preserve-caught-error -- the original error may show the gateway's settings.
      throw new Error(redact(errorMessage(error), gateway));
    }
  }

  // Makes an attached app-server the session's current one. Codex's own settings may hold the thread
  // to another sandbox than the one asked for, and the session takes the one in force, unless the user
  // has switched the level since, which then goes with the next turn.
  private use({ rpc, generation, sandbox: requested, response }: Attached): void {
    this.rpc = rpc;
    this.generation = generation;
    this.threadId = response.thread.id;
    const granted = sandboxLevel(response.sandbox) ?? requested;
    this.sandboxPolicies[granted] = response.sandbox;
    if (this.settings.sandbox === requested) this.settings.sandbox = granted;
  }

  private handlers(generation: number): RpcHandlers {
    const current = () => generation === this.generation;
    return {
      notification: (method, params) => {
        if (current()) this.notification(method, params);
      },
      request: (method, params, id) =>
        current()
          ? this.request(method, params, id)
          : Promise.reject(new Error('This connection has been replaced.')),
      exit: (error) => {
        if (current()) this.finish(error);
      },
    };
  }

  // The thread's past turns, then replay-finished.
  private async replay(): Promise<void> {
    for (const event of await pastEvents(this.rpc, this.threadId, this.translator)) {
      this.onEvent(event);
    }
    this.onEvent({ type: 'replay-finished' });
  }

  private async refreshModels(gatewayModel: string | undefined): Promise<void> {
    this.models = await allModels(this.rpc);
    this.onEvent({
      type: 'models',
      models: withGatewayModel(modelOptions(this.models), gatewayModel),
    });
  }

  // The turn's input, with whatever changed since the last turn. A model or an effort set back to the
  // default goes as Codex's default, since a turn cannot unset what an earlier one chose.
  private turnParams(message: Message): TurnStartParams {
    const model = this.settings.model ?? this.models.find((entry) => entry.isDefault)?.model;
    const effort =
      this.settings.effort ??
      this.models.find((entry) => entry.model === model)?.defaultReasoningEffort;
    return {
      threadId: this.threadId,
      input: turnInput(message),
      ...(this.modelChanged && model !== undefined ? { model } : {}),
      ...(this.effortChanged && effort !== undefined ? { effort } : {}),
      ...(this.modeChanged ? approvals(this.settings.mode) : {}),
      ...(this.sandboxChanged ? { sandboxPolicy: this.sandboxPolicy(this.settings.sandbox) } : {}),
    };
  }

  private sandboxPolicy(level: SandboxLevel): SandboxPolicy {
    return this.sandboxPolicies[level] ?? defaultPolicies[level];
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

  // Moves the thread to a new app-server that resumes it with the other gateway's settings, so the
  // session keeps its id and its history. Codex lets one app-server write a thread at a time, so the
  // current one ends first; what it still reports is ignored, and its end does not end the session.
  // Should the new one fail, the thread is resumed again on the earlier gateway. Codex may keep a
  // resumed thread on its earlier provider; the session then says so. A close asked for during the
  // switch ends the session once the new app-server is up.
  private async reconnect(gateway: string | null): Promise<void> {
    if (this.closed) return;
    const previousGateway = this.settings.gateway;
    this.generation = 0;
    await this.rpc.close();
    this.settings.gateway = gateway;
    let attached: Attached;
    try {
      attached = await this.attach(this.threadId);
    } catch (error) {
      this.settings.gateway = previousGateway;
      try {
        this.use(await this.attach(this.threadId));
      } catch (again) {
        this.finish(errorMessage(again));
      }
      throw error;
    }
    if (this.closing) {
      await attached.rpc.close();
      this.finish(undefined);
      return;
    }
    this.use(attached);
    this.onEvent({
      type: 'settings',
      gateway,
      model: attached.response.model,
      sandbox: this.settings.sandbox,
    });
    const { gatewayProvider, response } = attached;
    if (gatewayProvider !== undefined && response.modelProvider !== gatewayProvider) {
      this.onEvent({
        type: 'error',
        message: `Codex kept this session on its provider "${response.modelProvider}"; the gateway's provider "${gatewayProvider}" applies to new sessions.`,
      });
    }
    await this.refreshModels(attached.gatewayModel);
  }

  // The session's app-server, for the account's calls, while it runs on Codex's own sign-in; null
  // through a gateway, whose account is the gateway's, during a gateway switch and once it has ended.
  accountRpc(): Rpc | null {
    return this.closed || this.generation === 0 || this.settings.gateway !== null ? null : this.rpc;
  }

  private notification(method: string, params: unknown): void {
    // The account's rate limits as they change during turns, on Codex's own sign-in; a gateway's
    // limits are not the account's.
    if (method === 'account/rateLimits/updated') {
      const windows = updatedWindows(params);
      if (this.settings.gateway === null && windows.length > 0) {
        this.link.hear({ type: 'usage', windows });
      }
      return;
    }
    if (method === 'error' && this.settings.gateway === null && isSignInError(params)) {
      this.link.hear({ type: 'signed-out' });
    }
    if (method === 'serverRequest/resolved') {
      this.withdraw(String((params as ServerRequestResolvedNotification).requestId));
      return;
    }
    // An async question comes as an agent message that carries it, and shows as the question.
    if (method === 'item/completed') {
      const question = asyncQuestion((params as ItemCompletedNotification).item, {
        cwd: this.settings.cwd,
        now: Date.now(),
      });
      if (question !== undefined) {
        this.asyncQuestions.set(question.id, question);
        this.onEvent({ type: 'question-asked', request: question });
        return;
      }
    }
    for (const event of this.translator.live(method, params)) this.emit(event);
  }

  private request(method: string, params: unknown, id: RequestId): Promise<unknown> {
    const context = { cwd: this.settings.cwd, now: Date.now() };
    const requestId = String(id);
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.ask(
          commandApproval(requestId, params as CommandExecutionRequestApprovalParams, context),
        );
      case 'item/fileChange/requestApproval': {
        const changeParams = params as FileChangeRequestApprovalParams;
        const change = this.translator.fileChangeOf(changeParams.itemId);
        return this.ask(fileChangeApproval(requestId, changeParams, change, context));
      }
      case 'item/permissions/requestApproval':
        return this.ask(
          permissionsApproval(requestId, params as PermissionsRequestApprovalParams, context),
        );
      case 'item/tool/requestUserInput':
        return this.ask(
          userInputQuestion(requestId, params as ToolRequestUserInputParams, context),
        );
      // Only the user's own MCP servers ask this way, and they are not part of this version.
      case 'mcpServer/elicitation/request':
        return Promise.resolve({ action: 'decline', content: null, _meta: null });
      default:
        return Promise.reject(new Error(`3mukon-code does not answer ${method}.`));
    }
  }

  // An approval or a question waits for the user; in yolo, an approval is allowed without asking.
  private ask(request: CodexRequest): Promise<unknown> {
    if (request.kind !== 'question' && this.settings.mode === 'yolo') {
      return Promise.resolve(approvalResult(request, { decision: 'allow-once' }));
    }
    return new Promise((resolve) => {
      this.pending.set(request.request.id, { request, resolve });
      this.onEvent(
        request.kind === 'question'
          ? { type: 'question-asked', request: request.request }
          : { type: 'approval-requested', request: request.request },
      );
    });
  }

  // The user's message, shown at once. During a turn it joins the running turn (`turn/steer`); Codex
  // takes none into a turn that has just ended or that cannot take one, such as a compaction, and the
  // message then starts a turn of its own, at once or once the running turn ends.
  private async deliver(message: Message): Promise<void> {
    const steering = this.turnRunning;
    if (!steering) this.announceTurn();
    this.onEvent({
      type: 'message',
      id: randomUUID(),
      role: 'user',
      text: message.text,
      ...(message.images.length === 0 ? {} : { images: message.images }),
    });
    if (steering) {
      if (await this.steered(message)) return;
      if (this.turnRunning) {
        this.queued.push(message);
        return;
      }
      this.announceTurn();
    }
    await this.startTurn([...this.queued.splice(0), message]);
  }

  private announceTurn(): void {
    this.turnRunning = true;
    this.onEvent({ type: 'turn-started' });
  }

  // Adds the message to the running turn, once Codex has said which turn that is; false where Codex
  // does not take it.
  private async steered(message: Message): Promise<boolean> {
    if (this.starting !== null) await this.starting;
    const turnId = this.turnId;
    if (!this.turnRunning || turnId === null) return false;
    const params: TurnSteerParams = {
      threadId: this.threadId,
      expectedTurnId: turnId,
      input: turnInput(message),
    };
    return this.rpc.request<TurnSteerResponse>('turn/steer', params).then(
      () => true,
      () => false,
    );
  }

  // Starts a turn with the user's messages, which the session has shown, together as one input.
  private async startTurn(messages: Message[]): Promise<void> {
    const message = {
      text: messages
        .map((entry) => entry.text)
        .filter((text) => text !== '')
        .join('\n\n'),
      images: messages.flatMap((entry) => entry.images),
    };
    const started = this.rpc.request<TurnStartResponse>('turn/start', this.turnParams(message));
    const starting = started.then(
      () => undefined,
      () => undefined,
    );
    this.starting = starting;
    try {
      const { turn } = await started;
      this.turnId = turn.id;
      this.modeChanged = false;
      this.modelChanged = false;
      this.effortChanged = false;
      this.sandboxChanged = false;
    } catch (error) {
      this.turnRunning = false;
      this.onEvent({ type: 'turn-ended', outcome: 'failed', error: errorMessage(error) });
      throw error;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  // The messages that waited for the turn's end start the next turn, after any gateway switch; a message
  // sent meanwhile has taken them into its own turn.
  private async sendQueued(): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed || this.turnRunning || this.queued.length === 0) return;
    this.announceTurn();
    // A turn that fails to start says so in the session.
    await this.startTurn(this.queued.splice(0)).catch(() => undefined);
  }

  // The user's reply to an async question, which goes out as their next message.
  private async reply(text: string): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) return;
    await this.deliver({ text, images: [] }).catch(() => undefined);
  }

  private resolveAsyncQuestions(outcome: 'answered' | 'cancelled'): void {
    for (const requestId of this.asyncQuestions.keys()) {
      this.onEvent({ type: 'request-resolved', requestId, outcome });
    }
    this.asyncQuestions.clear();
  }

  // Codex resolved a request itself, such as when its turn ended; what the user has not answered is
  // cancelled.
  private withdraw(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    pending.resolve(declined(pending.request));
    this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
  }

  // The session has ended: what is still open is cancelled, the toolset is closed to it, and closed is
  // reported once.
  private finish(error: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.link.sessions.delete(this);
    this.turnRunning = false;
    this.resolveAsyncQuestions('cancelled');
    this.queued = [];
    this.access.close();
    for (const [requestId, pending] of this.pending) {
      pending.resolve(declined(pending.request));
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
    }
    this.pending.clear();
    this.onEvent(error === undefined ? { type: 'closed' } : { type: 'closed', error });
  }

  private emit(event: SessionEvent): void {
    if (event.type === 'turn-ended') {
      this.turnRunning = false;
      this.turnId = null;
    }
    this.onEvent(event);
    // A gateway asked for during the turn takes over before the next turn.
    if (event.type === 'turn-ended' && this.pendingGateway !== undefined) {
      const gateway = this.pendingGateway;
      this.pendingGateway = undefined;
      this.switchGateway(gateway).catch((error: unknown) => {
        this.onEvent({ type: 'error', message: errorMessage(error) });
      });
    }
    if (event.type === 'turn-ended' && this.queued.length > 0) void this.sendQueued();
  }
}

// A message of the user's, with its images.
interface Message {
  text: string;
  images: MessageImage[];
}

// A message as Codex takes it: its text, then its images as data URLs.
function turnInput({ text, images }: Message): UserInput[] {
  return [
    ...(text === '' ? [] : [{ type: 'text' as const, text, text_elements: [] }]),
    ...images.map((image) => ({ type: 'image' as const, url: imageUrl(image) })),
  ];
}

// The answer to a request that no one answered: a denial, or no answers to the questions.
function declined(request: CodexRequest): unknown {
  return request.kind === 'question'
    ? questionResult({ decision: 'decline' })
    : approvalResult(request, { decision: 'deny' });
}
