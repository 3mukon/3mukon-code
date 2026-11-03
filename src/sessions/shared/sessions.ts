import type {
  MessageImage,
  ModelOption,
  PermissionMode,
  ProviderId,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
} from './events';
import type { SessionState, SessionStatus } from './session-state';

// A session started in the app, in this run or an earlier one, as the Sessions list and the archived
// list show it.
export interface SessionSummary {
  // The app's id for the session, the same in every run.
  id: string;
  provider: ProviderId;
  // The provider's id for the session.
  sessionId: string;
  // The folder the session works in.
  cwd: string;
  // The title the provider gave the session, or else its first message, once there is one.
  title?: string;
  // Closed for a session that is not running: one of an earlier run, or one whose provider stopped.
  status: SessionStatus;
  // When the user last sent the session a message or a turn of it ended, in milliseconds since the
  // epoch; the lists show the latest first.
  activeAt: number;
  // While the session waits on the user, since when: its oldest open approval's or question's time.
  waitingSince?: number;
  // The session is in the archived list instead of the Sessions list.
  archived?: true;
}

// What the window's lists show of the sessions: the Sessions list's, how many are archived, which the
// archived list loads only as it opens, and the others the window has shown in its panels.
export interface SessionList {
  // The sessions that are not archived, the most recently active first: the 1,000 the records keep,
  // and any that is open.
  sessions: SessionSummary[];
  archived: number;
  // The sessions whose pages the window has shown in this run that the Sessions list does not hold:
  // archived ones, and those the records no longer keep.
  shown: SessionSummary[];
}

// The settings a session runs with. A null gateway is the provider's own configuration, a null model
// or effort the provider's default.
export interface SessionSettings {
  mode: PermissionMode;
  gateway: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  sandbox: SandboxLevel;
}

// What a session page starts a session with.
export interface StartRequest extends SessionSettings {
  provider: ProviderId;
  // The absolute path of the folder the session works in.
  cwd: string;
  // The first message, which starts the session's first turn, and its images.
  message: string;
  images: MessageImage[];
}

// What a session page resumes a session that is not running with: the settings it shows, and the
// message that starts the session's next turn, with its images.
export interface ResumeRequest extends SessionSettings {
  message: string;
  images: MessageImage[];
}

// What the user can do with a session from its menu: archive it, or unarchive it in the archived
// list, and remove it from the app's lists.
export type SessionAction = 'archive' | 'unarchive' | 'remove';

// What the user can do with an image the timeline shows, from its menu.
export type ImageAction = 'copy' | 'save';

// The settings a folder's sessions last used, which a session page opened there starts with. The
// permission mode is not among them: a session starts in auto unless the user chooses yolo on its page
// (ADR-0006).
export interface RememberedChoice {
  provider: ProviderId;
  gateway: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  sandbox: SandboxLevel;
}

// The settings sessions last used, for the providers the app offers: each folder's, by the folder's
// absolute path, and those the day folders share, which hold for every day folder in the day root.
export interface FolderChoices {
  folders: Record<string, RememberedChoice>;
  dayRoot: string;
  dayFolders?: RememberedChoice;
}

// A session's state as the main process has folded it, after this many of its events.
export interface SessionSnapshot {
  seq: number;
  state: SessionState;
}

// Hears each event of every session, numbered from 1 within its session.
export type SessionEventsListener = (id: string, seq: number, event: SessionEvent) => void;

// What the window asks of the sessions, through the preload bridge. Sessions go by the app's id.
export interface SessionsBridge {
  // The sessions started in the app, in this run and earlier ones, that are not archived, how many are
  // archived, and the others whose pages the window has shown.
  list(): Promise<SessionList>;
  // Calls the listener with the whole list whenever a session joins or leaves it or what it shows of
  // one changes, and returns a function that stops it.
  onChange(listener: (list: SessionList) => void): () => void;
  // The archived sessions, the most recently active first.
  archived(): Promise<SessionSummary[]>;
  // Resumes a session that is not running, with the settings the page shows, and sends it the message,
  // which starts its next turn; an archived session returns to the Sessions list.
  resume(id: string, request: ResumeRequest): Promise<void>;
  // Offers the session's menu at the pointer, does what the user chooses once they confirm where it
  // asks, and resolves with what was done, or null.
  showMenu(id: string): Promise<SessionAction | null>;
  // The providers the app can start sessions with, in order.
  providers(): Promise<ProviderId[]>;
  // Where a session page opens while no workspace has been added: a folder of the day's date in the
  // 3mukon-code folder of the user's home folder, made when its first session starts.
  dayFolder(): Promise<string>;
  // The gateways set up in the provider's own settings; empty for a provider without gateways.
  gateways(provider: ProviderId): Promise<string[]>;
  // The models a session through the gateway, or the provider's own configuration, could use.
  models(provider: ProviderId, gateway: string | null): Promise<ModelOption[]>;
  // The settings sessions last used, each folder's and the day folders'.
  choices(): Promise<FolderChoices>;
  // Remembers the settings a session in the folder started with or switched to, for all the day
  // folders when it is one.
  rememberChoice(folder: string, choice: RememberedChoice): Promise<void>;
  // Asks the user to confirm yolo for a session page whose session has not started; resolves with
  // whether they did.
  confirmYolo(): Promise<boolean>;
  // Starts a session with its first message, and resolves with the app's id for it.
  start(request: StartRequest): Promise<string>;
  // Sends a running session a message and its images, which start a turn, or go to the running one.
  send(id: string, text: string, images: MessageImage[]): Promise<void>;
  // Stops the running turn.
  interrupt(id: string): Promise<void>;
  // Switches the permission mode, to yolo only once the user confirms; resolves with whether it
  // switched.
  setMode(id: string, mode: PermissionMode): Promise<boolean>;
  setGateway(id: string, gateway: string | null): Promise<void>;
  setModel(id: string, model: string | null): Promise<void>;
  setEffort(id: string, effort: ReasoningEffort | null): Promise<void>;
  setSandbox(id: string, sandbox: SandboxLevel): Promise<void>;
  // The session's state so far, or null for a session the app does not have. For a session of an
  // earlier run, the first asks the main process to read its history, which follows as an event. A
  // session asked for joins the list's shown sessions while the Sessions list does not hold it.
  snapshot(id: string): Promise<SessionSnapshot | null>;
  // Calls the listener with every event of every session, and returns a function that stops it.
  onEvent(listener: SessionEventsListener): () => void;
  // Puts a message's text, or a PNG image, on the clipboard.
  copyText(text: string): Promise<void>;
  copyImage(image: MessageImage): Promise<void>;
  // Saves an image where the user chooses, and resolves with whether they chose a place.
  saveImage(image: MessageImage): Promise<boolean>;
  // Offers what can be done with an image, in a menu at the pointer, and resolves with the user's
  // choice, or null.
  imageMenu(): Promise<ImageAction | null>;
}
