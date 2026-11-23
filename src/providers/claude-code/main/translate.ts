import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { inboxNoticesOf } from '../../../sessions/shared/inbox';
import { mcpCall, toolWords, type McpCall } from '../../../sessions/shared/tools';
import type {
  FileChange,
  MessageImage,
  MessageRole,
  PermissionMode,
  SessionEvent,
  Task,
  ToolKind,
} from '../../../sessions/shared/events';
import { diffTexts, displayPath, unifiedDiff, type Hunk } from './patch';

type AssistantBlock = Extract<SDKMessage, { type: 'assistant' }>['message']['content'][number];
type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];

// The app's permission modes as Claude Code reports them. Other Claude Code modes, such as plan mode
// entered by Claude itself, are passing states that the app does not show.
const APP_MODES: Partial<Record<string, PermissionMode>> = {
  auto: 'auto',
  bypassPermissions: 'yolo',
};
type UserContent = Extract<SDKMessage, { type: 'user' }>['message']['content'];
// The fields of a tool result block that the translation reads.
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

// The task list arrives through these tools rather than as tool calls.
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
// Calls the timeline shows in another form, or not at all: the task list, questions, plan approvals.
const HIDDEN_TOOLS = new Set([
  ...TASK_TOOLS,
  'TaskList',
  'TaskGet',
  'AskUserQuestion',
  'ExitPlanMode',
]);

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  ToolSearch: 'search',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  Monitor: 'execute',
  WebFetch: 'fetch',
  EnterPlanMode: 'switch_mode',
  EnterWorktree: 'switch_mode',
  ExitWorktree: 'switch_mode',
};

// Tool output is kept to this many characters, so that long command output stays cheap to hold.
const OUTPUT_LIMIT = 20_000;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// What a tool call is about, for the timeline: a title, and the command or paths it works on.
export function describeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): { title: string; command?: string; paths?: string[] } {
  const filePath = str(input.file_path) || str(input.notebook_path);
  if (filePath !== '') {
    const path = displayPath(filePath, cwd);
    return { title: path, paths: [path] };
  }
  switch (name) {
    case 'Bash': {
      const command = str(input.command);
      return { title: str(input.description) || (command.split('\n')[0] ?? ''), command };
    }
    case 'Glob':
    case 'Grep': {
      const path = str(input.path);
      return {
        title: str(input.pattern),
        ...(path === '' ? {} : { paths: [displayPath(path, cwd)] }),
      };
    }
    case 'WebFetch':
      return { title: str(input.url) };
    case 'WebSearch':
    case 'ToolSearch':
      return { title: str(input.query) };
    // A subagent, by the few words that say its task.
    case 'Agent':
    case 'Task':
      return { title: str(input.description) || toolWords(name) };
    case 'Monitor':
      return { title: str(input.description) || str(input.command) || toolWords(name) };
    case 'Skill':
      return { title: str(input.skill) || toolWords(name) };
    case 'ReadMcpResource':
      return { title: str(input.uri) || toolWords(name) };
    case 'ListMcpResources':
      return { title: str(input.server) || toolWords(name) };
    // Any other tool by its name in words, such as Enter plan mode for EnterPlanMode.
    default:
      return { title: toolWords(name) };
  }
}

// An MCP tool's call, which Claude Code names mcp__<server>__<tool>, in the terms every provider
// shares; undefined for any other tool.
export function mcpOf(name: string, input: Record<string, unknown>): McpCall | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : mcpCall(match[1], match[2], input);
}

// Translates what the Claude Agent SDK reports, live or from a session's transcript, into session
// events. It remembers tool calls and the agent's task list from message to message, so one
// translator follows one session from its first message on.
export class Translator {
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private tasks: (Task & { id?: string })[] = [];
  private readonly createdTasks = new Map<string, number>();
  // An error Claude Code reported in place of an answer, such as a missing sign-in. It waits for the
  // turn's result, which usually repeats it, so that it is reported once.
  private assistantError: string | undefined;
  // The model's message being streamed, and the messages whose text has already arrived streamed, so
  // that the complete message does not add that text again.
  private streamingMessage: string | undefined;
  private readonly streamedMessages = new Set<string>();

  constructor(private readonly cwd: string) {}

