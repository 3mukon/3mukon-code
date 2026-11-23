import type {
  ApprovalAnswer,
  HistoryEntry,
  MessageImage,
  ModelOption,
  PermissionMode,
  ProviderId,
  QuestionAnswer,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../shared/events';
import type { InboxNotice } from '../shared/inbox';
import type {
  AutomationPolicy,
  AutomationCallReceipt,
  Availability,
  EndReason,
  PresentationNotice,
  ProviderToolLink,
} from '../shared/automation';

// Receives a session's events in the order they happen.
export type SessionEventListener = (event: SessionEvent) => void;

export interface StartOptions {
  // The workspace folder the agent works in.
  cwd: string;
  // auto when left out.
  mode?: PermissionMode;
  // A gateway as listGateways names it; the provider's own configuration when left out.
  gateway?: string;
  // A model as listModels names it; the provider's default when left out.
  model?: string;
  // One of the model's effort levels; the model's default when left out.
  effort?: ReasoningEffort;
  // workspace-write when left out.
  sandbox?: SandboxLevel;
  // Already bound by the host before startup, independently of the provider's native session ID.
  toolset?: Toolset;
}

export interface ResumeOptions extends StartOptions {
  // The provider's id of the session to continue, as listSessions returns it.
  sessionId: string;
}

// What a session's title is written from (ADR-0035): the session's gateway, model and effort, null
// for the provider's own configuration, default model or default effort, and the prompt, which
// holds the instructions and the conversation so far.
export interface TitleRequest {
  gateway: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  prompt: string;
}

// One provider protocol behind the provider-neutral session model; each adapter under src/providers/
// implements it. Methods reject when the provider refuses or fails; failures that happen later, while
// a session runs, arrive as error and closed events. Credentials never pass through this interface:
// providers sign in through their own tools, and gateways go by name (ADR-0008).
export interface Provider {
  readonly id: ProviderId;
  // Starts a session and resolves once the provider has given it an id. The listener receives every
  // event of the session, from the first.
  start(options: StartOptions, onEvent: SessionEventListener): Promise<ProviderSession>;
  // Continues a session from the provider's history. Its past events arrive first, then
  // replay-finished.
  resume(options: ResumeOptions, onEvent: SessionEventListener): Promise<ProviderSession>;
  // The folder's past sessions from the provider's own store, newest first, at most limit of them.
  listSessions(cwd: string, limit: number): Promise<HistoryEntry[]>;
  // A past session's events from the provider's own store, as resume replays them, without resuming
  // it: no turn runs, and nothing of the session stays open.
  history(sessionId: string, cwd: string): Promise<SessionEvent[]>;
  // The gateways set up in the provider's own settings, by name and in order; empty for a provider
  // without gateways.
  listGateways(): Promise<string[]>;
  // The models a session through this gateway, or through the provider's own configuration when it is
  // null, could use, in the folder where one is given. Found without starting a session, so nothing
  // appears in the provider's history, and without running anything in the folder, which may not exist
  // yet: a provider counts the folder's own settings only where it can read them so, as Codex can.
  listModels(gateway: string | null, cwd?: string): Promise<ModelOption[]>;
  // Answers the prompt with the agent's reply alone, through the gateway and with the model and
  // effort given, in a request of its own beside any session (ADR-0035): it runs no tools, changes
  // no session and leaves no session in the provider's history. Rejects when the provider refuses
  // or fails.
  writeTitle?(request: TitleRequest): Promise<string>;
  // Ends the processes the provider runs outside its sessions, such as those listing its models or
  // reading its account, and starts no more; resolves once they have ended. The app calls it as it
  // quits, so that none of them outlives the app.
  close(): Promise<void>;
}

export interface ProviderSession {
  // The provider's id for the session.
  readonly id: string;
  // Set only by an adapter that sends host context to the model separately from the user's text.
  readonly supportsHostContext?: true;
  // Sends the user's message and its images, and resolves once the provider has accepted it; the
  // message is reported at once. While no turn runs it starts one, whose progress and end arrive as
  // events; during a turn it goes to the running turn, or, where the provider cannot add it there, to a
  // turn of its own that follows, as the provider takes it.
  send(
    text: string,
    images?: MessageImage[],
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void>;
  // Stops the running turn. Approvals and questions still open resolve as cancelled.
  interrupt(): Promise<void>;
  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(
    requestId: string,
    answer: QuestionAnswer,
    context?: HostTurnContext,
    delivery?: HostContextDelivery,
  ): Promise<void>;
  // Switches the permission mode for what follows.
  setMode(mode: PermissionMode): Promise<void>;
  // Switches the model for what follows; null returns to the provider's default.
  setModel(model: string | null): Promise<void>;
  // Switches the reasoning effort for what follows; null returns to the model's default.
  setEffort(effort: ReasoningEffort | null): Promise<void>;
  // Switches the sandbox level, independently of the permission mode. Where the provider allows it the
  // switch happens at once, even during a turn; otherwise it applies from the next turn.
  setSandbox(sandbox: SandboxLevel): Promise<void>;
  // Switches the gateway; null returns to the provider's own configuration. Between turns the switch
  // happens at once; asked for during a turn, it happens when the turn ends, before the next one. The
  // session keeps its id and its history.
  setGateway(gateway: string | null): Promise<void>;
  // Gives the session the title in the provider's own store, where the provider keeps titles, so
  // that its own tools show it; a title event follows where the provider reports one.
  setTitle?(title: string): Promise<void>;
  // Starts a turn of the app's own that carries the host context alone, without a message of the
  // user's, as the notice of new messages to an idle session does (ADR-0036); resolves once the
  // provider has taken it, and refuses while a turn runs. Set only beside supportsHostContext.
  deliverContext?(context: HostTurnContext, delivery: HostContextDelivery): Promise<void>;
  // Ends the session and its provider process; a closed event follows.
  close(): Promise<void>;
}

// A session as an agent's session tools list it (ADR-0036): the app's id that addresses it, its
// title, provider, folder and status, and its parent where it is a child.
export interface CoordinatedSession {
  id: string;
  title: string;
  provider: ProviderId;
  folder: string;
  status: 'idle' | 'running' | 'waiting' | 'closed';
  parent?: string;
}

// What an agent asks a child session to be: its first message, which is its task, and where given,
// its provider, model, effort, a narrower sandbox level than its parent's and a title.
export interface ChildRequest {
  prompt: string;
  provider?: ProviderId;
  model?: string;
  effort?: ReasoningEffort;
  sandbox?: SandboxLevel;
  title?: string;
}

// A message in a session's inbox as its agent lists it, without its body, and whether it was read.
export interface InboxEntry extends InboxNotice {
  read: boolean;
}

// What an agent's session tools reach of the sessions (ADR-0036), which the host implements and the
// toolset calls with the calling session's own id, from its bound access, never from a model's
// arguments. Each method rejects, or throws, with the reason in words where the app refuses.
export interface SessionCoordinator {
  // Whether the session may start sessions: one that is not a child.
  mayStart(owner: string): boolean;
  // The sessions of the Sessions list, archived ones aside.
  list(owner: string): CoordinatedSession[];
  // Starts a child of the session, once it has taken its first message.
  start(owner: string, request: ChildRequest): Promise<CoordinatedSession>;
  // Ends a child of the session, or the session itself where it is a child.
  end(owner: string, id: string): Promise<CoordinatedSession>;
  // Puts a message in another session's inbox, and gives it back with the receiver's title.
  send(
    owner: string,
    to: string,
    summary: string,
    body: string,
  ): InboxEntry & { to: string; toTitle: string };
  // The session's inbox, the newest first, and one message's body, which marks it read.
  inbox(owner: string): InboxEntry[];
  read(owner: string, id: string): InboxEntry & { body: string };
  // The notices the result of the session's next call to the app's tools carries, and what marks
  // them told as the result goes; undefined where there are none.
  notices(owner: string): { notices: InboxNotice[]; told(): void } | undefined;
}

// A factory already bound to one app session (ADR-0023). The host supplies it before the provider
// has a native ID. Opening it rotates that owner's transport access; an adapter never chooses an
// owner through model arguments or a provider-native session ID.
export interface Toolset {
  // The name providers list it under.
  readonly name: string;
  // How long a provider waits on one of the toolset's calls, in milliseconds, where its MCP client
  // lets the app say: long enough for the user to answer an operation's approval, which the toolset
  // waits for without a limit of its own, so that no provider ends the call while the user decides.
  readonly callTimeoutMs: number;
  open(): ToolsetAccess;
}

// How one session's provider process reaches the toolset.
export interface ToolsetAccess {
  // The toolset's address, which only this Mac can reach.
  readonly url: string;
  // The session's own credential, which the provider sends as a bearer credential. It is the app's,
  // opens only the toolset and only for this session, and is never a provider credential.
  readonly credential: string;
  readonly generation?: number;
  // Canonical names registered by this app, for routing native approvals to the host broker.
  readonly tools?: readonly string[];
  // Adapter observations only; neither method is exposed to the model or the renderer.
  availability?(value: Availability): void;
  result?(toolName: string, providerToolId: string, receipt: AutomationCallReceipt): void;
  // Ends the session's access.
  close: () => void;
}

// Providers may include their HTTP configuration in an error. Hide only this process's app-owned
// transport credential; provider credentials never enter this interface.
export function toolsetErrorMessage(error: unknown, access?: ToolsetAccess): string {
  const message = error instanceof Error ? error.message : String(error);
  return access?.credential ? message.replaceAll(access.credential, '[toolset access]') : message;
}
export function toolsetError(error: unknown, access?: ToolsetAccess): Error {
  // The cause may hold raw transport configuration, so it must not accompany the sanitized error.
  return new Error(toolsetErrorMessage(error, access));
}

// App composition supplies the implementation; sessions imports no automation backend.
export interface SessionAutomationHost {
  bind(options: AutomationPolicy & { id: string; cwd: string }): Promise<SessionAutomation>;
}
export interface SessionAutomation {
  readonly toolset: Toolset;
  turnStarted(): void;
  turnEnded(): void;
  stop(reason?: EndReason): void;
  setPolicy(policy: AutomationPolicy): void;
  disconnect(): void;
  close(remove?: boolean): Promise<void>;
  // Accepted means a capable provider accepted the context with the turn, not that the renderer
  // queued it. Adapters without host context and failed sends leave notices pending. User text
  // stays unchanged.
  prepareSend(): HostContextDelivery & { context: HostTurnContext };
  linkResult(link: ProviderToolLink): void;
  // Tells the listener, at once and at each change, since when the session's oldest operation
  // approval has waited for the user's answer, or undefined while none waits; the function returned
  // stops it.
  onWaiting(listener: (since: number | undefined) => void): () => void;
}
export interface HostTurnContext {
  presentationNotices: readonly PresentationNotice[];
  // The new messages from other sessions the agent is told of, by their summaries (ADR-0036), in a
  // block of their own beside the presentation state.
  inboxNotices?: readonly InboxNotice[];
}
// Separate from the serializable context: queued input is not yet delivery. The adapter settles
// this only on a native acknowledgement, or failure, including cancellation of its queued messages.
export interface HostContextDelivery {
  // Queued messages can share a bounded context. Omitted notices stay pending, and an older
  // prepared version cannot acknowledge a newer change.
  accepted(delivered?: readonly PresentationNotice[]): void;
  failed(): void;
}

// A process a provider starts outside its sessions, such as one that lists its models or reads its
// account: a probe.
export interface ProbeProcess {
  // Resolves once the process has ended, however it ended; it never rejects.
  readonly ended: Promise<unknown>;
  // Ends the process; resolves once it has ended. Called again, it only waits.
  stop(): Promise<void>;
}

const CLOSED = 'The provider has closed, so it starts no more processes.';

// A provider's probes, each kept from its start until it ends, so that the provider can end them as the
// app quits: once it closes, it starts no probe, stops those it keeps, and resolves once every one has
// ended, including those still starting as it closed.
export class Probes {
  private closing = false;
  private readonly starting = new Set<Promise<unknown>>();
  private readonly running = new Set<ProbeProcess>();

  // Starts a probe and keeps it until it ends. Rejects once the provider is closing; a probe that
  // starts as it closes is stopped first.
  start<P extends ProbeProcess>(start: () => P | Promise<P>): Promise<P> {
    if (this.closing) return Promise.reject(new Error(CLOSED));
    const started = (async () => {
      const probe = await start();
      this.running.add(probe);
      const forget = () => {
        this.running.delete(probe);
      };
      probe.ended.then(forget, forget);
      if (this.closing) {
        await probe.stop();
        throw new Error(CLOSED);
      }
      return probe;
    })();
    this.starting.add(started);
    const settled = () => {
      this.starting.delete(started);
    };
    started.then(settled, settled);
    return started;
  }

  // Starts no more probes, stops those kept, and resolves once every one has ended.
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.starting);
    await Promise.allSettled([...this.running].map((probe) => probe.stop()));
  }
}
