import type { InboxNotice } from './inbox';
import type { McpCall } from './tools';

// The provider-neutral session model: the events a provider adapter reports, and the requests and
// answers that pass between a session and the user. Everything here is plain JSON-serializable data,
// so it crosses from the main process to the renderer unchanged. Text that comes from an agent or a
// provider (messages, titles, reasons, questions) is shown as data, never as UI copy. Paths are
// relative to the session's folder when they lie inside it, and absolute otherwise.

export type ProviderId = 'claude-code' | 'codex-cli' | 'grok-build' | 'antigravity';

// The two permission modes every provider offers (ADR-0006). In auto, the provider's own automatic
// review approves or denies each action and asks the user only when it cannot decide; in yolo, nothing
// is asked and every action runs. New sessions start in auto.
export type PermissionMode = 'auto' | 'yolo';

// How far a session's actions may reach, set independently of the permission mode. In read-only the
// agent can read and cannot write; in workspace-write it can write in the session's folder and in
// temporary folders; in full-access it runs without a sandbox. New sessions start in workspace-write.
export type SandboxLevel = 'read-only' | 'workspace-write' | 'full-access';

// A reasoning effort level as the provider names it; Claude Code's are low, medium, high, xhigh and max.
export type ReasoningEffort = string;

// A model a session can use.
export interface ModelOption {
  // The provider's name for the model, which chooses it.
  id: string;
  label: string;
  description?: string;
  // The reasoning effort levels the model takes, from the least to the most (orderedEfforts in
  // efforts.ts); empty when it takes none.
  efforts: ReasoningEffort[];
  // The model a session uses when it chooses none, as the provider resolves its own configuration.
  default?: boolean;
  // The effort level the model uses when the session chooses none, where the provider says.
  defaultEffort?: ReasoningEffort;
}

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

// An image in a message, or in what a tool call returned: its media type, such as image/png, and its
// bytes in base64.
export interface MessageImage {
  mediaType: string;
  data: string;
}

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
  // A denial can carry the user's message to the agent, which the provider passes on.
  denialMessage?: boolean;
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
  // The answer goes to the agent as the user's next message rather than within the turn, so the
  // question stays open after its turn ends.
  byMessage?: boolean;
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
  // The provider retries a request to the model that failed, and the turn waits for it: the retry it
  // makes, counted from 1, out of how many it makes at most, and why the request failed, in the
  // provider's own words, as far as the provider says. The agent's next output, approval or question,
  // or the turn's end, ends the wait, which no event of its own reports.
  | { type: 'retrying'; attempt?: number; maxRetries?: number; reason?: string }
  // Sets the whole text of a message, and its images.
  | { type: 'message'; id: string; role: MessageRole; text: string; images?: MessageImage[] }
  // Adds streamed text, and images, to the end of a message.
  | { type: 'message-delta'; id: string; role: MessageRole; text: string; images?: MessageImage[] }
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
      // The images the call returned, such as an image file it read.
      images?: MessageImage[];
      // For a call of an MCP tool, its server and tool in the terms every provider shares, which the
      // activity names the call by in place of the provider's title.
      mcp?: McpCall;
    }
  // Adds streamed output to the end of a tool call's output.
  | { type: 'tool-output'; id: string; text: string }
  // Replaces the agent's task list.
  | { type: 'tasks'; tasks: Task[] }
  // A file the agent changed, with the tool call that changed it, which shows the change.
  | { type: 'file-change'; change: FileChange; toolId?: string }
  | { type: 'approval-requested'; request: ApprovalRequest }
  | { type: 'question-asked'; request: QuestionRequest }
  // An approval or question was answered, or the provider withdrew it.
  | { type: 'request-resolved'; requestId: string; outcome: 'answered' | 'cancelled' }
  // The user's answer to an approval or question, as the host passed it on to the provider; a typed
  // answer to a question that asks for a secret is left out.
  | { type: 'request-answered'; requestId: string; answer: ApprovalAnswer | QuestionAnswer }
  | { type: 'title'; title: string }
  | { type: 'mode'; mode: PermissionMode }
  // The session's gateway, model, reasoning effort and sandbox; fields left out keep their value. A null
  // gateway is the provider's own configuration, a null model or effort the provider's default.
  | {
      type: 'settings';
      gateway?: string | null;
      model?: string | null;
      effort?: ReasoningEffort | null;
      sandbox?: SandboxLevel;
    }
  // The models the session can switch to.
  | { type: 'models'; models: ModelOption[] }
  // How many tokens of the model's context window the conversation takes, and the window's size when
  // the provider says.
  | { type: 'context'; used: number; size: number | null }
  // A resumed session has replayed its past events; what follows is live.
  | { type: 'replay-finished' }
  // A session that is not running, as the host read it from its provider's history: its past events,
  // or none, failed, when they could not be read. A host event, which no provider sends.
  | { type: 'history'; events: SessionEvent[]; failed?: true }
  // The host has resumed a session that was not running, which runs again. A host event, which no
  // provider sends.
  | { type: 'resumed' }
  // Messages from other sessions that the agent was told of, by their summaries (ADR-0036): a host
  // event as the notices are given, and a provider's as its history gives them back.
  | { type: 'inbox'; notices: InboxNotice[] }
  | { type: 'error'; message: string }
  // The session ended, and its provider process with it.
  | { type: 'closed'; error?: string };
