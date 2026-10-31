import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  QuestionAnswer,
  QuestionRequest,
} from '../../../sessions/shared/events';
import { diffTexts, displayPath } from './patch';
import { asRecord, str } from './translate';

export type ToolPermissionOptions = Parameters<CanUseTool>[2];

// What Claude Code asked through canUseTool, as the user will see it, with what answering needs.
export type ClaudeRequest =
  | {
      kind: 'approval';
      request: ApprovalRequest;
      input: Record<string, unknown>;
      // The rules that "allow for the session" adds, as Claude Code suggested them.
      suggestions: PermissionUpdate[];
    }
  | {
      kind: 'question';
      request: QuestionRequest;
      input: Record<string, unknown>;
      questionTexts: string[];
    };

// Turns one canUseTool call into an approval or a question. AskUserQuestion is how Claude Code asks
// the user questions, and ExitPlanMode how it asks to carry out a plan.
export function toRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: ToolPermissionOptions,
  context: { cwd: string; now: number },
): ClaudeRequest {
  const id = options.toolUseID;
  const questions = Array.isArray(input.questions) ? input.questions.map(asRecord) : [];
  if (toolName === 'AskUserQuestion' && questions.length > 0) {
    return {
      kind: 'question',
      input,
      questionTexts: questions.map((question) => str(question.question)),
      request: {
        id,
        requestedAt: context.now,
        questions: questions.map((question, index) => {
          const header = str(question.header);
          return {
            id: `q${String(index)}`,
            ...(header === '' ? {} : { header }),
            text: str(question.question),
            options: (Array.isArray(question.options) ? question.options : []).map((option) => {
              const { label, description } = asRecord(option);
              return {
                label: str(label),
                ...(str(description) === '' ? {} : { description: str(description) }),
              };
            }),
            multiSelect: question.multiSelect === true,
            // Claude Code always offers its own "Other" answer.
            freeText: true,
            secret: false,
          };
        }),
      },
    };
  }

  const suggestions = options.suggestions ?? [];
  const isPlan = toolName === 'ExitPlanMode';
  const reason = options.decisionReason ?? options.description;
  return {
    kind: 'approval',
    input,
    suggestions,
    request: {
      id,
      action: approvalAction(toolName),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(reason === undefined ? {} : { reason }),
      ...approvalDetail(toolName, input, context.cwd),
      canAllowForSession:
        !isPlan && suggestions.length > 0 && options.suppressAlwaysAllowRule !== true,
      denyByDefault: options.defaultToNo === true,
      // Claude Code gives a denial's message to the model as the reason.
      denialMessage: true,
      requestedAt: context.now,
    },
  };
}

// The answer to an approval, as canUseTool returns it; mode is the session's own Claude Code mode.
export function approvalResult(
  request: Extract<ClaudeRequest, { kind: 'approval' }>,
  answer: ApprovalAnswer,
  mode: PermissionMode,
): PermissionResult {
  if (answer.decision === 'deny') {
    const fallback =
      request.request.action === 'plan'
        ? 'The user wants you to keep planning instead of carrying out this plan.'
        : 'The user denied this action.';
    return { behavior: 'deny', message: answer.message ?? fallback };
  }
  if (request.request.action === 'plan') {
    // Approving a plan leaves plan mode for the session's own mode.
    return {
      behavior: 'allow',
      updatedInput: request.input,
      updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
    };
  }
  if (answer.decision === 'allow-for-session' && request.request.canAllowForSession) {
    return {
      behavior: 'allow',
      updatedInput: request.input,
      updatedPermissions: request.suggestions.map((suggestion) => ({
        ...suggestion,
        destination: 'session',
      })),
    };
  }
  return { behavior: 'allow', updatedInput: request.input };
}

// The answer to a question: AskUserQuestion takes the answers in its input, keyed by question text.
export function questionResult(
  request: Extract<ClaudeRequest, { kind: 'question' }>,
  answer: QuestionAnswer,
): PermissionResult {
  if (answer.decision === 'decline') {
    return { behavior: 'deny', message: 'The user declined to answer.' };
  }
  const answers = Object.fromEntries(
    request.questionTexts.map((text, index) => {
      const given = answer.answers[`q${String(index)}`];
      const parts = [
        ...(given?.selected ?? []),
        ...(given?.text === undefined || given.text === '' ? [] : [given.text]),
      ];
      return [text, parts.join(', ')];
    }),
  );
  return { behavior: 'allow', updatedInput: { ...request.input, answers } };
}

function approvalAction(toolName: string): ApprovalRequest['action'] {
  switch (toolName) {
    case 'Bash':
      return 'command';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'ExitPlanMode':
      return 'plan';
    default:
      return 'tool';
  }
}

function approvalDetail(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Pick<ApprovalRequest, 'command' | 'cwd' | 'paths' | 'diff' | 'plan' | 'toolName'> {
  const filePath = str(input.file_path) || str(input.notebook_path);
  const path = filePath === '' ? '' : displayPath(filePath, cwd);
  switch (toolName) {
    case 'Bash':
      return { command: str(input.command), cwd };
    case 'Edit':
      return { paths: [path], diff: diffTexts(path, str(input.old_string), str(input.new_string)) };
    case 'Write':
      return { paths: [path], diff: diffTexts(path, '', str(input.content)) };
    case 'NotebookEdit':
      return { paths: [path] };
    case 'ExitPlanMode':
      return { plan: str(input.plan) };
    default:
      return { toolName, ...(path === '' ? {} : { paths: [path] }) };
  }
}
