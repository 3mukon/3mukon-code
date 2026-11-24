import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Probes,
  toolsetErrorMessage,
  type Provider,
  type ProviderSession,
  type SessionEventListener,
  type StartOptions,
  type TitleRequest,
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
  QuestionRequest,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../../../sessions/shared/events';
import { imageUrl } from '../../../sessions/shared/images';
import type { AccountNews, AccountSource } from '../../../accounts/main/source';
import { isSignInError, readCodexAccount, resetCodexLimits, updatedWindows } from './account';
import { bundledCodexBinary } from './binary';
import {
  defaultGatewaysDir,
  gatewayLaunchArgs,
  listGateways,
  readGateway,
  redact,
  type GatewaySettings,
} from './gateways';
import type { InitializeParams } from './protocol/InitializeParams';
import type { RequestId } from './protocol/RequestId';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams';
import type { ConfigReadParams } from './protocol/v2/ConfigReadParams';
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification';
import type { Model } from './protocol/v2/Model';
import type { ModelListResponse } from './protocol/v2/ModelListResponse';
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams';
import type { SandboxMode } from './protocol/v2/SandboxMode';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy';
import type { ServerRequestResolvedNotification } from './protocol/v2/ServerRequestResolvedNotification';
import type { ThreadListResponse } from './protocol/v2/ThreadListResponse';
import type { ThreadReadParams } from './protocol/v2/ThreadReadParams';
import type { ThreadReadResponse } from './protocol/v2/ThreadReadResponse';
import type { ThreadResumeParams } from './protocol/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse';
import type { ThreadSetNameParams } from './protocol/v2/ThreadSetNameParams';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { ThreadTurnsListResponse } from './protocol/v2/ThreadTurnsListResponse';
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification';
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
import {
  CodexError,
  CodexRpc,
  type Launch,
  type Rpc,
  type RpcHandlers,
  type StartRpc,
} from './rpc';
import { Translator } from './translate';
import { toolsetReceipt } from '../../../sessions/shared/toolset-result';
import {
  presentationContext,
  PRESENTATION_CONTEXT,
  selectPresentationNotices,
} from '../../../sessions/shared/host-context';
import { inboxContext, INBOX_CONTEXT, type InboxNotice } from '../../../sessions/shared/inbox';
import type { HostTurnContext, HostContextDelivery } from '../../../sessions/main/provider';

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
// How long a title may take to be written, from the start of its app-server, before it fails.
const TITLE_TIMEOUT_MS = 120_000;
// The items a title's turn may hold: the prompt, the agent's reasoning and its reply.
const TITLE_ITEMS = new Set<string>(['userMessage', 'reasoning', 'agentMessage']);
// The instructions a title's thread runs with beside Codex's own.
const TITLE_INSTRUCTIONS =
  'You write short titles for conversations. Reply with the title alone, and run no commands.';
process.on('exit', () => {
  for (const folder of probeFolders) rmSync(folder, { recursive: true, force: true });
});

// The app-server's settings for the app's toolset (ADR-0023): its address, the variable that holds the
// session's credential, its tools allowed without asking, and how long a call may take, as the toolset
// says, so that Codex's own limit for a tool call never ends one while the user answers its approval.
// Codex starts no thread while it cannot reach the toolset.
function toolsetLaunch(toolset: Toolset, access: ToolsetAccess): Launch {
  const server = `mcp_servers.${toolset.name}`;
  const settings = [
    // Codex uses each segment of a dotted launch override as a literal key.
    'plugins.unified-computer-use@openai-bundled.enabled=false',
    `${server}.url=${JSON.stringify(access.url)}`,
    `${server}.bearer_token_env_var=${JSON.stringify(TOOLSET_VARIABLE)}`,
    `${server}.default_tools_approval_mode="approve"`,
    `${server}.required=true`,
    `${server}.tool_timeout_sec=${String(Math.ceil(toolset.callTimeoutMs / 1000))}`,
  ];
  return {
    args: settings.flatMap((setting) => ['-c', setting]),
    env: { [TOOLSET_VARIABLE]: access.credential },
  };
}

