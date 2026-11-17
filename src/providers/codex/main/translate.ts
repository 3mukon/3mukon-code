import type {
  MessageImage,
  SessionEvent,
  Task,
  ToolKind,
  ToolStatus,
} from '../../../sessions/shared/events';
import { imageTypeOf } from '../../../sessions/shared/images';
import { displayPath, fileChange } from './patch';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { AgentMessageDeltaNotification } from './protocol/v2/AgentMessageDeltaNotification';
import type { CommandAction } from './protocol/v2/CommandAction';
import type { CommandExecutionOutputDeltaNotification } from './protocol/v2/CommandExecutionOutputDeltaNotification';
import type { ErrorNotification } from './protocol/v2/ErrorNotification';
import type { FileChangePatchUpdatedNotification } from './protocol/v2/FileChangePatchUpdatedNotification';
import type { FileUpdateChange } from './protocol/v2/FileUpdateChange';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification';
import type { ItemGuardianApprovalReviewCompletedNotification } from './protocol/v2/ItemGuardianApprovalReviewCompletedNotification';
import type { ItemStartedNotification } from './protocol/v2/ItemStartedNotification';
import type { McpToolCallError } from './protocol/v2/McpToolCallError';
import type { McpToolCallResult } from './protocol/v2/McpToolCallResult';
import type { ModelReroutedNotification } from './protocol/v2/ModelReroutedNotification';
import type { ReasoningSummaryTextDeltaNotification } from './protocol/v2/ReasoningSummaryTextDeltaNotification';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { ThreadNameUpdatedNotification } from './protocol/v2/ThreadNameUpdatedNotification';
import type { ThreadTokenUsageUpdatedNotification } from './protocol/v2/ThreadTokenUsageUpdatedNotification';
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification';
import type { TurnError } from './protocol/v2/TurnError';
import type { TurnPlanUpdatedNotification } from './protocol/v2/TurnPlanUpdatedNotification';

// Tool output is kept to this many characters, so that long command output stays cheap to hold.
const OUTPUT_LIMIT = 20_000;

// Translates what codex app-server reports, live or from a thread's history, into session events. It
// remembers file changes, which approvals refer to, and how much output each command has streamed.
export class Translator {
  private readonly fileChanges = new Map<string, FileUpdateChange[]>();
  private readonly streamedOutput = new Map<string, number>();
  // The summary part of each reasoning item last streamed, so that a new part starts a paragraph.
  private readonly summaryParts = new Map<string, number>();
  // An error Codex reported during the turn without retrying, for the turn's end.
  private turnError: string | undefined;

  constructor(private readonly cwd: string) {}

  // One notification of the live session.
  live(method: string, params: unknown): SessionEvent[] {
    switch (method) {
      case 'item/started':
        return this.item((params as ItemStartedNotification).item, false);
      case 'item/completed':
        return this.item((params as ItemCompletedNotification).item, true);
      case 'item/agentMessage/delta': {
        const { itemId, delta } = params as AgentMessageDeltaNotification;
        return delta === ''
          ? []
          : [{ type: 'message-delta', id: itemId, role: 'agent', text: delta }];
      }
      case 'item/reasoning/summaryTextDelta': {
        const { itemId, delta, summaryIndex } = params as ReasoningSummaryTextDeltaNotification;
        if (delta === '') return [];
        const part = this.summaryParts.get(itemId);
        this.summaryParts.set(itemId, summaryIndex);
        const text = part !== undefined && summaryIndex > part ? `\n\n${delta}` : delta;
        return [{ type: 'message-delta', id: itemId, role: 'thinking', text }];
      }
      case 'item/commandExecution/outputDelta':
        return this.output(params as CommandExecutionOutputDeltaNotification);
      case 'item/fileChange/patchUpdated': {
        const { itemId, changes } = params as FileChangePatchUpdatedNotification;
        this.fileChanges.set(itemId, changes);
        const paths = changes.map((change) => displayPath(change.path, this.cwd));
        return [{ type: 'tool', id: itemId, title: paths.join(', '), paths }];
      }
      case 'turn/plan/updated':
        return [
          {
            type: 'tasks',
            tasks: (params as TurnPlanUpdatedNotification).plan.map(({ step, status }) => ({
              text: step,
              status: taskStatus(status),
            })),
          },
        ];
      case 'turn/completed':
        return this.turnCompleted(params as TurnCompletedNotification);
      case 'error': {
        const { error, willRetry } = params as ErrorNotification;
        if (willRetry) return [retrying(error)];
        this.turnError = error.message;
        return [];
      }
      case 'thread/name/updated': {
        const { threadName } = params as ThreadNameUpdatedNotification;
        return threadName === undefined || threadName === ''
          ? []
          : [{ type: 'title', title: threadName }];
      }
      // The context the thread takes is its last request's tokens, of the model's window.
      case 'thread/tokenUsage/updated': {
        const { tokenUsage } = params as ThreadTokenUsageUpdatedNotification;
        return [
          {
            type: 'context',
            used: tokenUsage.last.totalTokens,
            size: tokenUsage.modelContextWindow,
          },
        ];
      }
      case 'item/autoApprovalReview/completed':
        return this.review(params as ItemGuardianApprovalReviewCompletedNotification);
      case 'model/rerouted':
        return [{ type: 'settings', model: (params as ModelReroutedNotification).toModel }];
      default:
        return [];
    }
  }

