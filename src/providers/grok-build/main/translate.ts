import { randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  Diff,
  SessionConfigOption,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type {
  MessageImage,
  MessageRole,
  PermissionMode,
  ReasoningEffort,
  SessionEvent,
  ToolStatus,
} from '../../../sessions/shared/events';
import { INBOX_CONTEXT_URI, inboxNoticesOf } from '../../../sessions/shared/inbox';
import { mcpCall, TOOLSET_NAME, type McpCall } from '../../../sessions/shared/tools';
import { displayPath, fileChange } from './patch';

// Tool output is kept to this many characters, so that long command output stays cheap to hold.
const OUTPUT_LIMIT = 20_000;

// The ids under which Grok Build names its modes behind the app's two permission modes (ADR-0006), as a
// mode update may report them: its auto mode, in which a classifier reviews each action and asks when it
// will not allow it, and its always-approve mode. The adapter sets a mode through the session's flags.
const modeIds: Record<PermissionMode, string> = { auto: 'auto', yolo: 'bypassPermissions' };

// The session's model and reasoning effort as Grok's configuration options hold them.
export function currentChoices(options: readonly SessionConfigOption[]): {
  model?: string;
  effort?: ReasoningEffort;
} {
  const current = (id: string) => {
    const option = options.find((entry) => entry.id === id);
    return option?.type === 'select' ? option.currentValue : undefined;
  };
  const model = current('model');
  const effort = current('reasoning_effort');
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

// Translates the session updates Grok Build sends, live or while it replays a session it loads, into
// session events. ACP streams messages in chunks without ids, so a message lasts until something else
// comes between its chunks. A tool call's file changes are reported once it completes, from the diffs
// it showed.
export class Translator {
  private message: { id: string; role: MessageRole } | null = null;
  private readonly calls = new Map<string, ToolCallInfo>();

  constructor(private readonly cwd: string) {}

  // Ends the message being streamed, as when a turn starts or ends: what follows starts a new one.
  endMessage(): void {
    this.message = null;
  }

  // What a tool call that has not ended has shown so far, for an approval of it that shows less.
  callOf(toolCallId: string): ToolCallInfo | undefined {
    return this.calls.get(toolCallId);
  }

  update(update: SessionUpdate): SessionEvent[] {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return update.content.type === 'resource'
          ? inboxOf(update.content)
          : this.chunk('user', update.content);
      case 'agent_message_chunk':
        return this.chunk('agent', update.content);
      case 'agent_thought_chunk':
        return this.chunk('thinking', update.content);
      case 'tool_call':
        return this.tool(update, true);
      case 'tool_call_update':
        return this.tool(update, false);
      case 'plan':
        return [
          {
            type: 'tasks',
            tasks: update.entries.map((entry) => ({ text: entry.content, status: entry.status })),
          },
        ];
      case 'session_info_update':
        return update.title == null || update.title === ''
          ? []
          : [{ type: 'title', title: update.title }];
      // How many tokens of its context window the session takes, as ACP reports it.
      case 'usage_update':
        return [{ type: 'context', used: update.used, size: update.size }];
      case 'current_mode_update': {
        const mode = modeOf(update.currentModeId);
        return mode === undefined ? [] : [{ type: 'mode', mode }];
      }
      case 'config_option_update': {
        const choices = currentChoices(update.configOptions);
        return Object.keys(choices).length === 0 ? [] : [{ type: 'settings', ...choices }];
      }
      default:
        return [];
    }
  }

  // A chunk of text, or an image, in the message being streamed.
  private chunk(role: MessageRole, content: ContentBlock): SessionEvent[] {
    const text = content.type === 'text' ? content.text : '';
    const images =
      content.type === 'image' && content.data !== ''
        ? [{ mediaType: content.mimeType, data: content.data }]
        : [];
    if (text === '' && images.length === 0) return [];
    if (this.message?.role !== role) this.message = { id: randomUUID(), role };
    return [
      {
        type: 'message-delta',
        id: this.message.id,
        role,
        text,
        ...(images.length === 0 ? {} : { images }),
      },
    ];
  }

  // A tool call as it starts, and each update after. Grok sends a starting call without a status while
  // it runs, and a replayed one complete.
  private tool(update: ToolCall | ToolCallUpdate, started: boolean): SessionEvent[] {
    this.message = null;
    const id = update.toolCallId;
    const known = this.calls.get(id);
    const content = update.content ?? [];
    const diffs = content.filter(isDiff);
    const paths = pathsOf(update, this.cwd);
    const kind = update.kind ?? known?.kind;
    const call: ToolCallInfo = {
      ...(kind === undefined ? {} : { kind }),
      paths: [...new Set([...(known?.paths ?? []), ...paths])],
      diffs: diffs.length > 0 ? diffs : (known?.diffs ?? []),
    };
    this.calls.set(id, call);
    const status = toolStatus(update.status) ?? (started ? 'running' : undefined);
    const mcp = update.title == null ? undefined : mcpOfTitle(update.title, update.rawInput);
    const command = commandOf(update.rawInput);
    const output = outputOf(content);
    const images = imagesOf(content);
    const events: SessionEvent[] = [
      {
        type: 'tool',
        id,
        ...(update.kind == null ? {} : { kind: update.kind }),
        ...(update.title == null || update.title === '' ? {} : { title: update.title }),
        ...(status === undefined ? {} : { status }),
        ...(command === undefined ? {} : { command }),
        ...(paths.length === 0 ? {} : { paths: call.paths }),
        ...(output === undefined ? {} : { output }),
        ...(images.length === 0 ? {} : { images }),
        ...(mcp === undefined ? {} : { mcp }),
      },
    ];
    if (status === 'completed') {
      events.push(
        ...call.diffs.map((diff, index): SessionEvent => ({
          type: 'file-change',
          change: fileChange(`${id}:${String(index)}`, diff, kind === 'delete', this.cwd),
          toolId: id,
        })),
      );
    }
    if (status === 'completed' || status === 'failed') this.calls.delete(id);
    return events;
  }
}

// What the session knows of a tool call that has not ended: its kind, the files it names and the diffs
// it shows.
export interface ToolCallInfo {
  kind?: ToolKind;
  paths: string[];
  diffs: Diff[];
}

export function isDiff(content: ToolCallContent): content is Diff & { type: 'diff' } {
  return content.type === 'diff';
}

// The files a tool call names, as the user reads them: its locations, its diffs' files, and the file its
// input names, as Grok's file tools do.
export function pathsOf(call: ToolCall | ToolCallUpdate, cwd: string): string[] {
  const input = call.rawInput;
  const named =
    typeof input === 'object' && input !== null
      ? (input as { file_path?: unknown }).file_path
      : undefined;
  const paths = [
    ...(call.locations ?? []).map((location) => location.path),
    ...(call.content ?? []).filter(isDiff).map((diff) => diff.path),
    ...(typeof named === 'string' && named !== '' ? [named] : []),
  ];
  return [...new Set(paths.map((path) => displayPath(path, cwd)))];
}

// The command of a shell tool call, from the input Grok shows for it.
export function commandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { command } = input as { command?: unknown };
  return typeof command === 'string' && command !== '' ? command : undefined;
}

