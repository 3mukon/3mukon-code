import type {
  ApprovalAnswer,
  ApprovalRequest,
  FileChange,
  MessageImage,
  MessageRole,
  ModelOption,
  PermissionMode,
  QuestionAnswer,
  QuestionRequest,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
  Task,
  ToolKind,
  ToolStatus,
} from './events';
import type { InboxNotice } from './inbox';
import type { McpCall } from './tools';

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'closed';

export interface ToolItem {
  type: 'tool';
  id: string;
  kind: ToolKind;
  title: string;
  status: ToolStatus;
  command?: string;
  paths?: string[];
  output: string;
  // The files the call changed, in the order it reported them.
  changes: FileChange[];
  images?: MessageImage[];
  // For a call of an MCP tool, its server and tool, by which the activity names it.
  mcp?: McpCall;
}

export type TimelineItem =
  | { type: 'message'; id: string; role: MessageRole; text: string; images?: MessageImage[] }
  | ToolItem
  // A change no tool call in the timeline made.
  | { type: 'file-change'; change: FileChange }
  | {
      type: 'approval';
      request: ApprovalRequest;
      resolution?: 'answered' | 'cancelled';
      // The user's answer, once the app has passed one on.
      answer?: ApprovalAnswer;
    }
  | {
      type: 'question';
      request: QuestionRequest;
      resolution?: 'answered' | 'cancelled';
      answer?: QuestionAnswer;
    }
  // Messages from other sessions the agent was told of, by their summaries (ADR-0036).
  | { type: 'inbox'; notices: InboxNotice[] }
  // A compaction of the conversation by the provider.
  | { type: 'compaction'; id: string; trigger?: 'auto' | 'manual' }
  // Without a message, the UI says in its own words that the turn failed.
  | { type: 'error'; message?: string };

// An approval or a question in the timeline.
export type RequestItem = Extract<TimelineItem, { type: 'approval' | 'question' }>;

// A request to the model that failed, which the provider retries while the turn waits: the retry it
// makes, counted from 1, out of how many it makes at most where it says, and why the request failed,
// in the provider's own words where it gives them.
export interface Retrying {
  attempt: number;
  maxRetries?: number;
  reason?: string;
}

// What the UI shows of one session, folded from its events by applyEvent.
export interface SessionState {
  // In the order things first happened.
  timeline: TimelineItem[];
  // The agent's current task list.
  tasks: Task[];
  turnRunning: boolean;
  closed: boolean;
  // A resumed session has not finished replaying its past events, or the history of a session that is
  // not running has not been read yet.
  loadingHistory: boolean;
  // The history of a session that is not running could not be read from its provider.
  historyFailed: boolean;
  title?: string;
  mode?: PermissionMode;
  // A null gateway is the provider's own configuration, a null model or effort the provider's default.
  gateway?: string | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
  sandbox?: SandboxLevel;
  // The models the session can switch to, once the provider has listed them.
  models?: ModelOption[];
  // How much of the model's context window the conversation takes, once the provider has said.
  context?: { used: number; size: number | null };
  // The provider retries a request to the model that failed, until the agent goes on, with output, an
  // approval or a question, or the turn or the session ends.
  retrying?: Retrying;
}

export function initialSessionState(loadingHistory = false): SessionState {
  return {
    timeline: [],
    tasks: [],
    turnRunning: false,
    closed: false,
    loadingHistory,
    historyFailed: false,
  };
}

// The approvals and questions still waiting for the user, oldest first.
export function openRequests(state: SessionState): (ApprovalRequest | QuestionRequest)[] {
  return state.timeline
    .flatMap((item) =>
      (item.type === 'approval' || item.type === 'question') && item.resolution === undefined
        ? [item.request]
        : [],
    )
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

export function sessionStatus(state: SessionState): SessionStatus {
  if (state.closed) return 'closed';
  if (openRequests(state).length > 0) return 'waiting';
  return state.turnRunning ? 'running' : 'idle';
}

// Folds one event into the state. The state passed in is never changed.
export function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const next = fold(state, event);
  return endsRetrying(event) ? withoutRetrying(next) : next;
}