  // One item of a past turn, from the thread's history.
  history(item: ThreadItem): SessionEvent[] {
    if (item.type !== 'userMessage') return this.item(item, true);
    const text = item.content
      .flatMap((input) =>
        input.type === 'text' &&
        !input.text_elements.some((element) => element.placeholder === PRESENTATION_CONTEXT)
          ? [input.text]
          : [],
      )
      .join('\n');
    const images = item.content.flatMap((input) =>
      input.type === 'image' && 'url' in input ? imagesOfUrl(input.url) : [],
    );
    if (text.trim() === '' && images.length === 0) return [];
    return [
      {
        type: 'message',
        id: item.id,
        role: 'user',
        text,
        ...(images.length === 0 ? {} : { images }),
      },
    ];
  }

  // The paths and the diff of a file change item, for an approval that refers to it.
  fileChangeOf(itemId: string): { paths: string[]; diff: string } | undefined {
    const changes = this.fileChanges.get(itemId);
    if (changes === undefined) return undefined;
    const files = changes.map((change, index) =>
      fileChange(`${itemId}:${String(index)}`, change, this.cwd),
    );
    return { paths: files.map((file) => file.path), diff: files.map((file) => file.diff).join('') };
  }

  // An item as it starts, and again once it is complete. The user's own messages come from the
  // session, not from Codex, while it runs.
  private item(item: ThreadItem, completed: boolean): SessionEvent[] {
    switch (item.type) {
      case 'agentMessage':
      case 'plan':
        return completed && item.text.trim() !== ''
          ? [{ type: 'message', id: item.id, role: 'agent', text: item.text }]
          : [];
      case 'reasoning': {
        if (completed) this.summaryParts.delete(item.id);
        const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n');
        return completed && text.trim() !== ''
          ? [{ type: 'message', id: item.id, role: 'thinking', text }]
          : [];
      }
      case 'commandExecution':
        return [this.command(item, completed)];
      case 'fileChange':
        return this.fileChangeItem(item, completed);
      case 'mcpToolCall': {
        const images = completed ? mcpImages(item.result) : [];
        return [
          {
            type: 'tool',
            id: item.id,
            kind: 'other',
            title: `${item.server}: ${item.tool}`,
            status: completed ? itemStatus(item.status) : 'running',
            ...(completed ? { output: mcpOutput(item.result, item.error) } : {}),
            ...(images.length === 0 ? {} : { images }),
          },
        ];
      }
      // A generated image is the agent's, as a message of its own.
      case 'imageGeneration': {
        const data = 'result' in item ? item.result : '';
        if (!completed || data === '') return [];
        const image = { mediaType: imageTypeOf(data) ?? 'image/png', data };
        return [{ type: 'message', id: item.id, role: 'agent', text: '', images: [image] }];
      }
      case 'dynamicToolCall':
        return [
          {
            type: 'tool',
            id: item.id,
            kind: 'other',
            title: item.tool,
            status: completed ? (item.success === false ? 'failed' : 'completed') : 'running',
          },
        ];
      case 'webSearch':
        return [webSearch(item, completed)];
      case 'imageView': {
        const path = displayPath(item.path, this.cwd);
        return [
          {
            type: 'tool',
            id: item.id,
            kind: 'read',
            title: path,
            paths: [path],
            status: completed ? 'completed' : 'running',
          },
        ];
      }
      default:
        return [];
    }
  }

