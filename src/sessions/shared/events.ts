// The provider-neutral session model: the events a provider adapter reports, and the requests and
// answers that pass between a session and the user. Everything here is plain JSON-serializable data,
// so it crosses from the main process to the renderer unchanged. Text that comes from an agent or a
// provider (messages, titles, reasons, questions) is shown as data, never as UI copy. Paths are
// relative to the session's folder when they lie inside it, and absolute otherwise.

export type ProviderId = 'claude-code' | 'codex' | 'grok-build';

// The two permission modes every provider offers (ADR-0006). In auto, the provider's own automatic
// review approves or denies each action and asks the user only when it cannot decide; in yolo, nothing
// is asked and every action runs. New sessions start in auto.
export type PermissionMode = 'auto' | 'yolo';

// What a tool call does, in the vocabulary of the Agent Client Protocol.
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed';

export type MessageRole = 'user' | 'agent' | 'thinking';

// A row of the agent's own task list.
export interface Task {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// One file changed by the agent.
export interface FileChange {
  id: string;
  path: string;
  kind: 'add' | 'update' | 'delete' | 'move';
  // For a move, where the file went.
  newPath?: string;
  // The change as a unified diff.
  diff: string;
}

// The agent asks before acting.
export interface ApprovalRequest {
  id: string;
  action: 'command' | 'edit' | 'permissions' | 'plan' | 'tool';
  // The provider's own wording of what the agent wants to do, when it gives one.
  title?: string;
  // The agent's explanation.
  reason?: string;
  command?: string;
  cwd?: string;
  paths?: string[];
  // For an edit, the proposed change as a unified diff.
  diff?: string;
  // For a plan, the plan the agent wants to carry out.
  plan?: string;
  // For any other tool, its name.
  toolName?: string;
  // Whether the provider can remember the approval for the rest of the session.
  canAllowForSession: boolean;
  // The provider asks for the decline option to be preselected and for no one-key approval.
  denyByDefault: boolean;
  // Milliseconds since the epoch.
  requestedAt: number;
}

export type ApprovalAnswer =
  | { decision: 'allow-once' }
  | { decision: 'allow-for-session' }
  | { decision: 'deny'; message?: string };

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  // The key of this question's answer.
  id: string;
  // A short label, such as "Library".
  header?: string;
  text: string;
  options: QuestionOption[];
  multiSelect: boolean;
  // Whether the user may type an answer besides choosing options.
  freeText: boolean;
  // The typed answer goes into a masked field and is never stored or logged.
  secret: boolean;
}

// The agent asks the user one or more questions.
export interface QuestionRequest {
  id: string;
  questions: Question[];
  // Milliseconds since the epoch.
  requestedAt: number;
}

export type QuestionAnswer =
  | {
      decision: 'answer';
      // By question id: the labels of the chosen options and any typed text.
      answers: Record<string, { selected: string[]; text?: string }>;
    }
  | { decision: 'decline' };

// A past session in a provider's own store.
export interface HistoryEntry {
  // The provider's id for the session.
  id: string;
  title: string;
  cwd: string;
  // Milliseconds since the epoch.
  updatedAt: number;
}

export type SessionEvent =
  | { type: 'turn-started' }
  | { type: 'turn-ended'; outcome: 'completed' | 'interrupted' | 'failed'; error?: string }
  // Sets the whole text of a message.
  | { type: 'message'; id: string; role: MessageRole; text: string }
  // Adds streamed text to the end of a message.
  | { type: 'message-delta'; id: string; role: MessageRole; text: string }
  // Starts or updates a tool call; fields left out keep their value.
  | {
      type: 'tool';
      id: string;
      kind?: ToolKind;
      title?: string;
      status?: ToolStatus;
      command?: string;
      paths?: string[];
      output?: string;
    }
  // Adds streamed output to the end of a tool call's output.
  | { type: 'tool-output'; id: string; text: string }
  // Replaces the agent's task list.
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'file-change'; change: FileChange }
  | { type: 'approval-requested'; request: ApprovalRequest }
  | { type: 'question-asked'; request: QuestionRequest }
  // An approval or question was answered, or the provider withdrew it.
  | { type: 'request-resolved'; requestId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'title'; title: string }
  | { type: 'mode'; mode: PermissionMode }
  // A resumed session has replayed its past events; what follows is live.
  | { type: 'replay-finished' }
  | { type: 'error'; message: string }
  // The session ended, and its provider process with it.
  | { type: 'closed'; error?: string };