function fold(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'turn-started':
      return { ...state, turnRunning: true };
    case 'retrying': {
      // A provider that does not count its retries has them counted here, from the first it reports.
      const attempt = event.attempt ?? (state.retrying?.attempt ?? 0) + 1;
      const { maxRetries, reason } = event;
      return {
        ...state,
        retrying: {
          attempt,
          ...(maxRetries === undefined ? {} : { maxRetries }),
          ...(reason === undefined || reason === '' ? {} : { reason }),
        },
      };
    }
    case 'turn-ended': {
      const ended = { ...cancelOpenRequests(state, 'turn'), turnRunning: false };
      return event.outcome === 'failed' ? append(ended, errorItem(event.error)) : ended;
    }
    case 'message': {
      const index = find(state, 'message', event.id);
      return put(state, index, {
        type: 'message',
        id: event.id,
        role: event.role,
        text: event.text,
        ...withImages(event.images),
      });
    }
    case 'message-delta': {
      const index = find(state, 'message', event.id);
      const previous = state.timeline[index];
      const before = previous?.type === 'message' ? previous : undefined;
      return put(state, index, {
        type: 'message',
        id: event.id,
        role: event.role,
        text: (before?.text ?? '') + event.text,
        ...withImages([...(before?.images ?? []), ...(event.images ?? [])]),
      });
    }
    case 'tool': {
      const index = find(state, 'tool', event.id);
      const base = toolAt(state, index, event.id);
      const command = event.command ?? base.command;
      const paths = event.paths ?? base.paths;
      const images = event.images ?? base.images;
      const mcp = event.mcp ?? base.mcp;
      return put(state, index, {
        type: 'tool',
        id: event.id,
        kind: event.kind ?? base.kind,
        title: event.title ?? base.title,
        status: event.status ?? base.status,
        output: event.output ?? base.output,
        changes: base.changes,
        ...(command === undefined ? {} : { command }),
        ...(paths === undefined ? {} : { paths }),
        ...withImages(images),
        ...(mcp === undefined ? {} : { mcp }),
      });
    }
    case 'tool-output': {
      const index = find(state, 'tool', event.id);
      const base = toolAt(state, index, event.id);
      return put(state, index, { ...base, output: base.output + event.text });
    }
    case 'tasks':
      return { ...state, tasks: event.tasks };
    case 'file-change': {
      // A change goes with the tool call that made it, so that the timeline shows the call once.
      const index = event.toolId === undefined ? -1 : find(state, 'tool', event.toolId);
      const call = state.timeline[index];
      if (call?.type !== 'tool') {
        return put(state, find(state, 'file-change', event.change.id), {
          type: 'file-change',
          change: event.change,
        });
      }
      const known = call.changes.findIndex((change) => change.id === event.change.id);
      const changes =
        known < 0
          ? [...call.changes, event.change]
          : call.changes.map((change, at) => (at === known ? event.change : change));
      return put(state, index, { ...call, changes });
    }
    case 'approval-requested':
      return put(state, find(state, 'approval', event.request.id), {
        type: 'approval',
        request: event.request,
      });
    case 'question-asked':
      return put(state, find(state, 'question', event.request.id), {
        type: 'question',
        request: event.request,
      });
    case 'request-answered': {
      const index = state.timeline.findIndex(
        (item) =>
          (item.type === 'approval' || item.type === 'question') &&
          item.request.id === event.requestId,
      );
      const item = state.timeline[index];
      const { answer } = event;
      if (item?.type === 'approval' && isApprovalAnswer(answer)) {
        return put(state, index, { ...item, answer });
      }
      if (item?.type === 'question' && !isApprovalAnswer(answer)) {
        return put(state, index, { ...item, answer });
      }
      return state;
    }
    case 'request-resolved': {
      const index = state.timeline.findIndex(
        (item) =>
          (item.type === 'approval' || item.type === 'question') &&
          item.request.id === event.requestId,
      );
      const item = state.timeline[index];
      if (item?.type !== 'approval' && item?.type !== 'question') return state;
      return put(state, index, { ...item, resolution: event.outcome });
    }
    case 'title':
      return { ...state, title: event.title };
    case 'mode':
      return { ...state, mode: event.mode };
    case 'settings':
      return {
        ...state,
        ...(event.gateway === undefined ? {} : { gateway: event.gateway }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.effort === undefined ? {} : { effort: event.effort }),
        ...(event.sandbox === undefined ? {} : { sandbox: event.sandbox }),
      };
    case 'models':
      return { ...state, models: event.models };
    case 'context':
      return { ...state, context: { used: event.used, size: event.size } };
    case 'replay-finished':
      return { ...state, loadingHistory: false };
    case 'history': {
      // The session as its history leaves it, not running: no turn runs and no request waits.
      const past = event.events.reduce(applyEvent, state);
      return {
        ...cancelOpenRequests(past, 'session'),
        turnRunning: false,
        loadingHistory: false,
        historyFailed: event.failed === true,
      };
    }
    case 'resumed':
      return { ...state, closed: false, historyFailed: false };
    case 'inbox':
      return event.notices.length === 0
        ? state
        : append(state, { type: 'inbox', notices: event.notices });
    // Once for each compaction, however often the provider reports it.
    case 'compaction':
      return find(state, 'compaction', event.id) >= 0
        ? state
        : append(state, {
            type: 'compaction',
            id: event.id,
            ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
          });
    case 'error':
      return append(state, errorItem(event.message));
    case 'closed': {
      const closed = { ...cancelOpenRequests(state, 'session'), turnRunning: false, closed: true };
      return event.error === undefined ? closed : append(closed, errorItem(event.error));
    }
  }
}