  private command(
    item: Extract<ThreadItem, { type: 'commandExecution' }>,
    completed: boolean,
  ): SessionEvent {
    const actions = item.commandActions;
    const command =
      actions.length > 0 ? actions.map((action) => action.command).join(' && ') : item.command;
    const paths = actions.flatMap((action) =>
      action.type === 'read' ? [displayPath(action.path, this.cwd)] : [],
    );
    const output = completed ? item.aggregatedOutput : null;
    if (completed) this.streamedOutput.delete(item.id);
    return {
      type: 'tool',
      id: item.id,
      kind: commandKind(actions),
      title: actions[0]?.command ?? command,
      command,
      status: completed ? itemStatus(item.status) : 'running',
      ...(paths.length === 0 ? {} : { paths }),
      ...(output === null ? {} : { output: output.slice(0, OUTPUT_LIMIT) }),
    };
  }

  private fileChangeItem(
    item: Extract<ThreadItem, { type: 'fileChange' }>,
    completed: boolean,
  ): SessionEvent[] {
    this.fileChanges.set(item.id, item.changes);
    const paths = item.changes.map((change) => displayPath(change.path, this.cwd));
    const status = completed ? itemStatus(item.status) : 'running';
    return [
      { type: 'tool', id: item.id, kind: 'edit', title: paths.join(', '), status, paths },
      ...(status === 'completed'
        ? item.changes.map((change, index): SessionEvent => ({
            type: 'file-change',
            change: fileChange(`${item.id}:${String(index)}`, change, this.cwd),
            toolId: item.id,
          }))
        : []),
    ];
  }

  // Streamed command output, up to the limit each command keeps.
  private output({ itemId, delta }: CommandExecutionOutputDeltaNotification): SessionEvent[] {
    const streamed = this.streamedOutput.get(itemId) ?? 0;
    const text = delta.slice(0, Math.max(0, OUTPUT_LIMIT - streamed));
    if (text === '') return [];
    this.streamedOutput.set(itemId, streamed + text.length);
    return [{ type: 'tool-output', id: itemId, text }];
  }

  private turnCompleted({ turn }: TurnCompletedNotification): SessionEvent[] {
    const error = turn.error?.message ?? this.turnError;
    this.turnError = undefined;
    switch (turn.status) {
      case 'completed':
        return [{ type: 'turn-ended', outcome: 'completed' }];
      case 'interrupted':
        return [{ type: 'turn-ended', outcome: 'interrupted' }];
      case 'failed':
        return [
          { type: 'turn-ended', outcome: 'failed', ...(error === undefined ? {} : { error }) },
        ];
      case 'inProgress':
        return [];
    }
  }

  // Codex's automatic review denied an action; the action's tool call says why.
  private review({
    review,
    targetItemId,
  }: ItemGuardianApprovalReviewCompletedNotification): SessionEvent[] {
    if (review.status !== 'denied' || targetItemId === null) return [];
    const rationale = review.rationale === null ? '' : `: ${review.rationale}`;
    return [
      {
        type: 'tool',
        id: targetItemId,
        status: 'failed',
        output: `Codex's automatic review denied this${rationale}`,
      },
    ];
  }
}

// A request to the model that Codex retries, as its notice says it: "Reconnecting... 2/5" names the
// retry it makes, counted from 1, and how many it makes at most, while its details say why. A notice
// without a count, such as while Codex waits for the network, says why itself where it has no details.
function retrying({ message, additionalDetails }: TurnError): SessionEvent {
  const count = /(\d+)\/(\d+)\s*$/.exec(message);
  const details = additionalDetails?.trim() ?? '';
  const reason = details !== '' ? details : count === null ? message.trim() : '';
  return {
    type: 'retrying',
    ...(count === null ? {} : { attempt: Number(count[1]), maxRetries: Number(count[2]) }),
    ...(reason === '' ? {} : { reason }),
  };
}

