import type { ApprovalAnswer, MessageImage, PermissionMode, SandboxLevel } from './events';

// Serializable facts only. A handle, receipt or renderer snapshot is never execution authority.
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Sharing = 'none' | 'app' | 'global';
export type Delivery = 'background' | 'foreground';
export type BrowserKind = 'embedded' | 'chrome';
export type OperationKind =
  'browser-tab' | 'application-background' | 'application-foreground' | 'system-dialog';
export interface AutomationPolicy {
  mode: PermissionMode;
  sandbox: SandboxLevel;
}
export interface TargetRef {
  id: string;
  kind: 'browser-tab' | 'application' | 'window' | 'system-dialog';
  generation: number;
}
export interface ProfileSummary {
  id: string;
  name: string;
}
export interface TargetSummary {
  ref: TargetRef;
  owner: string;
  name: string;
  applicationName?: string;
  application?: TargetRef;
  iconId?: string;
  address?: string;
  sharing?: Sharing;
  profile?: ProfileSummary;
  browser?: BrowserKind;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Frame {
  target: TargetRef;
  observationId: string;
  documentGeneration: number | null;
  geometryGeneration: number;
  capturedAt: number;
  renderedAt?: number;
  image: MessageImage;
  imageSize: { width: number; height: number };
  viewport: Bounds;
  units: 'css-pixels' | 'window-points';
  imageToViewport: readonly [number, number, number, number, number, number];
}
// Activity snapshots carry geometry and media type only. Image bytes are read for visible calls.
export interface FrameSummary extends Omit<Frame, 'image'> {
  mediaType: MessageImage['mediaType'];
}
export type SetupRequirement =
  | { kind: 'browser'; browser: 'chrome'; step: 'connect' }
  | { kind: 'permission'; permission: 'accessibility' | 'screen-recording' | 'input-monitoring' }
  | { kind: 'restart-helper' };
export type RefusalDetail =
  | {
      kind: 'argument';
      field: 'actionId';
      reason: 'required' | 'invalid-type' | 'too-short' | 'too-long';
    }
  | { kind: 'setup'; requirement: SetupRequirement }
  | { kind: 'availability'; reason: AvailabilityReason }
  | { kind: 'denial'; message: string }
  | { kind: 'sandbox'; level: SandboxLevel }
  | {
      kind: 'presentation';
      reason:
        | 'stale-epoch'
        | 'command-conflict'
        | 'invalid-command'
        | 'wrong-owner'
        | 'presentation-unknown'
        | 'presentation-changed'
        | 'item-count-mismatch'
        | 'unsaved-changes'
        | 'busy';
      current: PresentationSummary | null;
    };
export type FailureCode =
  | 'wrong-owner'
  | 'access-revoked'
  | 'turn-inactive'
  | 'operation-ended'
  | 'stale-target'
  | 'stale-observation'
  | 'target-paused'
  | 'sandbox-denied'
  | 'file-scope-unverifiable'
  | 'approval-required'
  | 'denied'
  | 'setup-required'
  | 'background-unavailable'
  | 'image-input-unsupported'
  | 'busy'
  | 'limit-exceeded'
  | 'connection-lost'
  | 'renderer-unavailable'
  | 'layout-conflict'
  | 'request-conflict'
  | 'invalid-request'
  | 'not-found'
  | 'result-expired'
  | 'needs-user-action';
export type Outcome<T = JsonValue> =
  | { status: 'verified'; value: T }
  | { status: 'dispatched'; evidence: 'not-verified' }
  | { status: 'refused'; code: FailureCode; dispatched: false; detail?: RefusalDetail }
  | { status: 'cancelled-before-dispatch'; effects: 'none' }
  | { status: 'partial'; completed: readonly string[]; remaining: 'not-dispatched' | 'unknown' }
  | {
      status: 'indeterminate';
      reason: 'cancelled-after-dispatch' | 'timeout' | 'backend-lost' | 'presentation-race';
      exclusionHeld: boolean;
    };
export type EndReason =
  | 'agent-finished'
  | 'turn-ended'
  | 'session-closed'
  | 'stopped'
  | 'takeover'
  | 'user-ended'
  | 'denied'
  | 'policy-changed'
  | 'access-revoked'
  | 'deadline'
  | 'backend-lost'
  | 'tab-closed'
  | 'application-quit';
export interface Operation {
  id: string;
  owner: string;
  turn: string;
  accessGeneration: number;
  target: TargetRef;
  kind: OperationKind;
  policyEpoch: number;
  state: 'waiting' | 'active' | 'stopping' | 'ended';
  targetMayActivate: boolean;
  // When the operation ends, counted from when it was allowed; null while it waits for the user's
  // answer, which has no time limit.
  deadline: number | null;
}
export interface Grant {
  id: string;
  target: TargetSummary;
  summaryAt: number;
  operationKind: OperationKind;
  scope: 'operation' | 'session';
  operationId?: string;
  issuedAt: number;
}
export interface GrantEndRecord {
  grant: Grant;
  endedAt: number;
  reason: EndReason;
}
export interface HostApproval {
  id: string;
  callId: string;
  source: 'host';
  operation: Operation;
  target: TargetSummary;
  canAllowForSession: true;
  requestedAt: number;
}
export interface ApprovalRecord {
  request: HostApproval;
  answer: ApprovalAnswer | null;
  answeredAt: number | null;
  grantId: string | null;
}
export interface OperationEnd {
  at: number;
  reason: EndReason;
}
export type ActivityIncident = { at: number; operationId: string | null } & (
  | { kind: 'target-self-activated'; target: TargetRef; cause: 'popup' | 'dialog' | 'unknown' }
  | { kind: 'dialog-dismissed'; target: TargetRef; dialog: 'alert' | 'confirm' | 'prompt' }
  | { kind: 'takeover'; target: TargetRef; source: 'human' | 'unclassified-input' }
  | { kind: 'secure-input'; enabled: boolean }
);
export const AUTOMATION_ACTIVITY_LIMITS = {
  records: 256,
  endedGrants: 256,
  noticeReceipts: 4096,
  incidentsPerCall: 64,
  denialCharacters: 2048,
  controlLabelCharacters: 100,
} as const;
export const AUTOMATION_ICON_LIMITS = {
  mediaType: 'image/png',
  decodedBytes: 64 * 1024,
  edge: 128,
  perSession: 256,
} as const;
export interface Envelope<T> {
  epoch: string;
  sequence: number;
  sessionId: string;
  value: T;
}
export type AvailabilityReason =
  | { code: 'transport-unsupported'; transport: 'streamable-http' | 'stdio' }
  | { code: 'image-input-unsupported' }
  | { code: 'os-version-unsupported'; minimumVersion: string; installedVersion: string }
  | { code: 'backend-unavailable'; backend: BrowserKind | 'native' }
  | { code: 'not-probed' };
export interface Availability {
  tools: 'ready' | 'unavailable' | 'unknown';
  images: 'supported' | 'unsupported' | 'unknown';
  reason?: AvailabilityReason;
}
export const AUTOMATION_RESULT_LIMITS = {
  jsonBytes: 64 * 1024,
  imageBase64Bytes: 8 * 1024 * 1024,
  imageEdge: 4096,
} as const;
export interface ToolCapability {
  name: string;
  family: 'browser' | 'computer' | 'panel';
  availability: Availability;
  maxArgumentBytes: number;
}
export interface AutomationCapabilities {
  policy: AutomationPolicy;
  tools: readonly ToolCapability[];
  resultLimits: { jsonBytes: number; imageBase64Bytes: number; imageEdge: number };
}
export type CallTarget =
  | { state: 'resolved'; summary: TargetSummary }
  | { state: 'unresolved'; requestedKind?: TargetRef['kind']; requestedHandle?: string };
// A projection of the panels contract; it owns neither commands nor layout. Boxes are fractions of
// the panel area, and a null box means closed. Each item retains its content even while closed.
export type PresentationContent =
  | { kind: 'browser'; tabId: string }
  | { kind: 'computer'; targetId: string }
  | { kind: 'file'; path: string }
  | { kind: 'artifact'; artifactId: string };
export interface PresentationSummary {
  id: string;
  title: string;
  version: number;
  items: readonly { content: PresentationContent; box: Bounds | null }[];
}
export interface ProviderToolLink {
  callId: string;
  sessionId: string;
  turnId: string | null;
  accessGeneration: number;
  toolName: string;
  providerToolId: string;
}
export interface AutomationCallReceipt {
  schemaVersion: 1;
  callId: string;
}
export type BrowserActionSummary =
  | { kind: 'click' | 'type'; label?: string }
  | { kind: 'scroll' }
  // A script the agent ran in the page, whole, which the activity shows.
  | { kind: 'script'; script: string };
export type ComputerActionSummary =
  | { kind: 'click' | 'type' | 'scroll'; label?: string }
  | { kind: 'point-click' | 'point-scroll' | 'drag' | 'press' }
  | { kind: 'window'; change: 'raise' | 'minimize' | 'restore' | 'move' | 'resize' };
interface CallRecordBase {
  callId: string;
  sessionId: string;
  turnId: string | null;
  accessGeneration: number;
  revision: number;
  toolName: string;
  operationId: string | null;
  operationEnd: OperationEnd | null;
  grantId: string | null;
  grantEnd: GrantEndRecord | null;
  approval: ApprovalRecord | null;
  incidents: readonly ActivityIncident[];
  startedAt: number;
  completedAt: number | null;
  phase: 'received' | 'waiting' | 'dispatched' | 'settled';
  outcome: Outcome | null;
  frames: readonly FrameSummary[];
  framesState: 'available' | 'evicted';
  providerEntry: ProviderToolLink | null;
}
export type AutomationCallRecord = CallRecordBase &
  (
    | ({ target: CallTarget; sharing: Sharing | null; delivery: Delivery } & (
        | {
            family: 'browser';
            browserAction?: BrowserActionSummary;
            // That a panel showed the tab as the call was made; otherwise it worked in the background.
            inPanel?: true;
          }
        | { family: 'computer'; computerAction?: ComputerActionSummary }
      ))
    | { family: 'panel'; presentations: readonly PresentationSummary[] }
  );
// The panels module owns commands/layout; this leaf carries only the notice sent to the agent.
export interface PresentationNotice {
  noticeId: string;
  owner: string;
  reuseKey: string;
  presentation: PresentationSummary;
}
export interface ToolsetResult {
  automation: AutomationCallReceipt;
  outcome: Outcome;
  frames: readonly Frame[];
  presentationNotices: readonly PresentationNotice[];
  dialogDismissals?: readonly Extract<ActivityIncident, { kind: 'dialog-dismissed' }>['dialog'][];
}
export const previewFailureReasons = [
  'connection-lost',
  'tab-closed',
  'permission-required',
  'target-state-unsupported',
  'application-quit',
] as const;
export type PreviewFailureReason = (typeof previewFailureReasons)[number];
export type Preview =
  | { status: 'frame'; frame: Frame; freshness: 'captured' | 'kept' }
  | { status: 'unavailable'; reason: PreviewFailureReason };
export type PermissionState =
  'unknown' | 'not-granted' | 'granted' | 'restart-required' | 'unavailable';
export interface SetupSnapshot {
  appProfile: { id: string; canClear: boolean };
  chrome: {
    installedVersion: string | null;
    minimumVersion: string;
    connection: 'disconnected' | 'connecting' | 'connected' | 'waiting' | 'unavailable';
    profile: ProfileSummary | null;
    rememberedProfile?: ProfileSummary | null;
    profiles?: readonly ProfileSummary[];
    profileAccessRequired?: true;
    extensionFolder?: string;
  };
  computer: {
    helperName: string;
    accessibility: PermissionState;
    screenRecording: PermissionState;
    inputMonitoring: { required: boolean; state: PermissionState };
    restartRequired: boolean;
  };
}
export type ControlPauseReason = 'user-input' | 'secure-input';

export type ForegroundControl = {
  sessionId: string;
  application: TargetSummary;
  target: TargetRef;
  operationId: string;
  stopShortcut: boolean;
} & (
  | { state: 'acting' | 'stopping' | 'came-forward'; pauseReason?: never }
  | { state: 'paused'; pauseReason: ControlPauseReason }
);

export interface AutomationLiveState {
  sessionId: string;
  policy: AutomationPolicy;
  policyEpoch: number;
  phase: 'idle' | 'observing' | 'acting' | 'waiting-grant' | 'paused' | 'stopping';
  resources: readonly TargetSummary[];
  operations: readonly Operation[];
  grants: readonly Grant[];
  pendingApprovals: readonly HostApproval[];
  foregroundOwner: string | null;
  foregroundControl?: ForegroundControl;
  pausedTargets?: readonly { target: TargetRef; reason: ControlPauseReason }[];
  availability: Availability;
}
export interface AutomationSnapshot extends AutomationLiveState {
  endedGrants: readonly GrantEndRecord[];
  recentCalls: readonly AutomationCallRecord[];
  presentationNotices: readonly PresentationNotice[];
}
// State replaces only live facts; tool-call upserts by call ID/revision; tool-call-removed removes
// one retained call; grant-ended upserts by grant ID and grant-end-removed evicts it;
// presentation-notices replaces the pending set. Other events are notifications:
// their retained effects arrive through state/tool-call, never by applying those effects twice.
// Subscribe before snapshot; ignore older envelopes and resnapshot on epoch/sequence gaps.
export type AutomationEvent =
  | { kind: 'state'; state: AutomationLiveState }
  | { kind: 'tool-call'; call: AutomationCallRecord }
  | { kind: 'tool-call-removed'; callId: string }
  | { kind: 'presentation-notices'; notices: readonly PresentationNotice[] }
  | { kind: 'operation-ended'; id: string; at: number; reason: EndReason }
  | { kind: 'grant-ended'; record: GrantEndRecord }
  | { kind: 'grant-end-removed'; grantId: string }
  | { kind: 'approval-answered'; id: string; at: number; answer: ApprovalAnswer }
  | ActivityIncident
  | { kind: 'availability'; value: Availability };
