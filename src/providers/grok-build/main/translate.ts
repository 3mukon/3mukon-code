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
import { displayPath, fileChange } from './patch';

// Tool output is kept to this many characters, so that long command output stays cheap to hold.
const OUTPUT_LIMIT = 20_000;

// Grok Build's session mode behind each of the app's two permission modes (ADR-0006): its auto mode, in
// which a classifier reviews each action and asks when it will not allow it, and its always-approve mode.
export const modeIds: Record<PermissionMode, string> = { auto: 'auto', yolo: 'bypassPermissions' };

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
        return this.chunk('user', update.content);
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