export interface CodexProviderOptions {
  // An already-bound fallback for direct adapter composition/tests. Hosted sessions receive their
  // own bound factory in StartOptions.toolset (ADR-0023).
  toolset?: Toolset;
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
  // The probes' app-servers, each kept from the moment it starts, before Codex answers it, so that
  // closing ends one still starting.
  const probes = new Probes();
  const probeConnect: Connect = async (cwd, handlers, launch) => {
    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const { rpc } = await probes.start(() => {
      const started = startRpc(
        cwd,
        {
          ...handlers,
          exit: (error) => {
            markEnded();
            handlers.exit(error);
          },
        },
        launch,
      );
      return { rpc: started, ended, stop: () => started.close() };
    });
    return initialize(rpc, clientVersion);
  };
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
      return await withCodex(probeConnect, cwd, use);
    } finally {
      probeFolders.delete(cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  };
  return {
    id: 'codex',
    start(options, onEvent) {
      const bound = options.toolset ?? toolset;
      if (!bound) return Promise.reject(new Error('A session needs its bound toolset.'));
      const settings = sessionSettings(options, gatewaysDir);
      return CodexSession.open(settings, null, connect, bound, link, onEvent);
    },
    resume(options, onEvent) {
      const bound = options.toolset ?? toolset;
      if (!bound) return Promise.reject(new Error('A session needs its bound toolset.'));
      const settings = sessionSettings(options, gatewaysDir);
      return CodexSession.open(settings, options.sessionId, connect, bound, link, onEvent);
    },
    // Read through a short-lived app-server, which lists the thread's turns and reads its name without
    // loading it, the name being the title Codex keeps for the session, as a running session reports it.
    history(sessionId, cwd) {
      return withCodex(probeConnect, cwd, async (rpc): Promise<SessionEvent[]> => {
        const events = await pastEvents(rpc, sessionId, new Translator(cwd));
        const params: ThreadReadParams = { threadId: sessionId, includeTurns: false };
        const { thread } = await rpc.request<ThreadReadResponse>('thread/read', params);
        return thread.name === null || thread.name === ''
          ? events
          : [...events, { type: 'title', title: thread.name }];
      });
    },
    listSessions(cwd, limit) {
      return withCodex(probeConnect, cwd, async (rpc): Promise<HistoryEntry[]> => {
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
    // With the configuration as Codex reads it for the folder a page would start a session in, where
    // it gives one, so that a trusted project's own settings count as they do for a thread there; the
    // probe itself runs in a throwaway folder.
    async listModels(gateway, folder) {
      const own =
        gateway === null ? NO_DEFAULTS : gatewayDefaults(await readGateway(gatewaysDir, gateway));
      const cwd = await mkdtemp(join(tmpdir(), 'codex-models-'));
      probeFolders.add(cwd);
      try {
        return await withCodex(probeConnect, cwd, async (rpc) => {
          const models = await allModels(rpc);
          return modelOptions(models, overGateway(own, await configuredDefaults(rpc, folder)));
        });
      } finally {
        probeFolders.delete(cwd);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    // A title from an ephemeral thread of a short-lived app-server (ADR-0035), which Codex keeps no
    // rollout of.
    async writeTitle(request) {
      const gateway =
        request.gateway === null ? null : await readGateway(gatewaysDir, request.gateway);
      const cwd = await mkdtemp(join(tmpdir(), 'codex-title-'));
      probeFolders.add(cwd);
      try {
        return await writeTitle(probeConnect, cwd, request, request.gateway, gateway);
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
    close() {
      return probes.close();
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

// One exchange with a short-lived app-server, a probe, that starts no thread; it ends once the process
// has exited.
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

// The reply to a title's prompt from an ephemeral thread, which keeps no rollout, in a short-lived
// app-server in the folder given, through the gateway where one is named, with the model and effort
// given, read-only and never asking; the thread's last agent message once its turn completes.
async function writeTitle(
  connect: Connect,
  cwd: string,
  { model, effort, prompt }: TitleRequest,
  name: string | null,
  gateway: GatewaySettings | null,
): Promise<string> {
  let reply = '';
  let settle: { done: (text: string) => void; fail: (error: Error) => void } | undefined;
  const completed = new Promise<string>((resolve, reject) => {
    settle = { done: resolve, fail: reject };
  });
  const launch =
    name === null || gateway === null
      ? undefined
      : { args: gatewayLaunchArgs(name, gateway), env: {} };
  const rpc = await connect(
    cwd,
    {
      notification: (method, params) => {
        if (method === 'item/started') {
          // The thread runs no tools: one that starts fails the title, and closing the app-server
          // stops it.
          const { item } = params as ItemCompletedNotification;
          if (!TITLE_ITEMS.has(item.type)) {
            settle?.fail(new Error('Codex CLI started a tool instead of writing the title.'));
          }
        } else if (method === 'item/completed') {
          const { item } = params as ItemCompletedNotification;
          if (item.type === 'agentMessage' && item.text.trim() !== '') reply = item.text;
        } else if (method === 'turn/completed') {
          const { turn } = params as TurnCompletedNotification;
          if (turn.status === 'completed') settle?.done(reply);
          else settle?.fail(new Error(turn.error?.message ?? 'Codex CLI did not write the title.'));
        }
      },
      request: (method) => Promise.reject(new Error(`3mukon-code does not answer ${method} here.`)),
      exit: () => {
        settle?.fail(new Error('Codex CLI ended before it wrote the title.'));
      },
    },
    launch,
  );
  try {
    const params: ThreadStartParams = {
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: TITLE_INSTRUCTIONS,
      ...(model === null ? {} : { model }),
      ...(gateway === null ? {} : { config: gateway.config }),
      ...(gateway?.modelProvider === undefined ? {} : { modelProvider: gateway.modelProvider }),
    };
    const { thread } = await rpc.request<ThreadStartResponse>('thread/start', params);
    const turn: TurnStartParams = {
      threadId: thread.id,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(effort === null ? {} : { effort }),
    };
    await rpc.request<TurnStartResponse>('turn/start', turn);
    return await withinTime(
      completed,
      TITLE_TIMEOUT_MS,
      'Codex CLI did not write the title in time.',
    );
  } catch (error) {
    // Without the original error as its cause, since that may show the gateway's settings.
    const kind = error instanceof CodexError ? error.kind : undefined;
    throw new CodexError(
      redact(error instanceof Error ? error.message : String(error), gateway),
      kind,
    );
  } finally {
    await rpc.close();
  }
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

// The model and effort a thread runs when the session chooses none, where settings name them.
interface Defaults {
  model: string | undefined;
  effort: ReasoningEffort | undefined;
}

const NO_DEFAULTS: Defaults = { model: undefined, effort: undefined };

// What a gateway's file names, which goes with the thread over Codex's own configuration.
function gatewayDefaults({ model, effort }: GatewaySettings): Defaults {
  return { model, effort };
}

// What Codex's own configuration names, as config/read gives it, for the folder where one is given,
// whose project settings then count, as for a thread there: a trusted project's, and none for a folder
// that does not exist yet. Codex 0.171.0 refuses the legacy `profile` key, so these are what it runs.
// Should Codex not answer, nothing counts as named, and the catalog's defaults stand.
async function configuredDefaults(rpc: Rpc, cwd?: string): Promise<Defaults> {
  const params: ConfigReadParams = cwd === undefined ? {} : { cwd };
  try {
    const { config } = await rpc.request<ConfigReadResponse>('config/read', params);
    return { model: config.model ?? undefined, effort: config.model_reasoning_effort ?? undefined };
  } catch {
    return NO_DEFAULTS;
  }
}

// The gateway's own over Codex's configuration, as the thread takes them.
function overGateway(gateway: Defaults, configured: Defaults): Defaults {
  return { model: gateway.model ?? configured.model, effort: gateway.effort ?? configured.effort };
}

// The model a thread runs when it chooses none: the one its settings name, or else the catalog's.
function defaultModel(models: Model[], defaults: Defaults): string | undefined {
  return defaults.model ?? models.find((model) => model.isDefault)?.model;
}

// The effort a thread runs a model with when the session chooses none: the one its settings name,
// which Codex runs whatever the model, even one that the model does not list, or else the model's own.
function defaultEffort(
  models: Model[],
  defaults: Defaults,
  model: string | undefined,
): ReasoningEffort | undefined {
  return defaults.effort ?? models.find((entry) => entry.model === model)?.defaultReasoningEffort;
}

// The models, with the one a thread runs when it chooses none marked, and the effort each one then
// runs with. A model that the settings name and Codex does not offer, such as a gateway's own, leads
// the list, since Codex runs it all the same.
function modelOptions(models: Model[], defaults: Defaults): ModelOption[] {
  const selected = defaultModel(models, defaults);
  const options = models.map((model): ModelOption => ({
    id: model.model,
    label: model.displayName,
    ...(model.description === '' ? {} : { description: model.description }),
    efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    ...(model.model === selected ? { default: true } : {}),
    defaultEffort: defaults.effort ?? model.defaultReasoningEffort,
  }));
  if (selected === undefined || options.some((option) => option.id === selected)) return options;
  return [
    {
      id: selected,
      label: selected,
      efforts: [],
      default: true,
      ...(defaults.effort === undefined ? {} : { defaultEffort: defaults.effort }),
    },
    ...options,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The errors with which Codex keeps a thread on the provider it started with, as it resumes the thread
// on an app-server whose configuration names another provider.
const PROVIDER_KEPT: ReadonlySet<string> = new Set([
  'modelProviderMismatch',
  'modelProviderNotConfigured',
]);

function keepsProvider(error: unknown): boolean {
  return error instanceof CodexError && error.kind !== undefined && PROVIDER_KEPT.has(error.kind);
}

// A gateway in words, or Codex's own configuration where there is none.
function gatewayWords(gateway: string | null): string {
  return gateway === null ? "Codex CLI's own configuration" : `the gateway "${gateway}"`;
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
  gatewayDefaults: Defaults;
}

class CodexSession implements ProviderSession {
  readonly supportsHostContext = true;
  private rpc!: Rpc;
  private threadId = '';
  private readonly translator: Translator;
  // The session's access to the app's toolset, and what its app-servers start with to use it.
  private access?: ToolsetAccess;
  // Codex's async questions waiting for the user's reply, by request id.
  private readonly asyncQuestions = new Map<string, QuestionRequest>();
  // The user's messages that Codex took into no turn, which start the next one together.
  private queued: Message[] = [];
  // Each connection's handlers act only while their connection is the session's current one. The
  // first connection is number 1, so 0 stands for none, as during a gateway switch.
  private generation = 0;
  private generations = 0;
  private models: Model[] = [];
  // What the gateway's file and Codex's configuration, as the session's folder makes it, name.
  private defaults: Defaults = NO_DEFAULTS;
  // The model the native thread actually selected, which may differ from its catalog default.
  private effectiveModel: string | null = null;
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
      session.access?.close();
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
      await session.refreshModels(attached.gatewayDefaults);
    } catch (error) {
      void attached.rpc.close();
      session.access?.close();
      throw error;
    }
    link.sessions.add(session);
    return session;
  }

  private constructor(
    private readonly settings: SessionSettings,
    private readonly connect: Connect,
    private readonly toolset: Toolset,
    private readonly link: AccountLink,
    private readonly onEvent: SessionEventListener,
  ) {
    this.translator = new Translator(settings.cwd);
    // A thread takes no effort of its own; a chosen one goes with the first turn.
    this.effortChanged = settings.effort !== null;
  }

  async send(
    text: string,
    images: MessageImage[] = [],
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    // A message of the user's own is their reply to Codex's async questions still open.
    this.resolveAsyncQuestions('answered');
    await this.deliver({ text, images, context, delivery });
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

  answerQuestion(
    requestId: string,
    answer: QuestionAnswer,
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void> {
    const asynchronous = this.asyncQuestions.get(requestId);
    if (asynchronous !== undefined) {
      this.asyncQuestions.delete(requestId);
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'answered' });
      const reply = asyncReply(asynchronous, answer);
      if (reply !== undefined) void this.reply(reply, context, delivery);
      else delivery?.failed();
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

  // Codex 0.171.0 takes a sandbox only for the turns that follow, in its stable and its experimental
  // API alike, so a switch during a turn applies from the next one.
  setSandbox(sandbox: SandboxLevel): Promise<void> {
    this.settings.sandbox = sandbox;
    this.sandboxChanged = true;
    this.onEvent({ type: 'settings', sandbox });
    return Promise.resolve();
  }

  // A turn of the app's own with the host context alone, as the notice of new messages (ADR-0036):
  // no message of the user's goes with it or shows.
  async deliverContext(context: HostTurnContext, delivery: HostContextDelivery): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    if (this.turnRunning) throw new Error('A turn is running.');
    this.announceTurn();
    await this.startTurn([{ text: '', images: [], context, delivery }]);
  }

  // Codex keeps the title as the thread's name, which it then reports.
  async setTitle(title: string): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    const params: ThreadSetNameParams = { threadId: this.threadId, name: title };
    await this.rpc.request('thread/name/set', params);
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
  // settings and the gateway's file as they are now: the app-server names the gateway's provider, which
  // Codex takes the thread's messages through, and the file's settings go with the thread. Codex's
  // errors are told without the file's text.
  private async attach(resumeId: string | null): Promise<Attached> {
    const { cwd, mode, model, sandbox, gatewaysDir, gateway: name } = this.settings;
    const gateway = name === null ? null : await readGateway(gatewaysDir, name);
    this.access?.close();
    this.access = this.toolset.open();
    const provider = name === null || gateway === null ? [] : gatewayLaunchArgs(name, gateway);
    const transport = toolsetLaunch(this.toolset, this.access);
    const launch = { ...transport, args: [...transport.args, ...provider] };
    const generation = ++this.generations;
    const rpc = await this.connect(cwd, this.handlers(generation), launch).catch(
      (error: unknown) => {
        this.access?.close();
        throw new Error(toolsetErrorMessage(error, this.access));
      },
    );
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
        gatewayDefaults: gateway === null ? NO_DEFAULTS : gatewayDefaults(gateway),
      };
    } catch (error) {
      this.access.close();
      void rpc.close();
      // Without the original error as its cause, since that may show the gateway's settings.
      const kind = error instanceof CodexError ? error.kind : undefined;
      throw new CodexError(redact(toolsetErrorMessage(error, this.access), gateway), kind);
    }
  }

  // Makes an attached app-server the session's current one. Codex's own settings may hold the thread
  // to another sandbox than the one asked for, and the session takes the one in force, unless the user
  // has switched the level since, which then goes with the next turn.
  private use({ rpc, generation, sandbox: requested, response }: Attached): void {
    this.rpc = rpc;
    this.generation = generation;
    this.threadId = response.thread.id;
    this.effectiveModel = response.model;
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

  // The models, and the defaults that Codex's configuration names for the session's folder, under the
  // gateway's own.
  private async refreshModels(gateway: Defaults): Promise<void> {
    this.models = await allModels(this.rpc);
    this.defaults = overGateway(gateway, await configuredDefaults(this.rpc, this.settings.cwd));
    this.onEvent({ type: 'models', models: modelOptions(this.models, this.defaults) });
    this.reportAvailability();
  }

  private reportAvailability(): void {
    const selected = this.models.find((model) => model.model === this.effectiveModel);
    const modalities = selected?.inputModalities;
    this.access?.availability?.({
      tools: 'ready',
      images: !modalities ? 'unknown' : modalities.includes('image') ? 'supported' : 'unsupported',
    });
  }

  // The turn's input, with whatever changed since the last turn. A model or an effort set back to the
  // default goes as the default that the models mark, the one the thread runs when it chooses none,
  // since a turn cannot unset what an earlier one chose.
  private turnParams(message: Message): TurnStartParams {
    const model = this.settings.model ?? defaultModel(this.models, this.defaults);
    const effort = this.settings.effort ?? defaultEffort(this.models, this.defaults, model);
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
  // Should the new one fail, the thread is resumed again on the earlier gateway. Codex keeps a thread on
  // the provider it started with, and refuses a gateway with another provider, or none in place of one;
  // the session then says so. A close asked for during the switch ends the session once the new
  // app-server is up.
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
        throw error;
      }
      if (!keepsProvider(error)) throw error;
      const message = `Codex CLI keeps this session on the model provider it started with, so it stays on ${gatewayWords(previousGateway)}; ${gatewayWords(gateway)} applies to new sessions.`;
      this.onEvent({ type: 'error', message });
      throw new Error(message, { cause: error });
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
    await this.refreshModels(attached.gatewayDefaults);
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
      const completed = params as ItemCompletedNotification;
      const item = completed.item;
      if (
        completed.threadId === this.threadId &&
        item.type === 'mcpToolCall' &&
        item.server === this.toolset.name &&
        this.access?.tools?.includes(item.tool)
      ) {
        const receipt = toolsetReceipt(item.result?.structuredContent, item.result?.content);
        if (receipt) this.access.result?.(item.tool, item.id, receipt);
      }
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
      () => {
        message.delivery?.accepted(
          selectPresentationNotices(message.context?.presentationNotices ?? []),
        );
        return true;
      },
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
      context: {
        presentationNotices: selectPresentationNotices(
          messages.flatMap((entry) => entry.context?.presentationNotices ?? []),
        ),
        inboxNotices: uniqueNotices(messages.flatMap((entry) => entry.context?.inboxNotices ?? [])),
      },
    };
    const params = this.turnParams(message);
    if (params.model && params.model !== this.effectiveModel)
      this.access?.availability?.({ tools: 'ready', images: 'unknown' });
    const started = this.rpc.request<TurnStartResponse>('turn/start', params);
    const starting = started.then(
      () => undefined,
      () => undefined,
    );
    this.starting = starting;
    try {
      const { turn } = await started;
      for (const entry of messages) entry.delivery?.accepted(message.context.presentationNotices);
      if (params.model) this.effectiveModel = params.model;
      this.reportAvailability();
      this.turnId = turn.id;
      this.modeChanged = false;
      this.modelChanged = false;
      this.effortChanged = false;
      this.sandboxChanged = false;
    } catch (error) {
      for (const message of messages) message.delivery?.failed();
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
  private async reply(
    text: string,
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) {
      delivery?.failed();
      return;
    }
    await this.deliver({ text, images: [], context, delivery }).catch(() => {
      delivery?.failed();
    });
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
    for (const message of this.queued) message.delivery?.failed();
    this.queued = [];
    this.access?.close();
    for (const [requestId, pending] of this.pending) {
      pending.resolve(declined(pending.request));
      this.onEvent({ type: 'request-resolved', requestId, outcome: 'cancelled' });
    }
    this.pending.clear();
    this.onEvent(error === undefined ? { type: 'closed' } : { type: 'closed', error });
  }

  private emit(event: SessionEvent): void {
    if (event.type === 'settings' && typeof event.model === 'string') {
      this.effectiveModel = event.model;
      this.reportAvailability();
    }
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
  context?: HostTurnContext;
  delivery?: HostContextDelivery;
}

// The notices once each, the first of each id.
function uniqueNotices(notices: readonly InboxNotice[]): InboxNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => !seen.has(notice.id) && Boolean(seen.add(notice.id)));
}

// A message as Codex takes it: its text, then its images as data URLs.
function turnInput({ text, images, context }: Message): UserInput[] {
  const host = presentationContext(context?.presentationNotices ?? []);
  const inbox = inboxContext(context?.inboxNotices ?? []);
  return [
    ...(host
      ? [
          {
            type: 'text' as const,
            text: host,
            text_elements: [
              {
                byteRange: { start: 0, end: Buffer.byteLength(host, 'utf8') },
                placeholder: PRESENTATION_CONTEXT,
              },
            ],
          },
        ]
      : []),
    ...(inbox
      ? [
          {
            type: 'text' as const,
            text: inbox,
            text_elements: [
              {
                byteRange: { start: 0, end: Buffer.byteLength(inbox, 'utf8') },
                placeholder: INBOX_CONTEXT,
              },
            ],
          },
        ]
      : []),
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