function toolStatus(status: ToolCallStatus | null | undefined): ToolStatus | undefined {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

// What a tool call printed, from the text it shows.
function outputOf(content: readonly ToolCallContent[]): string | undefined {
  const texts = content.flatMap((item) =>
    item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [],
  );
  return texts.length === 0 ? undefined : texts.join('\n').slice(0, OUTPUT_LIMIT);
}

// The images a tool call shows.
function imagesOf(content: readonly ToolCallContent[]): MessageImage[] {
  return content.flatMap((item) =>
    item.type === 'content' && item.content.type === 'image'
      ? [{ mediaType: item.content.mimeType, data: item.content.data }]
      : [],
  );
}

function modeOf(modeId: string): PermissionMode | undefined {
  return (Object.keys(modeIds) as PermissionMode[]).find((mode) => modeIds[mode] === modeId);
}

// The notices of new messages the app gave beside a message, or alone, in a resource of its own
// (ADR-0036); nothing for any other resource.
function inboxOf(content: Extract<ContentBlock, { type: 'resource' }>): SessionEvent[] {
  const { resource } = content;
  if (resource.uri !== INBOX_CONTEXT_URI || !('text' in resource)) return [];
  const notices = inboxNoticesOf(resource.text);
  return notices === undefined || notices.length === 0 ? [] : [{ type: 'inbox', notices }];
}

// The toolset's server as Grok knows it. Grok registers an MCP server's tools only if its name
// starts with a letter or an underscore, and otherwise skips them all, while the toolset's name
// starts with its 3; Grok gets the 3 as san, the Japanese word for three. The session's server, the
// allow rules and the titles that route approvals and results all use this name.
export function grokServerName(name: string): string {
  return name.replace(/^3/, 'san');
}

// A tool call's title as an MCP call where Grok titles one <server>__<tool>, the app's own toolset by
// the name Grok knows it by; undefined for a title in words, as Grok titles its own tools.
function mcpOfTitle(title: string, input: unknown): McpCall | undefined {
  const match = /^([A-Za-z_][\w-]*)__([\w.-]+)$/.exec(title);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const server = match[1] === grokServerName(TOOLSET_NAME) ? TOOLSET_NAME : match[1];
  return mcpCall(server, match[2], toolArguments(input));
}

// A call's own arguments: those Grok's use_tool passes on as its tool_input, or else its input.
export function toolArguments(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const { tool_name: name, tool_input: args } = input as Record<string, unknown>;
  return typeof name === 'string' && typeof args === 'object' && args !== null ? args : input;
}
