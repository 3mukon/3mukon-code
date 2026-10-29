import type {
  ModelOption,
  PermissionMode,
  ProviderId,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from './events';
import type { SessionState, SessionStatus } from './session-state';

// One of the sessions the app has open, as the Sessions list shows it.
export interface SessionSummary {
  // The app's id for the session while it is open.
  id: string;
  provider: ProviderId;
  // The provider's id for the session.
  sessionId: string;
  // The folder the session works in.
  cwd: string;
  // The title the provider gave the session, once it has given one.
  title?: string;
  status: SessionStatus;
  // When the app opened the session, in milliseconds since the epoch.
  openedAt: number;
}

// What a session page starts a session with. A null gateway is the provider's own configuration, a
// null model or effort the provider's default.
export interface StartRequest {
  provider: ProviderId;
  // The absolute path of the folder the session works in.
  cwd: string;
  mode: PermissionMode;
  gateway: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  sandbox: SandboxLevel;
  // The first message, which starts the session's first turn.
  message: string;
}

// A session's state as the main process has folded it, after this many of its events.
export interface SessionSnapshot {
  seq: number;
  state: SessionState;
}

// Hears each event of every open session, numbered from 1 within its session.
export type SessionEventsListener = (id: string, seq: number, event: SessionEvent) => void;

// What the window asks of the sessions, through the preload bridge. Sessions go by the app's id.
export interface SessionsBridge {
  // The open sessions, newest first.
  list(): Promise<SessionSummary[]>;
  // Calls the listener with the whole list whenever a session opens or its title or status changes,
  // and returns a function that stops it.
  onChange(listener: (sessions: SessionSummary[]) => void): () => void;
  // The providers the app can start sessions with, in order.
  providers(): Promise<ProviderId[]>;
  // Where a session page opens while no workspace has been added: a folder of the day's date in the
  // 3mukon-code folder of the user's home folder, made when its first session starts.
  dayFolder(): Promise<string>;
  // The gateways set up in the provider's own settings; empty for a provider without gateways.
  gateways(provider: ProviderId): Promise<string[]>;
  // The models a session through the gateway, or the provider's own configuration, could use.
  models(provider: ProviderId, gateway: string | null): Promise<ModelOption[]>;
  // Asks the user to confirm yolo for a session page whose session has not started; resolves with
  // whether they did.
  confirmYolo(): Promise<boolean>;
  // Starts a session with its first message, and resolves with the app's id for it.
  start(request: StartRequest): Promise<string>;
  // Sends a message, starting a turn; only while no turn runs.
  send(id: string, text: string): Promise<void>;
  // Stops the running turn.
  interrupt(id: string): Promise<void>;
  // Switches the permission mode, to yolo only once the user confirms; resolves with whether it
  // switched.
  setMode(id: string, mode: PermissionMode): Promise<boolean>;
  setGateway(id: string, gateway: string | null): Promise<void>;
  setModel(id: string, model: string | null): Promise<void>;
  setEffort(id: string, effort: ReasoningEffort | null): Promise<void>;
  setSandbox(id: string, sandbox: SandboxLevel): Promise<void>;
  // The session's state so far, or null for a session the app does not have open.
  snapshot(id: string): Promise<SessionSnapshot | null>;
  // Calls the listener with every event of every open session, and returns a function that stops it.
  onEvent(listener: SessionEventsListener): () => void;
}
