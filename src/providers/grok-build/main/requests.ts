import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  QuestionAnswer,
  QuestionRequest,
} from '../../../sessions/shared/events';
import { fileChange } from './patch';
import { commandOf, isDiff, pathsOf, type ToolCallInfo } from './translate';

interface Context {
  cwd: string;
  now: number;
}

// A tool call Grok Build asks to run, with the answers it offers. Grok's request may show less than the
// call's own updates did, such as an edit's file and diff, which known then supplies. Grok remembers an
// "always" answer for the project rather than for the session, so the session offers allowing once and
// denying only.
export function permissionApproval(
  id: string,
  params: RequestPermissionRequest,
  context: Context,
  known?: ToolCallInfo,
): { request: ApprovalRequest; options: PermissionOption[] } {
  const call = params.toolCall;
  const command = commandOf(call.rawInput);
  const shown = (call.content ?? []).filter(isDiff);
  const diffs = shown.length > 0 ? shown : (known?.diffs ?? []);
  const paths = [...new Set([...pathsOf(call, context.cwd), ...(known?.paths ?? [])])];
  const kind = call.kind ?? known?.kind;
  const action = actionOf(kind);
  const diff = diffs
    .map(
      (entry, index) =>
        fileChange(`${id}:${String(index)}`, entry, kind === 'delete', context.cwd).diff,
    )
    .join('');
  return {
    options: params.options,
    request: {
      id,
      action,
      ...(call.title == null || call.title === '' ? {} : { title: call.title }),
      ...(command === undefined ? {} : { command }),
      ...(paths.length === 0 ? {} : { paths }),
      ...(diff === '' ? {} : { diff }),
      ...(action === 'tool' ? { toolName: call.name ?? call.title ?? 'tool' } : {}),
      canAllowForSession: false,
      denyByDefault: false,
      requestedAt: context.now,
    },
  };
}

function actionOf(kind: string | null | undefined): ApprovalRequest['action'] {
  switch (kind) {
    case 'execute':
      return 'command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    default:
      return 'tool';
  }
}

export const cancelledPermission: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

// The option Grok offers for the user's answer: allowing or rejecting this once. Grok's "always" options
// would outlast the session, so an answer never picks them, and is cancelled where Grok offers no other.
export function approvalResult(
  options: readonly PermissionOption[],
  answer: ApprovalAnswer,
): RequestPermissionResponse {
  const kind = answer.decision === 'deny' ? 'reject_once' : 'allow_once';
  const option = options.find((entry) => entry.kind === kind);
  return option === undefined
    ? cancelledPermission
    : { outcome: { outcome: 'selected', optionId: option.optionId } };
}

// Grok Build's own question tool, `ask_user_question`, which asks an ACP client through this extension
// request once the client has said that it shows questions.
export const ASK_USER_QUESTION = '_x.ai/ask_user_question';

const askUserQuestionParams = z.object({
  sessionId: z.string(),
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().nullish(),
        options: z
          .array(z.object({ label: z.string(), description: z.string().nullish() }))
          .nullish(),
        multiSelect: z.boolean().nullish(),
      }),
    )
    .min(1),
});

export type AskUserQuestionParams = z.infer<typeof askUserQuestionParams>;

export function parseAskUserQuestion(params: unknown): AskUserQuestionParams {
  return askUserQuestionParams.parse(params);
}

// The answer Grok takes: the user's answers by question text, or none.
export type AskUserQuestionResult =
  | { outcome: 'accepted'; answers: Record<string, string>; annotations: Record<string, never> }
  | { outcome: 'cancelled' };

export const cancelledQuestion: AskUserQuestionResult = { outcome: 'cancelled' };

// The questions as the session shows them. Every question also takes typed text, as Grok's own question
// card does.
export function userQuestion(
  id: string,
  params: AskUserQuestionParams,
  context: Context,
): { request: QuestionRequest; texts: string[] } {
  return {
    texts: params.questions.map((question) => question.question),
    request: {
      id,
      questions: params.questions.map((question, index) => ({
        id: `q${String(index)}`,
        ...(question.header == null || question.header === '' ? {} : { header: question.header }),
        text: question.question,
        options: (question.options ?? []).map((option) => ({
          label: option.label,
          ...(option.description == null || option.description === ''
            ? {}
            : { description: option.description }),
        })),
        multiSelect: question.multiSelect === true,
        freeText: true,
        secret: false,
      })),
      requestedAt: context.now,
    },
  };
}

// The user's answers, keyed by question text as Grok takes them: the chosen labels and any typed text,
// joined.
export function questionResult(
  texts: readonly string[],
  answer: QuestionAnswer,
): AskUserQuestionResult {
  if (answer.decision === 'decline') return cancelledQuestion;
  return {
    outcome: 'accepted',
    answers: Object.fromEntries(
      texts.map((text, index) => {
        const given = answer.answers[`q${String(index)}`];
        const parts = [
          ...(given?.selected ?? []),
          ...(given?.text === undefined || given.text === '' ? [] : [given.text]),
        ];
        return [text, parts.join(', ')];
      }),
    ),
    annotations: {},
  };
}