function taskStatus(status: 'pending' | 'inProgress' | 'completed'): Task['status'] {
  return status === 'inProgress' ? 'in_progress' : status;
}

function itemStatus(status: 'inProgress' | 'completed' | 'failed' | 'declined'): ToolStatus {
  switch (status) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'declined':
      return 'failed';
  }
}

// What a command does, from what Codex made of it: reading, searching or running.
function commandKind(actions: readonly CommandAction[]): ToolKind {
  if (actions.length === 0) return 'execute';
  if (actions.every((action) => action.type === 'read')) return 'read';
  if (actions.every((action) => action.type === 'listFiles' || action.type === 'search')) {
    return 'search';
  }
  return 'execute';
}

// A web search by what it did. A search shows its first query, and all of them in its output when it
// ran several, where Codex's own query is the first followed by an ellipsis. Opening a page shows the
// page, and finding text in one the text and the page. Anything else, such as opening pages the
// search found, which Codex reports without a query, shows the pages it got back by their domains,
// with their titles in its output; a search still running has none of these yet.
function webSearch(
  item: Extract<ThreadItem, { type: 'webSearch' }>,
  completed: boolean,
): SessionEvent {
  const call = { type: 'tool', id: item.id, status: completed ? 'completed' : 'running' } as const;
  const { action } = item;
  switch (action?.type) {
    case 'search': {
      const queries = action.queries ?? (action.query === null ? [] : [action.query]);
      return {
        ...call,
        kind: 'search',
        title: queries[0] ?? item.query,
        ...(queries.length > 1 ? { output: queries.join('\n') } : {}),
      };
    }
    case 'openPage':
      return { ...call, kind: 'fetch', title: action.url ?? item.query };
    case 'findInPage': {
      const found = [action.pattern, action.url].filter((part) => part !== null && part !== '');
      return { ...call, kind: 'search', title: found.length > 0 ? found.join(' · ') : item.query };
    }
    default: {
      const pages = pagesOf(item.results);
      if (item.query !== '' || pages.length === 0) {
        return { ...call, kind: 'search', title: item.query };
      }
      const domains = [
        ...new Set(pages.flatMap((page) => (page.domain === '' ? [] : [page.domain]))),
      ];
      return {
        ...call,
        kind: 'fetch',
        title: domains.join(', '),
        output: pages
          .map((page) => [page.title, page.domain].filter((part) => part !== '').join(' · '))
          .join('\n'),
      };
    }
  }
}

// The pages a web search got back, from the results Codex passes on as they come: each one's title
// and its domain, without www.
function pagesOf(results: JsonValue[] | null): { title: string; domain: string }[] {
  return (results ?? []).flatMap((result) => {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return [];
    const title = typeof result.title === 'string' ? result.title.trim() : '';
    const domain = (
      typeof result.domain === 'string'
        ? result.domain
        : typeof result.url === 'string'
          ? hostOf(result.url)
          : ''
    ).replace(/^www\./, '');
    return title === '' && domain === '' ? [] : [{ title, domain }];
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// The images an MCP tool returned, as MCP gives them in base64.
function mcpImages(result: McpToolCallResult | null): MessageImage[] {
  return (result?.content ?? []).flatMap((block) =>
    typeof block === 'object' &&
    block !== null &&
    !Array.isArray(block) &&
    block.type === 'image' &&
    typeof block.data === 'string' &&
    typeof block.mimeType === 'string'
      ? [{ mediaType: block.mimeType, data: block.data }]
      : [],
  );
}

// An image given as a data URL, as the app sends the user's.
function imagesOfUrl(url: string): MessageImage[] {
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(url);
  return match?.[1] === undefined || match[2] === undefined
    ? []
    : [{ mediaType: match[1], data: match[2] }];
}

function mcpOutput(result: McpToolCallResult | null, error: McpToolCallError | null): string {
  if (error !== null) return error.message.slice(0, OUTPUT_LIMIT);
  const text = (result?.content ?? []).flatMap((block) =>
    typeof block === 'object' &&
    block !== null &&
    !Array.isArray(block) &&
    typeof block.text === 'string'
      ? [block.text]
      : [],
  );
  return text.join('\n').slice(0, OUTPUT_LIMIT);
}
import { PRESENTATION_CONTEXT } from '../../../sessions/shared/host-context';
