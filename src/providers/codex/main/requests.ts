import type {
  ApprovalAnswer,
  ApprovalRequest,
  QuestionAnswer,
  QuestionRequest,
} from '../../../sessions/shared/events';
import { displayPath } from './patch';
import type { CommandExecutionApprovalDecision } from './protocol/v2/CommandExecutionApprovalDecision';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams';
import type { FileChangeApprovalDecision } from './protocol/v2/FileChangeApprovalDecision';
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams';
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams';
import type { PermissionsRequestApprovalResponse } from './protocol/v2/PermissionsRequestApprovalResponse';
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams';
import type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse';

// A request from Codex that waits for the user, with what answering it needs.
export type CodexRequest =
  | { kind: 'command'; request: ApprovalRequest }
  | { kind: 'file-change'; request: ApprovalRequest }
  | { kind: 'permissions'; request: ApprovalRequest; params: PermissionsRequestApprovalParams }
  | { kind: 'question'; request: QuestionRequest };

interface Context {
  cwd: string;
  now: number;
}

// A command Codex wants to run outside its sandbox, or input for a command that is running.
export function commandApproval(
  id: string,
  params: CommandExecutionRequestApprovalParams,
  context: Context,
): CodexRequest {
  const command =
    params.commandActions?.map((action) => action.command).join(' && ') ?? params.command;
  return {
    kind: 'command',
    request: {
      id,
      action: 'command',
      ...(params.kind === 'writeStdin' ? { title: 'Write to a running command' } : {}),
      ...(params.reason == null ? {} : { reason: params.reason }),
      ...(command == null || command === '' ? {} : { command }),
      ...(params.cwd == null ? {} : { cwd: displayPath(params.cwd, context.cwd) }),
      canAllowForSession: true,
      denyByDefault: false,
      requestedAt: context.now,
    },
  };
}

// Changes Codex wants to write; their paths and diff come from the file change item they belong to.
export function fileChangeApproval(
  id: string,
  params: FileChangeRequestApprovalParams,
  change: { paths: string[]; diff: string } | undefined,
  context: Context,
): CodexRequest {
  return {
    kind: 'file-change',
    request: {
      id,
      action: 'edit',
      ...(params.reason == null ? {} : { reason: params.reason }),
      ...(change === undefined ? {} : { paths: change.paths, diff: change.diff }),
      canAllowForSession: true,
      denyByDefault: false,
      requestedAt: context.now,
    },
  };
}

// More network or file access than the sandbox allows.
export function permissionsApproval(
  id: string,
  params: PermissionsRequestApprovalParams,
  context: Context,
): CodexRequest {
  const { network, fileSystem } = params.permissions;
  const paths = [...(fileSystem?.read ?? []), ...(fileSystem?.write ?? [])].map((path) =>
    displayPath(path, context.cwd),
  );
  const wants = [
    ...(network?.enabled === true ? ['network access'] : []),
    ...(fileSystem?.write?.length ? ['writing outside the folder'] : []),
    ...(fileSystem?.read?.length ? ['reading outside the folder'] : []),
  ];
  return {
    kind: 'permissions',
    params,
    request: {
      id,
      action: 'permissions',
      ...(wants.length === 0 ? {} : { title: `Codex asks for ${wants.join(', ')}` }),
      ...(params.reason === null ? {} : { reason: params.reason }),
      ...(paths.length === 0 ? {} : { paths }),
      canAllowForSession: true,
      denyByDefault: false,
      requestedAt: context.now,
    },
  };
}

// Questions Codex asks the user. Codex takes one choice per question, or a typed answer where it allows
// one.
export function userInputQuestion(
  id: string,
  params: ToolRequestUserInputParams,
  context: Context,
): CodexRequest {
  return {
    kind: 'question',
    request: {
      id,
      questions: params.questions.map((question) => ({
        id: question.id,
        ...(question.header === '' ? {} : { header: question.header }),
        text: question.question,
        options: (question.options ?? []).map((option) => ({
          label: option.label,
          ...(option.description === '' ? {} : { description: option.description }),
        })),
        multiSelect: false,
        freeText: question.isOther || (question.options ?? []).length === 0,
        secret: question.isSecret,
      })),
      requestedAt: context.now,
    },
  };
}

// The response Codex takes for the user's answer to an approval.
export function approvalResult(
  request: Exclude<CodexRequest, { kind: 'question' }>,
  answer: ApprovalAnswer,
):
  | { decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision }
  | PermissionsRequestApprovalResponse {
  if (request.kind !== 'permissions') return { decision: decision(answer) };
  if (answer.decision === 'deny') return { permissions: {}, scope: 'turn' };
  const { network, fileSystem } = request.params.permissions;
  return {
    permissions: {
      ...(network === null ? {} : { network }),
      ...(fileSystem === null ? {} : { fileSystem }),
    },
    scope: answer.decision === 'allow-for-session' ? 'session' : 'turn',
  };
}

function decision(answer: ApprovalAnswer): 'accept' | 'acceptForSession' | 'decline' {
  switch (answer.decision) {
    case 'allow-once':
      return 'accept';
    case 'allow-for-session':
      return 'acceptForSession';
    case 'deny':
      return 'decline';
  }
}

// The response Codex takes for the user's answers: the chosen labels and any typed text, by question.
export function questionResult(answer: QuestionAnswer): ToolRequestUserInputResponse {
  if (answer.decision === 'decline') return { answers: {} };
  return {
    answers: Object.fromEntries(
      Object.entries(answer.answers).map(([id, { selected, text }]) => [
        id,
        { answers: [...selected, ...(text === undefined || text === '' ? [] : [text])] },
      ]),
    ),
  };
}
