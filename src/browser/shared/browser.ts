import type {
  BrowserKind,
  Outcome,
  ProfileSummary,
  Sharing,
  TargetRef,
} from '../../sessions/shared/automation';

export type BrowserTabRef = TargetRef & { kind: 'browser-tab' };
export type BrowserLoadError = 'unreachable' | 'timed-out' | 'certificate' | 'blocked';
export interface BrowserTabState {
  ref: BrowserTabRef;
  owner: string;
  browser: BrowserKind;
  sharing: Sharing;
  profile: ProfileSummary | null;
  title: string;
  address: string | null;
  documentGeneration: number;
  geometryGeneration: number;
  loading: boolean;
  error: BrowserLoadError | null;
  signIn: 'unknown' | 'needed';
  canGoBack: boolean;
  canGoForward: boolean;
  control: 'agent' | 'user';
}

export type BrowserNavigation =
  { kind: 'navigate'; url: string } | { kind: 'back' | 'forward' | 'reload' | 'stop-loading' };

export type BrowserTabCommand =
  | BrowserNavigation
  | { kind: 'take-control' }
  | { kind: 'hand-back' }
  | { kind: 'open-external' }
  // The user's own Close, which ends the tab whoever has it.
  | { kind: 'close' };

export interface BrowserTabs {
  snapshot(owner: string, tab: BrowserTabRef): Promise<BrowserTabState | null>;
  // The first callback is the current state. Null means the tab has ended or is out of scope.
  subscribe(
    owner: string,
    tab: BrowserTabRef,
    listener: (state: BrowserTabState | null) => void,
  ): () => void;
  // User controls only. MCP tools use the broker's separate operation path.
  command(owner: string, tab: BrowserTabRef, command: BrowserTabCommand): Promise<Outcome<null>>;
}
