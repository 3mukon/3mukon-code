import type { ProviderId } from './events';
import type { SessionStatus } from './session-state';

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

// What the window asks of the sessions, through the preload bridge.
export interface SessionsBridge {
  // The open sessions, newest first.
  list(): Promise<SessionSummary[]>;
  // Calls the listener with the whole list whenever a session opens or its title or status changes,
  // and returns a function that stops it.
  onChange(listener: (sessions: SessionSummary[]) => void): () => void;
}
