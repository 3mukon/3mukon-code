import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  QuestionAnswer,
  QuestionRequest,
} from '../../../sessions/shared/events';
import { fileChange } from './patch';
import { commandOf, isDiff, pathsOf, record, toolNameOf, type ToolCallInfo } from './translate';

interface Context {
  cwd: string;
  now: number;
}

// Whether a call asks to run outside Antigravity's terminal sandbox.
export function leavesSandbox(call: ToolCallUpdate): boolean {
  return record(call.rawInput)?.BypassSandbox === true;
}

// A tool call Antigravity asks to run, with the answers it offers: allowing and denying once. Its
// request may show less than the call's own updates did, such as an edit's file and diff, which known
// then supplies. A command that asks to run outside the terminal sandbox is asked with denial
// preselected (ADR-0043).
export function permissionApproval(
  id: string,
  params: RequestPermissionRequest,
  context: Context,
  known: ToolCallInfo | undefined,
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
      // A command that would leave the sandbox says so, as the request looks like any other command's.
      ...(leavesSandbox(call)
        ? { title: 'Antigravity asks to run this command outside its sandbox' }
        : call.title == null || call.title === ''
          ? {}
          : { title: call.title }),
      ...(command === undefined ? {} : { command }),
      ...(paths.length === 0 ? {} : { paths }),
      ...(diff === '' ? {} : { diff }),
      ...(action === 'tool' ? { toolName: toolNameOf(call) ?? call.title ?? 'tool' } : {}),
      canAllowForSession: false,
      denyByDefault: leavesSandbox(call),
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

// The option Antigravity offers for the user's answer: allowing or denying this once, the only answers
// it offers; cancelled where it offers neither.
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

// One of the form's questions: the property that holds its answer, the property for typed text beside
// it where the form has one, whether it takes several choices, and its choices' values by label.
export interface FormField {
  key: string;
  other?: string;
  multiple: boolean;
  choices: { value: string; label: string }[];
}

export const cancelledForm: CreateElicitationResponse = { action: 'cancel' };

// Antigravity's own question tool asks through ACP's form elicitation: a property per question, its
// choices as consts titled with their labels, and beside it a property for typed text named after it
// with `_other`. The form's questions as the session shows them; undefined for any other kind of
// elicitation, such as a link to open.
export function formQuestion(
  id: string,
  params: CreateElicitationRequest,
  context: Context,
): { request: QuestionRequest; fields: FormField[] } | undefined {
  if (params.mode !== 'form') return undefined;
  const schema = record(record(params)?.requestedSchema);
  const properties = record(schema?.properties);
  if (properties === undefined) return undefined;
  const fields: FormField[] = [];
  const questions: QuestionRequest['questions'] = [];
  for (const [key, value] of Object.entries(properties)) {
    const property = record(value);
    if (property === undefined) continue;
    // A question's typed text, which its question takes.
    if (key.endsWith('_other') && key.slice(0, -'_other'.length) in properties) continue;
    const other = `${key}_other` in properties ? `${key}_other` : undefined;
    const multiple = property.type === 'array';
    const choices = choicesOf(multiple ? record(property.items) : property);
    fields.push({ key, ...(other === undefined ? {} : { other }), multiple, choices });
    const title = text(property.title) ?? key;
    const description = text(property.description);
    questions.push({
      id: key,
      text: description === undefined || other !== undefined ? title : `${title}\n\n${description}`,
      options: choices.map((choice) => ({ label: choice.label })),
      multiSelect: multiple,
      freeText: other !== undefined || choices.length === 0,
      secret: false,
    });
  }
  if (questions.length === 0) return undefined;
  return { fields, request: { id, questions, requestedAt: context.now } };
}

// A property's choices: titled consts, or plain values.
function choicesOf(schema: Record<string, unknown> | undefined): FormField['choices'] {
  const titled = schema?.oneOf ?? schema?.anyOf;
  if (Array.isArray(titled)) {
    return titled.flatMap((entry: unknown) => {
      const option = record(entry);
      const value = text(option?.const);
      return value === undefined ? [] : [{ value, label: text(option?.title) ?? value }];
    });
  }
  const plain = schema?.enum;
  return Array.isArray(plain)
    ? plain.flatMap((value: unknown) =>
        typeof value === 'string' && value !== '' ? [{ value, label: value }] : [],
      )
    : [];
}

// The user's answers as the form takes them: each question's chosen values, and any typed text in its
// property for typed text, or as its answer where it has no choices; a declined form is declined.
export function formResult(
  fields: readonly FormField[],
  answer: QuestionAnswer,
): CreateElicitationResponse {
  if (answer.decision === 'decline') return { action: 'decline' };
  const content: Record<string, string | string[]> = {};
  for (const field of fields) {
    const given = answer.answers[field.key];
    if (given === undefined) continue;
    const values = given.selected.flatMap(
      (label) => field.choices.find((choice) => choice.label === label)?.value ?? [],
    );
    if (field.multiple && values.length > 0) content[field.key] = values;
    else if (values[0] !== undefined) content[field.key] = values[0];
    const typed = given.text ?? '';
    if (typed === '') continue;
    if (field.other !== undefined) content[field.other] = typed;
    else if (field.choices.length === 0) content[field.key] = typed;
  }
  return { action: 'accept', content };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