// The index of the item of this type and id, or -1.
function find(state: SessionState, type: TimelineItem['type'], id: string): number {
  return state.timeline.findIndex((item) => item.type === type && itemId(item) === id);
}

function itemId(item: TimelineItem): string | undefined {
  switch (item.type) {
    case 'message':
    case 'tool':
    case 'compaction':
      return item.id;
    case 'file-change':
      return item.change.id;
    case 'approval':
    case 'question':
      return item.request.id;
    case 'inbox':
    case 'error':
      return undefined;
  }
}

// Replaces the item at index, or appends it when index is -1.
function put(state: SessionState, index: number, item: TimelineItem): SessionState {
  if (index < 0) return append(state, item);
  const timeline = [...state.timeline];
  timeline[index] = item;
  return { ...state, timeline };
}

function append(state: SessionState, item: TimelineItem): SessionState {
  return { ...state, timeline: [...state.timeline, item] };
}

function toolAt(state: SessionState, index: number, id: string): ToolItem {
  const item = state.timeline[index];
  return item?.type === 'tool'
    ? item
    : { type: 'tool', id, kind: 'other', title: '', status: 'pending', output: '', changes: [] };
}

// A message's or a tool call's images, left out while there are none.
function withImages(images: MessageImage[] | undefined): { images?: MessageImage[] } {
  return images === undefined || images.length === 0 ? {} : { images };
}

function errorItem(message: string | undefined): TimelineItem {
  return message === undefined || message === '' ? { type: 'error' } : { type: 'error', message };
}

// Requests that can no longer be answered once their turn or session is over; a question answered by
// message outlasts its turn.
function cancelOpenRequests(state: SessionState, over: 'turn' | 'session'): SessionState {
  const cancelled = (item: TimelineItem): item is RequestItem =>
    (item.type === 'approval' || item.type === 'question') &&
    item.resolution === undefined &&
    (over === 'session' || item.type === 'approval' || item.request.byMessage !== true);
  if (!state.timeline.some(cancelled)) return state;
  return {
    ...state,
    timeline: state.timeline.map((item) =>
      cancelled(item) ? { ...item, resolution: 'cancelled' } : item,
    ),
  };
}

// Whether an event ends the wait for a retried request: the agent's output, its approvals and
// questions, and the end of the turn or of the session say that the provider no longer retries, while
// the user's own message, sent during the turn, says nothing of it.
function endsRetrying(event: SessionEvent): boolean {
  switch (event.type) {
    case 'message':
    case 'message-delta':
      return event.role !== 'user';
    case 'tool':
    case 'tool-output':
    case 'tasks':
    case 'file-change':
    case 'approval-requested':
    case 'question-asked':
    case 'turn-started':
    case 'turn-ended':
    case 'history':
    case 'closed':
      return true;
    default:
      return false;
  }
}

function withoutRetrying(state: SessionState): SessionState {
  const { retrying, ...rest } = state;
  return retrying === undefined ? state : rest;
}

function isApprovalAnswer(answer: ApprovalAnswer | QuestionAnswer): answer is ApprovalAnswer {
  return answer.decision !== 'answer' && answer.decision !== 'decline';
}
