import type {
  ApprovalAnswer,
  HistoryEntry,
  MessageImage,
  ModelOption,
  PermissionMode,
  ProviderId,
  Question,
  QuestionAnswer,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from '../shared/events';

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
}

export interface ResumeOptions extends StartOptions {
  // The provider's id of the session to continue, as listSessions returns it.
  sessionId: string;
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
  // The gateways set up in the provider's own settings, by name and in order; empty for a provider
  // without gateways.
  listGateways(): Promise<string[]>;
  // The models a session through this gateway, or through the provider's own configuration when it is
  // null, could use. Found without starting a session, so nothing appears in the provider's history.
  listModels(gateway: string | null): Promise<ModelOption[]>;
}

export interface ProviderSession {
  // The provider's id for the session.
  readonly id: string;
  // Starts a turn with the user's message and its images, and resolves once the provider has accepted
  // it; the turn's progress and end arrive as events. Called only while no turn is running.
  send(text: string, images?: MessageImage[]): Promise<void>;
  // Stops the running turn. Approvals and questions still open resolve as cancelled.
  interrupt(): Promise<void>;
  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void>;
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
  // Ends the session and its provider process; a closed event follows.
  close(): Promise<void>;
}

// The app's own MCP toolset, named 3mukon-code (ADR-0009). The app starts it once and hands it to the
// adapters whose providers lack one of its tools; an adapter opens it for each session it runs and
// gives the session's provider process the address and the credential.
export interface Toolset {
  // The name providers list it under.
  readonly name: string;
  open(session: ToolsetSession): ToolsetAccess;
}

// What the toolset needs from the session that a call comes from.
export interface ToolsetSession {
  // Shows the questions to the user, as a question request of the session, and resolves with the
  // answer. It resolves as declined when the user declines, the turn is interrupted or the session
  // closes, and when the signal aborts, as it does when the provider gives up the call.
  ask(questions: Question[], signal: AbortSignal): Promise<QuestionAnswer>;
}

// How one session's provider process reaches the toolset.
export interface ToolsetAccess {
  // The toolset's address, which only this Mac can reach.
  readonly url: string;
  // The session's own credential, which the provider sends as a bearer credential. It is the app's,
  // opens only the toolset and only for this session, and is never a provider credential.
  readonly credential: string;
  // Ends the session's access; calls still running end as cancelled.
  close(): void;
}
