import type {
  ApprovalAnswer,
  HistoryEntry,
  PermissionMode,
  ProviderId,
  QuestionAnswer,
  SessionEvent,
} from '../shared/events';

// Receives a session's events in the order they happen.
export type SessionEventListener = (event: SessionEvent) => void;

export interface StartOptions {
  // The workspace folder the agent works in.
  cwd: string;
  // auto when left out.
  mode?: PermissionMode;
}

export interface ResumeOptions extends StartOptions {
  // The provider's id of the session to continue, as listSessions returns it.
  sessionId: string;
}

// One provider protocol behind the provider-neutral session model; each adapter under src/providers/
// implements it. Methods reject when the provider refuses or fails; failures that happen later, while
// a session runs, arrive as error and closed events. Credentials never pass through this interface:
// providers sign in through their own tools (ADR-0001).
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
}

export interface ProviderSession {
  // The provider's id for the session.
  readonly id: string;
  // Starts a turn with the user's message, and resolves once the provider has accepted it; the turn's
  // progress and end arrive as events. Called only while no turn is running.
  send(text: string): Promise<void>;
  // Stops the running turn. Approvals and questions still open resolve as cancelled.
  interrupt(): Promise<void>;
  answerApproval(requestId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(requestId: string, answer: QuestionAnswer): Promise<void>;
  // Switches the permission mode for what follows.
  setMode(mode: PermissionMode): Promise<void>;
  // Ends the session and its provider process; a closed event follows.
  close(): Promise<void>;
}
