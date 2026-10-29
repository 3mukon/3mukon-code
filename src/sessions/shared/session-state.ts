import type {
  ApprovalRequest,
  FileChange,
  MessageRole,
  ModelOption,
  PermissionMode,
  QuestionRequest,
  ReasoningEffort,
  SandboxLevel,
  SessionEvent,
  Task,
  ToolKind,
  ToolStatus,
} from './events';

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'closed';

interface ToolItem {
  type: 'tool';
  id: string;
  kind: ToolKind;
  title: string;
  status: ToolStatus;
  command?: string;
  paths?: string[];
  output: string;
}

export type TimelineItem =
  | { type: 'message'; id: string; role: MessageRole; text: string }
  | ToolItem
  | { type: 'file-change'; change: FileChange }
  | { type: 'approval'; request: ApprovalRequest; resolution?: 'answered' | 'cancelled' }
  | { type: 'question'; request: QuestionRequest; resolution?: 'answered' | 'cancelled' }
  // Without a message, the UI says in its own words that the turn failed.
  | { type: 'error'; message?: string };

// What the UI shows of one session, folded from its events by applyEvent.
export interface SessionState {
  // In the order things first happened.
  timeline: TimelineItem[];
  // The agent's current task list.
  tasks: Task[];
  turnRunning: boolean;
  closed: boolean;
  // A resumed session has not finished replaying its past events.
  loadingHistory: boolean;
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
}

export function initialSessionState(loadingHistory = false): SessionState {
  return { timeline: [], tasks: [], turnRunning: false, closed: false, loadingHistory };
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
  switch (event.type) {
    case 'turn-started':
      return { ...state, turnRunning: true };
    case 'turn-ended': {
      const ended = { ...cancelOpenRequests(state), turnRunning: false };
      return event.outcome === 'failed' ? append(ended, errorItem(event.error)) : ended;
    }
    case 'message': {
      const index = find(state, 'message', event.id);
      return put(state, index, {
        type: 'message',
        id: event.id,
        role: event.role,
        text: event.text,
      });
    }
    case 'message-delta': {
      const index = find(state, 'message', event.id);
      const previous = state.timeline[index];
      const text = (previous?.type === 'message' ? previous.text : '') + event.text;
      return put(state, index, { type: 'message', id: event.id, role: event.role, text });
    }
    case 'tool': {
      const index = find(state, 'tool', event.id);
      const base = toolAt(state, index, event.id);
      const command = event.command ?? base.command;
      const paths = event.paths ?? base.paths;
      return put(state, index, {
        type: 'tool',
        id: event.id,
        kind: event.kind ?? base.kind,
        title: event.title ?? base.title,
        status: event.status ?? base.status,
        output: event.output ?? base.output,
        ...(command === undefined ? {} : { command }),
        ...(paths === undefined ? {} : { paths }),
      });
    }
    case 'tool-output': {
      const index = find(state, 'tool', event.id);
      const base = toolAt(state, index, event.id);
      return put(state, index, { ...base, output: base.output + event.text });
    }
    case 'tasks':
      return { ...state, tasks: event.tasks };
    case 'file-change':
      return put(state, find(state, 'file-change', event.change.id), {
        type: 'file-change',
        change: event.change,
      });
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
    case 'error':
      return append(state, errorItem(event.message));
    case 'closed': {
      const closed = { ...cancelOpenRequests(state), turnRunning: false, closed: true };
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
      return item.id;
    case 'file-change':
      return item.change.id;
    case 'approval':
    case 'question':
      return item.request.id;
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
    : { type: 'tool', id, kind: 'other', title: '', status: 'pending', output: '' };
}

function errorItem(message: string | undefined): TimelineItem {
  return message === undefined || message === '' ? { type: 'error' } : { type: 'error', message };
}

// Requests that can no longer be answered once their turn or session is over.
function cancelOpenRequests(state: SessionState): SessionState {
  if (openRequests(state).length === 0) return state;
  return {
    ...state,
    timeline: state.timeline.map((item) =>
      (item.type === 'approval' || item.type === 'question') && item.resolution === undefined
        ? { ...item, resolution: 'cancelled' }
        : item,
    ),
  };
}
