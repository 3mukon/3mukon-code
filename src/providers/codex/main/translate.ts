import type { SessionEvent, Task, ToolKind, ToolStatus } from '../../../sessions/shared/events';
import { displayPath, fileChange } from './patch';
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
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification';
import type { TurnPlanUpdatedNotification } from './protocol/v2/TurnPlanUpdatedNotification';

// Tool output is kept to this many characters, so that long command output stays cheap to hold.
const OUTPUT_LIMIT = 20_000;

// Translates what codex app-server reports, live or from a thread's history, into session events. It
// remembers file changes, which approvals refer to, and how much output each command has streamed.
export class Translator {
  private readonly fileChanges = new Map<string, FileUpdateChange[]>();
  private readonly streamedOutput = new Map<string, number>();
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
        const { itemId, delta } = params as ReasoningSummaryTextDeltaNotification;
        return delta === ''
          ? []
          : [{ type: 'message-delta', id: itemId, role: 'thinking', text: delta }];
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
        if (!willRetry) this.turnError = error.message;
        return [];
      }
      case 'thread/name/updated': {
        const { threadName } = params as ThreadNameUpdatedNotification;
        return threadName === undefined || threadName === ''
          ? []
          : [{ type: 'title', title: threadName }];
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
      .flatMap((input) => (input.type === 'text' ? [input.text] : []))
      .join('\n');
    return text.trim() === '' ? [] : [{ type: 'message', id: item.id, role: 'user', text }];
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
        const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n');
        return completed && text.trim() !== ''
          ? [{ type: 'message', id: item.id, role: 'thinking', text }]
          : [];
      }
      case 'commandExecution':
        return [this.command(item, completed)];
      case 'fileChange':
        return this.fileChangeItem(item, completed);
      case 'mcpToolCall':
        return [
          {
            type: 'tool',
            id: item.id,
            kind: 'other',
            title: `${item.server}: ${item.tool}`,
            status: completed ? itemStatus(item.status) : 'running',
            ...(completed ? { output: mcpOutput(item.result, item.error) } : {}),
          },
        ];
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
        return [
          {
            type: 'tool',
            id: item.id,
            kind: 'search',
            title: item.query,
            status: completed ? 'completed' : 'running',
          },
        ];
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