  live(message: SDKMessage): SessionEvent[] {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'api_retry') return [retrying(message)];
        // Each turn starts with an init message, which names the mode. It names the model too, but as
        // Claude Code resolved it, such as claude-opus-5-5 for opus, and the session's model stays the
        // one it chose, which its list knows.
        if (message.subtype !== 'init') return [];
        const mode = APP_MODES[message.permissionMode];
        return mode === undefined ? [] : [{ type: 'mode', mode }];
      }
      case 'stream_event':
        return message.parent_tool_use_id === null ? this.stream(message.event) : [];
      case 'assistant': {
        // Subagents' own work is not shown in this version.
        if (message.parent_tool_use_id !== null) return [];
        if (message.error !== undefined) {
          this.assistantError = assistantText(message.message.content) || message.error;
          return [];
        }
        const streamed = this.streamedMessages.has(message.message.id);
        return this.assistant(message.uuid, message.message.content, streamed);
      }
      case 'user':
        return message.parent_tool_use_id === null
          ? this.toolResults(message.message.content, message.tool_use_result)
          : [];
      case 'result': {
        const reported = this.assistantError;
        this.assistantError = undefined;
        this.streamingMessage = undefined;
        this.streamedMessages.clear();
        if (message.subtype !== 'success' || message.is_error) {
          const error = resultError(message) ?? reported;
          return [
            { type: 'turn-ended', outcome: 'failed', ...(error === undefined ? {} : { error }) },
          ];
        }
        return [
          ...(reported === undefined ? [] : [{ type: 'error' as const, message: reported }]),
          { type: 'turn-ended', outcome: 'completed' },
        ];
      }
      default:
        return [];
    }
  }

  // One message of a session's transcript, as getSessionMessages returns it.
  history(message: SessionMessage): SessionEvent[] {
    if (message.parent_tool_use_id !== null || message.parent_agent_id !== null) return [];
    const content = asRecord(message.message).content;
    if (message.type === 'assistant' && Array.isArray(content)) {
      return this.assistant(message.uuid, content as AssistantBlock[]);
    }
    if (message.type !== 'user') return [];
    if (typeof content === 'string') return userText(message.uuid, content);
    if (!Array.isArray(content)) return [];
    const blocks = content as Exclude<UserContent, string>;
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    return [
      ...userText(message.uuid, text, imagesOf(blocks)),
      ...inboxOf(blocks),
      ...this.toolResults(blocks, undefined),
    ];
  }

  // Text and thinking that already arrived streamed are left out of the complete message.
  private assistant(
    uuid: string,
    content: readonly AssistantBlock[],
    streamed = false,
  ): SessionEvent[] {
    return content.flatMap((block, index): SessionEvent[] => {
      const id = `${uuid}:${String(index)}`;
      switch (block.type) {
        case 'text':
          return streamed || block.text.trim() === ''
            ? []
            : [{ type: 'message', id, role: 'agent', text: block.text }];
        case 'thinking':
          return streamed || block.thinking.trim() === ''
            ? []
            : [{ type: 'message', id, role: 'thinking', text: block.thinking }];
        case 'tool_use':
          return this.toolUse(block.id, block.name, asRecord(block.input));
        default:
          return [];
      }
    });
  }

  // The model's raw stream: text and thinking arrive as deltas, under the message's id and the block's
  // index. Tool calls are taken from the complete message, which carries their whole input.
  private stream(event: StreamEvent): SessionEvent[] {
    if (event.type === 'message_start') {
      this.streamingMessage = event.message.id;
      return [];
    }
    if (event.type !== 'content_block_delta' || this.streamingMessage === undefined) return [];
    const delta = event.delta;
    let role: MessageRole;
    let text: string;
    if (delta.type === 'text_delta') [role, text] = ['agent', delta.text];
    else if (delta.type === 'thinking_delta') [role, text] = ['thinking', delta.thinking];
    else return [];
    if (text === '') return [];
    this.streamedMessages.add(this.streamingMessage);
    return [
      { type: 'message-delta', id: `${this.streamingMessage}:${String(event.index)}`, role, text },
    ];
  }

  private toolUse(id: string, name: string, input: Record<string, unknown>): SessionEvent[] {
    this.tools.set(id, { name, input });
    if (TASK_TOOLS.has(name)) return this.taskCall(id, name, input);
    if (HIDDEN_TOOLS.has(name)) return [];
    const mcp = mcpOf(name, input);
    return [
      {
        type: 'tool',
        id,
        kind: TOOL_KINDS[name] ?? 'other',
        status: 'running',
        ...(mcp === undefined ? describeTool(name, input, this.cwd) : { title: name, mcp }),
      },
    ];
  }

  // Tool results arrive in user messages; structured is the SDK's structured result, given only when a
  // message carries a single result.
  private toolResults(content: UserContent, structured: unknown): SessionEvent[] {
    if (typeof content === 'string') return [];
    const results = content.filter((block) => block.type === 'tool_result') as ToolResultBlock[];
    return results.flatMap((block): SessionEvent[] => {
      const tool = this.tools.get(block.tool_use_id);
      if (tool === undefined) return [];
      const output = results.length === 1 ? structured : undefined;
      const failed = block.is_error === true;
      if (tool.name === 'TaskCreate' && !failed)
        this.taskCreated(block.tool_use_id, output, resultText(block.content));
      if (HIDDEN_TOOLS.has(tool.name)) return [];
      const change = failed ? null : this.fileChange(block.tool_use_id, tool, output);
      const images = imagesOf(block.content);
      return [
        {
          type: 'tool',
          id: block.tool_use_id,
          status: failed ? 'failed' : 'completed',
          output: resultText(block.content).slice(0, OUTPUT_LIMIT),
          ...(images.length === 0 ? {} : { images }),
        },
        ...(change === null
          ? []
          : [{ type: 'file-change' as const, change, toolId: block.tool_use_id }]),
      ];
    });
  }

  private fileChange(
    id: string,
    tool: { name: string; input: Record<string, unknown> },
    structured: unknown,
  ): FileChange | null {
    if (tool.name !== 'Edit' && tool.name !== 'Write') return null;
    const output = asRecord(structured);
    const path = displayPath(str(output.filePath) || str(tool.input.file_path), this.cwd);
    if (path === '') return null;
    const added = tool.name === 'Write' && output.type === 'create';
    const hunks = Array.isArray(output.structuredPatch) ? (output.structuredPatch as Hunk[]) : null;
    let diff: string;
    if (hunks !== null && hunks.length > 0) diff = unifiedDiff(path, hunks, added);
    else if (added) diff = diffTexts(path, '', str(tool.input.content));
    // From a transcript: an edit's strings still give its diff; a write's earlier content is unknown.
    else if (tool.name === 'Edit')
      diff = diffTexts(path, str(tool.input.old_string), str(tool.input.new_string));
    else return null;
    return { id, path, kind: added ? 'add' : 'update', diff };
  }

  private taskCall(id: string, name: string, input: Record<string, unknown>): SessionEvent[] {
    if (name === 'TodoWrite') {
      const todos = Array.isArray(input.todos) ? input.todos.map(asRecord) : [];
      this.tasks = todos.map((todo) => ({
        text: str(todo.content),
        status: taskStatus(todo.status),
      }));
    } else if (name === 'TaskCreate') {
      this.createdTasks.set(id, this.tasks.length);
      this.tasks = [...this.tasks, { text: str(input.subject), status: 'pending' }];
    } else {
      const index = this.tasks.findIndex((task) => task.id === str(input.taskId));
      const task = this.tasks[index];
      if (task === undefined) return [];
      if (input.status === 'deleted') this.tasks = this.tasks.filter((_, i) => i !== index);
      else {
        const updated = {
          ...task,
          text: str(input.subject) || task.text,
          status: input.status === undefined ? task.status : taskStatus(input.status),
        };
        this.tasks = this.tasks.map((existing, i) => (i === index ? updated : existing));
      }
    }
    return [{ type: 'tasks', tasks: this.tasks.map(({ text, status }) => ({ text, status })) }];
  }

  // TaskUpdate names tasks by the id TaskCreate returned: from the structured result live, or from the
  // result's text in a transcript.
  private taskCreated(toolUseId: string, structured: unknown, text: string): void {
    const index = this.createdTasks.get(toolUseId);
    const task = index === undefined ? undefined : this.tasks[index];
    if (index === undefined || task === undefined) return;
    const id =
      str(asRecord(asRecord(structured).task).id) || (/^Task #(\w+) created/.exec(text)?.[1] ?? '');
    if (id !== '')
      this.tasks = this.tasks.map((existing, i) => (i === index ? { ...task, id } : existing));
  }
}

