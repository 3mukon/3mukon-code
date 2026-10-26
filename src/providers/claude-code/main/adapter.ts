import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Provider,
  ProviderSession,
  SessionEventListener,
  StartOptions,
} from '../../../sessions/main/provider';
import type {
  ApprovalAnswer,
  ModelOption,
  PermissionMode,
  QuestionAnswer,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../../../sessions/shared/events';
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

// Claude Code's effort level for the app's choice; throws for a level Claude Code does not have.
function effortLevel(effort: ReasoningEffort | null): EffortLevel | null {
  if (effort === null || EFFORT_LEVELS.has(effort)) return effort as EffortLevel | null;
  throw new Error(`Claude Code has no reasoning effort "${effort}".`);
}

export interface ClaudeCodeProviderOptions {
  // The folder of gateway files; Claude Code's own gateways folder when left out.
  gatewaysDir?: string;
}

// Claude Code through the Claude Agent SDK, on whatever sign-in Claude Code itself has.
export function createClaudeCodeProvider({
  gatewaysDir = defaultGatewaysDir(),
}: ClaudeCodeProviderOptions = {}): Provider {
  return {
    id: 'claude-code',
    async start(options, onEvent) {
      const settings = await sessionSettings(options, gatewaysDir, randomUUID(), false);
      return ClaudeCodeSession.open(settings, onEvent, new Translator(options.cwd));
    },
    async resume(options, onEvent) {
      const settings = await sessionSettings(options, gatewaysDir, options.sessionId, true);
      const translator = new Translator(options.cwd);
      for (const message of await getSessionMessages(options.sessionId, { dir: options.cwd })) {
        for (const event of translator.history(message)) onEvent(event);
      }
      onEvent({ type: 'replay-finished' });
      return ClaudeCodeSession.open(settings, onEvent, translator);
    },
    async listSessions(cwd, limit) {
      const sessions = await listSessions({ dir: cwd, limit });
      return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary,
        cwd: session.cwd ?? cwd,
        updatedAt: session.lastModified,
      }));
    },
    listGateways() {
      return listGateways(gatewaysDir);
    },
    async listModels(gateway) {
      return probeModels(gateway === null ? null : await existingGatewayPath(gatewaysDir, gateway));
    },
  };
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
  };
}

// The models a session would have, from a Claude Code that initializes and is closed before any message,
// so that no session is recorded. It loads no settings files, so that none of the user's or a project's
// hooks run; a gateway's file is the one it reads.
async function probeModels(gatewayFile: string | null): Promise<ModelOption[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-code-models-'));
  const input = new InputQueue();
  const probe = query({
    prompt: input,
    options: {
      cwd,
      settingSources: [],
      persistSession: false,
      ...(gatewayFile === null ? {} : { settings: gatewayFile }),
    },
  });
  try {
    return modelOptions((await probe.initializationResult()).models);
  } finally {
    input.end();
    probe.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

function modelOptions(models: ModelInfo[]): ModelOption[] {
  return models.map((model) => ({
    id: model.value,
    label: model.displayName,
    ...(model.description === '' ? {} : { description: model.description }),
    efforts: model.supportedEffortLevels ?? [],
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SessionSettings {
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
  readonly input: InputQueue;
  readonly query: Query;
  // Settles once the process's messages have ended.
  done: Promise<void>;
}

class ClaudeCodeSession implements ProviderSession {
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
  private closing = false;
  private closed = false;
  // A gateway asked for during a turn, which takes over when the turn ends.
  private pendingGateway: string | null | undefined;
  // The gateway switch under way, which a message waits for; it never rejects.
  private switching: Promise<void> | null = null;

  // Resolves once Claude Code has started and answered the SDK's initialization.
  static async open(
    settings: SessionSettings,
    onEvent: SessionEventListener,
    translator: Translator,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(settings, onEvent, translator);
    try {
      await session.initialize();
    } catch (error) {
      session.connection.query.close();
      throw error;
    }
    return session;
  }

  private constructor(
    private readonly settings: SessionSettings,
    private readonly onEvent: SessionEventListener,
    private readonly translator: Translator,
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

  async send(text: string): Promise<void> {
    if (this.switching !== null) await this.switching;
    if (this.closed) throw new Error('The session is closed.');
    this.turnRunning = true;
    // From its first message on, Claude Code keeps a transcript that a new process can continue.
    this.settings.resume = true;
    this.onEvent({ type: 'turn-started' });
    this.onEvent({ type: 'message', id: randomUUID(), role: 'user', text });
    this.connection.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
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
    await (await this.process()).setPermissionMode(nativeModes[mode]);
    this.settings.mode = mode;
    this.onEvent({ type: 'mode', mode });
  }

  async setModel(model: string | null): Promise<void> {
    await (await this.process()).setModel(model ?? undefined);
    this.settings.model = model;
    this.onEvent({ type: 'settings', model });
  }

  async setEffort(effort: ReasoningEffort | null): Promise<void> {
    const level = effortLevel(effort);
    await (await this.process()).applyFlagSettings({ effortLevel: level });
    this.settings.effort = level;
    this.onEvent({ type: 'settings', effort: level });
  }

  // Claude Code takes the new level at once, during a turn too.
  async setSandbox(sandbox: SandboxLevel): Promise<void> {
    const query = await this.process();
    const leavingReadOnly = this.settings.sandbox === 'read-only';
    await query.applyFlagSettings(sandboxSettings(sandbox, this.settings.folders, leavingReadOnly));
    this.settings.sandbox = sandbox;
    this.onEvent({ type: 'settings', sandbox });
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
    this.connection.input.end();
    this.connection.query.close();
    return Promise.resolve();
  }

  // Starts a Claude Code process for the session, with the session's settings as they are now.
  private connect(): Connection {
    const { settings } = this;
    const input = new InputQueue();
    const connection: Connection = {
      input,
      query: query({
        prompt: input,
        options: {
          cwd: settings.cwd,
          permissionMode: nativeModes[settings.mode],
          // Lets a session switch to yolo later; it starts in, and stays in, the mode chosen.
          allowDangerouslySkipPermissions: true,
          // Text and thinking arrive as they are written.
          includePartialMessages: true,
          // Claude Code's own system prompt, as in the CLI; its settings and CLAUDE.md files load as
          // they do there.
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          canUseTool: this.canUseTool,
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

  // Waits for Claude Code's initialization, which lists the models the session can use, and puts the
  // process on the session's sandbox level before any message. The level goes in as flag settings,
  // since the SDK's own sandbox option cannot go beside a gateway's settings file.
  private async initialize(): Promise<void> {
    const init = await this.connection.query.initializationResult();
    await this.connection.query.applyFlagSettings(
      sandboxSettings(this.settings.sandbox, this.settings.folders, false),
    );
    this.onEvent({ type: 'models', models: modelOptions(init.models) });
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
  // gateway's file, so the session keeps its id and its history.
  private async reconnect(gateway: string | null): Promise<void> {
    if (this.closed) return;
    const previous = this.connection;
    this.retired.add(previous);
    previous.input.end();
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
      throw error;
    }
    this.onEvent({ type: 'settings', gateway });
  }

  // Every canUseTool call waits here for the user's answer, or for the SDK to give up on it.
  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
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

  private async pump(connection: Connection): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of connection.query) {
        for (const event of this.translator.live(message)) this.emit(event);
      }
    } catch (caught) {
      error = errorMessage(caught);
    }
    if (!this.retired.has(connection)) this.finish(error);
  }

  // The session has ended: what is still open is cancelled, and closed is reported once.
  private finish(error: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
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