function taskStatus(value: unknown): Task['status'] {
  return value === 'in_progress' || value === 'completed' ? value : 'pending';
}

// The notices of new messages the app gave beside a message, or alone, in a document of its own
// (ADR-0036).
function inboxOf(content: unknown): SessionEvent[] {
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).flatMap((block): SessionEvent[] => {
    const source = asRecord(block.source);
    if (block.type !== 'document' || typeof source.data !== 'string') return [];
    const notices = inboxNoticesOf(source.data);
    return notices === undefined || notices.length === 0 ? [] : [{ type: 'inbox', notices }];
  });
}

function userText(id: string, text: string, images: MessageImage[] = []): SessionEvent[] {
  if (text.trim() === '' && images.length === 0) return [];
  return [{ type: 'message', id, role: 'user', text, ...(images.length === 0 ? {} : { images }) }];
}

// The images among content blocks, as Claude's API gives them in base64.
function imagesOf(content: unknown): MessageImage[] {
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).flatMap((block) => {
    const source = asRecord(block.source);
    return block.type === 'image' &&
      source.type === 'base64' &&
      typeof source.media_type === 'string' &&
      typeof source.data === 'string'
      ? [{ mediaType: source.media_type, data: source.data }]
      : [];
  });
}

function assistantText(content: readonly AssistantBlock[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(asRecord)
    .flatMap((block) => (block.type === 'text' ? [str(block.text)] : []))
    .join('\n');
}

function resultError(message: Extract<SDKMessage, { type: 'result' }>): string | undefined {
  if (message.subtype !== 'success') return message.errors.join('\n') || undefined;
  return str((message as { result?: unknown }).result) || undefined;
}

// A request to the model that Claude Code retries: which retry it makes, of how many, and why, as the
// HTTP status and the kind of error Claude Code names, such as 529 overloaded. A connection that
// failed has no status, and an error of no known kind leaves the status alone.
function retrying({
  attempt,
  max_retries: maxRetries,
  error_status: status,
  error,
}: Extract<SDKMessage, { subtype: 'api_retry' }>): SessionEvent {
  const reason = [status === null ? '' : String(status), error === 'unknown' ? '' : error]
    .filter((part) => part !== '')
    .join(' ')
    .replaceAll('_', ' ');
  return { type: 'retrying', attempt, maxRetries, ...(reason === '' ? {} : { reason }) };
}
